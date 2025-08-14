import Redis from 'ioredis';
import { createHash } from 'crypto';
import { getRedisConfig } from './env-utils';
import { differenceInDays, parseISO } from 'date-fns';

interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfter?: number;
}

interface SearchRequest {
  origin: string;
  destination: string;
  maxStop: number;
  startDate: string;
  endDate: string;
  apiKey: string | null;
  minReliabilityPercent?: number;
  seats?: number;
}

// Rate limiting configuration
const RATE_LIMITS = {
  uniqueSearches: {
    limit: 10,           // Maximum unique searches
    window: 300,         // Per 5 minutes
    dailyLimit: 10      // Maximum unique searches per day
  },
  totalRequests: {
    limit: 200,          // Total requests (including filters/pagination)
    window: 300,         // Per 5 minutes
    dailyLimit: 2000     // Maximum total requests per day
  },
  pagination: {
    limit: 1,            // Maximum 1 pagination request
    window: 3            // Per 3 seconds
  }
};

// Redis client for rate limiting
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
      console.warn('Redis rate limiter error:', err.message);
    });
    
    return redis;
  } catch (error) {
    console.warn('Failed to create Redis client for rate limiter:', error);
    return null;
  }
}

/**
 * Generate a unique search key based on core search parameters only
 * This identifies unique searches vs filtering/pagination of existing searches
 */
function generateUniqueSearchKey(body: SearchRequest): string {
  const searchParams = {
    origin: body.origin,
    destination: body.destination,
    maxStop: body.maxStop,
    startDate: body.startDate,
    endDate: body.endDate,
    // Note: We don't include apiKey, minReliabilityPercent, or seats
    // as these don't fundamentally change the search
  };
  
  const hash = createHash('sha256').update(JSON.stringify(searchParams)).digest('hex');
  return `unique-search:${hash}`;
}

/**
 * Validate restrictions for null API key requests
 */
function validateNullApiKeyRestrictions(body: SearchRequest, queryParams: URLSearchParams): RateLimitResult {
  if (body.apiKey !== null) {
    return { allowed: true }; // No restrictions for paid API keys
  }

  try {
    // 1. Check date span (max 3 days including both end dates)
    const startDate = parseISO(body.startDate);
    const endDate = parseISO(body.endDate);
    const daysDifference = differenceInDays(endDate, startDate);
    
    if (daysDifference > 2) { // 0, 1, or 2 days difference allowed (3 days total including both dates)
      return {
        allowed: false,
        reason: 'Date range too long. Maximum 3 days allowed for free searches (including start and end dates).',
        retryAfter: 60
      };
    }

    // 2. Check maxStop limit (max 2 stops)
    if (body.maxStop > 2) {
      return {
        allowed: false,
        reason: 'Too many stops. Maximum 2 stops allowed for free searches.',
        retryAfter: 60
      };
    }

    // 3. Check origin * destination combinations (max 4 total combinations)
    const originCodes = body.origin.split('/').filter(Boolean);
    const destinationCodes = body.destination.split('/').filter(Boolean);
    const totalCombinations = originCodes.length * destinationCodes.length;
    
    if (totalCombinations > 4) {
      return {
        allowed: false,
        reason: 'Too many airport combinations. Maximum 4 origin×destination combinations allowed for free searches.',
        retryAfter: 60
      };
    }

    // 4. Check pageSize limit (max 10)
    const pageSize = parseInt(queryParams.get('pageSize') || '10');
    if (pageSize > 10) {
      return {
        allowed: false,
        reason: 'Page size too large. Maximum 10 items per page allowed for free searches.',
        retryAfter: 60
      };
    }

    return { allowed: true };
  } catch (error) {
    console.error('Error validating null API key restrictions:', error);
    return {
      allowed: false,
      reason: 'Invalid request format.',
      retryAfter: 60
    };
  }
}

/**
 * Check if this is a unique search or a variation of existing search
 */
async function isUniqueSearch(clientIP: string, searchKey: string): Promise<boolean> {
  const redisClient = getRedisClient();
  if (!redisClient) return true; // Conservative approach if Redis unavailable
  
  try {
    const exists = await redisClient.exists(`${clientIP}:${searchKey}`);
    return !exists;
  } catch (error) {
    console.warn('Error checking unique search:', error);
    return true; // Conservative approach
  }
}

