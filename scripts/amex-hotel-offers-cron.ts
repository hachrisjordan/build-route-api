#!/usr/bin/env node

require('dotenv').config();
const { format, addDays } = require('date-fns');

// Import Supabase admin client and AmEx headers (same as working amex-hotel-calendar / FHR)
const { getSupabaseAdminClient } = require('../src/lib/supabase-admin');
const { getAmExBrowserHeaders } = require('../src/lib/amex-api-headers');

const AMEX_API_URL = 'https://tlsonlwrappersvcs.americanexpress.com/consumertravel/services/v1/en-US/hotelOffers';
const BATCH_SIZE = 200;
const DELAY_BETWEEN_BATCHES = 5000; // 5 seconds

interface HotelRecord {
  hotel_id: number;
}

interface HotelOffer {
  hotelId: number;
  offerDetails: {
    currency: string;
    offerPrice: string;
    dates: {
      checkInDate: string;
      checkOutDate: string;
    };
    remainingCount: number;
    freeCancellation: boolean;
    listPrice: string;
  };
}

interface AmExApiResponse {
  hotels: HotelOffer[];
}

/**
 * Uses shared getAmExBrowserHeaders (same as amex-hotel-calendar FHR). Includes Referer and
 * AMEX_COOKIE from env when set, which are required to avoid 403 from AmEx API.
 */

/**
 * Fetch all hotel IDs from the hotel table
 */
