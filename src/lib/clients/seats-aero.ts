import { SeatsAeroClient, PaginateSearchResult } from '@/types/availability-v2';
import https from 'https';
import { URL } from 'url';
import { initializeDnsCache } from '@/lib/http/dns-cache';

// Initialize DNS caching for production (reduces DNS lookup overhead)
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
  initializeDnsCache();
}

// Global HTTPS agent with keepAlive for connection pooling
// This dramatically improves performance in production by reusing TCP connections
// Production performance issue: Without keepAlive, each request creates a new TCP connection
// which adds ~100-500ms overhead per request. With 50 concurrent requests, this compounds.
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000, // Send keepalive probe after 30s of inactivity
  maxSockets: 100, // Max concurrent connections per host (increased for high concurrency)
  maxFreeSockets: 20, // Max idle connections to keep open (increased for better reuse)
  timeout: 60000, // Socket timeout
  scheduling: 'fifo' as const,
});

// Configure global agent defaults for better connection reuse
// This affects all HTTPS requests in the process
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production') {
  https.globalAgent = httpsAgent;
}

// Use undici for better performance if available (Node.js 18+)
// Undici has superior connection pooling and HTTP/2 support
let customFetch: typeof fetch;
let useUndici = false;

try {
  // Try to use undici (Node.js 18+ built-in, better connection pooling)
  // @ts-ignore - undici may not be in types
  const undici = require('undici');
  
  if (undici && undici.fetch && undici.Agent) {
    // Create undici agent with optimized connection pooling
    const undiciAgent = new undici.Agent({
      connections: 100, // Max concurrent connections per origin
      pipelining: 0, // HTTP/1.1 pipelining (0 = disabled for compatibility)
      keepAliveTimeout: 30000, // Keep connections alive for 30s
      keepAliveMaxTimeout: 60000, // Max time to keep connection alive
      tls: {
        rejectUnauthorized: true,
      },
    });

    customFetch = (url: string | URL | Request, init?: RequestInit) => {
      return undici.fetch(url, {
        ...init,
        dispatcher: undiciAgent,
      });
    };
    useUndici = true;
    console.log('[seats-aero] Using undici with connection pooling for optimal performance');
  } else {
    throw new Error('undici not available');
  }
} catch (e) {
  // Fallback: Use native fetch with global agent (Node.js 18+ uses undici internally)
  // The global https agent will be used automatically
  customFetch = fetch;
  console.log('[seats-aero] Using native fetch with global HTTPS agent keepAlive');
}

export function createSeatsAeroClient(apiKey: string): SeatsAeroClient {
  const isProduction = process.env.NODE_ENV === 'production';
  
  return {
    fetch: (url: string, init?: RequestInit) => {
      const startTime = isProduction ? Date.now() : undefined;
      const headers = {
        ...init?.headers,
        accept: 'application/json',
        'Partner-Authorization': apiKey,
        'Connection': 'keep-alive', // Explicitly request keep-alive
      };
      
      // For native fetch, we can't directly set agent, but global agent will be used
      // For undici, the dispatcher is already set in customFetch
      const fetchPromise = customFetch(url, { ...init, headers });
      
      // Log slow requests in production for diagnostics
      if (isProduction && startTime) {
        fetchPromise
          .then(() => {
            const duration = Date.now() - startTime;
            if (duration > 5000) {
              // Log requests taking more than 5 seconds
              console.warn(`[seats-aero] Slow request: ${duration}ms for ${new URL(url).pathname}`);
            }
          })
          .catch(() => {
            // Ignore errors in logging
          });
      }
      
      return fetchPromise;
    },
  };
}

function buildUrl(baseUrl: string, params: Record<string, string | number>) {
  const sp = new URLSearchParams(params as any);
  return `${baseUrl}${sp.toString()}`;
}

// Timeout configuration
// Increased for production network conditions (higher latency, slower DNS)
// Production shows 3-4x slower fetch times, so we need more generous timeouts
const FIRST_PAGE_TIMEOUT = process.env.NODE_ENV === 'production' ? 60000 : 30000; // 60s prod, 30s dev
const SUBSEQUENT_PAGE_TIMEOUT = process.env.NODE_ENV === 'production' ? 45000 : 20000; // 45s prod, 20s dev
const RETRY_TIMEOUT = 20000; // 20 seconds for retry (increased from 15s)

// Retry configuration (disabled by default)
const RETRY_CONFIG = {
  FIRST_PAGE_RETRY: false,
};

/**
 * Creates an AbortController with timeout
 */
function createTimeoutSignal(timeout: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  return { signal: controller.signal, cleanup: () => clearTimeout(timeoutId) };
}

/**
 * Fetches with timeout protection
 */
