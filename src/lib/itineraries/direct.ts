import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getFlightUUID } from '@/lib/itineraries/ids';

export function buildDirectItineraries(
  origin: string,
  destination: string,
  filteredSegmentPool: Record<string, AvailabilityGroup[]>,
  flightMap: Map<string, AvailabilityFlight>
): Record<string, string[][]> {
  const output: Record<string, Record<string, string[][]>> = {};
  for (const [segKey, groups] of Object.entries(filteredSegmentPool)) {
    const [segOrigin, segDestination] = segKey.split('-');
    if (segOrigin !== origin || segDestination !== destination) continue;
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


