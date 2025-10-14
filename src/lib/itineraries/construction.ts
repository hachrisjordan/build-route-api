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
    
    // Build itineraries by connecting flights across ALL segments
    // For routes like HAN-TYO-CHI-LAX, we need to connect:
    // HAN-TYO flights → TYO-CHI flights → CHI-LAX flights
    const numSegments = segmentFlightsForDate.length;
    
    if (numSegments === 0) continue;
    
    // Start with all flights from the first segment
    const firstSegmentFlights = segmentFlightsForDate[0] || [];
    
    // Build itineraries recursively through all segments
    function buildItinerariesFromSegment(
      currentItinerary: string[], 
      segmentIndex: number
    ): void {
      if (segmentIndex >= numSegments) {
        // We've built a complete itinerary
        if (currentItinerary.length === numSegments) {
          dateResults.push([...currentItinerary]);
        }
        return;
      }
      
      const segmentFlights = segmentFlightsForDate[segmentIndex] || [];
      
      for (const flight of segmentFlights) {
        const flightUuid = getFlightUUID(flight);
        if (!flightMap.has(flightUuid)) {
          flightMap.set(flightUuid, flight);
        }
        
        // For the first segment, just add the flight
        if (segmentIndex === 0) {
          buildItinerariesFromSegment([flightUuid], segmentIndex + 1);
        } else {
          // For subsequent segments, check connection validity
          const lastFlightUuid = currentItinerary[currentItinerary.length - 1];
          if (lastFlightUuid) {
            const validConnections = connectionMatrix.get(lastFlightUuid);
            if (validConnections && validConnections.has(flightUuid)) {
              // Valid connection - continue building the itinerary
              buildItinerariesFromSegment([...currentItinerary, flightUuid], segmentIndex + 1);
            }
          }
        }
      }
    }
    
    // Start building itineraries from the first segment
    buildItinerariesFromSegment([], 0);
    
    if (dateResults.length > 0) {
      const uniqueResults = Array.from(new Map(dateResults.map(itin => [itin.join('>'), itin])).values());
      results[date] = uniqueResults;
    }
  }

  return results;
}
