import type { FullRoutePathResult } from '@/types/route';
import type { AvailabilityGroup } from '@/types/availability';
import { getAirportCityCode, isSameCity } from '@/lib/airports/city-groups';

export function prefilterValidRoutes(
  routes: FullRoutePathResult[],
  filteredSegmentPool: Record<string, AvailabilityGroup[]>
) {
  const allRoutes = routes;
  const validRoutes = allRoutes.filter(route => {
    const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
    if (codes.length < 2) return false;
    
    for (let i = 0; i < codes.length - 1; i++) {
      const from = codes[i];
      const to = codes[i + 1];
      if (!from || !to) return false;
      
      // Check for exact airport-to-airport segment
      const segKey = `${from}-${to}`;
      const availability = filteredSegmentPool[segKey];
      if (availability && availability.length > 0) {
        continue; // Found exact match, continue to next segment
      }
      
      // Check for city-based cross-airport connections
      const fromCity = getAirportCityCode(from);
      const toCity = getAirportCityCode(to);
      
      // Look for any segment that connects the same cities (cross-airport)
      let foundCityConnection = false;
      for (const [segmentKey, segmentAvailability] of Object.entries(filteredSegmentPool)) {
        if (!segmentAvailability || segmentAvailability.length === 0) continue;
        
        // Get the first flight to check origin/destination cities
        const firstFlight = segmentAvailability[0];
        if (!firstFlight) continue;
        
        const segmentFromCity = firstFlight.originCity;
        const segmentToCity = firstFlight.destinationCity;
        
        if (segmentFromCity === fromCity && segmentToCity === toCity) {
          foundCityConnection = true;
          break;
        }
      }
      
      if (!foundCityConnection) {
        return false; // No availability for this segment
      }
    }
    return true;
  });
  return { allRoutes, validRoutes };
}


