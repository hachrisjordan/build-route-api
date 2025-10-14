import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getFlightUUID } from '@/lib/itineraries/ids';
import { initializeCityGroups, getAirportCityCode } from '@/lib/airports/city-groups';

export async function composeItineraries(
  segments: [string, string][],
  segmentAvail: AvailabilityGroup[][],
  alliances: (string[] | null)[],
  flightMap: Map<string, AvailabilityFlight>,
  connectionMatrix: Map<string, Set<string>>,
  minConnectionMinutes = 45
): Promise<Record<string, string[][]>> {
  // Initialize city groups for city-based building
  await initializeCityGroups();
  
  const results: Record<string, string[][]> = {};
  if (segments.length === 0 || segmentAvail.some(arr => arr.length === 0)) return results;

  // Since create-full-route-path returns city-to-city routes (HAN-TYO-ORD),
  // we need to build from city flows instead of segment structures
  
  // Collect all available flights by city connectivity
  const cityFlightsMap = new Map<string, AvailabilityGroup[]>();
  
  // Build a map of all flights by city connectivity
  for (let i = 0; i < segmentAvail.length; i++) {
    const groups = segmentAvail[i] || [];
    for (const group of groups) {
      // Filter by alliance if specified
      if (alliances[i] && alliances[i]!.length > 0 && !alliances[i]!.includes(group.alliance)) {
        continue;
      }
      
      const cityKey = `${group.originCity}-${group.destinationCity}`;
      
      if (!cityFlightsMap.has(cityKey)) {
        cityFlightsMap.set(cityKey, []);
      }
      cityFlightsMap.get(cityKey)!.push(group);
    }
  }

  // Build itineraries by connecting segments based on city connectivity
  // For a route like HAN-TYO-ORD, we need to connect:
  // 1. Any HAN-TYO flight to any TYO-ORD flight
  // 2. Use connection matrix to validate airport-to-airport connections
  
  
  // Get the city keys from the segments
  const segmentCityKeys: string[] = [];
  for (const segment of segments) {
    const [fromAirport, toAirport] = segment;
    const fromCity = await getAirportCityCode(fromAirport);
    const toCity = await getAirportCityCode(toAirport);
    segmentCityKeys.push(`${fromCity}-${toCity}`);
  }
  
  
  // Get flights for each segment by city key
  const segmentFlights: AvailabilityGroup[][] = [];
  for (const cityKey of segmentCityKeys) {
    const flights = cityFlightsMap.get(cityKey) || [];
    segmentFlights.push(flights);
  }
  
  // Check if we have flights for all segments
  if (segmentFlights.some(flights => flights.length === 0)) {
    return results;
  }

  // Build itineraries by connecting flights across segments
  const flightsByDate = new Map<string, AvailabilityFlight[][]>();
  
  // Group flights by date for each segment
  for (let segIdx = 0; segIdx < segmentFlights.length; segIdx++) {
    const groups = segmentFlights[segIdx];
    if (!groups) continue;
    
    for (const group of groups) {
      if (!flightsByDate.has(group.date)) {
        flightsByDate.set(group.date, []);
      }
      const dateFlights = flightsByDate.get(group.date)!;
      if (!dateFlights[segIdx]) {
        dateFlights[segIdx] = [];
      }
      dateFlights[segIdx]!.push(...group.flights);
    }
  }

  // Build itineraries for each date using city-based connectivity
  for (const [date, segmentFlightsForDate] of flightsByDate) {
    if (segmentFlightsForDate.some(flights => flights.length === 0)) continue;
    
    const dateResults: string[][] = [];
    
    // For a 2-segment route like HAN-TYO-CHI, we need to connect:
    // Any HAN-TYO flight to any TYO-CHI flight
    const firstSegmentFlights = segmentFlightsForDate[0] || [];
    const secondSegmentFlights = segmentFlightsForDate[1] || [];
    
    
    // Debug: Track VN310 and UA882 specifically
    const vn310Flights = firstSegmentFlights.filter(f => f.FlightNumbers === 'VN310');
    const ua882Flights = secondSegmentFlights.filter(f => f.FlightNumbers === 'UA882');
    
    
    // Try every first segment flight with every second segment flight
    for (const firstFlight of firstSegmentFlights) {
      const firstUuid = getFlightUUID(firstFlight);
      if (!flightMap.has(firstUuid)) {
        flightMap.set(firstUuid, firstFlight);
      }
      
      const isVN310 = firstFlight.FlightNumbers === 'VN310';
      
      for (const secondFlight of secondSegmentFlights) {
        const secondUuid = getFlightUUID(secondFlight);
        if (!flightMap.has(secondUuid)) {
          flightMap.set(secondUuid, secondFlight);
        }
        
        const isUA882 = secondFlight.FlightNumbers === 'UA882';
        
        if (isVN310 && isUA882) {
        }
        
        // Check if connection is valid using connection matrix
        const validConnections = connectionMatrix.get(firstUuid);
        if (validConnections && validConnections.has(secondUuid)) {
          // Valid connection - add to results
          dateResults.push([firstUuid, secondUuid]);
          if (isVN310 && isUA882) {
          }
        }
      }
    }
    
    if (dateResults.length > 0) {
      const uniqueResults = Array.from(new Map(dateResults.map(itin => [itin.join('>'), itin])).values());
      results[date] = uniqueResults;
    }
  }

  return results;
}