async function fetchAllHotelIds(): Promise<number[]> {
  console.log('[CRON] Fetching all hotel IDs from database...');
  
  const supabase = getSupabaseAdminClient();
  
  try {
    const { data, error } = await supabase
      .from('hotel')
      .select('hotel_id');

    if (error) {
      console.error('[CRON] Error fetching hotel IDs:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    if (!data || data.length === 0) {
      console.log('[CRON] No hotels found in database');
      return [];
    }

    const hotelIds = data.map((record: HotelRecord) => record.hotel_id);
    console.log(`[CRON] Found ${hotelIds.length} hotels in database`);
    
    return hotelIds;
  } catch (error) {
    console.error('[CRON] Failed to fetch hotel IDs:', error);
    throw error;
  }
}

/**
 * Split array into batches of specified size
 */
function createBatches<T>(array: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Build AmEx API URL with query parameters
 */
function buildAmExUrl(checkIn: string, checkOut: string, hotelIds: number[]): string {
  // Manually build the query string to avoid double encoding issues
  const baseParams = new URLSearchParams({
    availOnly: 'false',
    checkIn,
    checkOut,
    hotelPrograms: '20',
    sortType: 'PREMIUM',
  });
  
  // Add hotel IDs with proper %2C encoding
  const hotelIdsParam = hotelIds.join('%2C');
  const fullUrl = `${AMEX_API_URL}?${baseParams.toString()}&ecom_hotel_ids=${hotelIdsParam}`;
  
  return fullUrl;
}

/**
 * Call AmEx hotel offers API for a batch of hotel IDs
 */
async function fetchHotelOffersBatch(hotelIds: number[], checkIn: string, checkOut: string): Promise<HotelOffer[]> {
  const url = buildAmExUrl(checkIn, checkOut, hotelIds);
  
  // Debug: Log the URL being called (truncated for readability)
  console.log(`[CRON] Calling AmEx API with ${hotelIds.length} hotel IDs (first few: ${hotelIds.slice(0, 3).join(', ')}...)`);
  console.log(`[CRON] URL: ${url.substring(0, 200)}...`);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: getAmExBrowserHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CRON] API error for batch: ${response.status} ${response.statusText}`);
      console.error(`[CRON] Error response: ${errorText.substring(0, 500)}...`);
      return [];
    }

    const data: AmExApiResponse = await response.json();
    
    if (!data.hotels || data.hotels.length === 0) {
      console.log(`[CRON] No offers found for batch of ${hotelIds.length} hotels`);
      return [];
    }

    console.log(`[CRON] Found ${data.hotels.length} offers for batch of ${hotelIds.length} hotels`);
    return data.hotels;
    
  } catch (error) {
    console.error('[CRON] Error fetching hotel offers batch:', error);
    return [];
  }
}

/**
 * Map a single offer to a hotel row for upsert
 */
function offerToRow(offer: HotelOffer): Record<string, unknown> {
  return {
    hotel_id: offer.hotelId,
    offer_price: parseFloat(offer.offerDetails.offerPrice) || null,
    checkin_date: offer.offerDetails.dates.checkInDate || null,
    checkout_date: offer.offerDetails.dates.checkOutDate || null,
    remaining_count: offer.offerDetails.remainingCount ?? null,
    free_cancellation: offer.offerDetails.freeCancellation ?? null,
    list_price: parseFloat(offer.offerDetails.listPrice) || null,
  };
}

/**
 * Bulk upsert hotel offer data for a batch (one DB round-trip instead of N sequential updates)
 */
async function bulkUpsertHotelOffers(offers: HotelOffer[]): Promise<{ updated: number }> {
  if (offers.length === 0) {
    return { updated: 0 };
  }

  const supabase = getSupabaseAdminClient();
  const rows = offers.map(offerToRow);

  const { error } = await supabase
    .from('hotel')
    .upsert(rows, { onConflict: 'hotel_id' });

  if (error) {
    console.error(`[CRON] Bulk upsert error:`, error);
    return { updated: 0 };
  }

  return { updated: offers.length };
}

/**
 * Process a batch of hotel offers and update database (single bulk upsert per batch)
 */
async function processBatch(batch: number[], checkIn: string, checkOut: string): Promise<{ processed: number; updated: number }> {
  console.log(`[CRON] Processing batch of ${batch.length} hotels...`);

  const offers = await fetchHotelOffersBatch(batch, checkIn, checkOut);
  const { updated } = await bulkUpsertHotelOffers(offers);

  console.log(`[CRON] Batch completed: ${offers.length} offers processed, ${updated} records updated`);

  return {
    processed: offers.length,
    updated,
  };
}

/**
 * Main cron job function
 */
async function runCronJob() {
  console.log('[CRON] Starting AmEx hotel offers update job...');
  
  try {
    // Calculate dates (30 days from today for check-in, 33 days for check-out)
    const today = new Date();
    const checkIn = format(addDays(today, 30), 'yyyy-MM-dd');
    const checkOut = format(addDays(today, 33), 'yyyy-MM-dd');
    
    console.log(`[CRON] Using dates: check-in ${checkIn}, check-out ${checkOut}`);
    
    // Fetch all hotel IDs
    const hotelIds = await fetchAllHotelIds();
    
    if (hotelIds.length === 0) {
      console.log('[CRON] No hotels to process, exiting');
      return;
    }
    
    // Create batches
    const batches = createBatches(hotelIds, BATCH_SIZE);
    console.log(`[CRON] Created ${batches.length} batches of up to ${BATCH_SIZE} hotels each`);
    
    let totalProcessed = 0;
    let totalUpdated = 0;
    
    // Process each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`[CRON] Processing batch ${i + 1}/${batches.length} (${batch.length} hotels)`);
      
      const result = await processBatch(batch, checkIn, checkOut);
      totalProcessed += result.processed;
      totalUpdated += result.updated;
      
      // Add delay between batches (except for the last one)
      if (i < batches.length - 1) {
        console.log(`[CRON] Waiting ${DELAY_BETWEEN_BATCHES}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
      }
    }
    
    console.log(`[CRON] Job completed successfully:`);
    console.log(`[CRON] - Total hotels processed: ${hotelIds.length}`);
    console.log(`[CRON] - Total offers found: ${totalProcessed}`);
    console.log(`[CRON] - Total records updated: ${totalUpdated}`);
    
  } catch (error) {
    console.error('[CRON] Job failed:', error);
    process.exit(1);
  }
}

// Run the cron job if this script is executed directly
if (require.main === module) {
  runCronJob()
    .then(() => {
      console.log('[CRON] Cron job finished successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[CRON] Cron job failed:', error);
      process.exit(1);
    });
}

module.exports = { runCronJob };
