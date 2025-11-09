import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import type { FullRoutePathResult } from '@/types/route';
import type { PricingEntry } from '@/types/availability-v2';
import { extractSegmentPricing } from '@/lib/itineraries/pricing-matcher';
import { isCityCode, getCityAirports } from '@/lib/airports/city-groups';

export interface OptimizedItinerary {
  route: string;
  date: string;
  itinerary: string[];
  totalDuration: number;
  departureTime: number;
  arrivalTime: number;
  stopCount: number;
  airlineCodes: string[];
  origin: string;
  destination: string;
  connections: string[];
  classPercentages: { y: number; w: number; j: number; f: number };
  pricingId?: string[]; // Array of pricing IDs for segments (O-A, A-B, B-D)
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
  };
}

export function getTotalDuration(flights: (any | undefined)[]): number {
  let total = 0;
  for (let i = 0; i < flights.length; i++) {
    const flight = flights[i];
    if (!flight) continue;
    total += flight.TotalDuration;
    if (i > 0 && flights[i - 1]) {
      const prevArrive = new Date(flights[i - 1].ArrivesAt).getTime();
      const currDepart = new Date(flight.DepartsAt).getTime();
      const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
      total += layover;
    }
  }
  return total;
}

/**
 * Extract route timings based on the O-A-B-D structure
 * Maps flights to route waypoints and extracts arrival/departure times
 * Returns times in ISO 8601 format (e.g., "2025-01-01T01:02:03Z")
 */
export function extractRouteTimings(
  flights: AvailabilityFlight[],
  routeStructure: FullRoutePathResult | null
): {
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
} | null {
  if (!routeStructure || flights.length === 0) {
    return null;
  }

  const { O, A, h1, h2, B, D } = routeStructure;
  
  // Build waypoint sequence: O -> A -> h1 -> h2 -> B -> D
  const waypoints = [O, A, h1, h2, B, D].filter((w): w is string => w !== null && w !== undefined);
  
  if (waypoints.length === 0) {
    return null;
  }

  // Map flights to waypoints by matching origin/destination airports
  const result = {
    O: O || null,
    A: A || null,
    B: B || null,
    D: D || null,
    OA: null as string | null,
    AB: null as string | null,
    BD: null as string | null,
    ODepartureTime: null as string | null,
    AArrivalTime: null as string | null,
    ADepartureTime: null as string | null,
    BArrivalTime: null as string | null,
    BDepartureTime: null as string | null,
    DArrivalTime: null as string | null,
  };

  // Helper function to format date to ISO string (YYYY-MM-DDTHH:MM:SS format without milliseconds and without Z)
  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toISOString().replace(/\.\d{3}Z$/, '');
  };

  // Helper function to check if an airport matches a waypoint (handles city codes)
  const matchesWaypoint = (airport: string, waypoint: string | null): boolean => {
    if (!waypoint) return false;
    if (airport === waypoint) return true;
    
    // If waypoint is a city code, check if airport belongs to that city
    if (isCityCode(waypoint)) {
      const cityAirports = getCityAirports(waypoint);
      return cityAirports.includes(airport);
    }
    
    return false;
  };

  // Track flight numbers for each segment
  const oaFlightNumbers: string[] = [];
  const abFlightNumbers: string[] = [];
  const bdFlightNumbers: string[] = [];

  // First pass: classify each flight into segments based on route structure
  for (let i = 0; i < flights.length; i++) {
    const flight = flights[i];
    if (!flight) continue;
    
    const origin = flight.originAirport;
    const destination = flight.destinationAirport;
    const flightNumber = flight.FlightNumbers;

    // Determine which segment this flight belongs to
    // O-A segment: Only if O exists and this flight starts from O
    if (O && origin && matchesWaypoint(origin, O)) {
      oaFlightNumbers.push(flightNumber);
      continue;
    }

    // B-D segment: Only if D exists and this flight ends at D
    if (D && destination && matchesWaypoint(destination, D)) {
      bdFlightNumbers.push(flightNumber);
      continue;
    }

    // A-B segment: Everything else between A and B
    // This includes flights from A and flights going to B (but not from O or to D)
    abFlightNumbers.push(flightNumber);
  }

  // Set segment flight numbers
  if (oaFlightNumbers.length > 0) {
    result.OA = oaFlightNumbers.join(', ');
  }
  if (abFlightNumbers.length > 0) {
    result.AB = abFlightNumbers.join(', ');
  }
  if (bdFlightNumbers.length > 0) {
    result.BD = bdFlightNumbers.join(', ');
  }

  // Second pass: extract timing information for each waypoint
  for (const flight of flights) {
    const origin = flight.originAirport;
    const destination = flight.destinationAirport;

    // O waypoint
    if (O && origin && matchesWaypoint(origin, O)) {
      if (result.ODepartureTime === null) {
        result.ODepartureTime = formatDate(flight.DepartsAt);
      }
    }

    // A waypoint
    if (A) {
      if (destination && matchesWaypoint(destination, A) && result.AArrivalTime === null) {
        result.AArrivalTime = formatDate(flight.ArrivesAt);
      }
      if (origin && matchesWaypoint(origin, A) && result.ADepartureTime === null) {
        result.ADepartureTime = formatDate(flight.DepartsAt);
      }
    }

    // B waypoint
    if (B) {
      if (destination && matchesWaypoint(destination, B) && result.BArrivalTime === null) {
        result.BArrivalTime = formatDate(flight.ArrivesAt);
      }
      if (origin && matchesWaypoint(origin, B) && result.BDepartureTime === null) {
        result.BDepartureTime = formatDate(flight.DepartsAt);
      }
    }

    // D waypoint
    if (D && destination && matchesWaypoint(destination, D)) {
      result.DArrivalTime = formatDate(flight.ArrivesAt);
    }
  }

  return result;
}

