import { pool } from '@/lib/pool';
import { getCachedAvailabilityV2Response, saveAvailabilityV2ResponseToCache } from '@/lib/cache';

export interface AvailabilityFetchParams {
  baseUrl: string;
  apiKey?: string | null;
  startDate: string;
  endDate: string;
  cabin?: string;
  carriers?: string;
  seats?: number;
  united?: boolean;
  concurrency: number;
}

export interface AvailabilityTaskResult {
  routeId: string;
  error: boolean;
  data: any;
}

export async function fetchAvailabilityForGroups(
  routeGroups: string[],
  params: AvailabilityFetchParams
): Promise<{ results: AvailabilityTaskResult[]; minRateLimitRemaining: number | null; minRateLimitReset: number | null }> {
  let minRateLimitRemaining: number | null = null;
  let minRateLimitReset: number | null = null;

  const availabilityTasks = routeGroups.map((routeId) => async () => {
    const bodyParams: Record<string, any> = {
      routeId,
      startDate: params.startDate,
      endDate: params.endDate,
      ...(params.cabin ? { cabin: params.cabin } : {}),
      ...(params.carriers ? { carriers: params.carriers } : {}),
      ...(params.seats ? { seats: params.seats } : {}),
      ...(params.united ? { united: params.united } : {}),
    };

    const cached = await getCachedAvailabilityV2Response(bodyParams);
    if (cached) {
      return { routeId, error: false, data: cached } as AvailabilityTaskResult;
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (typeof params.apiKey === 'string') {
        headers['partner-authorization'] = params.apiKey;
      }
      const res = await fetch(`${params.baseUrl}/api/availability-v2`, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyParams),
      });
      const rlRemaining = res.headers.get('x-ratelimit-remaining');
      const rlReset = res.headers.get('x-ratelimit-reset');
      if (rlRemaining !== null) {
        const val = parseInt(rlRemaining, 10);
        if (!isNaN(val)) {
          if (minRateLimitRemaining === null || val < minRateLimitRemaining) {
            minRateLimitRemaining = val;
          }
        }
      }
      if (rlReset !== null) {
        const val = parseInt(rlReset, 10);
        if (!isNaN(val)) {
          if (minRateLimitReset === null || val < minRateLimitReset) {
            minRateLimitReset = val;
          }
        }
      }
      if (!res.ok) {
        return { routeId, error: true, data: [] } as AvailabilityTaskResult;
      }
      const data = await res.json();
      await saveAvailabilityV2ResponseToCache(bodyParams, data);
      return { routeId, error: false, data } as AvailabilityTaskResult;
    } catch (err) {
      return { routeId, error: true, data: [] } as AvailabilityTaskResult;
    }
  });

  const results = await pool(availabilityTasks, params.concurrency);
  return { results, minRateLimitRemaining, minRateLimitReset };
}


