import { SeatsAeroClient, PaginateSearchResult } from '@/types/availability-v2';

export function createSeatsAeroClient(apiKey: string): SeatsAeroClient {
  return {
    fetch: (url: string, init?: RequestInit) => {
      const headers = {
        ...init?.headers,
        accept: 'application/json',
        'Partner-Authorization': apiKey,
      };
      return fetch(url, { ...init, headers });
    },
  };
}

function buildUrl(baseUrl: string, params: Record<string, string | number>) {
  const sp = new URLSearchParams(params as any);
  return `${baseUrl}${sp.toString()}`;
}

// Timeout configuration
const FIRST_PAGE_TIMEOUT = 30000; // 30 seconds
const SUBSEQUENT_PAGE_TIMEOUT = 20000; // 20 seconds
const RETRY_TIMEOUT = 15000; // 15 seconds for retry

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
    let cursor: string | null = firstData.cursor || null;

    // Subsequent pages (graceful degradation on timeout)
    let pageCount = 0;
    if (hasMore) {
      while (hasMore && pageCount < maxPages) {
        pageCount++;
        const params = cursor ? { ...baseParams, cursor } : { ...baseParams, skip: pageCount * 1000 };
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
            console.warn(`[PERF] Stopping pagination at page ${pageCount} due to timeout. Returning ${pages.length} pages collected.`);
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
          cursor = data.cursor || cursor;
          lastResponse = res;
        } catch (err: any) {
          // Non-timeout errors - log and stop
          console.error(`[PERF] Error fetching page ${pageCount}:`, err.message);
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


