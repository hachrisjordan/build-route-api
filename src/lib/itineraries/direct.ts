import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getFlightUUID } from '@/lib/itineraries/ids';
import { initializeCityGroups, getAirportCityCode, isSameCity, isCityCode, getCityAirports } from '@/lib/airports/city-groups';

export async function buildDirectItineraries(
  origin: string,
  destination: string,
  filteredSegmentPool: Record<string, AvailabilityGroup[]>,
  flightMap: Map<string, AvailabilityFlight>
): Promise<Record<string, Record<string, string[][]>>> {
  await initializeCityGroups();
  
  const output: Record<string, Record<string, string[][]>> = {};
  
  // Build acceptable origin/destination airport sets from slash-separated inputs and city codes
  const originCodes = origin.split('/').map(s => s.trim().toUpperCase()).filter(Boolean);
  const destinationCodes = destination.split('/').map(s => s.trim().toUpperCase()).filter(Boolean);
  const acceptableOriginAirports = new Set<string>();
  const acceptableDestinationAirports = new Set<string>();
  
  for (const code of originCodes) {
    const airports = isCityCode(code) ? getCityAirports(code) : [code];
    airports.forEach(a => acceptableOriginAirports.add(a));
  }
  for (const code of destinationCodes) {
    const airports = isCityCode(code) ? getCityAirports(code) : [code];
    airports.forEach(a => acceptableDestinationAirports.add(a));
  }
  
  for (const [segKey, groups] of Object.entries(filteredSegmentPool)) {
    const [segOrigin, segDestination] = segKey.split('-');
    
    // Check against expanded airport sets instead of exact string comparison
    const originMatches = segOrigin ? acceptableOriginAirports.has(segOrigin) : false;
    const destinationMatches = segDestination ? acceptableDestinationAirports.has(segDestination) : false;
    
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


