import type { Airport } from '@/types/route';
import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getHaversineDistance } from '@/lib/route-helpers';

export function filterUnreliableSegments(
  segmentPool: Record<string, AvailabilityGroup[]>,
  origin: string,
  destination: string,
  minReliabilityPercent: number,
  airportByIata: Record<string, Airport | null>,
  directDistanceMiles: number
): Record<string, AvailabilityGroup[]> {
  const filtered: Record<string, AvailabilityGroup[]> = {};
  for (const [segKey, groups] of Object.entries(segmentPool)) {
    const [segOrigin, segDestination] = segKey.split('-');
    const isOriginSegment = segOrigin === origin;
    const isDestinationSegment = segDestination === destination;
    const isOriginOrDestinationSegment = isOriginSegment || isDestinationSegment;

    const filteredGroups: AvailabilityGroup[] = [];
    for (const group of groups) {
      const filteredFlights: AvailabilityFlight[] = [];
      for (const flight of group.flights) {
        if (isOriginOrDestinationSegment) {
          const minReliability = Math.max(0, Math.min(100, minReliabilityPercent)) / 100;
          const maxUnreliableAllowed = (1 - minReliability) * directDistanceMiles * 2;
          const isReliableOD = (
            flight.YPartner ||
            flight.WPartner ||
            flight.JPartner ||
            flight.FPartner
          );
          if (!isReliableOD && typeof segOrigin === 'string' && typeof segDestination === 'string') {
            const oAp = airportByIata[segOrigin];
            const dAp = airportByIata[segDestination];
            if (oAp && dAp && typeof oAp.latitude === 'number' && typeof oAp.longitude === 'number' && typeof dAp.latitude === 'number' && typeof dAp.longitude === 'number') {
              const segDistance = getHaversineDistance(oAp.latitude, oAp.longitude, dAp.latitude, dAp.longitude);
              if (segDistance > maxUnreliableAllowed) {
                continue; // prune unreliable long segment
              }
            }
          }
          filteredFlights.push(flight);
          continue;
        }

        const isReliable = (
          flight.YPartner ||
          flight.WPartner ||
          flight.JPartner ||
          flight.FPartner
        );
        if (isReliable) filteredFlights.push(flight);
      }
      if (filteredFlights.length > 0) {
        filteredGroups.push({ ...group, flights: filteredFlights });
      }
    }
    if (filteredGroups.length > 0) {
      filtered[segKey] = filteredGroups;
    }
  }
  return filtered;
}

export function isUnreliableFlight(flight: AvailabilityFlight) {
  // A flight is unreliable only when ALL Partner fields are false
  return (
    !flight.YPartner &&
    !flight.WPartner &&
    !flight.JPartner &&
    !flight.FPartner
  );
}

