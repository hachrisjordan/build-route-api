import { startOfDay, endOfDay, parseISO } from 'date-fns';
import type { AvailabilityFlight } from '@/types/availability';

export function filterItinerariesByDate(
  output: Record<string, Record<string, string[][]>>,
  flightMap: Map<string, AvailabilityFlight>,
  startDate: string,
  endDate: string
) {
  const startDateObj = startOfDay(parseISO(startDate));
  const endDateObj = endOfDay(parseISO(endDate));
  const flightDateCache = new Map<string, number>();

  for (const routeKey of Object.keys(output)) {
    const routeData = output[routeKey];
    if (!routeData) continue;
    for (const date of Object.keys(routeData)) {
      const dateItineraries = routeData[date];
      if (!dateItineraries) continue;
      routeData[date] = dateItineraries.filter(itin => {
        if (!itin.length) return false;
        const firstFlightUUID = itin[0];
        if (!firstFlightUUID) return false;
        const firstFlight = flightMap.get(firstFlightUUID);
        if (!firstFlight || !firstFlight.DepartsAt) return false;
        let depDateTime: number;
        if (flightDateCache.has(firstFlight.DepartsAt)) {
          depDateTime = flightDateCache.get(firstFlight.DepartsAt)!;
        } else {
          depDateTime = new Date(firstFlight.DepartsAt).getTime();
          flightDateCache.set(firstFlight.DepartsAt, depDateTime);
        }
        return depDateTime >= startDateObj.getTime() && depDateTime <= endDateObj.getTime();
      });
      if (routeData[date].length === 0) {
        delete routeData[date];
      }
    }
    if (Object.keys(routeData).length === 0) {
      delete output[routeKey];
    }
  }
  return output;
}

export function buildFlightsPage(itinerariesPage: Array<{ itinerary: string[] }>, allFlights: Record<string, AvailabilityFlight>) {
  const flightUUIDs = new Set<string>();
  itinerariesPage.forEach((card) => {
    card.itinerary.forEach((uuid) => flightUUIDs.add(uuid));
  });
  const flightsPage: Record<string, any> = {};
  flightUUIDs.forEach(uuid => {
    if (allFlights[uuid]) flightsPage[uuid] = allFlights[uuid];
  });
  return flightsPage;
}

export function buildResponse({
  data,
  total,
  page,
  pageSize,
  minRateLimitRemaining,
  minRateLimitReset,
  totalSeatsAeroHttpRequests,
  filterMetadata,
  flightsPage,
}: any) {
  return {
    itineraries: data,
    flights: flightsPage,
    total,
    page,
    pageSize,
    minRateLimitRemaining,
    minRateLimitReset,
    totalSeatsAeroHttpRequests,
    filterMetadata,
  };
}

export function dedupeAndPruneOutput(output: Record<string, Record<string, string[][]>>) {
  Object.keys(output).forEach((key) => {
    const routeData = output[key];
    if (!routeData || Object.keys(routeData).length === 0) {
      delete output[key];
    }
  });
  for (const routeKey of Object.keys(output)) {
    const routeData = output[routeKey];
    if (!routeData) continue;
    for (const date of Object.keys(routeData)) {
      const dateItineraries = routeData[date];
      if (!dateItineraries) continue;
      const uniqueItineraries = new Map<string, string[]>();
      for (const itinerary of dateItineraries) {
        const itineraryHash = itinerary.join('>');
        if (!uniqueItineraries.has(itineraryHash)) uniqueItineraries.set(itineraryHash, itinerary);
      }
      routeData[date] = Array.from(uniqueItineraries.values());
    }
  }
  return output;
}

export function pruneUnusedFlights(flightMap: Map<string, AvailabilityFlight>, usedFlightUUIDs: Set<string>) {
  for (const uuid of flightMap.keys()) {
    if (!usedFlightUUIDs.has(uuid)) {
      flightMap.delete(uuid);
    }
  }
}

export function collectUsedFlightUUIDs(output: Record<string, Record<string, string[][]>>) {
  const used = new Set<string>();
  for (const routeKey of Object.keys(output)) {
    const routeData = output[routeKey];
    if (!routeData) continue;
    for (const date of Object.keys(routeData)) {
      const dateItineraries = routeData[date];
      if (!dateItineraries) continue;
      for (const itin of dateItineraries) {
        for (const uuid of itin) used.add(uuid);
      }
    }
  }
  return used;
}
