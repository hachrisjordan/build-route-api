import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import { saveCompressedJson } from '@/lib/redis/client';
import { getRedisClient } from '@/lib/cache';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const AmExHotelCalendarSchema = z.object({
  hotelId: z.union([z.string(), z.number()]).transform(val => String(val)),
});

const AMEX_API_URL = 'https://tlsonlwrappersvcs.americanexpress.com/consumertravel/services/v1/en-US/hotelOffers';

/**
 * Generate 360 consecutive date pairs starting from today
 */
function generateDatePairs(): Array<{ checkIn: string; checkOut: string }> {
  const pairs = [];
  const today = new Date();
  
  for (let i = 0; i < 360; i++) {
    const checkInDate = new Date(today);
    checkInDate.setDate(today.getDate() + i);
    
    const checkOutDate = new Date(checkInDate);
    checkOutDate.setDate(checkInDate.getDate() + 1);
    
    pairs.push({
      checkIn: checkInDate.toISOString().split('T')[0]!,
      checkOut: checkOutDate.toISOString().split('T')[0]!,
    });
  }
  
  return pairs;
}

/**
 * Build AmEx API URL with query parameters (reused from amex-hotel-offers)
 */
function buildAmExUrl(checkIn: string, checkOut: string, hotelId: string): string {
  const baseParams = new URLSearchParams({
    availOnly: 'false',
    checkIn,
    checkOut,
    hotelPrograms: '20',
    sortType: 'PREMIUM',
  });
  
  const fullUrl = `${AMEX_API_URL}?${baseParams.toString()}&ecom_hotel_ids=${hotelId}`;
  return fullUrl;
}

/**
 * Get browser-like headers (reused from amex-hotel-offers)
 */
