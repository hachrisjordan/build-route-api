import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';

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

export function precomputeItineraryMetadata(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Record<string, AvailabilityFlight>,
  reliability: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number,
  getClassPercentages: (flightsArr: any[], reliability: any, minReliabilityPercent: number) => { y: number; w: number; j: number; f: number }
): OptimizedItinerary[] {
  const optimized: OptimizedItinerary[] = [];
  for (const routeKey of Object.keys(itineraries)) {
    const routeSegments = routeKey.split('-');
    const stopCount = routeSegments.length - 2;
    const origin = routeSegments[0] || '';
    const destination = routeSegments[routeSegments.length - 1] || '';
    const connections = routeSegments.slice(1, -1).filter(Boolean);
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
        const classPercentages = getClassPercentages(flightObjs, reliability, minReliabilityPercent);
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


