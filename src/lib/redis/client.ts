import Redis from 'ioredis';
import zlib from 'zlib';
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

export async function saveCompressedJson(key: string, value: unknown, ttlSeconds = 1800) {
  const client = getRedisClient();
  if (!client) return;
  try {
    const json = JSON.stringify(value);
    const compressed = zlib.gzipSync(json, { level: 6, memLevel: 8 });
    const pipeline = client.pipeline();
    pipeline.set(key, compressed);
    if (ttlSeconds > 0) pipeline.expire(key, ttlSeconds);
    await pipeline.exec();
  } catch (err) {
    console.error('Redis saveCompressedJson error:', err);
  }
}


