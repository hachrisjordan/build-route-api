import type { AvailabilityGroup } from '@/types/availability';
import type { PricingEntry } from '@/types/availability-v2';

export function buildSegmentPool(availabilityResults: Array<{ error: boolean; data: any }>): Record<string, AvailabilityGroup[]> {
  const segmentPool: Record<string, AvailabilityGroup[]> = {};
  for (const result of availabilityResults) {
    if (
      !result.error &&
      result.data &&
      typeof result.data === 'object' &&
      result.data !== null &&
      Array.isArray(result.data.groups)
    ) {
      for (const group of result.data.groups as any[]) {
        // Convert GroupedResult to AvailabilityGroup format
        // Add airport information to each flight
        const flightsWithAirports = group.flights.map((flight: any) => ({
          ...flight,
          originAirport: group.originAirport,
          destinationAirport: group.destinationAirport,
          originCity: group.originCity,
          destinationCity: group.destinationCity,
        }));

        const availabilityGroup: AvailabilityGroup = {
          originAirport: group.originAirport,
          destinationAirport: group.destinationAirport,
          originCity: group.originCity,
          destinationCity: group.destinationCity,
          date: group.date,
          alliance: group.alliance,
          flights: flightsWithAirports,
          earliestDeparture: group.earliestDeparture,
          latestDeparture: group.latestDeparture,
          earliestArrival: group.earliestArrival,
          latestArrival: group.latestArrival,
        };
        
        const segKey = `${group.originAirport}-${group.destinationAirport}`;
        if (!segmentPool[segKey]) segmentPool[segKey] = [];
        segmentPool[segKey].push(availabilityGroup);
      }
    }
  }
  return segmentPool;
}

/**
 * Builds a pricing pool from availability results with early filtering
 * Only includes pricing entries that match valid O→A, A→B, B→D airport pairings
 * For direct flights (maxStop === 0) or when route structure is invalid, includes all pricing entries
 * Returns a Map of pricing entry ID to PricingEntry for fast lookup
 */
export function buildPricingPool(
  availabilityResults: Array<{ error: boolean; data: any }>,
  routeStructure?: {
    airportList?: {
      O?: string[];
      A?: string[];
      B?: string[];
      D?: string[];
    };
  },
  maxStop?: number
): Map<string, PricingEntry> {
  const pricingPool = new Map<string, PricingEntry>();
  
  // For direct flights (maxStop === 0), never apply filtering regardless of route structure
  // The route structure might still have A/B airports even for direct flights
  if (maxStop === 0) {
    // Collect all pricing entries without filtering
    for (const result of availabilityResults) {
      if (
        !result.error &&
        result.data &&
        typeof result.data === 'object' &&
        result.data !== null
      ) {
        if (Array.isArray(result.data.pricing)) {
          for (const pricingEntry of result.data.pricing as PricingEntry[]) {
            pricingPool.set(pricingEntry.id, pricingEntry);
          }
        }
      }
    }
    console.log(`[buildPricingPool] Direct flights (maxStop=0): Included all ${pricingPool.size} pricing entries without filtering`);
    return pricingPool;
  }
  
  // Build valid airport pairings for early filtering
  // Only apply filtering if we have a valid multi-segment route structure (O→A→B→D)
  const validPairings = new Set<string>();
  let shouldApplyFiltering = false;
  
  if (routeStructure?.airportList) {
    const { O = [], A = [], B = [], D = [] } = routeStructure.airportList;
    
    // Check if we have a valid multi-segment route structure
    // For direct flights, O/A/B/D might be empty or incomplete
    const hasO = O.length > 0;
    const hasA = A.length > 0;
    const hasB = B.length > 0;
    const hasD = D.length > 0;
    
    // Only apply filtering if we have at least O→A or A→B or B→D segments
    // This indicates a multi-segment route, not a direct flight
    if ((hasO && hasA) || (hasA && hasB) || (hasB && hasD)) {
      shouldApplyFiltering = true;
      
      // O → A pairings
      for (const origin of O) {
        for (const dest of A) {
          validPairings.add(`${origin}-${dest}`);
        }
      }
      
      // A → B pairings  
      for (const origin of A) {
        for (const dest of B) {
          validPairings.add(`${origin}-${dest}`);
        }
      }
      
      // B → D pairings
      for (const origin of B) {
        for (const dest of D) {
          validPairings.add(`${origin}-${dest}`);
        }
      }
    }
  }
  
  // Collect all pricing entries first
  const allPricingEntries: PricingEntry[] = [];
  for (const result of availabilityResults) {
    if (
      !result.error &&
      result.data &&
      typeof result.data === 'object' &&
      result.data !== null
    ) {
      // Process pricing data
      if (Array.isArray(result.data.pricing)) {
        allPricingEntries.push(...(result.data.pricing as PricingEntry[]));
      }
    }
  }
  
  // Apply filtering only if we have a valid multi-segment route structure
  if (shouldApplyFiltering && validPairings.size > 0) {
    // Filter pricing entries based on valid pairings
    for (const pricingEntry of allPricingEntries) {
      const airportPair = `${pricingEntry.departingAirport}-${pricingEntry.arrivingAirport}`;
      
      if (validPairings.has(airportPair)) {
        pricingPool.set(pricingEntry.id, pricingEntry);
      }
    }
    
    console.log(`[buildPricingPool] Applied O→A, A→B, B→D filtering: ${pricingPool.size} pricing entries from ${allPricingEntries.length} total`);
  } else {
    // For direct flights or when route structure is invalid/incomplete, include all pricing entries
    for (const pricingEntry of allPricingEntries) {
      pricingPool.set(pricingEntry.id, pricingEntry);
    }
    
    if (allPricingEntries.length > 0) {
      console.log(`[buildPricingPool] No filtering applied (direct flight or invalid route structure): ${pricingPool.size} pricing entries included`);
    }
  }
  
  // Fallback: If pricing pool is empty but we have pricing data, log a warning
  if (pricingPool.size === 0 && allPricingEntries.length > 0) {
    console.warn(`[buildPricingPool] Warning: Pricing pool is empty but ${allPricingEntries.length} pricing entries were found. This may indicate a filtering issue.`);
    // Include all pricing entries as fallback
    for (const pricingEntry of allPricingEntries) {
      pricingPool.set(pricingEntry.id, pricingEntry);
    }
    console.log(`[buildPricingPool] Fallback: Added all ${pricingPool.size} pricing entries to pool`);
  }
  
  return pricingPool;
}

