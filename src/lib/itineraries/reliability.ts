import type { AvailabilityFlight } from '@/types/availability';

export function filterReliableItineraries(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Map<string, AvailabilityFlight>,
  minReliabilityPercent: number,
  isUnreliableFlight: (f: AvailabilityFlight) => boolean
) {
  const filtered: Record<string, Record<string, string[][]>> = {};
  const usedFlightUUIDs = new Set<string>();
  for (const routeKey of Object.keys(itineraries)) {
    const routeItineraries = itineraries[routeKey];
    if (!routeItineraries) continue;
    for (const date of Object.keys(routeItineraries)) {
      const dateItineraries = routeItineraries[date];
      if (!dateItineraries) continue;
      const keptItins: string[][] = [];
      for (const itin of dateItineraries) {
        const flightsArr = itin.map(uuid => flights.get(uuid)).filter(Boolean) as AvailabilityFlight[];
        if (!flightsArr.length) continue;
        const totalDuration = flightsArr.reduce((sum, f) => sum + f.TotalDuration, 0);
        const unreliableDuration = flightsArr.filter(f => isUnreliableFlight(f)).reduce((sum, f) => sum + f.TotalDuration, 0);
        if (unreliableDuration === 0) {
          keptItins.push(itin);
          itin.forEach(uuid => usedFlightUUIDs.add(uuid));
          continue;
        }
        if (totalDuration === 0) continue;
        const unreliablePct = (unreliableDuration / totalDuration) * 100;
        if (unreliablePct <= (100 - minReliabilityPercent)) {
          keptItins.push(itin);
          itin.forEach(uuid => usedFlightUUIDs.add(uuid));
        }
      }
      if (keptItins.length) {
        if (!filtered[routeKey]) filtered[routeKey] = {};
        filtered[routeKey][date] = keptItins;
      }
    }
  }
  for (const uuid of Array.from(flights.keys())) {
    if (!usedFlightUUIDs.has(uuid)) {
      flights.delete(uuid);
    }
  }
  return filtered;
}
