import type { AvailabilityFlight } from '@/types/availability';
import type { PricingEntry } from '@/types/availability-v2';
import type { FullRoutePathResult } from '@/types/route';

/**
 * Matches a flight to a pricing entry based on exact criteria:
 * - Flight numbers match
 * - Origin airport matches
 * - Destination airport matches  
 * - Departure/arrival times match within tolerance
 */
export function matchPricingToFlight(
  flight: AvailabilityFlight,
  pricingIndex: { byFlightAndRoute: Map<string, PricingEntry[]> },
  toleranceMinutes: number = 5
): PricingEntry | null {
  const flightKey = flight.FlightNumbers.toLowerCase();
  const routeKey = `${flight.originAirport}-${flight.destinationAirport}`;
  const combinedKey = `${flightKey}:${routeKey}`;

  // Get only relevant pricing entries (O(1) lookup instead of O(n))
  const candidates = pricingIndex.byFlightAndRoute.get(combinedKey);
  if (!candidates || candidates.length === 0) {
    return null;
  }

  const flightDeparture = new Date(flight.DepartsAt).getTime();
  const flightArrival = new Date(flight.ArrivesAt).getTime();
  const tolerance = toleranceMinutes * 60 * 1000;

  // Now only iterate through matching candidates (typically 1-3 entries)
  for (const pricingEntry of candidates) {
    const pricingDeparture = new Date(pricingEntry.DepartsAt).getTime();
    const pricingArrival = new Date(pricingEntry.ArrivesAt).getTime();

    const departureDiff = Math.abs(flightDeparture - pricingDeparture);
    const arrivalDiff = Math.abs(flightArrival - pricingArrival);

    if (departureDiff <= tolerance && arrivalDiff <= tolerance) {
      return pricingEntry;
    }
  }

  return null;
}

/**
 * Extracts pricing IDs for each segment of an itinerary based on route timings
 * Matches pricing entries using route segment information (AB, OA, BD) and exact timing
 * Returns array of pricing IDs for actual segments only (no nulls)
 */
export function extractSegmentPricing(
  flights: AvailabilityFlight[],
  routeStructure: FullRoutePathResult | null,
  pricingIndex: { byFlightAndRoute: Map<string, PricingEntry[]> },
  routeTimings?: {
    O: string | null;
    A: string | null;
    B: string | null;
    D: string | null;
    OA: string | null;
    AB: string | null;
    BD: string | null;
    ODepartureTime: string | null;
    AArrivalTime: string | null;
    ADepartureTime: string | null;
    BArrivalTime: string | null;
    BDepartureTime: string | null;
    DArrivalTime: string | null;
  }
): string[] {
  if (!routeStructure || flights.length === 0 || !routeTimings) {
    return [];
  }

  const pricingIds: string[] = [];

  // Helper to match pricing by route segment info using indexed lookup
  const matchPricingBySegment = (segmentFlights: string | null, departureTime: string | null, arrivalTime: string | null): PricingEntry | null => {
    if (!segmentFlights || !departureTime || !arrivalTime) {
      return null;
    }

    // Extract flight numbers and route from segment flights
    const flightNumbers = segmentFlights.split(', ')[0]; // Take first flight number
    if (!flightNumbers) return null;
    const flightKey = flightNumbers.toLowerCase();
    
    // Try to find route by checking all available routes for this flight
    for (const [combinedKey, candidates] of pricingIndex.byFlightAndRoute) {
      if (combinedKey.startsWith(`${flightKey}:`)) {
        // Check if departure time matches (within 5 minutes tolerance)
        const expectedDeparture = new Date(departureTime).getTime();
        const expectedArrival = new Date(arrivalTime).getTime();
        const tolerance = 5 * 60 * 1000; // 5 minutes in milliseconds

        for (const pricingEntry of candidates) {
          const pricingDeparture = new Date(pricingEntry.DepartsAt).getTime();
          const pricingArrival = new Date(pricingEntry.ArrivesAt).getTime();
          
          const departureDiff = Math.abs(pricingDeparture - expectedDeparture);
          const arrivalDiff = Math.abs(pricingArrival - expectedArrival);

          if (departureDiff <= tolerance && arrivalDiff <= tolerance) {
            return pricingEntry;
          }
        }
      }
    }

    return null;
  };

  // OA segment (O to A)
  if (routeTimings.OA) {
    const pricing = matchPricingBySegment(routeTimings.OA, routeTimings.ODepartureTime, routeTimings.AArrivalTime);
    if (pricing) {
      pricingIds.push(pricing.id);
    }
  }

  // AB segment (A to B)
  if (routeTimings.AB) {
    const pricing = matchPricingBySegment(routeTimings.AB, routeTimings.ADepartureTime, routeTimings.BArrivalTime);
    if (pricing) {
      pricingIds.push(pricing.id);
    }
  }

  // BD segment (B to D)
  if (routeTimings.BD) {
    const pricing = matchPricingBySegment(routeTimings.BD, routeTimings.BDepartureTime, routeTimings.DArrivalTime);
    if (pricing) {
      pricingIds.push(pricing.id);
    }
  }

  return pricingIds;
}

/**
 * Gets all pricing data for flights in an itinerary
 * Returns array of pricing entries that match any flight in the itinerary
 */
export function getAllPricingForItinerary(
  flights: AvailabilityFlight[],
  pricingIndex: { byFlightAndRoute: Map<string, PricingEntry[]> }
): PricingEntry[] {
  const pricingEntries: PricingEntry[] = [];
  const seenIds = new Set<string>();

  for (const flight of flights) {
    const pricing = matchPricingToFlight(flight, pricingIndex);
    if (pricing && !seenIds.has(pricing.id)) {
      pricingEntries.push(pricing);
      seenIds.add(pricing.id);
    }
  }

  return pricingEntries;
}
