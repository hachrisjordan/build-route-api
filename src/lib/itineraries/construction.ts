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
      // Filter by alliance if specified - apply per-segment alliance restrictions
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
  // Note: We need to handle multi-day itineraries where segments may be on different dates
  
  // Collect ALL flights for each segment (regardless of date)
  const allSegmentFlights: AvailabilityFlight[][] = [];
  for (let segIdx = 0; segIdx < segmentFlights.length; segIdx++) {
    const groups = segmentFlights[segIdx] || [];
    const flights: AvailabilityFlight[] = [];
    
    for (const group of groups) {
      flights.push(...group.flights);
    }
    
    allSegmentFlights.push(flights);
  }
  
  // Check if we have flights for all segments
  if (allSegmentFlights.some(flights => flights.length === 0)) {
    return results;
  }

  // Build itineraries by connecting flights across ALL segments (cross-date connections allowed)
  const allDateResults: string[][] = [];
  const numSegments = allSegmentFlights.length;
  
  if (numSegments === 0) {
    return results;
  }
  
  // Build itineraries recursively through all segments
  function buildItinerariesFromSegment(
    currentItinerary: string[], 
    segmentIndex: number
  ): void {
    if (segmentIndex >= numSegments) {
      // We've built a complete itinerary
      if (currentItinerary.length === numSegments) {
        allDateResults.push([...currentItinerary]);
      }
      return;
    }
    
    const segmentFlights = allSegmentFlights[segmentIndex] || [];
    
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
  
  // Group results by the departure date of the first flight
  if (allDateResults.length > 0) {
    const uniqueResults = Array.from(new Map(allDateResults.map(itin => [itin.join('>'), itin])).values());
    
    // Group by departure date of first flight
    for (const itinerary of uniqueResults) {
      const firstFlightUuid = itinerary[0];
      if (firstFlightUuid) {
        const firstFlight = flightMap.get(firstFlightUuid);
        if (firstFlight && firstFlight.DepartsAt) {
          const departureDate = new Date(firstFlight.DepartsAt).toISOString().split('T')[0] || '';
          if (!results[departureDate]) {
            results[departureDate] = [];
          }
          results[departureDate].push(itinerary);
        }
      }
    }
  }

  return results;
}