/**
 * Enhanced function that builds both segment pool and pricing pool with early filtering
 */
export function buildSegmentAndPricingPools(
  availabilityResults: Array<{ error: boolean; data: any }>,
  routeStructure?: {
    airportList?: {
      O?: string[];
      A?: string[];
      B?: string[];
      D?: string[];
    };
  },
  maxStop?: number
): {
  segmentPool: Record<string, AvailabilityGroup[]>;
  pricingPool: Map<string, PricingEntry>;
  pricingIndex: {
    byFlightNumber: Map<string, PricingEntry[]>;
    byRoute: Map<string, PricingEntry[]>;
    byFlightAndRoute: Map<string, PricingEntry[]>;
  };
} {
  const pricingPool = buildPricingPool(availabilityResults, routeStructure, maxStop);
  return {
    segmentPool: buildSegmentPool(availabilityResults),
    pricingPool,
    pricingIndex: buildPricingIndex(pricingPool)
  };
}

export function buildPricingIndex(pricingPool: Map<string, PricingEntry>): {
  byFlightNumber: Map<string, PricingEntry[]>;
  byRoute: Map<string, PricingEntry[]>;
  byFlightAndRoute: Map<string, PricingEntry[]>;
} {
  const byFlightNumber = new Map<string, PricingEntry[]>();
  const byRoute = new Map<string, PricingEntry[]>();
  const byFlightAndRoute = new Map<string, PricingEntry[]>();

  for (const entry of pricingPool.values()) {
    const flightKey = entry.flightnumbers.toLowerCase().trim();
    const routeKey = `${entry.departingAirport}-${entry.arrivingAirport}`;
    const combinedKey = `${flightKey}:${routeKey}`;

    // Index by flight number
    if (!byFlightNumber.has(flightKey)) {
      byFlightNumber.set(flightKey, []);
    }
    byFlightNumber.get(flightKey)!.push(entry);

    // Index by route
    if (!byRoute.has(routeKey)) {
      byRoute.set(routeKey, []);
    }
    byRoute.get(routeKey)!.push(entry);

    // Index by flight + route (most specific)
    if (!byFlightAndRoute.has(combinedKey)) {
      byFlightAndRoute.set(combinedKey, []);
    }
    byFlightAndRoute.get(combinedKey)!.push(entry);
  }

  // Debug logging for pricing index
  if (pricingPool.size > 0) {
    console.log(`[buildPricingIndex] Built index: ${byFlightAndRoute.size} unique flight+route combinations from ${pricingPool.size} pricing entries`);
    // Log a few sample keys for debugging
    const sampleKeys = Array.from(byFlightAndRoute.keys()).slice(0, 3);
    if (sampleKeys.length > 0) {
      console.log(`[buildPricingIndex] Sample keys: ${sampleKeys.join(', ')}`);
    }
  }

  return { byFlightNumber, byRoute, byFlightAndRoute };
}


