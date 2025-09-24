import { createHash } from 'crypto';
import zlib from 'zlib';
import Redis from 'ioredis';
import { getRedisConfig } from '@/lib/env-utils';

let redis: Redis | null = null;

export function getRedisClient(): Redis | null {
  if (redis) return redis;
  const config = getRedisConfig();
  try {
    redis = new Redis({
      ...config,
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    redis.on('error', (err) => {
      console.warn('Redis connection error:', err.message);
    });
    return redis;
  } catch (error) {
    console.warn('Failed to create Redis client:', error);
    return null;
  }
}

export const CACHE_TTL_SECONDS = 1800; // 30 minutes

export function getCacheKey(params: any) {
  const { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent, seats, united } = params;
  const hash = createHash('sha256').update(JSON.stringify({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent, seats, united })).digest('hex');
  return `build-itins:${origin}:${destination}:${hash}`;
}

export async function cacheItineraries(key: string, data: any, ttlSeconds = CACHE_TTL_SECONDS) {
  const client = getRedisClient();
  if (!client) return;
  try {
    const compressed = zlib.gzipSync(JSON.stringify(data));
    await client.set(key, compressed, 'EX', ttlSeconds);
  } catch (error) {
    console.warn('Failed to cache data:', error);
  }
}

export async function getCachedItineraries(key: string) {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const compressed = await client.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (error) {
    console.warn('Failed to get cached data:', error);
    return null;
  }
}

export function getOptimizedCacheKey(params: any, filterParams: any) {
  const { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent, seats, united } = params;
  const baseHash = createHash('sha256').update(JSON.stringify({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent, seats, united })).digest('hex');
  const filterHash = createHash('sha256').update(JSON.stringify(filterParams)).digest('hex');
  return `build-itins:${origin}:${destination}:${baseHash}:${filterHash}`;
}

export async function cacheOptimizedItineraries(key: string, data: any, ttlSeconds = CACHE_TTL_SECONDS) {
  const client = getRedisClient();
  if (!client) return;
  try {
    const compressed = zlib.gzipSync(JSON.stringify(data));
    await client.set(key, compressed, 'EX', ttlSeconds);
  } catch (error) {
    console.warn('Failed to cache optimized data:', error);
  }
}

export async function getCachedOptimizedItineraries(key: string) {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const compressed = await client.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (error) {
    console.warn('Failed to get cached optimized data:', error);
    return null;
  }
}

export async function getCachedAvailabilityV2Response(params: any) {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const key = `availability-v2-response:${hash}`;
    const compressed = await client.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (err) {
    console.error('Redis getCachedAvailabilityV2Response error:', err);
    return null;
  }
}

export async function saveAvailabilityV2ResponseToCache(params: any, response: any) {
  const client = getRedisClient();
  if (!client) return;
  try {
    const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const key = `availability-v2-response:${hash}`;
    const json = JSON.stringify(response);
    const compressed = zlib.gzipSync(json);
    await client.set(key, compressed);
    await client.expire(key, 1800);
  } catch (err) {
    console.error('Redis saveAvailabilityV2ResponseToCache error:', err);
  }
}


