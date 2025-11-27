import { createClient } from '@supabase/supabase-js';
import { getSanitizedEnv, getRedisConfig } from './env-utils';
import Redis from 'ioredis';

interface ReliabilityEntry {
  code: string;
  min_count: number;
  exemption?: string;
  ffp_program?: string[];
}

interface ReliabilityCache {
  data: ReliabilityEntry[];
  timestamp: number;
}

// Shared cache instance (in-memory backup)
let reliabilityCache: ReliabilityCache | null = null;
let ongoingFetch: Promise<ReliabilityEntry[]> | null = null;

const RELIABILITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REDIS_RELIABILITY_KEY = 'reliability_table_cache';
const REDIS_FETCH_LOCK_KEY = 'reliability_fetch_lock';
const REDIS_LOCK_TTL_SECONDS = 30; // Lock expires after 30 seconds

// Redis client for coordination
let redis: Redis | null = null;

function getRedisClient(): Redis | null {
  if (redis) return redis;
  
  const config = getRedisConfig();
  
  try {
    redis = new Redis({ 
      ...config,
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: true
    });
    
    redis.on('error', (err) => {
      console.warn('[reliability-cache] Redis connection error:', err.message);
    });
    
    return redis;
  } catch (error) {
    console.warn('[reliability-cache] Failed to create Redis client:', error);
    return null;
  }
}

/**
 * Shared reliability table cache with Redis coordination.
 * Ensures only one fetch happens at a time across all instances.
 */
export async function getReliabilityTableCached(): Promise<ReliabilityEntry[]> {
  const startTime = Date.now();
  const now = Date.now();
  const redisClient = getRedisClient();
  
  // First check in-memory cache
  if (reliabilityCache && (now - reliabilityCache.timestamp) < RELIABILITY_CACHE_TTL_MS) {
    console.log(`[reliability-cache] In-memory cache hit (${Date.now() - startTime}ms)`);
    return reliabilityCache.data;
  }
  
  // Check Redis cache if available
  if (redisClient) {
    try {
      const cached = await redisClient.get(REDIS_RELIABILITY_KEY);
      if (cached) {
        const parsedCache: ReliabilityCache = JSON.parse(cached);
        
        // Check if Redis cache is still valid
        if ((now - parsedCache.timestamp) < RELIABILITY_CACHE_TTL_MS) {
          // Update in-memory cache
          reliabilityCache = parsedCache;
          return parsedCache.data;
        }
      }
    } catch (error) {
      console.warn('[reliability-cache] Redis get error:', error);
    }
  }
  
  // If a fetch is already in progress locally, wait for it
  if (ongoingFetch) {
    console.log(`[reliability-cache] Waiting for ongoing fetch (${Date.now() - startTime}ms)`);
    return await ongoingFetch;
  }
  
  // Try to acquire Redis lock to coordinate across instances
  let lockAcquired = false;
  if (redisClient) {
    try {
      const lockResult = await redisClient.set(
        REDIS_FETCH_LOCK_KEY, 
        process.pid.toString(), 
        'EX', 
        REDIS_LOCK_TTL_SECONDS, 
        'NX'
      );
      lockAcquired = lockResult === 'OK';
      
      if (!lockAcquired) {
        // Another instance is fetching, wait a bit and try Redis cache again
        console.log(`[reliability-cache] Lock not acquired, waiting for other instance (${Date.now() - startTime}ms)`);
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
        
        try {
          const cached = await redisClient.get(REDIS_RELIABILITY_KEY);
          if (cached) {
            const parsedCache: ReliabilityCache = JSON.parse(cached);
            reliabilityCache = parsedCache;
            console.log(`[reliability-cache] Got fresh data from other instance (${Date.now() - startTime}ms)`);
            return parsedCache.data;
          }
        } catch (error) {
          console.warn('[reliability-cache] Error getting fresh cache:', error);
        }
      }
    } catch (error) {
      console.warn('[reliability-cache] Redis lock error:', error);
      lockAcquired = false; // Fall through to direct fetch
    }
  }
  
  // Start new fetch and store the promise
  console.log(`[reliability-cache] Starting fresh fetch (lock: ${lockAcquired}) (${Date.now() - startTime}ms)`);
  ongoingFetch = fetchReliabilityTable();
  
  try {
    const data = await ongoingFetch;
    
    // Update cache with fresh data
    const newCache: ReliabilityCache = {
      data,
      timestamp: now
    };
    
    reliabilityCache = newCache;
    
    // Store in Redis if available
    if (redisClient) {
      try {
        await redisClient.setex(REDIS_RELIABILITY_KEY, Math.ceil(RELIABILITY_CACHE_TTL_MS / 1000), JSON.stringify(newCache));
      } catch (error) {
        console.warn('[reliability-cache] Redis set error:', error);
      }
      
      // Release lock
      if (lockAcquired) {
        try {
          await redisClient.del(REDIS_FETCH_LOCK_KEY);
        } catch (error) {
          console.warn('[reliability-cache] Redis unlock error:', error);
        }
      }
    }
    
    console.log(`[reliability-cache] Fresh fetch completed (${Date.now() - startTime}ms)`);
    return data;
  } catch (error) {
    console.error('[reliability-cache] Failed to fetch reliability table:', error);
    
    // Release lock on error
    if (redisClient && lockAcquired) {
      try {
        await redisClient.del(REDIS_FETCH_LOCK_KEY);
      } catch (lockError) {
        console.warn('[reliability-cache] Redis unlock error after fetch failure:', lockError);
      }
    }
    
    // Return cached data if available, even if expired
    if (reliabilityCache) {
      console.warn(`[reliability-cache] Returning stale cache due to fetch error (${Date.now() - startTime}ms)`);
      return reliabilityCache.data;
    }
    
    // Return empty array as fallback
    console.warn(`[reliability-cache] Returning empty array as fallback (${Date.now() - startTime}ms)`);
    return [];
  } finally {
    // Clear the ongoing fetch promise
    ongoingFetch = null;
  }
}

/**
 * Internal function to fetch reliability table from Supabase
 */
async function fetchReliabilityTable(): Promise<ReliabilityEntry[]> {
  const supabaseUrl = getSanitizedEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = getSanitizedEnv('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase environment variables');
  }
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from('reliability')
    .select('code, min_count, exemption, ffp_program');
  
  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }
  
  return data || [];
}

/**
 * Convert reliability table to map for fast lookups
 */
export function getReliabilityMap(table: ReliabilityEntry[]): Record<string, { min_count: number; exemption?: string }> {
  const map: Record<string, { min_count: number; exemption?: string }> = {};
  for (const row of table) {
    map[row.code] = { min_count: row.min_count, exemption: row.exemption };
  }
  return map;
}

/**
 * Clear the cache (useful for testing or forced refresh)
 */
export function clearReliabilityCache(): void {
  reliabilityCache = null;
  ongoingFetch = null;
}
