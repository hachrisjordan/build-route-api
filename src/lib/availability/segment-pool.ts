import type { AvailabilityGroup } from '@/types/availability';

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


