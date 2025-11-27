import { getAirportCityCode } from '@/lib/airports/city-groups';

/**
 * Aggregates airport pair counts to city pair counts
 * 
 * Example:
 * - Input: "LHR,JFK" → 10, "LGW,JFK" → 5, "EWR,LHR" → 8, "JFK,LHR" → 3
 * - Output: "LON,JFK" → 15 (LHR-JFK + LGW-JFK), "NYC,LON" → 11 (EWR-LHR + JFK-LHR)
 * 
 * @param airportPairCounts Map of airport pairs to counts (format: "originAirport,destAirport" → count)
 * @returns Map of city pairs to aggregated counts (format: "originCity,destCity" → aggregated count)
 */
export function aggregateAirportPairsToCityPairs(
  airportPairCounts: Map<string, number>
): Map<string, number> {
  const cityPairCounts = new Map<string, number>();

  for (const [airportPair, count] of airportPairCounts) {
    const [originAirport, destAirport] = airportPair.split(',');
    
    if (!originAirport || !destAirport) {
      console.warn(`[city-aggregator] Invalid airport pair format: ${airportPair}`);
      continue;
    }

    // Normalize airports to city codes (or keep airport code if not in city group)
    const originCity = getAirportCityCode(originAirport.trim());
    const destCity = getAirportCityCode(destAirport.trim());
    
    // Create city pair key
    const cityKey = `${originCity},${destCity}`;
    
    // Sum counts for routes that map to the same city pair
    cityPairCounts.set(cityKey, (cityPairCounts.get(cityKey) || 0) + count);
  }

  return cityPairCounts;
}

