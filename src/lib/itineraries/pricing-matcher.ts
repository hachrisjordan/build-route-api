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
  pricingPool: Map<string, PricingEntry>,
  toleranceMinutes: number = 5
): PricingEntry | null {
  const flightDeparture = new Date(flight.DepartsAt).getTime();
  const flightArrival = new Date(flight.ArrivesAt).getTime();
  const tolerance = toleranceMinutes * 60 * 1000; // Convert to milliseconds

  // Match flight against pricing entries

  for (const pricingEntry of pricingPool.values()) {
    // Check flight numbers match (case insensitive)
    if (flight.FlightNumbers.toLowerCase() !== pricingEntry.flightnumbers.toLowerCase()) {
      continue;
    }

    // Check airports match
    if (flight.originAirport !== pricingEntry.departingAirport || 
        flight.destinationAirport !== pricingEntry.arrivingAirport) {
      continue;
    }

    // Check times match within tolerance
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
  pricingPool: Map<string, PricingEntry>,
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

  // Helper to match pricing by route segment info
  const matchPricingBySegment = (segmentFlights: string | null, departureTime: string | null, arrivalTime: string | null): PricingEntry | null => {
    if (!segmentFlights || !departureTime || !arrivalTime) {
      return null;
    }

    // Match pricing by segment info

    for (const pricingEntry of pricingPool.values()) {
      // Check if flight numbers match exactly
      if (pricingEntry.flightnumbers !== segmentFlights) {
        continue;
      }

      // Check if departure time matches (within 5 minutes tolerance)
      const pricingDeparture = new Date(pricingEntry.DepartsAt).getTime();
      const expectedDeparture = new Date(departureTime).getTime();
      const departureDiff = Math.abs(pricingDeparture - expectedDeparture);
      const tolerance = 5 * 60 * 1000; // 5 minutes in milliseconds

      if (departureDiff > tolerance) {
        continue;
      }

      // Check if arrival time matches (within 5 minutes tolerance)
      const pricingArrival = new Date(pricingEntry.ArrivesAt).getTime();
      const expectedArrival = new Date(arrivalTime).getTime();
      const arrivalDiff = Math.abs(pricingArrival - expectedArrival);

      if (arrivalDiff > tolerance) {
        continue;
      }

      return pricingEntry;
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
  pricingPool: Map<string, PricingEntry>
): PricingEntry[] {
  const pricingEntries: PricingEntry[] = [];
  const seenIds = new Set<string>();

  for (const flight of flights) {
    const pricing = matchPricingToFlight(flight, pricingPool);
    if (pricing && !seenIds.has(pricing.id)) {
      pricingEntries.push(pricing);
      seenIds.add(pricing.id);
    }
  }

  return pricingEntries;
}
