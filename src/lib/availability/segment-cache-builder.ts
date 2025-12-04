import { getCachedAvailabilityGroup, getCachedPricingGroup } from '@/lib/availability-v2/cache-helper';
import { generateDateRange } from '@/lib/availability-v2/date-utils';
import type { GroupedResult, PricingEntry } from '@/types/availability-v2';
import type { AvailabilityTaskResult } from '@/lib/availability/fetch';

/**
 * Build availability results from segment-level cache for fully cached routes
 * @param cachedRoutes Array of route strings like "ORD-AUH"
 * @param startDate Start date string (YYYY-MM-DD)
 * @param endDate End date string (YYYY-MM-DD)
 * @param seatsAeroEndDate End date for seats.aero (typically endDate + 3 days)
 * @param binbin Whether to include pricing data
 * @returns Array of AvailabilityTaskResult matching fetchAvailabilityForGroups output format
 */
export async function buildAvailabilityResultsFromSegmentCache(
  cachedRoutes: string[],
  startDate: string,
  endDate: string,
  seatsAeroEndDate: string,
  binbin: boolean
): Promise<AvailabilityTaskResult[]> {
  if (cachedRoutes.length === 0) {
    return [];
  }

  console.log(`[segment-cache-builder] Building availability results from segment cache for ${cachedRoutes.length} routes`);

  const results: AvailabilityTaskResult[] = [];
  const dates = generateDateRange(startDate, seatsAeroEndDate);

  // Process all routes in parallel for better performance
  // This was previously sequential, causing ~17s delay for 387 routes
  const routePromises = cachedRoutes.map(async (route) => {
    const [origin, destination] = route.split('-');
    
    if (!origin || !destination) {
      console.warn(`[segment-cache-builder] Invalid route format: ${route}, skipping`);
      return null;
    }

    // Collect all groups and pricing entries for this route across all dates
    const groups: GroupedResult[] = [];
    const pricingEntries: PricingEntry[] = [];
    let missingCacheCount = 0;

    // Fetch availability and pricing for each date in parallel
    const cachePromises = dates.map(async (date) => {
      const [availabilityGroups, pricingData] = await Promise.all([
        getCachedAvailabilityGroup(origin, destination, date),
        binbin ? getCachedPricingGroup(origin, destination, date) : Promise.resolve(null)
      ]);

      return { date, availabilityGroups, pricingData };
    });

    const cacheResults = await Promise.all(cachePromises);

    // Process cache results
    for (const { date, availabilityGroups, pricingData } of cacheResults) {
      // Handle availability groups
      if (availabilityGroups === null) {
        missingCacheCount++;
        // Silent warning - only log if significant number missing
        if (missingCacheCount === dates.length) {
          console.warn(`[segment-cache-builder] Missing all availability cache for ${route}`);
        }
      } else if (availabilityGroups.length > 0) {
        // Add groups with date information if needed
        groups.push(...availabilityGroups);
      }

      // Handle pricing data if binbin is enabled
      if (binbin && pricingData !== null && pricingData.length > 0) {
        pricingEntries.push(...pricingData);
      }
    }

    // Build result in the format expected by AvailabilityTaskResult
    const result: AvailabilityTaskResult = {
      routeId: route,
      error: false,
      data: {
        groups: groups,
        pricing: binbin && pricingEntries.length > 0 ? pricingEntries : undefined,
        seatsAeroRequests: 0 // All from cache, no HTTP requests
      }
    };

    return result;
  });

  // Wait for all routes to be processed in parallel
  const routeResults = await Promise.all(routePromises);
  
  // Filter out null results (invalid routes)
  for (const result of routeResults) {
    if (result !== null) {
      results.push(result);
    }
  }

  const totalGroups = results.reduce((sum, r) => sum + (r.data?.groups?.length || 0), 0);
  const totalPricing = results.reduce((sum, r) => sum + (r.data?.pricing?.length || 0), 0);
  
  console.log(`[segment-cache-builder] Built ${results.length} route results: ${totalGroups} groups, ${totalPricing} pricing entries`);

  return results;
}

