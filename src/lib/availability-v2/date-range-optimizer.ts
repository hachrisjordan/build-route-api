import { generateDateRange } from './date-utils';
import { getCachedAvailabilityGroup } from './cache-helper';

/**
 * Get optimal date range for a single route based on cache availability
 * Returns first missing to last missing date strategy
 */
export async function getOptimalDateRangeForRoute(
  origin: string,
  destination: string,
  startDate: string,
  endDate: string
): Promise<{ start: string; end: string; needsFetch: boolean }> {
  const dates = generateDateRange(startDate, endDate);
  
  let firstMissing: string | null = null;
  let lastMissing: string | null = null;
  
  // Check each date in cache
  // null = not cached (needs fetch), [] = cached but empty (no fetch needed)
  for (const date of dates) {
    const cached = await getCachedAvailabilityGroup(origin, destination, date);
    
    if (cached === null) {
      // Not cached = needs fetch
      if (!firstMissing) {
        firstMissing = date;
      }
      lastMissing = date;
    }
    // If cached !== null (even if empty array), it's cached, so don't fetch
  }
  
  // All dates cached
  if (!firstMissing || !lastMissing) {
    return { start: startDate, end: endDate, needsFetch: false };
  }
  
  // Return range from first missing to last missing
  return {
    start: firstMissing,
    end: lastMissing,
    needsFetch: true
  };
}

/**
 * Calculate envelope date range for multiple routes
 * Returns the earliest start and latest end among all routes
 */
export function calculateEnvelopeDateRange(
  routeRanges: Array<{ start: string; end: string; needsFetch: boolean }>
): { start: string; end: string } {
  const fetchableRanges = routeRanges.filter(r => r.needsFetch);
  
  if (fetchableRanges.length === 0) {
    // All cached, return original range
    return { start: routeRanges[0].start, end: routeRanges[0].end };
  }
  
  // Find earliest start and latest end
  const starts = fetchableRanges.map(r => r.start);
  const ends = fetchableRanges.map(r => r.end);
  
  return {
    start: starts.sort()[0],
    end: ends.sort().reverse()[0]
  };
}

