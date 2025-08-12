import zlib from 'zlib';
import { createHash } from 'crypto';
import { getRedisClient } from '@/lib/redis';

const CACHE_TTL_SECONDS = 1800; // 30 minutes

export function getCacheKey(params: any) {
  const { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent } = params;
  const hash = createHash('sha256')
    .update(
      JSON.stringify({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent })
    )
    .digest('hex');
  return `build-itins:${origin}:${destination}:${hash}`;
}

export async function cacheItineraries(key: string, data: any, ttlSeconds = CACHE_TTL_SECONDS) {
  const redisClient = getRedisClient();
  if (!redisClient) return;
  try {
    const compressed = zlib.gzipSync(JSON.stringify(data));
    await redisClient.set(key, compressed, 'EX', ttlSeconds);
  } catch (error) {
    console.warn('Failed to cache data:', error);
  }
}

export async function getCachedItineraries(key: string) {
  const redisClient = getRedisClient();
  if (!redisClient) return null;
  try {
    const compressed = await redisClient.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (error) {
    console.warn('Failed to get cached data:', error);
    return null;
  }
}

export function getOptimizedCacheKey(params: any, filterParams: any) {
  const { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent } = params;
  const baseHash = createHash('sha256')
    .update(
      JSON.stringify({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent })
    )
    .digest('hex');
  const filterHash = createHash('sha256').update(JSON.stringify(filterParams)).digest('hex');
  return `build-itins:${origin}:${destination}:${baseHash}:${filterHash}`;
}

export async function cacheOptimizedItineraries(key: string, data: any, ttlSeconds = CACHE_TTL_SECONDS) {
  const redisClient = getRedisClient();
  if (!redisClient) return;
  try {
    const compressed = zlib.gzipSync(JSON.stringify(data));
    await redisClient.set(key, compressed, 'EX', ttlSeconds);
  } catch (error) {
    console.warn('Failed to cache optimized data:', error);
  }
}

export async function getCachedOptimizedItineraries(key: string) {
  const redisClient = getRedisClient();
  if (!redisClient) return null;
  try {
    const compressed = await redisClient.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (error) {
    console.warn('Failed to get cached optimized data:', error);
    return null;
  }
}