async function fetchWithTimeout(
  client: SeatsAeroClient,
  url: string,
  timeout: number,
  isFirstPage: boolean,
  retryOnTimeout: boolean = false
): Promise<Response | null> {
  const { signal, cleanup } = createTimeoutSignal(timeout);
  
  try {
    const res = await client.fetch(url, { signal });
    cleanup();
    return res;
  } catch (err: any) {
    cleanup();
    
    if (err.name === 'AbortError') {
      // Timeout occurred
      if (isFirstPage && retryOnTimeout) {
        // Single retry for first page only
        console.warn(`[PERF] First page timeout, retrying with shorter timeout...`);
        const { signal: retrySignal, cleanup: retryCleanup } = createTimeoutSignal(RETRY_TIMEOUT);
        try {
          const retryRes = await client.fetch(url, { signal: retrySignal });
          retryCleanup();
          return retryRes;
        } catch (retryErr: any) {
          retryCleanup();
          if (retryErr.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeout}ms + ${RETRY_TIMEOUT}ms retry`);
          }
          throw retryErr;
        }
      } else if (isFirstPage) {
        // First page timeout, no retry - fail immediately
        throw new Error(`First page request timeout after ${timeout}ms`);
      } else {
        // Subsequent page timeout - return null to signal graceful stop
        console.warn(`[PERF] Page timeout after ${timeout}ms, stopping pagination`);
        return null; // Signal to stop pagination
      }
    }
    throw err;
  }
}

export async function paginateSearch(
  client: SeatsAeroClient,
  baseUrl: string,
  baseParams: Record<string, string>,
  maxPages: number,
  onPageReceived?: (page: any, pageIndex: number) => void
): Promise<PaginateSearchResult> {
  let requestCount = 0;
  let lastResponse: Response | null = null;
  const pages: any[] = [];

  // First page (critical - fail if this times out)
  const firstUrl = buildUrl(baseUrl, { ...baseParams });
  
  try {
    const firstRes = await fetchWithTimeout(
      client,
      firstUrl,
      FIRST_PAGE_TIMEOUT,
      true,
      RETRY_CONFIG.FIRST_PAGE_RETRY
    );
    
    if (!firstRes) {
      throw new Error('First page request failed');
    }
    
    requestCount++;
    lastResponse = firstRes;
    
    if (!firstRes.ok) {
      return { pages, requestCount, lastResponse, rateLimit: { remaining: null, reset: null } };
    }
    
    const firstData = await firstRes.json();
    pages.push(firstData);
    
    // Call callback if provided for incremental processing
    if (onPageReceived) {
      onPageReceived(firstData, 0);
    }

    let hasMore: boolean = firstData.hasMore || false;
    // Get cursor from first page - this stays the SAME for all subsequent pages
    const cursor: string | null = firstData.cursor || null;
    
    // Get take value from baseParams (default 1000)
    const takeValue = parseInt(baseParams.take || '1000', 10);

    // Subsequent pages (graceful degradation on timeout)
    // We already have 1 page, so we can fetch maxPages - 1 more pages
    let pageCount = 0;
    const maxAdditionalPages = maxPages - 1; // Subtract 1 because we already fetched the first page
    
    if (hasMore && maxAdditionalPages > 0) {
      while (hasMore && pageCount < maxAdditionalPages) {
        pageCount++;
        // According to seats.aero API docs: Use BOTH cursor AND skip together
        // - cursor: stays the same from first response (maintains consistent ordering)
        // - skip: increments by take value (skip=1000, skip=2000, skip=3000, etc.)
        const skipValue = pageCount * takeValue;
        const params: Record<string, string> = { ...baseParams, skip: skipValue.toString() };
        
        // Add cursor if we have it (from first page response)
        if (cursor) {
          params.cursor = cursor;
        }
        
        const url = buildUrl(baseUrl, params);
        
        try {
          const res = await fetchWithTimeout(
            client,
            url,
            SUBSEQUENT_PAGE_TIMEOUT,
            false,
            false
          );
          
          // Check if timeout returned null (graceful stop)
          if (!res) {
            console.warn(`[PERF] Stopping pagination at page ${pageCount + 1} (page ${pageCount} after first) due to timeout. Returning ${pages.length} pages collected.`);
            break; // Stop pagination, return what we have
          }
          
          requestCount++;
          if (!res.ok) {
            break; // API error, stop pagination
          }
          
          const data = await res.json();
          pages.push(data);
          
          // Call callback if provided for incremental processing
          if (onPageReceived) {
            onPageReceived(data, pageCount);
          }
          
          hasMore = data.hasMore || false;
          // Note: cursor stays the same from first page - we don't update it
          // The cursor from first response is used for ALL subsequent pages
          lastResponse = res;
        } catch (err: any) {
          // Non-timeout errors - log and stop
          console.error(`[PERF] Error fetching page ${pageCount + 1} (page ${pageCount} after first):`, err.message);
          break;
        }
      }
    }

    const remaining = lastResponse?.headers?.get('x-ratelimit-remaining') ?? null;
    const reset = lastResponse?.headers?.get('x-ratelimit-reset') ?? null;

    return { pages, requestCount, lastResponse, rateLimit: { remaining, reset } };
  } catch (err: any) {
    // First page failed - propagate error
    throw err;
  }
}


