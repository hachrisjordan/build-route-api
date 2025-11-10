import { ALLIANCE_MAP } from '@/lib/airlines/alliances';
import { MergedEntry, FlightEntry, GroupedResult } from '@/types/availability-v2';
import { initializeCityGroups, getAirportCityCode } from '@/lib/airports/city-groups';

/**
 * Groups merged entries by alliance and deduplicates identical flights.
 */
export async function groupAndDeduplicate(mergedMap: Map<string, MergedEntry>): Promise<GroupedResult[]> {
  // Initialize city groups to get city codes
  await initializeCityGroups();
  
  // Pre-compute all unique airport city codes to avoid repeated lookups
  const cityCodeCache = new Map<string, string>();
  const uniqueAirports = new Set<string>();
  
  for (const entry of mergedMap.values()) {
    uniqueAirports.add(entry.originAirport);
    uniqueAirports.add(entry.destinationAirport);
  }
  
  // Cache all city code lookups once
  for (const airport of uniqueAirports) {
    cityCodeCache.set(airport, getAirportCityCode(airport));
  }
  
  const finalGroupedMap = new Map<string, GroupedResult>();

  for (const entry of mergedMap.values()) {
    const flightPrefix = entry.FlightNumbers.slice(0, 2);
    const alliance = ALLIANCE_MAP.get(flightPrefix);
    if (!alliance) continue;

    // Use cached city codes (if no city group, city = airport)
    const originCity = cityCodeCache.get(entry.originAirport)!;
    const destinationCity = cityCodeCache.get(entry.destinationAirport)!;

    // Use array join for better performance with multiple concatenations
    const groupKey = [entry.originAirport, entry.destinationAirport, entry.date, alliance].join('|');
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
          YFare: entry.YFare, // Direct reference - we use concat in merge operations
          WFare: entry.WFare,
          JFare: entry.JFare,
          FFare: entry.FFare,
          YPartner: entry.YPartner,
          WPartner: entry.WPartner,
          JPartner: entry.JPartner,
          FPartner: entry.FPartner,
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
        YFare: entry.YFare, // Direct reference - arrays are already copied in merge
        WFare: entry.WFare,
        JFare: entry.JFare,
        FFare: entry.FFare,
        YPartner: entry.YPartner,
        WPartner: entry.WPartner,
        JPartner: entry.JPartner,
        FPartner: entry.FPartner,
      });
    }
  }

  // Deduplicate identical flights within each group
  for (const group of finalGroupedMap.values()) {
    const flightMap = new Map<string, FlightEntry>();
    for (const flight of group.flights) {
      // Use array join for better performance
      const flightKey = [flight.FlightNumbers, flight.DepartsAt, flight.ArrivesAt, flight.TotalDuration].join('|');
      const existingFlight = flightMap.get(flightKey);
      if (!existingFlight) {
        flightMap.set(flightKey, { ...flight });
      } else {
        existingFlight.YCount += flight.YCount;
        existingFlight.WCount += flight.WCount;
        existingFlight.JCount += flight.JCount;
        existingFlight.FCount += flight.FCount;
        // Combine fare classes efficiently - use concat instead of spread operator
        if (flight.YFare.length > 0) existingFlight.YFare = existingFlight.YFare.concat(flight.YFare);
        if (flight.WFare.length > 0) existingFlight.WFare = existingFlight.WFare.concat(flight.WFare);
        if (flight.JFare.length > 0) existingFlight.JFare = existingFlight.JFare.concat(flight.JFare);
        if (flight.FFare.length > 0) existingFlight.FFare = existingFlight.FFare.concat(flight.FFare);
        // Combine partner booleans using OR logic (if any flight has partner=true, result is true)
        existingFlight.YPartner = existingFlight.YPartner || flight.YPartner;
        existingFlight.WPartner = existingFlight.WPartner || flight.WPartner;
        existingFlight.JPartner = existingFlight.JPartner || flight.JPartner;
        existingFlight.FPartner = existingFlight.FPartner || flight.FPartner;
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