/**
 * Track a unique search
 */
async function trackUniqueSearch(clientIP: string, searchKey: string): Promise<void> {
  const redisClient = getRedisClient();
  if (!redisClient) return;
  
  try {
    const pipeline = redisClient.pipeline();
    
    // Mark this search as seen for this IP
    pipeline.setex(`${clientIP}:${searchKey}`, RATE_LIMITS.uniqueSearches.window, '1');
    
    // Track count of unique searches in time window
    const windowKey = `${clientIP}:unique-count:${Math.floor(Date.now() / 1000 / RATE_LIMITS.uniqueSearches.window)}`;
    pipeline.incr(windowKey);
    pipeline.expire(windowKey, RATE_LIMITS.uniqueSearches.window);
    
    // Track daily count
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `${clientIP}:daily-unique:${today}`;
    pipeline.incr(dailyKey);
    pipeline.expire(dailyKey, 86400);
    
    await pipeline.exec();
  } catch (error) {
    console.warn('Error tracking unique search:', error);
  }
}

/**
 * Check rate limits for unique searches
 */
async function checkUniqueSearchLimits(clientIP: string): Promise<RateLimitResult> {
  const redisClient = getRedisClient();
  if (!redisClient) return { allowed: true };
  
  try {
    // Check current window
    const windowKey = `${clientIP}:unique-count:${Math.floor(Date.now() / 1000 / RATE_LIMITS.uniqueSearches.window)}`;
    const currentCount = await redisClient.get(windowKey);
    
    if (currentCount && parseInt(currentCount) >= RATE_LIMITS.uniqueSearches.limit) {
      return {
        allowed: false,
        reason: `Too many unique searches. Maximum ${RATE_LIMITS.uniqueSearches.limit} unique searches per ${RATE_LIMITS.uniqueSearches.window / 60} minutes. You can still filter and paginate existing results.`,
        retryAfter: RATE_LIMITS.uniqueSearches.window
      };
    }
    
    // Check daily limit
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `${clientIP}:daily-unique:${today}`;
    const dailyCount = await redisClient.get(dailyKey);
    
    if (dailyCount && parseInt(dailyCount) >= RATE_LIMITS.uniqueSearches.dailyLimit) {
      return {
        allowed: false,
        reason: `Daily limit reached. Maximum ${RATE_LIMITS.uniqueSearches.dailyLimit} unique searches per day. Quota resets at midnight UTC.`,
        retryAfter: 3600 // 1 hour
      };
    }
    
    return { allowed: true };
  } catch (error) {
    console.warn('Error checking unique search limits:', error);
    return { allowed: true }; // Conservative approach
  }
}

/**
 * Track total requests (including filtering/pagination)
 */
async function trackTotalRequest(clientIP: string): Promise<void> {
  const redisClient = getRedisClient();
  if (!redisClient) return;
  
  try {
    const pipeline = redisClient.pipeline();
    
    // Track count of total requests in time window
    const windowKey = `${clientIP}:total-count:${Math.floor(Date.now() / 1000 / RATE_LIMITS.totalRequests.window)}`;
    pipeline.incr(windowKey);
    pipeline.expire(windowKey, RATE_LIMITS.totalRequests.window);
    
    // Track daily count
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `${clientIP}:daily-total:${today}`;
    pipeline.incr(dailyKey);
    pipeline.expire(dailyKey, 86400);
    
    await pipeline.exec();
  } catch (error) {
    console.warn('Error tracking total request:', error);
  }
}

/**
 * Check rate limits for total requests
 */
