import { ALLIANCE_MAP } from '@/lib/airlines/alliances';
import { MergedEntry, FlightEntry, GroupedResult } from '@/types/availability-v2';
import { initializeCityGroups, getAirportCityCode } from '@/lib/airports/city-groups';

/**
 * Groups merged entries by alliance and deduplicates identical flights.
 */
export async function groupAndDeduplicate(mergedMap: Map<string, MergedEntry>): Promise<GroupedResult[]> {
  // Initialize city groups to get city codes
  await initializeCityGroups();
  
  const finalGroupedMap = new Map<string, GroupedResult>();

  for (const entry of mergedMap.values()) {
    const flightPrefix = entry.FlightNumbers.slice(0, 2);
    const alliance = ALLIANCE_MAP.get(flightPrefix);
    if (!alliance) continue;

    // Get city codes for airports (if no city group, city = airport)
    const originCity = getAirportCityCode(entry.originAirport);
    const destinationCity = getAirportCityCode(entry.destinationAirport);

    const groupKey = `${entry.originAirport}|${entry.destinationAirport}|${entry.date}|${alliance}`;
    const existing = finalGroupedMap.get(groupKey);

    if (!existing) {
      finalGroupedMap.set(groupKey, {
        originAirport: entry.originAirport,
        destinationAirport: entry.destinationAirport,
        originCity: originCity, // Always include city (same as airport if no city group)
        destinationCity: destinationCity, // Always include city (same as airport if no city group)
        date: entry.date,
        distance: entry.distance,
        alliance,
        earliestDeparture: entry.DepartsAt,
        latestDeparture: entry.DepartsAt,
        earliestArrival: entry.ArrivesAt,
        latestArrival: entry.ArrivesAt,
        flights: [{
          FlightNumbers: entry.FlightNumbers,
          TotalDuration: entry.TotalDuration,
          Aircraft: entry.Aircraft,
          DepartsAt: entry.DepartsAt,
          ArrivesAt: entry.ArrivesAt,
          YCount: entry.YCount,
          WCount: entry.WCount,
          JCount: entry.JCount,
          FCount: entry.FCount,
          distance: entry.distance,
        }]
      });
    } else {
      if (entry.DepartsAt < existing.earliestDeparture) existing.earliestDeparture = entry.DepartsAt;
      if (entry.DepartsAt > existing.latestDeparture) existing.latestDeparture = entry.DepartsAt;
      if (entry.ArrivesAt < existing.earliestArrival) existing.earliestArrival = entry.ArrivesAt;
      if (entry.ArrivesAt > existing.latestArrival) existing.latestArrival = entry.ArrivesAt;

      existing.flights.push({
        FlightNumbers: entry.FlightNumbers,
        TotalDuration: entry.TotalDuration,
        Aircraft: entry.Aircraft,
        DepartsAt: entry.DepartsAt,
        ArrivesAt: entry.ArrivesAt,
        YCount: entry.YCount,
        WCount: entry.WCount,
        JCount: entry.JCount,
        FCount: entry.FCount,
        distance: entry.distance,
      });
    }
  }

  // Deduplicate identical flights within each group
  for (const group of finalGroupedMap.values()) {
    const flightMap = new Map<string, FlightEntry>();
    for (const flight of group.flights) {
      const flightKey = `${flight.FlightNumbers}|${flight.DepartsAt}|${flight.ArrivesAt}|${flight.TotalDuration}`;
      const existingFlight = flightMap.get(flightKey);
      if (!existingFlight) {
        flightMap.set(flightKey, { ...flight });
      } else {
        existingFlight.YCount += flight.YCount;
        existingFlight.WCount += flight.WCount;
        existingFlight.JCount += flight.JCount;
        existingFlight.FCount += flight.FCount;
        if (!existingFlight.Aircraft || existingFlight.Aircraft.trim() === '') {
          existingFlight.Aircraft = flight.Aircraft;
        }
        if (flight.distance > 0 && (existingFlight.distance === 0 || flight.distance < existingFlight.distance)) {
          existingFlight.distance = flight.distance;
        }
      }
    }
    group.flights = Array.from(flightMap.values());
  }

  return Array.from(finalGroupedMap.values());
}