export function precomputeItineraryMetadata(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Record<string, AvailabilityFlight>,
  minReliabilityPercent: number,
  getClassPercentages: (flightsArr: any[], minReliabilityPercent: number) => { y: number; w: number; j: number; f: number },
  routeStructureMap?: Map<string, FullRoutePathResult>,
  pricingIndex?: { byFlightAndRoute: Map<string, PricingEntry[]> }
): OptimizedItinerary[] {
  const optimized: OptimizedItinerary[] = [];
  for (const routeKey of Object.keys(itineraries)) {
    const routeSegments = routeKey.split('-');
    const stopCount = routeSegments.length - 2;
    const origin = routeSegments[0] || '';
    const destination = routeSegments[routeSegments.length - 1] || '';
    const connections = routeSegments.slice(1, -1).filter(Boolean);
    
    // Get route structure for timing extraction
    const routeStructure = routeStructureMap?.get(routeKey) || null;
    
    for (const date of Object.keys(itineraries[routeKey] || {})) {
      for (const itinerary of itineraries[routeKey]![date] || []) {
        const flightObjs = itinerary.map(uuid => flights[uuid]).filter(Boolean);
        if (flightObjs.length === 0) continue;
        let totalDuration = 0;
        for (let i = 0; i < flightObjs.length; i++) {
          totalDuration += flightObjs[i]!.TotalDuration;
          if (i > 0 && flightObjs[i - 1]) {
            const prevArrive = new Date(flightObjs[i - 1]!.ArrivesAt).getTime();
            const currDepart = new Date(flightObjs[i]!.DepartsAt).getTime();
            const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
            totalDuration += layover;
          }
        }
        const departureTime = new Date(flightObjs[0]!.DepartsAt).getTime();
        const arrivalTime = new Date(flightObjs[flightObjs.length - 1]!.ArrivesAt).getTime();
        const airlineCodes = flightObjs.map(f => f!.FlightNumbers.slice(0, 2).toUpperCase());
        const classPercentages = getClassPercentages(flightObjs, minReliabilityPercent);
        
        // Extract route timings based on O-A-B-D structure
        const routeTimings = extractRouteTimings(flightObjs as AvailabilityFlight[], routeStructure);
        
        // Extract pricing information if pricing pool is available
        // For direct flights, routeTimings may be null, but extractSegmentPricing handles that case
        let pricingId: string[] | undefined;
        
        if (pricingIndex && 
            pricingIndex.byFlightAndRoute && 
            pricingIndex.byFlightAndRoute instanceof Map) {
          pricingId = extractSegmentPricing(flightObjs as AvailabilityFlight[], routeStructure, pricingIndex, routeTimings || undefined);
        }
        
        optimized.push({
          route: routeKey,
          date,
          itinerary,
          totalDuration,
          departureTime,
          arrivalTime,
          stopCount,
          airlineCodes,
          origin,
          destination,
          connections,
          classPercentages,
          ...(pricingId && pricingId.length > 0 && { pricingId }),
          ...(routeTimings && { routeTimings }),
        });
      }
    }
  }
  return optimized;
}

