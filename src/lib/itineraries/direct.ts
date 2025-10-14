import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getFlightUUID } from '@/lib/itineraries/ids';
import { initializeCityGroups, getAirportCityCode, isSameCity } from '@/lib/airports/city-groups';

export async function buildDirectItineraries(
  origin: string,
  destination: string,
  filteredSegmentPool: Record<string, AvailabilityGroup[]>,
  flightMap: Map<string, AvailabilityFlight>
): Promise<Record<string, string[][]>> {
  await initializeCityGroups();
  
  const output: Record<string, Record<string, string[][]>> = {};
  for (const [segKey, groups] of Object.entries(filteredSegmentPool)) {
    const [segOrigin, segDestination] = segKey.split('-');
    
    // Check if this segment matches the origin/destination (handling city codes)
    const originMatches = segOrigin === origin || isSameCity(segOrigin, origin);
    const destinationMatches = segDestination === destination || isSameCity(segDestination, destination);
    
    if (!originMatches || !destinationMatches) continue;
    const routeKey = segKey;
    if (!output[routeKey]) output[routeKey] = {};
    for (const group of groups) {
      const date = group.date;
      if (!output[routeKey][date]) output[routeKey][date] = [];
      for (const flight of group.flights) {
        const uuid = getFlightUUID(flight);
        flightMap.set(uuid, flight);
        output[routeKey][date].push([uuid]);
      }
    }
  }
  return output;
}


