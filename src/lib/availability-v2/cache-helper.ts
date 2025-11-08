import { getRedisClient } from '@/lib/redis/client';
import zlib from 'zlib';
import { GroupedResult, PricingEntry } from '@/types/availability-v2';

/**
 * Get cache key for availability group
 */
function getCacheKey(originAirport: string, destinationAirport: string, date: string): string {
  return `availability-v2-group:${originAirport}:${destinationAirport}:${date}`;
}

/**
 * Get cached availability groups from Redis (all alliances for the date)
 * @param originAirport Origin airport code
 * @param destinationAirport Destination airport code
 * @param date Date in YYYY-MM-DD format
 * @returns Array of cached groups (all alliances), empty array [] if cached but no results, or null if not cached
 */
export async function getCachedAvailabilityGroup(
  originAirport: string,
  destinationAirport: string,
  date: string
): Promise<GroupedResult[] | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const key = getCacheKey(originAirport, destinationAirport, date);
    const compressed = await client.getBuffer(key);
    if (!compressed) return null;

    const json = zlib.gunzipSync(compressed).toString();
    const result = JSON.parse(json) as GroupedResult[];
    // Return empty array if cached as empty, null only if key doesn't exist
    return Array.isArray(result) ? result : null;
  } catch (err) {
    console.error(`[cache-helper] Error getting cached groups for ${originAirport}-${destinationAirport}-${date}:`, err);
    return null;
  }
}

/**
 * Save availability groups to Redis cache (all alliances for the date)
 * @param originAirport Origin airport code
 * @param destinationAirport Destination airport code
 * @param date Date in YYYY-MM-DD format
 * @param groups Array of grouped results (all alliances) to cache
 * @param ttlSeconds TTL in seconds (default: 1800 = 30 minutes)
 */
export async function saveCachedAvailabilityGroup(
  originAirport: string,
  destinationAirport: string,
  date: string,
  groups: GroupedResult[],
  ttlSeconds: number = 1800
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    const key = getCacheKey(originAirport, destinationAirport, date);
    const json = JSON.stringify(groups);
    const compressed = zlib.gzipSync(json, { level: 6, memLevel: 8 });
    const pipeline = client.pipeline();
    pipeline.set(key, compressed);
    if (ttlSeconds > 0) pipeline.expire(key, ttlSeconds);
    await pipeline.exec();
  } catch (err) {
    console.error(`[cache-helper] Error saving cached groups for ${originAirport}-${destinationAirport}-${date}:`, err);
  }
}

/**
 * Get cache key for pricing group
 */
function getPricingCacheKey(originAirport: string, destinationAirport: string, date: string): string {
  return `availability-v2-pricing:${originAirport}:${destinationAirport}:${date}`;
}

/**
 * Get cached pricing entries from Redis
 * @param originAirport Origin airport code
 * @param destinationAirport Destination airport code
 * @param date Date in YYYY-MM-DD format
 * @returns Array of cached pricing entries or null if not found
 */
export async function getCachedPricingGroup(
  originAirport: string,
  destinationAirport: string,
  date: string
): Promise<PricingEntry[] | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const key = getPricingCacheKey(originAirport, destinationAirport, date);
    const compressed = await client.getBuffer(key);
    if (!compressed) return null;

    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json) as PricingEntry[];
  } catch (err) {
    console.error(`[cache-helper] Error getting cached pricing for ${originAirport}-${destinationAirport}-${date}:`, err);
    return null;
  }
}

/**
 * Save pricing entries to Redis cache
 * @param originAirport Origin airport code
 * @param destinationAirport Destination airport code
 * @param date Date in YYYY-MM-DD format
 * @param pricingEntries Array of pricing entries to cache
 * @param ttlSeconds TTL in seconds (default: 1800 = 30 minutes)
 */
export async function saveCachedPricingGroup(
  originAirport: string,
  destinationAirport: string,
  date: string,
  pricingEntries: PricingEntry[],
  ttlSeconds: number = 1800
): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    const key = getPricingCacheKey(originAirport, destinationAirport, date);
    const json = JSON.stringify(pricingEntries);
    const compressed = zlib.gzipSync(json, { level: 6, memLevel: 8 });
    const pipeline = client.pipeline();
    pipeline.set(key, compressed);
    if (ttlSeconds > 0) pipeline.expire(key, ttlSeconds);
    await pipeline.exec();
  } catch (err) {
    console.error(`[cache-helper] Error saving cached pricing for ${originAirport}-${destinationAirport}-${date}:`, err);
  }
}