export function optimizedFilterSortSearchPaginate(
  optimizedItineraries: OptimizedItinerary[],
  query: {
    stops?: number[];
    includeAirlines?: string[];
    excludeAirlines?: string[];
    maxDuration?: number;
    minYPercent?: number;
    minWPercent?: number;
    minJPercent?: number;
    minFPercent?: number;
    depTimeMin?: number;
    depTimeMax?: number;
    arrTimeMin?: number;
    arrTimeMax?: number;
    includeOrigin?: string[];
    includeDestination?: string[];
    includeConnection?: string[];
    excludeOrigin?: string[];
    excludeDestination?: string[];
    excludeConnection?: string[];
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
  }
) {
  let result = optimizedItineraries;

  if (query.stops?.length || query.includeAirlines?.length || query.excludeAirlines?.length ||
      query.maxDuration !== undefined || query.minYPercent !== undefined || query.minWPercent !== undefined ||
      query.minJPercent !== undefined || query.minFPercent !== undefined || query.depTimeMin !== undefined ||
      query.depTimeMax !== undefined || query.arrTimeMin !== undefined || query.arrTimeMax !== undefined ||
      query.includeOrigin?.length || query.includeDestination?.length || query.includeConnection?.length ||
      query.excludeOrigin?.length || query.excludeDestination?.length || query.excludeConnection?.length) {
    result = result.filter(item => {
      if (query.stops?.length && !query.stops.includes(item.stopCount)) return false;
      if (query.includeAirlines?.length && !item.airlineCodes.some(code => query.includeAirlines!.includes(code))) return false;
      if (query.excludeAirlines?.length && item.airlineCodes.some(code => query.excludeAirlines!.includes(code))) return false;
      if (query.maxDuration !== undefined && item.totalDuration > query.maxDuration) return false;
      if (query.minYPercent !== undefined && item.classPercentages.y < query.minYPercent) return false;
      if (query.minWPercent !== undefined && item.classPercentages.w < query.minWPercent) return false;
      if (query.minJPercent !== undefined && item.classPercentages.j < query.minJPercent) return false;
      if (query.minFPercent !== undefined && item.classPercentages.f < query.minFPercent) return false;
      if (query.depTimeMin !== undefined && item.departureTime < query.depTimeMin) return false;
      if (query.depTimeMax !== undefined && item.departureTime > query.depTimeMax) return false;
      if (query.arrTimeMin !== undefined && item.arrivalTime < query.arrTimeMin) return false;
      if (query.arrTimeMax !== undefined && item.arrivalTime > query.arrTimeMax) return false;
      if (query.includeOrigin?.length && !query.includeOrigin.includes(item.origin)) return false;
      if (query.includeDestination?.length && !query.includeDestination.includes(item.destination)) return false;
      if (query.includeConnection?.length && !item.connections.some(c => query.includeConnection!.includes(c))) return false;
      if (query.excludeOrigin?.length && query.excludeOrigin.includes(item.origin)) return false;
      if (query.excludeDestination?.length && query.excludeDestination.includes(item.destination)) return false;
      if (query.excludeConnection?.length && item.connections.some(c => query.excludeConnection!.includes(c))) return false;
      return true;
    });
  }

  if (query.search?.trim()) {
    const terms = query.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    result = result.filter(item => {
      return terms.every(term => {
        if (item.route.toLowerCase().includes(term)) return true;
        if (item.date.toLowerCase().includes(term)) return true;
        return item.airlineCodes.some(code => code.toLowerCase().includes(term));
      });
    });
  }

  if (query.sortBy) {
    result = result.sort((a, b) => {
      let aVal: number, bVal: number;
      switch (query.sortBy) {
        case 'duration': aVal = a.totalDuration; bVal = b.totalDuration; break;
        case 'departure': aVal = a.departureTime; bVal = b.departureTime; break;
        case 'arrival': aVal = a.arrivalTime; bVal = b.arrivalTime; break;
        case 'y': aVal = a.classPercentages.y; bVal = b.classPercentages.y; break;
        case 'w': aVal = a.classPercentages.w; bVal = b.classPercentages.w; break;
        case 'j': aVal = a.classPercentages.j; bVal = b.classPercentages.j; break;
        case 'f': aVal = a.classPercentages.f; bVal = b.classPercentages.f; break;
        default: aVal = 0; bVal = 0;
      }
      if (aVal !== bVal) {
        if (["arrival", "y", "w", "j", "f"].includes(query.sortBy!)) {
          return query.sortOrder === 'asc' ? bVal - aVal : bVal - aVal;
        }
        if (["duration", "departure"].includes(query.sortBy!)) {
          return query.sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
        }
        return query.sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      }
      return a.totalDuration - b.totalDuration;
    });
  }

  const total = result.length;
  const page = query.page || 1;
  const pageSize = query.pageSize || 10;
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const data = result.slice(start, end);
  return { total, page, pageSize, data };
}


