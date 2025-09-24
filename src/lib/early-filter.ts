import type { Airport } from '@/types/route';
import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getHaversineDistance } from '@/lib/route-helpers';

export function filterUnreliableSegments(
  segmentPool: Record<string, AvailabilityGroup[]>,
  reliability: Record<string, { min_count: number; exemption?: string }>,
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
          const airlineCodeOD = flight.FlightNumbers.slice(0, 2).toUpperCase();
          const relOD = reliability[airlineCodeOD];
          const minCountOD = relOD?.min_count ?? 1;
          const exemptionOD = relOD?.exemption || '';
          const minYOD = exemptionOD.includes('Y') ? 1 : minCountOD;
          const minWOD = exemptionOD.includes('W') ? 1 : minCountOD;
          const minJOD = exemptionOD.includes('J') ? 1 : minCountOD;
          const minFOD = exemptionOD.includes('F') ? 1 : minCountOD;
          const isReliableOD = (
            flight.YCount >= minYOD ||
            flight.WCount >= minWOD ||
            flight.JCount >= minJOD ||
            flight.FCount >= minFOD
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

        const airlineCode = flight.FlightNumbers.slice(0, 2).toUpperCase();
        const rel = reliability[airlineCode];
        const minCount = rel?.min_count ?? 1;
        const exemption = rel?.exemption || '';
        const minY = exemption.includes('Y') ? 1 : minCount;
        const minW = exemption.includes('W') ? 1 : minCount;
        const minJ = exemption.includes('J') ? 1 : minCount;
        const minF = exemption.includes('F') ? 1 : minCount;
        const isReliable = (
          flight.YCount >= minY ||
          flight.WCount >= minW ||
          flight.JCount >= minJ ||
          flight.FCount >= minF
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

export function isUnreliableFlight(
  flight: AvailabilityFlight,
  reliability: Record<string, { min_count: number; exemption?: string }>
) {
  const code = flight.FlightNumbers.slice(0, 2).toUpperCase();
  const rel = reliability[code];
  const min = rel?.min_count ?? 1;
  const exemption = rel?.exemption || '';
  const minY = exemption.includes('Y') ? 1 : min;
  const minW = exemption.includes('W') ? 1 : min;
  const minJ = exemption.includes('J') ? 1 : min;
  const minF = exemption.includes('F') ? 1 : min;
  return (
    (flight.YCount < minY) &&
    (flight.WCount < minW) &&
    (flight.JCount < minJ) &&
    (flight.FCount < minF)
  );
}

