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

export async function paginateSearch(
  client: SeatsAeroClient,
  baseUrl: string,
  baseParams: Record<string, string>,
  maxPages: number
): Promise<PaginateSearchResult> {
  let requestCount = 0;
  let lastResponse: Response | null = null;
  const pages: any[] = [];

  // First page
  const firstUrl = buildUrl(baseUrl, { ...baseParams });
  const firstRes = await client.fetch(firstUrl);
  requestCount++;
  lastResponse = firstRes;
  if (!firstRes.ok) {
    return { pages, requestCount, lastResponse, rateLimit: { remaining: null, reset: null } };
  }
  const firstData = await firstRes.json();
  pages.push(firstData);

  let hasMore: boolean = firstData.hasMore || false;
  let cursor: string | null = firstData.cursor || null;

  // Prefer skip pagination if available; otherwise cursor
  let pageCount = 0;
  if (hasMore) {
    while (hasMore && pageCount < maxPages) {
      pageCount++;
      const params = cursor ? { ...baseParams, cursor } : { ...baseParams, skip: pageCount * 1000 };
      const url = buildUrl(baseUrl, params);
      const res = await client.fetch(url);
      requestCount++;
      if (!res.ok) break;
      const data = await res.json();
      pages.push(data);
      hasMore = data.hasMore || false;
      cursor = data.cursor || cursor;
      lastResponse = res;
    }
  }

  const remaining = lastResponse?.headers?.get('x-ratelimit-remaining') ?? null;
  const reset = lastResponse?.headers?.get('x-ratelimit-reset') ?? null;

  return { pages, requestCount, lastResponse, rateLimit: { remaining, reset } };
}


