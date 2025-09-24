import { pool } from '@/lib/pool';
import type { FullRoutePathResult } from '@/types/route';
import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { composeItineraries } from '@/lib/itineraries/construction';

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
  options: { parallel: boolean }
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
      const segments: [string, string][] = [];
      for (let i = 0; i < codes.length - 1; i++) {
        const code1 = codes[i]!;
        const code2 = codes[i + 1]!;
        segments.push([code1, code2]);
      }
      const segmentAvail: AvailabilityGroup[][] = [];
      const alliances: (string[] | null)[] = [];
      for (const [from, to] of segments) {
        const segKey = `${from}-${to}`;
        const avail = segmentAvailability[segKey] || [];
        segmentAvail.push(avail);
        const allowedAlliances = Array.from(new Set(avail.map(g => g.alliance)));
        alliances.push(allowedAlliances.length ? allowedAlliances : null);
      }
      const t0 = Date.now();
      const routeResults = composeItineraries(segments, segmentAvail, alliances, flightMap, connectionMatrix);
      const t1 = Date.now();
      return { routeKey: codes.join('-'), routeResults, segCount: segments.length, compositionMs: t1 - t0 };
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
      const { routeKey, routeResults, segCount, compositionMs } = res;
      if (!output[routeKey]) output[routeKey] = {};
      for (const [date, itins] of Object.entries(routeResults)) {
        if (!output[routeKey][date]) output[routeKey][date] = [];
        output[routeKey][date]!.push(...itins);
        totalItinerariesCreated += itins.length;
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
      const segments: [string, string][] = [];
      for (let i = 0; i < codes.length - 1; i++) {
        segments.push([codes[i]!, codes[i + 1]!] );
      }
      const segmentAvail: AvailabilityGroup[][] = [];
      const alliances: (string[] | null)[] = [];
      for (const [from, to] of segments) {
        const segKey = `${from}-${to}`;
        const avail = segmentAvailability[segKey] || [];
        segmentAvail.push(avail);
        const allowedAlliances = Array.from(new Set(avail.map(g => g.alliance)));
        alliances.push(allowedAlliances.length ? allowedAlliances : null);
      }
      const routeResults = composeItineraries(segments, segmentAvail, alliances, flightMap, connectionMatrix);
      const routeKey = codes.join('-');
      if (!output[routeKey]) output[routeKey] = {};
      for (const [date, itins] of Object.entries(routeResults)) {
        if (!output[routeKey][date]) output[routeKey][date] = [];
        output[routeKey][date]!.push(...itins);
        compositionCount += itins.length;
      }
      segmentCount += segments.length;
    }
    const sequentialProcessingTime = Date.now() - t0;
    itineraryMetrics.phases.routeProcessing.totalMs = sequentialProcessingTime;
    itineraryMetrics.phases.routeProcessing.count = routes.length;
    itineraryMetrics.phases.routeProcessing.avgMs = routes.length ? sequentialProcessingTime / routes.length : 0;
    itineraryMetrics.totals.routesProcessed = routes.length;
    itineraryMetrics.totals.segmentsProcessed = segmentCount;
    itineraryMetrics.totals.itinerariesCreated = compositionCount;
  }

  return { output, itineraryMetrics };
}


