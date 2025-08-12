import Redis from 'ioredis';

let redis: Redis | null = null;

export function getRedisClient(): Redis | null {
  if (redis) return redis;

  const host = 'redis';
  const port = 6379;
  const password = process.env.REDIS_PASSWORD;

  try {
    redis = new Redis({
      host,
      port,
      password: password || undefined,
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