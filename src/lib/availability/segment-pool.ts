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
  }
): Map<string, PricingEntry> {
  const pricingPool = new Map<string, PricingEntry>();
  
  // Build valid airport pairings for early filtering
  const validPairings = new Set<string>();
  if (routeStructure?.airportList) {
    const { O = [], A = [], B = [], D = [] } = routeStructure.airportList;
    
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
    
    // Valid airport pairings prepared
  }
  
  for (const result of availabilityResults) {
    if (
      !result.error &&
      result.data &&
      typeof result.data === 'object' &&
      result.data !== null
    ) {
      // Process pricing data
      
      if (Array.isArray(result.data.pricing)) {
        for (const pricingEntry of result.data.pricing as PricingEntry[]) {
          // Early filtering: check if airport pairing is valid
          const airportPair = `${pricingEntry.departingAirport}-${pricingEntry.arrivingAirport}`;
          
          if (validPairings.size > 0 && !validPairings.has(airportPair)) {
            continue; // Filter out invalid airport pairings
          }
          
          pricingPool.set(pricingEntry.id, pricingEntry);
        }
      }
    }
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
  }
): {
  segmentPool: Record<string, AvailabilityGroup[]>;
  pricingPool: Map<string, PricingEntry>;
  pricingIndex: {
    byFlightNumber: Map<string, PricingEntry[]>;
    byRoute: Map<string, PricingEntry[]>;
    byFlightAndRoute: Map<string, PricingEntry[]>;
  };
} {
  const pricingPool = buildPricingPool(availabilityResults, routeStructure);
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
    const flightKey = entry.flightnumbers.toLowerCase();
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

  return { byFlightNumber, byRoute, byFlightAndRoute };
}


