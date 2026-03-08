import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import { saveCompressedJson } from '@/lib/redis/client';
import { getRedisClient } from '@/lib/cache';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const AmExHotelCalendarSchema = z.object({
  hotelId: z.union([z.string(), z.number()]).transform((val) => String(val)),
  nights: z.union([z.string(), z.number()]).optional().transform((val) => (val != null ? Number(val) : undefined)),
}).transform((data) => {
  const nights = data.nights != null && Number.isInteger(data.nights) && data.nights >= 1 ? data.nights : 1;
  return { ...data, nights };
});

/**
 * Redis cache key for table-backed calendar response (hotelId + nights + today).
 */
function getCalendarCacheKey(hotelId: string, nights: number, startDate: string): string {
  const hash = createHash('sha256').update(`${hotelId}:${nights}:${startDate}`).digest('hex');
  return `amex-hotel-calendar:${hotelId}:${nights}:${hash}`;
}

/**
 * Get cached calendar response (from previous table read).
 */
async function getCachedCalendarData(hotelId: string, nights: number, startDate: string) {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const key = getCalendarCacheKey(hotelId, nights, startDate);
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
 * Cache calendar response from table (24h TTL).
 */
async function cacheCalendarData(hotelId: string, nights: number, startDate: string, data: unknown[]) {
  const key = getCalendarCacheKey(hotelId, nights, startDate);
  await saveCompressedJson(key, data, 86400);
}

/**
 * Map amex_hotel_calendar_cache row to API response shape.
 */
function mapCacheRowToCalendarItem(row: {
  check_in_date: string;
  check_out_date: string | null;
  nights: number | null;
  offer_price: number | null;
  remaining_count: number | null;
  free_cancellation: boolean | null;
  list_price: number | null;
}) {
  return {
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date ?? null,
    nights: row.nights ?? null,
    offerPrice: row.offer_price ?? null,
    remainingCount: row.remaining_count ?? 0,
    freeCancellation: row.free_cancellation ?? null,
    listPrice: row.list_price ?? null,
  };
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
        { error: 'Invalid input', details: parsed.error.errors },
        { status: 400 }
      );
    }

    const { hotelId, nights } = parsed.data;
    const today = new Date().toISOString().split('T')[0]!;

    // Optional: return Redis-cached response (table-backed)
    const cachedData = await getCachedCalendarData(hotelId, nights, today);
    if (cachedData) {
      return NextResponse.json({
        hotelId,
        nights,
        data: cachedData,
        cached: true,
      });
    }

    // Read from amex_hotel_calendar_cache (populated by cron)
    const supabase = getSupabaseAdminClient();
    const { data: rows, error } = await supabase
      .from('amex_hotel_calendar_cache')
      .select('check_in_date, check_out_date, nights, offer_price, remaining_count, free_cancellation, list_price')
      .eq('hotel_id', hotelId)
      .eq('nights', nights)
      .order('check_in_date', { ascending: true });

    if (error) {
      console.error('amex-hotel-calendar table read error:', error);
      return NextResponse.json(
        { error: 'Failed to read calendar data', details: error.message },
        { status: 500 }
      );
    }

    const data = (rows ?? []).map(mapCacheRowToCalendarItem);
    await cacheCalendarData(hotelId, nights, today, data);

    return NextResponse.json({
      hotelId,
      nights,
      data,
      cached: false,
      totalDays: data.length,
      daysWithOffers: data.filter((r) => (r.remainingCount ?? 0) > 0).length,
    });
  } catch (error) {
    console.error('Error in amex-hotel-calendar POST:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