function getBrowserHeaders() {
  return {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
    'Origin': 'https://www.americanexpress.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

/**
 * Transform AmEx API response to extract offer details
 */
function transformAmExResponse(data: any, checkInDate: string) {
  if (!data || !Array.isArray(data.hotels) || data.hotels.length === 0) {
    return {
      checkInDate,
      offerPrice: null,
      remainingCount: 0,
    };
  }

  const hotel = data.hotels[0];
  const offerDetails = hotel?.offerDetails;

  return {
    checkInDate,
    offerPrice: offerDetails?.offerPrice || null,
    remainingCount: offerDetails?.remainingCount || 0,
  };
}

/**
 * Make a single API call to AmEx for a specific date range
 */
async function fetchHotelOffer(checkIn: string, checkOut: string, hotelId: string, proxyAgent?: any) {
  try {
    const url = buildAmExUrl(checkIn, checkOut, hotelId);
    
    const fetchOptions: any = {
      method: 'GET',
      headers: getBrowserHeaders(),
    };
    
    if (proxyAgent) {
      fetchOptions.agent = proxyAgent;
    }
    
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      console.error(`AmEx API error for ${checkIn}-${checkOut}: ${response.status} ${response.statusText}`);
      return {
        checkInDate: checkIn,
        offerPrice: null,
        remainingCount: 0,
        success: false,
      };
    }

    const data = await response.json();
    return {
      ...transformAmExResponse(data, checkIn),
      success: true,
    };
  } catch (error) {
    console.error(`Error fetching offer for ${checkIn}-${checkOut}:`, error);
    return {
      checkInDate: checkIn,
      offerPrice: null,
      remainingCount: 0,
      success: false,
    };
  }
}

/**
 * Process a batch of API calls
 */
async function processBatch(
  datePairs: Array<{ checkIn: string; checkOut: string }>,
  hotelId: string,
  startIndex: number,
  batchSize: number,
  proxyAgent?: any
) {
  const batch = datePairs.slice(startIndex, startIndex + batchSize);
  const promises = batch.map(({ checkIn, checkOut }) => 
    fetchHotelOffer(checkIn, checkOut, hotelId, proxyAgent)
  );
  
  return Promise.all(promises);
}

/**
 * Get cache key for hotel calendar data
 */
function getCacheKey(hotelId: string, startDate: string): string {
  const hash = createHash('sha256').update(`${hotelId}:${startDate}`).digest('hex');
  return `amex-hotel-calendar:${hotelId}:${hash}`;
}

/**
 * Get cached hotel calendar data
 */
async function getCachedCalendarData(hotelId: string, startDate: string) {
  const client = getRedisClient();
  if (!client) return null;
  
  try {
    const key = getCacheKey(hotelId, startDate);
    const compressed = await client.getBuffer(key);
    if (!compressed) return null;
    
    const json = require('zlib').gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (error) {
    console.warn('Failed to get cached calendar data:', error);
    return null;
  }
}

/**
 * Cache hotel calendar data
 */
async function cacheCalendarData(hotelId: string, startDate: string, data: any[]) {
  const key = getCacheKey(hotelId, startDate);
  await saveCompressedJson(key, data, 86400); // 24 hours TTL
}

/**
 * Store a batch of calendar data to Supabase
 */
async function storeCalendarBatchToSupabase(
  batch: Array<{ checkInDate: string; offerPrice: number | null; remainingCount: number }>,
  hotelId: string
): Promise<{ success: boolean; stored: number; error?: string }> {
  try {
    const supabase = getSupabaseAdminClient();

    // Format data for database
    const formattedData = batch.map((item) => ({
      hotel_id: hotelId,
      check_in_date: item.checkInDate,
      offer_price: item.offerPrice,
      remaining_count: item.remainingCount,
      last_updated: new Date().toISOString(),
    }));

    // Upsert to Supabase using the unique constraint (hotel_id, check_in_date)
    const { data, error } = await supabase
      .from('amex_hotel_calendar_cache')
      .upsert(formattedData, {
        onConflict: 'hotel_id,check_in_date',
        ignoreDuplicates: false,
      })
      .select();

    if (error) {
      console.error('Error storing calendar batch to Supabase:', error);
      return {
        success: false,
        stored: 0,
        error: error.message,
      };
    }

    return {
      success: true,
      stored: data?.length || 0,
    };
  } catch (error) {
    console.error('Exception storing calendar batch to Supabase:', error);
    return {
      success: false,
      stored: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = await req.json();
    const parsed = AmExHotelCalendarSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { 
          error: 'Invalid input', 
          details: parsed.error.errors 
        }, 
        { status: 400 }
      );
    }

    const { hotelId } = parsed.data;
    const today = new Date().toISOString().split('T')[0]!;

    // Check cache first
    const cachedData = await getCachedCalendarData(hotelId, today);
    if (cachedData) {
      console.log(`Cache hit for hotel ${hotelId}, returning cached calendar data`);
      return NextResponse.json({ 
        hotelId,
        data: cachedData,
        cached: true 
      });
    }

    console.log(`Cache miss for hotel ${hotelId}, starting calendar scraping...`);

    // Proxy config (runtime only)
    const USE_PROXY = false;
    const proxy_host = process.env.PROXY_HOST;
    const proxy_port = process.env.PROXY_PORT;
    const proxy_username = process.env.PROXY_USERNAME;
    const proxy_password = process.env.PROXY_PASSWORD;
    if (USE_PROXY && (!proxy_host || !proxy_port || !proxy_username || !proxy_password)) {
      return NextResponse.json({ 
        error: 'Proxy configuration is missing. Please set PROXY_HOST, PROXY_PORT, PROXY_USERNAME, and PROXY_PASSWORD in your environment variables.' 
      }, { status: 500 });
    }
    const PROXY_URL = USE_PROXY
      ? `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`
      : undefined;
    const proxyAgent = USE_PROXY && PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

    if (proxyAgent) {
      console.log(`Using proxy: ${proxy_host}:${proxy_port}`);
    }

    // Generate date pairs for 360 days
    const datePairs = generateDatePairs();
    const results = [];
    const batchSize = 36;
    const totalBatches = Math.ceil(datePairs.length / batchSize);

    console.log(`Processing ${datePairs.length} API calls in ${totalBatches} batches of ${batchSize}`);

    // Process batches with 500ms delay between batches
    let totalSuccessfulCalls = 0;
    let totalFailedCalls = 0;
    let totalStoredToSupabase = 0;
    const supabaseErrors: string[] = [];
    
    for (let i = 0; i < totalBatches; i++) {
      const startIndex = i * batchSize;
      const batchResults = await processBatch(datePairs, hotelId, startIndex, batchSize, proxyAgent);
      
      // Count successful vs failed calls in this batch
      const batchSuccessful = batchResults.filter(r => r.success).length;
      const batchFailed = batchResults.filter(r => !r.success).length;
      
      totalSuccessfulCalls += batchSuccessful;
      totalFailedCalls += batchFailed;
      
      results.push(...batchResults);
      
      // Store batch to Supabase (remove success field before storing)
      const batchForStorage = batchResults.map(({ success, ...rest }) => rest);
      const storageResult = await storeCalendarBatchToSupabase(batchForStorage, hotelId);
      
      if (storageResult.success) {
        totalStoredToSupabase += storageResult.stored;
        console.log(`Completed batch ${i + 1}/${totalBatches} (${batchResults.length} calls) - Success: ${batchSuccessful}, Failed: ${batchFailed}, Stored to Supabase: ${storageResult.stored}`);
      } else {
        const errorMsg = `Batch ${i + 1}/${totalBatches} Supabase storage failed: ${storageResult.error}`;
        supabaseErrors.push(errorMsg);
        console.error(errorMsg);
        console.log(`Completed batch ${i + 1}/${totalBatches} (${batchResults.length} calls) - Success: ${batchSuccessful}, Failed: ${batchFailed}, Supabase storage failed`);
      }
      
      // Add delay between batches (except for the last batch)
      if (i < totalBatches - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Remove success field before caching (not needed in cache)
    const resultsForCache = results.map(({ success, ...rest }) => rest);
    
    // Cache the results
    await cacheCalendarData(hotelId, today, resultsForCache);

    console.log(`Calendar scraping completed for hotel ${hotelId}. Found ${results.filter(r => r.remainingCount > 0).length} days with offers.`);
    console.log(`API Call Summary - Total: ${totalSuccessfulCalls + totalFailedCalls}, Successful: ${totalSuccessfulCalls}, Failed: ${totalFailedCalls}, Success Rate: ${((totalSuccessfulCalls / (totalSuccessfulCalls + totalFailedCalls)) * 100).toFixed(1)}%`);
    console.log(`Supabase Storage Summary - Total stored: ${totalStoredToSupabase}, Errors: ${supabaseErrors.length}`);

    // Remove success field from final response
    const finalResults = results.map(({ success, ...rest }) => rest);
    
    return NextResponse.json({
      hotelId,
      data: finalResults,
      cached: false,
      totalDays: finalResults.length,
      daysWithOffers: finalResults.filter(r => r.remainingCount > 0).length,
      apiCallSummary: {
        total: totalSuccessfulCalls + totalFailedCalls,
        successful: totalSuccessfulCalls,
        failed: totalFailedCalls,
        successRate: parseFloat(((totalSuccessfulCalls / (totalSuccessfulCalls + totalFailedCalls)) * 100).toFixed(1))
      },
      supabaseStorageSummary: {
        totalStored: totalStoredToSupabase,
        errors: supabaseErrors,
        success: supabaseErrors.length === 0
      }
    });

  } catch (error) {
    console.error('Error in amex-hotel-calendar POST:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      }, 
      { status: 500 }
    );
  }
}
