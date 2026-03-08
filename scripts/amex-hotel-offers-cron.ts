#!/usr/bin/env node

require('dotenv').config();

// Import Supabase admin client and AmEx headers (same as working amex-hotel-calendar / FHR)
const { getSupabaseAdminClient } = require('../src/lib/supabase-admin');
const { getAmExBrowserHeaders } = require('../src/lib/amex-api-headers');

const AMEX_API_URL = 'https://tlsonlwrappersvcs.americanexpress.com/consumertravel/services/v1/en-US/hotelOffers';
const BATCH_SIZE = 200; // hotels per API request
const MAX_CALLS_PER_BATCH = 36; // API calls per chunk (then delay)
const CALENDAR_DAYS = 360; // consecutive date pairs from today (check-in days 0..359)
const DELAY_BETWEEN_CHUNKS_MS = 500;

const USAGE = `Usage: npx tsx scripts/amex-hotel-offers-cron.ts <nights>
  nights  Required. Number of nights per stay (check-out = check-in + nights).
          Example: 1 = check-in Apr 3, check-out Apr 4; 2 = Apr 3 -> Apr 5.
`;

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
 * Generate consecutive date pairs from today. Check-in = day 0..CALENDAR_DAYS-1;
 * check-out = check-in + nights.
 */
function generateDatePairs(nights: number): Array<{ checkIn: string; checkOut: string }> {
  const pairs: Array<{ checkIn: string; checkOut: string }> = [];
  const today = new Date();
  for (let i = 0; i < CALENDAR_DAYS; i++) {
    const checkInDate = new Date(today);
    checkInDate.setDate(today.getDate() + i);
    const checkOutDate = new Date(checkInDate);
    checkOutDate.setDate(checkInDate.getDate() + nights);
    pairs.push({
      checkIn: checkInDate.toISOString().split('T')[0]!,
      checkOut: checkOutDate.toISOString().split('T')[0]!,
    });
  }
  return pairs;
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
 * Call AmEx hotel offers API for a batch of hotel IDs.
 * @param quiet - when true, skip success logs (used when running many calls in parallel per chunk)
 */
async function fetchHotelOffersBatch(
  hotelIds: number[],
  checkIn: string,
  checkOut: string,
  quiet?: boolean
): Promise<HotelOffer[]> {
  const url = buildAmExUrl(checkIn, checkOut, hotelIds);

  if (!quiet) {
    console.log(`[CRON] Calling AmEx API with ${hotelIds.length} hotel IDs (first few: ${hotelIds.slice(0, 3).join(', ')}...)`);
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: getAmExBrowserHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CRON] API error for batch ${checkIn}-${checkOut}: ${response.status} ${response.statusText}`);
      if (!quiet) console.error(`[CRON] Error response: ${errorText.substring(0, 300)}...`);
      return [];
    }

    const data: AmExApiResponse = await response.json();

    if (!data.hotels || data.hotels.length === 0) {
      return [];
    }

    return data.hotels;
  } catch (error) {
    console.error(`[CRON] Error fetching hotel offers batch ${checkIn}-${checkOut}:`, error);
    return [];
  }
}

/**
 * Compute nights from check-in and check-out (e.g. 2025-04-03 to 2025-04-05 = 2 nights).
 */
function computeNights(checkIn: string, checkOut: string): number | null {
  const a = new Date(checkIn);
  const b = new Date(checkOut);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  const diffMs = b.getTime() - a.getTime();
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return days >= 0 ? days : null;
}

/** Row shape for amex_hotel_calendar_cache (includes all fields from original cron / API) */
interface CalendarCacheRow {
  hotel_id: number;
  check_in_date: string;
  check_out_date: string | null;
  nights: number | null;
  offer_price: number | null;
  remaining_count: number;
  free_cancellation: boolean | null;
  list_price: number | null;
  last_updated: string;
}

/**
 * Map a single offer to amex_hotel_calendar_cache row.
 * Uses request dates when the API does not return them (avoids dropping offers).
 */
function offerToCalendarRow(
  offer: HotelOffer,
  requestCheckIn: string,
  requestCheckOut: string
): CalendarCacheRow {
  const details = offer.offerDetails;
  const checkInDate =
    details?.dates?.checkInDate?.trim() ? details.dates.checkInDate : requestCheckIn;
  const checkOutDate =
    details?.dates?.checkOutDate?.trim() ? details.dates.checkOutDate : requestCheckOut;
  const offerPrice = details?.offerPrice;
  const listPrice = details?.listPrice;
  const nights = computeNights(checkInDate, checkOutDate || requestCheckOut);
  return {
    hotel_id: offer.hotelId,
    check_in_date: checkInDate,
    check_out_date: checkOutDate || null,
    nights,
    offer_price: offerPrice != null ? parseFloat(String(offerPrice)) || null : null,
    remaining_count: details?.remainingCount ?? 0,
    free_cancellation: details?.freeCancellation ?? null,
    list_price: listPrice != null ? parseFloat(String(listPrice)) || null : null,
    last_updated: new Date().toISOString(),
  };
}

/**
 * Bulk upsert into amex_hotel_calendar_cache (onConflict: hotel_id, check_in_date)
 */
async function bulkUpsertCalendarCache(rows: CalendarCacheRow[]): Promise<{ updated: number }> {
  if (rows.length === 0) {
    return { updated: 0 };
  }

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from('amex_hotel_calendar_cache')
    .upsert(rows, { onConflict: 'hotel_id,check_in_date', ignoreDuplicates: false });

  if (error) {
    console.error('[CRON] Bulk upsert amex_hotel_calendar_cache error:', error);
    return { updated: 0 };
  }

  return { updated: rows.length };
}

/**
 * Purge rows in amex_hotel_calendar_cache where nights matches (before re-populating for this nights).
 */
async function purgeCalendarCacheByNights(nights: number): Promise<{ deleted: number }> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('amex_hotel_calendar_cache')
    .delete()
    .eq('nights', nights)
    .select('hotel_id');

  if (error) {
    console.error('[CRON] Purge amex_hotel_calendar_cache error:', error);
    return { deleted: 0 };
  }
  return { deleted: data?.length ?? 0 };
}

/** Row from amex_hotel_calendar_cache for cheapest-offer aggregation */
interface CalendarCacheRecord {
  hotel_id: number | string;
  check_in_date: string;
  check_out_date: string | null;
  nights: number | null;
  offer_price: number | null;
  remaining_count: number | null;
  free_cancellation: boolean | null;
  list_price: number | null;
}

const CACHE_PAGE_SIZE = 1000; // Supabase default limit; fetch in pages to get all rows

/**
 * Update hotel table from cheapest offer per hotel in amex_hotel_calendar_cache.
 * For each hotel_id, picks the row with minimum offer_price across all nights (all rows in cache).
 */
async function updateHotelTableFromCheapestOffers(): Promise<{ updated: number }> {
  const supabase = getSupabaseAdminClient();
  const rows: CalendarCacheRecord[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: page, error: fetchError } = await supabase
      .from('amex_hotel_calendar_cache')
      .select('hotel_id, check_in_date, check_out_date, nights, offer_price, remaining_count, free_cancellation, list_price')
      .range(offset, offset + CACHE_PAGE_SIZE - 1);

    if (fetchError) {
      console.error('[CRON] Fetch amex_hotel_calendar_cache for hotel update error:', fetchError);
      return { updated: 0 };
    }
    if (page?.length) rows.push(...(page as CalendarCacheRecord[]));
    hasMore = (page?.length ?? 0) === CACHE_PAGE_SIZE;
    offset += CACHE_PAGE_SIZE;
  }

  if (!rows.length) {
    return { updated: 0 };
  }

  const byHotel = new Map<number, CalendarCacheRecord>();
  for (const r of rows) {
    const hid = typeof r.hotel_id === 'string' ? parseInt(r.hotel_id, 10) : r.hotel_id;
    if (Number.isNaN(hid)) continue;
    const current = byHotel.get(hid);
    const price = r.offer_price ?? Infinity;
    if (!current || (current.offer_price ?? Infinity) > price) {
      byHotel.set(hid, r);
    }
  }

  const hotelRows = Array.from(byHotel.entries()).map(([hotel_id, r]) => ({
    hotel_id,
    offer_price: r.offer_price ?? null,
    checkin_date: r.check_in_date ?? null,
    checkout_date: r.check_out_date ?? null,
    remaining_count: r.remaining_count ?? null,
    free_cancellation: r.free_cancellation ?? null,
    list_price: r.list_price ?? null,
    nights: r.nights ?? null,
  }));

  const { error: upsertError } = await supabase
    .from('hotel')
    .upsert(hotelRows, { onConflict: 'hotel_id' });

  if (upsertError) {
    console.error('[CRON] Upsert hotel from cheapest offers error:', upsertError);
    return { updated: 0 };
  }
  return { updated: hotelRows.length };
}

/** One API call task: (checkIn, checkOut, hotelIds) */
type Task = { checkIn: string; checkOut: string; hotelIds: number[] };

/**
 * Chunk array into chunks of at most size
 */
function chunkTasks<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Main cron job: multi-date calendar with 36 API calls per chunk, writing to amex_hotel_calendar_cache.
 * @param nights - Required. Number of nights per stay (check-out = check-in + nights).
 */
async function runCronJob(nights: number) {
  console.log(`[CRON] Starting AmEx hotel offers (multi-date calendar) job (nights=${nights})...`);

  try {
    const { deleted } = await purgeCalendarCacheByNights(nights);
    console.log(`[CRON] Purged ${deleted} rows from amex_hotel_calendar_cache where nights=${nights}`);

    const datePairs = generateDatePairs(nights);
    console.log(`[CRON] Generated ${datePairs.length} date pairs (${CALENDAR_DAYS} check-in days from today, ${nights} night(s) per stay)`);

    const hotelIds = await fetchAllHotelIds();
    if (hotelIds.length === 0) {
      console.log('[CRON] No hotels to process, exiting');
      return;
    }

    const hotelBatches = createBatches(hotelIds, BATCH_SIZE);
    console.log(`[CRON] Created ${hotelBatches.length} hotel batches of up to ${BATCH_SIZE} hotels each`);

    // Task list: every (datePair × hotelBatch) = one API call
    const tasks: Task[] = [];
    for (const pair of datePairs) {
      for (const ids of hotelBatches) {
        tasks.push({ checkIn: pair.checkIn, checkOut: pair.checkOut, hotelIds: ids });
      }
    }
    const taskChunks = chunkTasks(tasks, MAX_CALLS_PER_BATCH);
    console.log(`[CRON] Total tasks: ${tasks.length}, chunk count: ${taskChunks.length} (max ${MAX_CALLS_PER_BATCH} calls per chunk)`);

    let totalOffers = 0;
    let totalRowsUpserted = 0;

    for (let i = 0; i < taskChunks.length; i++) {
      const chunk = taskChunks[i]!;
      const callPromises = chunk.map((t) =>
        fetchHotelOffersBatch(t.hotelIds, t.checkIn, t.checkOut, true)
      );
      const results = await Promise.all(callPromises);

      const allOffers = results.flat();
      const rows = chunk.flatMap((task, j) =>
        (results[j] ?? []).map((offer) =>
          offerToCalendarRow(offer, task.checkIn, task.checkOut)
        )
      );
      const { updated } = await bulkUpsertCalendarCache(rows);

      totalOffers += allOffers.length;
      totalRowsUpserted += updated;

      console.log(
        `[CRON] Chunk ${i + 1}/${taskChunks.length}: ${chunk.length} calls, ${allOffers.length} offers, ${updated} rows upserted`
      );

      if (i < taskChunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_CHUNKS_MS));
      }
    }

    console.log('[CRON] Calendar cache completed:');
    console.log(`[CRON] - Total API calls: ${tasks.length}`);
    console.log(`[CRON] - Total offers: ${totalOffers}`);
    console.log(`[CRON] - Total rows upserted to amex_hotel_calendar_cache: ${totalRowsUpserted}`);

    const { updated: hotelUpdated } = await updateHotelTableFromCheapestOffers();
    console.log(`[CRON] Hotel table updated: ${hotelUpdated} rows (cheapest offer_price per hotel across all nights in cache)`);
    console.log('[CRON] Job completed successfully.');
  } catch (error) {
    console.error('[CRON] Job failed:', error);
    process.exit(1);
  }
}

// Run the cron job if this script is executed directly (nights required as first CLI arg)
if (require.main === module) {
  const nightsArg = process.argv[2];
  const nights = nightsArg != null ? parseInt(nightsArg, 10) : NaN;
  if (!Number.isInteger(nights) || nights < 1) {
    console.error('[CRON] Missing or invalid required argument: nights');
    console.error(USAGE);
    process.exit(1);
  }

  runCronJob(nights)
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
