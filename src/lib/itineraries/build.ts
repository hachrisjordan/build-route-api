import { pool } from '@/lib/pool';
import type { FullRoutePathResult } from '@/types/route';
import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { composeItineraries } from '@/lib/itineraries/construction';
import { isCityCode, getCityAirports, getAirportCityCode } from '@/lib/airports/city-groups';

export interface ItineraryMetrics {
  phases: {
    routeProcessing: { totalMs: number; count: number; avgMs: number };
    segmentProcessing: { totalMs: number; count: number; avgMs: number };
    itineraryComposition: { totalMs: number; count: number; avgMs: number };
    postProcessing: { totalMs: number; count: number; avgMs: number };
  };
  totals: {
    routesProcessed: number;
    segmentsProcessed: number;
    itinerariesCreated: number;
    totalTimeMs: number;
  };
}

export async function buildItinerariesAcrossRoutes(
  routes: FullRoutePathResult[],
  segmentAvailability: Record<string, AvailabilityGroup[]>,
  flightMap: Map<string, AvailabilityFlight>,
  connectionMatrix: Map<string, Set<string>>,
  routeToOriginalMap: Map<FullRoutePathResult, FullRoutePathResult>,
  options: { parallel: boolean } = { parallel: false }
) {
  const output: Record<string, Record<string, string[][]>> = {};

  const itineraryMetrics: ItineraryMetrics = {
    phases: {
      routeProcessing: { totalMs: 0, count: 0, avgMs: 0 },
      segmentProcessing: { totalMs: 0, count: 0, avgMs: 0 },
      itineraryComposition: { totalMs: 0, count: 0, avgMs: 0 },
      postProcessing: { totalMs: 0, count: 0, avgMs: 0 },
    },
    totals: { routesProcessed: 0, segmentsProcessed: 0, itinerariesCreated: 0, totalTimeMs: 0 },
  };

  const start = Date.now();
  if (options.parallel && routes.length > 10) {
    const routeTasks = routes.map(route => async () => {
      const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
      if (codes.length < 2) return { routeKey: '', routeResults: {}, segCount: 0, compositionMs: 0 };
      
      // Expand city codes to all airport combinations for segments
      const segmentPairs: [string, string][] = [];
      for (let i = 0; i < codes.length - 1; i++) {
        const from = codes[i]!;
        const to = codes[i + 1]!;
        
        // Get all airport combinations for this segment
        const fromAirports = isCityCode(from) ? getCityAirports(from) : [from];
        const toAirports = isCityCode(to) ? getCityAirports(to) : [to];
        
        // Add all airport combinations as separate segments
        for (const fromAirport of fromAirports) {
          for (const toAirport of toAirports) {
            segmentPairs.push([fromAirport, toAirport]);
          }
        }
      }
      
      // Create segment structure based on actual route
const segments: [string, string][] = [];
for (let i = 0; i < codes.length - 1; i++) {
  segments.push([codes[i]!, codes[i + 1]!]);
}
      // Group segment availability by route structure
      const segmentAvail: AvailabilityGroup[][] = [];
      const alliances: (string[] | null)[] = [];
      
      for (let i = 0; i < segments.length; i++) {
        const [from, to] = segments[i]!;
        const segmentFlights: AvailabilityGroup[] = [];
        
        // Collect all flights for this segment by expanding city codes
        const fromAirports = isCityCode(from) ? getCityAirports(from) : [from];
        const toAirports = isCityCode(to) ? getCityAirports(to) : [to];
        
        for (const fromAirport of fromAirports) {
          for (const toAirport of toAirports) {
            const segKey = `${fromAirport}-${toAirport}`;
            const avail = segmentAvailability[segKey] || [];
            segmentFlights.push(...avail);
          }
        }
        
        segmentAvail.push(segmentFlights);
        
        // Alliance validation based on route position
        if (i === 0) {
          alliances.push(Array.isArray(route.all1) ? route.all1 : (route.all1 ? [route.all1] : null));
        } else if (i === segments.length - 1) {
          alliances.push(Array.isArray(route.all3) ? route.all3 : (route.all3 ? [route.all3] : null));
        } else {
          alliances.push(Array.isArray(route.all2) ? route.all2 : (route.all2 ? [route.all2] : null));
        }
      }
      
      const t0 = Date.now();
      const routeResults = await composeItineraries(segments, segmentAvail, alliances, flightMap, connectionMatrix);
      const t1 = Date.now();
      
      // Process results to rebuild route keys from actual flights
      const processedResults: Record<string, string[][]> = {};
      for (const [date, itineraries] of Object.entries(routeResults)) {
        for (const itinerary of itineraries) {
          // Get the actual flights for this itinerary
          const flights = itinerary.map(uuid => flightMap.get(uuid)).filter((f): f is AvailabilityFlight => !!f);
          if (flights.length === 0) continue;
          
          // Rebuild route string from actual airports used
          const routeParts: string[] = [];
          
          // Add origin airport
          routeParts.push(flights[0]?.originAirport || route.O || '');
          
          // For each connection point, decide whether to use airport code or city code
          for (let i = 0; i < flights.length - 1; i++) {
            const currentFlight = flights[i]!;
            const nextFlight = flights[i + 1]!;
            
            const currentArrival = currentFlight.destinationAirport || '';
            const nextDeparture = nextFlight.originAirport || '';
            
            if (currentArrival === nextDeparture) {
              // Same airport connection - use airport code
              routeParts.push(currentArrival);
            } else {
              // Cross-airport connection - use city code
              const cityCode = getAirportCityCode(currentArrival);
              routeParts.push(cityCode);
            }
          }
          
          // Add final destination airport
          const lastFlight = flights[flights.length - 1]!;
          routeParts.push(lastFlight.destinationAirport || '');
          
          const rebuiltRouteKey = routeParts.join('-');
          
          // Group by rebuilt route key and date
          if (!processedResults[rebuiltRouteKey]) processedResults[rebuiltRouteKey] = [];
          processedResults[rebuiltRouteKey].push(itinerary);
        }
      }
      
      return { routeResults: processedResults, segCount: segmentPairs.length, compositionMs: t1 - t0 };
    });
    const results = await pool(routeTasks, Math.min(10, Math.ceil(routes.length / 4)));
    const totalMs = Date.now() - start;
    itineraryMetrics.phases.routeProcessing.totalMs = totalMs;
    itineraryMetrics.phases.routeProcessing.count = routes.length;
    itineraryMetrics.phases.routeProcessing.avgMs = routes.length ? totalMs / routes.length : 0;
    itineraryMetrics.totals.routesProcessed = routes.length;

    let totalSegmentsProcessed = 0;
    let totalItinerariesCreated = 0;
    let totalCompositionTime = 0;
    for (const res of results) {
      const { routeResults, segCount, compositionMs } = res;
      // routeResults is now a Record<string, string[][]> where keys are rebuilt route keys
      for (const [rebuiltRouteKey, itineraries] of Object.entries(routeResults)) {
        if (!output[rebuiltRouteKey]) output[rebuiltRouteKey] = {};
        
        // Group itineraries by date
        const itinerariesByDate: Record<string, string[][]> = {};
        for (const itinerary of itineraries) {
          // Find the date for this itinerary by checking the first flight
          const firstFlightUuid = itinerary[0];
          if (firstFlightUuid) {
            const firstFlight = flightMap.get(firstFlightUuid);
            if (firstFlight && firstFlight.DepartsAt) {
              // Get date from flight departure time
              const date = new Date(firstFlight.DepartsAt).toISOString().split('T')[0] || '';
              if (!itinerariesByDate[date]) itinerariesByDate[date] = [];
              itinerariesByDate[date].push(itinerary);
            }
          }
        }
        
        // Add to output by date
        for (const [date, dateItineraries] of Object.entries(itinerariesByDate)) {
          if (!output[rebuiltRouteKey][date]) output[rebuiltRouteKey][date] = [];
          output[rebuiltRouteKey][date]!.push(...dateItineraries);
          totalItinerariesCreated += dateItineraries.length;
        }
      }
      totalSegmentsProcessed += segCount;
      totalCompositionTime += compositionMs;
    }
    itineraryMetrics.phases.itineraryComposition.totalMs = totalCompositionTime;
    itineraryMetrics.phases.itineraryComposition.count = totalItinerariesCreated;
    itineraryMetrics.phases.itineraryComposition.avgMs = totalItinerariesCreated > 0 ? totalCompositionTime / totalItinerariesCreated : 0;
    itineraryMetrics.totals.segmentsProcessed = totalSegmentsProcessed;
    itineraryMetrics.totals.itinerariesCreated = totalItinerariesCreated;
  } else {
    const t0 = Date.now();
    let segmentCount = 0;
    let compositionCount = 0;
    for (const route of routes) {
      const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
      if (codes.length < 2) continue;
      
      // Expand city codes to all airport combinations for segments
      const segmentPairs: [string, string][] = [];
      for (let i = 0; i < codes.length - 1; i++) {
        const from = codes[i]!;
        const to = codes[i + 1]!;
        
        // Get all airport combinations for this segment
        const fromAirports = isCityCode(from) ? getCityAirports(from) : [from];
        const toAirports = isCityCode(to) ? getCityAirports(to) : [to];
        
        // Add all airport combinations as separate segments
        for (const fromAirport of fromAirports) {
          for (const toAirport of toAirports) {
            segmentPairs.push([fromAirport, toAirport]);
          }
        }
      }
      
      // Group segments by original route structure (2-segment routes)
      // For HAN-TYO-ORD, we want: [HAN-NRT, HAN-HND] and [NRT-ORD, HND-ORD]
      const firstSegmentFlights: AvailabilityGroup[] = [];
      const secondSegmentFlights: AvailabilityGroup[] = [];
      
      // Collect all flights for each segment
      for (const [from, to] of segmentPairs) {
        const segKey = `${from}-${to}`;
        const avail = segmentAvailability[segKey] || [];
        
        // Determine which segment group this belongs to based on origin
        if (from === codes[0]) { // First segment (HAN-*)
          firstSegmentFlights.push(...avail);
        } else { // Second segment (*-ORD)
          secondSegmentFlights.push(...avail);
        }
      }
      
      
      // Create a simple 2-segment structure for composeItineraries
      // Create segment structure based on actual route
const segments: [string, string][] = [];
for (let i = 0; i < codes.length - 1; i++) {
  segments.push([codes[i]!, codes[i + 1]!]);
}
      // Group segment availability by route structure
      const segmentAvail: AvailabilityGroup[][] = [];
      const alliances: (string[] | null)[] = [];
      
      for (let i = 0; i < segments.length; i++) {
        const [from, to] = segments[i]!;
        const segmentFlights: AvailabilityGroup[] = [];
        
        // Collect all flights for this segment by expanding city codes
        const fromAirports = isCityCode(from) ? getCityAirports(from) : [from];
        const toAirports = isCityCode(to) ? getCityAirports(to) : [to];
        
        for (const fromAirport of fromAirports) {
          for (const toAirport of toAirports) {
            const segKey = `${fromAirport}-${toAirport}`;
            const avail = segmentAvailability[segKey] || [];
            segmentFlights.push(...avail);
          }
        }
        
        segmentAvail.push(segmentFlights);
        
        // Alliance validation based on route position
        if (i === 0) {
          alliances.push(Array.isArray(route.all1) ? route.all1 : (route.all1 ? [route.all1] : null));
        } else if (i === segments.length - 1) {
          alliances.push(Array.isArray(route.all3) ? route.all3 : (route.all3 ? [route.all3] : null));
        } else {
          alliances.push(Array.isArray(route.all2) ? route.all2 : (route.all2 ? [route.all2] : null));
        }
      }
      
      const routeResults = await composeItineraries(segments, segmentAvail, alliances, flightMap, connectionMatrix);
      
      // Process each date's results to rebuild route keys from actual flights
      const processedRouteResults: Record<string, string[][]> = {};
      for (const [date, itineraries] of Object.entries(routeResults)) {
        const processedItineraries: string[][] = [];
        
        for (const itinerary of itineraries) {
          // Get the actual flights for this itinerary
          const flights = itinerary.map(uuid => flightMap.get(uuid)).filter((f): f is AvailabilityFlight => !!f);
          if (flights.length === 0) continue;
          
          // Rebuild route string from actual airports used
          const routeParts: string[] = [];
          
          // Add origin airport
          routeParts.push(flights[0]?.originAirport || route.O || '');
          
          // For each connection point, decide whether to use airport code or city code
          for (let i = 0; i < flights.length - 1; i++) {
            const currentFlight = flights[i]!;
            const nextFlight = flights[i + 1]!;
            
            const currentArrival = currentFlight.destinationAirport || '';
            const nextDeparture = nextFlight.originAirport || '';
            
            if (currentArrival === nextDeparture) {
              // Same airport connection - use airport code
              routeParts.push(currentArrival);
            } else {
              // Cross-airport connection - use city code
              const cityCode = getAirportCityCode(currentArrival);
              routeParts.push(cityCode);
            }
          }
          
          // Add final destination airport
          const lastFlight = flights[flights.length - 1]!;
          routeParts.push(lastFlight.destinationAirport || '');
          
          const rebuiltRouteKey = routeParts.join('-');
          
          // Group by rebuilt route key
          if (!processedRouteResults[rebuiltRouteKey]) {
            processedRouteResults[rebuiltRouteKey] = [];
          }
          processedRouteResults[rebuiltRouteKey].push(itinerary);
        }
      }
      
      // Add all processed results to output
      for (const [rebuiltRouteKey, itineraries] of Object.entries(processedRouteResults)) {
        if (!output[rebuiltRouteKey]) output[rebuiltRouteKey] = {};
        
        // Group itineraries by date
        const itinerariesByDate: Record<string, string[][]> = {};
        for (const itinerary of itineraries) {
          // Find the date for this itinerary by checking the first flight
          const firstFlightUuid = itinerary[0];
          if (firstFlightUuid) {
            const firstFlight = flightMap.get(firstFlightUuid);
            if (firstFlight && firstFlight.DepartsAt) {
              // Get date from flight departure time
              const date = new Date(firstFlight.DepartsAt).toISOString().split('T')[0] || '';
              if (!itinerariesByDate[date]) itinerariesByDate[date] = [];
              itinerariesByDate[date].push(itinerary);
            }
          }
        }
        
        // Add to output by date
        for (const [date, dateItineraries] of Object.entries(itinerariesByDate)) {
          if (!output[rebuiltRouteKey][date]) output[rebuiltRouteKey][date] = [];
          output[rebuiltRouteKey][date]!.push(...dateItineraries);
          compositionCount += dateItineraries.length;
        }
      }
      segmentCount += segmentPairs.length;
    }
    const sequentialProcessingTime = Date.now() - t0;
    itineraryMetrics.phases.routeProcessing.totalMs = sequentialProcessingTime;
    itineraryMetrics.phases.routeProcessing.count = routes.length;
    itineraryMetrics.phases.routeProcessing.avgMs = routes.length ? sequentialProcessingTime / routes.length : 0;
    itineraryMetrics.totals.routesProcessed = routes.length;
    itineraryMetrics.totals.segmentsProcessed = segmentCount;
    itineraryMetrics.totals.itinerariesCreated = compositionCount;
  }

  const totalMs = Date.now() - start;
  itineraryMetrics.totals.totalTimeMs = totalMs;

  return { output, metrics: itineraryMetrics };
}