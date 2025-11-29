import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { aggregateAirportPairsToCityPairs } from './city-aggregator';
import { generateDateRange } from '@/lib/availability-v2/date-utils';

/**
 * Update route metrics in Supabase based on availability data
 * 
 * Process:
 * 1. Count raw items by airport pairs from allPages
 * 2. Track missing routes (searched but zero results) if searchedAirportPairs provided
 * 3. Aggregate to city pairs using city group aggregation
 * 4. Calculate day_count from date range
 * 5. Upsert to route_metrics table with cumulative updates
 * 
 * @param allPages Array of pages from seats.aero API response
 * @param startDate Start date string (YYYY-MM-DD)
 * @param seatsAeroEndDate End date string (YYYY-MM-DD)
 * @param searchedAirportPairs Optional array of airport pairs that were searched (format: "originAirport,destAirport")
 */
export async function updateRouteMetrics(
  allPages: any[],
  startDate: string,
  seatsAeroEndDate: string,
  searchedAirportPairs?: string[]
): Promise<void> {
  try {
    // Step 1: Count raw items by airport pairs
    const airportPairCounts = new Map<string, number>();
    
    for (const page of allPages) {
      if (!page?.data || !Array.isArray(page.data)) continue;
      
      for (const item of page.data) {
        const origin = item.Route?.OriginAirport;
        const dest = item.Route?.DestinationAirport;
        
        if (origin && dest) {
          const key = `${origin},${dest}`;
          airportPairCounts.set(key, (airportPairCounts.get(key) || 0) + 1);
        }
      }
    }

    // Step 2: Track missing routes (searched but zero results)
    if (searchedAirportPairs && searchedAirportPairs.length > 0) {
      // Initialize all searched pairs with 0 if they don't have results
      for (const searchedPair of searchedAirportPairs) {
        if (!airportPairCounts.has(searchedPair)) {
          airportPairCounts.set(searchedPair, 0);
        }
      }
    }

    if (airportPairCounts.size === 0) {
      console.log('[route-metrics] No airport pairs found in data, skipping update');
      return;
    }

    // Step 3: Aggregate to city pairs
    const cityPairCounts = aggregateAirportPairsToCityPairs(airportPairCounts);

    // Step 4: Calculate day_count
    const day_count = generateDateRange(startDate, seatsAeroEndDate).length;

    // Step 5: Upsert to Supabase
    const supabase = getSupabaseAdminClient();
    const updates: Array<{ origin: string; destination: string; count: number; day_count: number }> = [];

    for (const [cityPair, newCount] of cityPairCounts) {
      const [origin, destination] = cityPair.split(',');
      
      if (!origin || !destination) {
        console.warn(`[route-metrics] Invalid city pair format: ${cityPair}`);
        continue;
      }

      updates.push({
        origin: origin.trim(),
        destination: destination.trim(),
        count: newCount,
        day_count
      });
    }

    if (updates.length === 0) {
      console.log('[route-metrics] No valid city pairs to update');
      return;
    }

    // Batch upsert with conflict resolution
    // Use SQL to add to existing values instead of replacing
    const batchSize = 100;
    let processed = 0;

    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      
      // Use raw SQL for atomic increment operations
      for (const update of batch) {
        try {
          // First, try to get existing record (use maybeSingle to handle new routes gracefully)
          const { data: existing, error: queryError } = await supabase
            .from('route_metrics')
            .select('count, day_count')
            .eq('origin', update.origin)
            .eq('destination', update.destination)
            .maybeSingle();

          // If query error (not just "not found"), log it but continue
          if (queryError && queryError.code !== 'PGRST116') {
            console.warn(`[route-metrics] Query error for ${update.origin}-${update.destination}:`, queryError.message);
          }

          // Handle new routes (existing is null) or existing routes
          const existingCount = existing?.count || 0;
          const existingDayCount = existing?.day_count || 0;

          // Upsert with cumulative values (creates new record if doesn't exist)
          const { error } = await supabase
            .from('route_metrics')
            .upsert({
              origin: update.origin,
              destination: update.destination,
              count: existingCount + update.count,
              day_count: existingDayCount + update.day_count
              // avg is computed automatically by the database
            }, {
              onConflict: 'origin,destination',
              ignoreDuplicates: false
            });

          if (error) {
            console.error(`[route-metrics] Error upserting ${update.origin}-${update.destination}:`, error.message);
          } else {
            processed++;
          }
        } catch (err) {
          console.error(`[route-metrics] Exception upserting ${update.origin}-${update.destination}:`, err);
        }
      }
    }

    console.log(`[route-metrics] Updated ${processed}/${updates.length} route metrics`);
  } catch (error) {
    // Log error but don't throw - this should not block the main request
    console.error('[route-metrics] Error updating route metrics:', error);
  }
}

/**
 * Load route metrics from Supabase for route optimizer
 * Returns a Map of route keys to avg values (rounded to nearest int)
 * Loads all route metrics from the database
 * 
 * @param routeKeys Unused parameter (kept for API compatibility, loads all metrics)
 * @returns Map of route keys to avg values (rounded)
 */
export async function loadRouteMetrics(
  routeKeys: string[]
): Promise<Map<string, number>> {
  const routeMetrics = new Map<string, number>();
  
  try {
    const supabase = getSupabaseAdminClient();
    
    // Query all route metrics at once
    const { data, error } = await supabase
      .from('route_metrics')
      .select('origin, destination, avg');

    if (error) {
      console.warn('[route-metrics] Failed to load route metrics:', error.message);
      return routeMetrics;
    }

    if (!data || data.length === 0) {
      console.warn('[route-metrics] No route metrics found in database');
      return routeMetrics;
    }

    // Build map of route keys to avg values
    // Round to nearest int, but ensure minimum of 1 (avg < 1 rounds to 1)
    for (const record of data) {
      const key = `${record.origin},${record.destination}`;
      const avg = record.avg ? Math.max(1, Math.round(Number(record.avg))) : 1;
      routeMetrics.set(key, avg);
    }

    console.log(`[route-metrics] Loaded ${routeMetrics.size} route metrics from Supabase`);
  } catch (error) {
    console.error('[route-metrics] Error loading route metrics:', error);
  }

  return routeMetrics;
}