async function checkTotalRequestLimits(clientIP: string): Promise<RateLimitResult> {
  const redisClient = getRedisClient();
  if (!redisClient) return { allowed: true };
  
  try {
    // Check current window
    const windowKey = `${clientIP}:total-count:${Math.floor(Date.now() / 1000 / RATE_LIMITS.totalRequests.window)}`;
    const currentCount = await redisClient.get(windowKey);
    
    if (currentCount && parseInt(currentCount) >= RATE_LIMITS.totalRequests.limit) {
      return {
        allowed: false,
        reason: `Too many requests. Maximum ${RATE_LIMITS.totalRequests.limit} requests per ${RATE_LIMITS.totalRequests.window / 60} minutes.`,
        retryAfter: RATE_LIMITS.totalRequests.window
      };
    }
    
    // Check daily limit
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `${clientIP}:daily-total:${today}`;
    const dailyCount = await redisClient.get(dailyKey);
    
    if (dailyCount && parseInt(dailyCount) >= RATE_LIMITS.totalRequests.dailyLimit) {
      return {
        allowed: false,
        reason: `Daily limit reached. Maximum ${RATE_LIMITS.totalRequests.dailyLimit} requests per day. Quota resets at midnight UTC.`,
        retryAfter: 3600 // 1 hour
      };
    }
    
    return { allowed: true };
  } catch (error) {
    console.warn('Error checking total request limits:', error);
    return { allowed: true }; // Conservative approach
  }
}

/**
 * Check if request is pagination-related (page parameter changes)
 */
function isPaginationRequest(queryParams: URLSearchParams): boolean {
  const page = queryParams.get('page');
  const pageSize = queryParams.get('pageSize');
  
  // If page parameter exists and is not 1, or pageSize is specified, consider it pagination
  return (page && page !== '1') || pageSize !== null;
}

/**
 * Check pagination rate limits (1 request per 3 seconds)
 */
async function checkPaginationLimits(clientIP: string): Promise<RateLimitResult> {
  const redisClient = getRedisClient();
  if (!redisClient) return { allowed: true };
  
  try {
    const paginationKey = `${clientIP}:pagination:${Math.floor(Date.now() / 1000 / RATE_LIMITS.pagination.window)}`;
    const currentCount = await redisClient.get(paginationKey);
    
    if (currentCount && parseInt(currentCount) >= RATE_LIMITS.pagination.limit) {
      return {
        allowed: false,
        reason: `Pagination too fast. Maximum ${RATE_LIMITS.pagination.limit} page request per ${RATE_LIMITS.pagination.window} seconds.`,
        retryAfter: RATE_LIMITS.pagination.window
      };
    }
    
    return { allowed: true };
  } catch (error) {
    console.warn('Error checking pagination limits:', error);
    return { allowed: true }; // Conservative approach
  }
}

/**
 * Track pagination request
 */
async function trackPaginationRequest(clientIP: string): Promise<void> {
  const redisClient = getRedisClient();
  if (!redisClient) return;
  
  try {
    const paginationKey = `${clientIP}:pagination:${Math.floor(Date.now() / 1000 / RATE_LIMITS.pagination.window)}`;
    const pipeline = redisClient.pipeline();
    pipeline.incr(paginationKey);
    pipeline.expire(paginationKey, RATE_LIMITS.pagination.window);
    await pipeline.exec();
  } catch (error) {
    console.warn('Error tracking pagination request:', error);
  }
}

/**
 * Get client IP from request
 */
function getClientIP(req: any): string {
  return req.ip || 
         req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
         req.headers.get('x-real-ip') ||
         req.headers.get('cf-connecting-ip') ||
         'unknown';
}

/**
 * Main smart rate limiting function
 */
export async function smartRateLimit(req: any, body: SearchRequest): Promise<RateLimitResult> {
  const clientIP = getClientIP(req);
  
  // Parse query parameters from request URL
  const url = new URL(req.url, `http://${req.headers.get('host') || 'localhost'}`);
  const queryParams = url.searchParams;
  
  // 1. Validate null API key restrictions (including pageSize limit)
  const nullApiValidation = validateNullApiKeyRestrictions(body, queryParams);
  if (!nullApiValidation.allowed) {
    return nullApiValidation;
  }
  
  // 2. Check pagination-specific rate limits
  const isPagination = isPaginationRequest(queryParams);
  if (isPagination) {
    const paginationLimitCheck = await checkPaginationLimits(clientIP);
    if (!paginationLimitCheck.allowed) {
      return paginationLimitCheck;
    }
  }
  
  // 3. Check total request limits (applies to all requests)
  const totalLimitCheck = await checkTotalRequestLimits(clientIP);
  if (!totalLimitCheck.allowed) {
    return totalLimitCheck;
  }
  
  // 4. Generate unique search key and check if this is a new unique search
  const searchKey = generateUniqueSearchKey(body);
  const isNewUniqueSearch = await isUniqueSearch(clientIP, searchKey);
  
  if (isNewUniqueSearch) {
    // 5. Check unique search limits
    const uniqueLimitCheck = await checkUniqueSearchLimits(clientIP);
    if (!uniqueLimitCheck.allowed) {
      return uniqueLimitCheck;
    }
    
    // 6. Track this unique search
    await trackUniqueSearch(clientIP, searchKey);
  }
  
  // 7. Track pagination request if applicable
  if (isPagination) {
    await trackPaginationRequest(clientIP);
  }
  
  // 8. Track total request (always)
  await trackTotalRequest(clientIP);
  
  console.log(`[smart-rate-limit] IP: ${clientIP}, Unique: ${isNewUniqueSearch}, Pagination: ${isPagination}, Search: ${body.origin}->${body.destination}`);
  
  return { allowed: true };
}

/**
 * Get current rate limit status for debugging/monitoring
 */
export async function getRateLimitStatus(req: any): Promise<{
  uniqueSearches: { current: number; limit: number; daily: number; dailyLimit: number };
  totalRequests: { current: number; limit: number; daily: number; dailyLimit: number };
  pagination: { current: number; limit: number; window: number };
}> {
  const clientIP = getClientIP(req);
  const redisClient = getRedisClient();
  
  if (!redisClient) {
    return {
      uniqueSearches: { current: 0, limit: RATE_LIMITS.uniqueSearches.limit, daily: 0, dailyLimit: RATE_LIMITS.uniqueSearches.dailyLimit },
      totalRequests: { current: 0, limit: RATE_LIMITS.totalRequests.limit, daily: 0, dailyLimit: RATE_LIMITS.totalRequests.dailyLimit },
      pagination: { current: 0, limit: RATE_LIMITS.pagination.limit, window: RATE_LIMITS.pagination.window }
    };
  }
  
  try {
    const today = new Date().toISOString().split('T')[0];
    const uniqueWindowKey = `${clientIP}:unique-count:${Math.floor(Date.now() / 1000 / RATE_LIMITS.uniqueSearches.window)}`;
    const uniqueDailyKey = `${clientIP}:daily-unique:${today}`;
    const totalWindowKey = `${clientIP}:total-count:${Math.floor(Date.now() / 1000 / RATE_LIMITS.totalRequests.window)}`;
    const totalDailyKey = `${clientIP}:daily-total:${today}`;
    const paginationKey = `${clientIP}:pagination:${Math.floor(Date.now() / 1000 / RATE_LIMITS.pagination.window)}`;
    
    const [uniqueCurrent, uniqueDaily, totalCurrent, totalDaily, paginationCurrent] = await Promise.all([
      redisClient.get(uniqueWindowKey),
      redisClient.get(uniqueDailyKey),
      redisClient.get(totalWindowKey),
      redisClient.get(totalDailyKey),
      redisClient.get(paginationKey)
    ]);
    
    return {
      uniqueSearches: {
        current: parseInt(uniqueCurrent || '0'),
        limit: RATE_LIMITS.uniqueSearches.limit,
        daily: parseInt(uniqueDaily || '0'),
        dailyLimit: RATE_LIMITS.uniqueSearches.dailyLimit
      },
      totalRequests: {
        current: parseInt(totalCurrent || '0'),
        limit: RATE_LIMITS.totalRequests.limit,
        daily: parseInt(totalDaily || '0'),
        dailyLimit: RATE_LIMITS.totalRequests.dailyLimit
      },
      pagination: {
        current: parseInt(paginationCurrent || '0'),
        limit: RATE_LIMITS.pagination.limit,
        window: RATE_LIMITS.pagination.window
      }
    };
  } catch (error) {
    console.warn('Error getting rate limit status:', error);
    return {
      uniqueSearches: { current: 0, limit: RATE_LIMITS.uniqueSearches.limit, daily: 0, dailyLimit: RATE_LIMITS.uniqueSearches.dailyLimit },
      totalRequests: { current: 0, limit: RATE_LIMITS.totalRequests.limit, daily: 0, dailyLimit: RATE_LIMITS.totalRequests.dailyLimit },
      pagination: { current: 0, limit: RATE_LIMITS.pagination.limit, window: RATE_LIMITS.pagination.window }
    };
  }
}
