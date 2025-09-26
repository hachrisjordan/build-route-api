import { SupabaseClient } from '@/lib/route-helpers';
import { FullRoutePathResult, Path, IntraRoute } from '@/types/route';
import { getHaversineDistance } from '@/lib/route-helpers';
import { RoutePathCacheService } from './cache';
import { RouteGroupingService } from './grouping';
import { RoutePerformanceMonitor } from './performance';
import { ErrorHandlerService, RouteErrorType } from './error-handler';

/**
 * Input parameters for route calculation
 */
export interface RouteCalculationInput {
  origin: string;
  destination: string;
  maxStop: number;
  supabase: SupabaseClient;
  cacheService: RoutePathCacheService;
  sharedPathsKey?: string;
}

/**
 * Result of route calculation
 */
export interface RouteCalculationResult {
  routes: FullRoutePathResult[];
  queryParamsArr: string[];
  cached: boolean;
}

/**
 * Helper to ensure value is array
 */
function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Service for calculating full route paths
 */
export class RouteCalculatorService {
  readonly serviceName = 'RouteCalculatorService';
  readonly version = '1.0.0';

  /**
   * Calculate full route path for a given origin-destination pair
   */
  async calculateFullRoutePath(input: RouteCalculationInput): Promise<RouteCalculationResult> {
    const { origin, destination, maxStop, supabase, cacheService, sharedPathsKey } = input;
    const performanceMonitor = new RoutePerformanceMonitor(`${origin}-${destination}`);
    
    // Get airports from cache (pre-fetched)
    const originAirport = cacheService.cache.airport.get(origin);
    const destinationAirport = cacheService.cache.airport.get(destination);
    
    if (!originAirport || !destinationAirport) {
      const missingAirport = !originAirport ? origin : destination;
      throw ErrorHandlerService.createAirportNotFoundError(missingAirport);
    }

    const results: FullRoutePathResult[] = [];
    
    // Calculate direct distance and fetch paths in parallel
    performanceMonitor.startRoute('distance-calculation');
    const directDistance = getHaversineDistance(
      originAirport.latitude,
      originAirport.longitude,
      destinationAirport.latitude,
      destinationAirport.longitude
    );
    const maxDistance = 2 * directDistance;
    performanceMonitor.endRoute('distance-calculation');
    
    // Fetch direct intra routes and get shared paths
    performanceMonitor.startRoute('data-fetch');
    const directIntraRoutes = await cacheService.fetchIntraRoutesCached(supabase, origin, destination);
    
    // Use shared path data if available, otherwise fetch individually
    let paths: Path[];
    if (sharedPathsKey && cacheService.hasSharedPaths(sharedPathsKey)) {
      const allSharedPaths = cacheService.getSharedPaths(sharedPathsKey)!;
      // Filter shared paths for this specific pair and maxStop
      paths = allSharedPaths.filter(p => {
        // Apply maxStop filtering logic here
        if (maxStop === 0) {
          return p.origin === origin && p.destination === destination;
        } else if (maxStop === 1) {
          return (p.origin === origin || p.destination === destination) && p.type !== 'A-H-H-B';
        } else if (maxStop === 2) {
          return (p.type === 'A-H-H-B' && p.origin === origin && p.destination === destination) ||
                 (p.type === 'A-H-B' && (p.origin === origin || p.destination === destination)) ||
                 p.type === 'A-B' || p.type === 'A-A';
        }
        return true; // For maxStop > 2, include all
      });
      console.log(`[${origin}-${destination}] Using shared path data: ${paths.length} paths (filtered from ${allSharedPaths.length})`);
    } else {
      // Fallback to individual fetching
      paths = await cacheService.fetchPathsCached(supabase, originAirport.region, destinationAirport.region, maxDistance, origin, destination, maxStop);
    }
    
    performanceMonitor.endRoute('data-fetch', { 
      pathsCount: paths.length, 
      directRoutesCount: directIntraRoutes.length 
    });

    // Case 4: Direct intra_route (origin to destination)
    performanceMonitor.startRoute('case4-processing');
    if (directIntraRoutes.length > 0) {
      for (const intra of directIntraRoutes) {
        results.push({
          O: null,
          A: origin,
          h1: null,
          h2: null,
          B: destination,
          D: null,
          all1: intra.Alliance ?? null,
          all2: null,
          all3: null,
          cumulativeDistance: intra.Distance,
          caseType: 'case4',
        });
      }
    }
    performanceMonitor.endRoute('case4-processing');

    // Case 1: Direct path
    performanceMonitor.startRoute('case1-processing');
    const case1Paths = paths.filter(p => p.origin === origin && p.destination === destination);
    for (const p of case1Paths) {
      results.push({
        O: null,
        A: origin,
        h1: p.h1 ?? null,
        h2: p.h2 ?? null,
        B: destination,
        D: null,
        all1: null,
        all2: p.alliance,
        all3: null,
        cumulativeDistance: p.totalDistance,
        caseType: 'case1',
      });
    }
    performanceMonitor.endRoute('case1-processing', { pathsCount: case1Paths.length });

    // Prepare all intra route pairs for batch fetching
    const intraRoutePairs: { origin: string; destination: string }[] = [];
    
    // Case 2A: path.destination === destination, path.origin != origin
    const case2APaths = paths.filter(p => p.destination === destination && p.origin !== origin);
    case2APaths.forEach(p => {
      if (p.origin) intraRoutePairs.push({ origin, destination: p.origin });
    });
    
    // Case 2B: path.origin === origin, path.destination != destination
    const case2BPaths = paths.filter(p => p.origin === origin && p.destination !== destination);
    case2BPaths.forEach(p => {
      if (p.destination) intraRoutePairs.push({ origin: p.destination, destination });
    });
    
    // Case 3: path.origin != origin && path.destination != destination
    const case3Paths = paths.filter(p => p.origin !== origin && p.destination !== destination);
    case3Paths.forEach(p => {
      if (p.origin) intraRoutePairs.push({ origin, destination: p.origin });
      if (p.destination) intraRoutePairs.push({ origin: p.destination, destination });
    });

    console.log(`[${origin}-${destination}] Intra route pairs prepared: ${intraRoutePairs.length} pairs`);

    // Batch fetch all intra routes
    performanceMonitor.startRoute('intra-routes-fetch');
    const intraRoutesMap = await cacheService.batchFetchIntraRoutesCached(supabase, intraRoutePairs);
    performanceMonitor.endRoute('intra-routes-fetch', { pairsCount: intraRoutePairs.length });

    // Process Case 2A
    performanceMonitor.startRoute('case2a-processing');
    for (const p of case2APaths) {
      if (!p.origin) continue;
      const key = `${origin}-${p.origin}`;
      const intraMatches = intraRoutesMap[key] || [];
      for (const intra of intraMatches) {
        const cumulativeDistance = p.totalDistance + intra.Distance;
        if (cumulativeDistance <= maxDistance) {
          results.push({
            O: origin,
            A: p.origin,
            h1: p.h1 ?? null,
            h2: p.h2 ?? null,
            B: destination,
            D: null,
            all1: intra.Alliance,
            all2: p.alliance,
            all3: null,
            cumulativeDistance,
            caseType: 'case2A',
          });
        }
      }
    }
    performanceMonitor.endRoute('case2a-processing');

    // Process Case 2B
    performanceMonitor.startRoute('case2b-processing');
    for (const p of case2BPaths) {
      if (!p.destination) continue;
      const key = `${p.destination}-${destination}`;
      const intraMatches = intraRoutesMap[key] || [];
      for (const intra of intraMatches) {
        const cumulativeDistance = p.totalDistance + intra.Distance;
        if (cumulativeDistance <= maxDistance) {
          results.push({
            O: null,
            A: origin,
            h1: p.h1 ?? null,
            h2: p.h2 ?? null,
            B: p.destination,
            D: destination,
            all1: null,
            all2: p.alliance,
            all3: intra.Alliance,
            cumulativeDistance,
            caseType: 'case2B',
          });
        }
      }
    }
    performanceMonitor.endRoute('case2b-processing');

    // Process Case 3
    performanceMonitor.startRoute('case3-processing');
    for (const p of case3Paths) {
      if (!p.origin || !p.destination) continue;
      const leftKey = `${origin}-${p.origin}`;
      const rightKey = `${p.destination}-${destination}`;
      const intraLeftMatches = intraRoutesMap[leftKey] || [];
      const intraRightMatches = intraRoutesMap[rightKey] || [];
      
      for (const intraLeft of intraLeftMatches) {
        for (const intraRight of intraRightMatches) {
          const cumulativeDistance = p.totalDistance + intraLeft.Distance + intraRight.Distance;
          if (cumulativeDistance <= maxDistance) {
            results.push({
              O: origin,
              A: p.origin,
              h1: p.h1 ?? null,
              h2: p.h2 ?? null,
              B: p.destination,
              D: destination,
              all1: intraLeft.Alliance,
              all2: p.alliance,
              all3: intraRight.Alliance,
              cumulativeDistance,
              caseType: 'case3',
            });
          }
        }
      }
    }
    performanceMonitor.endRoute('case3-processing');

    // Filter by maxStop and ensure unique airports
    performanceMonitor.startRoute('filtering');
    const filteredResults = results.filter(route => {
      const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D]
        .filter(x => x !== null && typeof x === 'string' && x.trim() !== '');
      const stops = codes.length;
      const uniqueCodes = new Set(codes);
      return stops <= (maxStop + 2) && uniqueCodes.size === codes.length;
    });
    performanceMonitor.endRoute('filtering', { 
      inputCount: results.length, 
      outputCount: filteredResults.length 
    });

    if (filteredResults.length === 0) {
      throw ErrorHandlerService.createNoRoutesFoundError(origin, destination, maxStop);
    }

    // Explode all combinations of all1, all2, all3
    performanceMonitor.startRoute('explosion');
    const explodedResults: any[] = [];
    for (const route of filteredResults) {
      const all1Arr = toArray(route.all1);
      const all2Arr = toArray(route.all2);
      const all3Arr = toArray(route.all3);
      
      const all1Vals = all1Arr.length ? all1Arr : [null];
      const all2Vals = all2Arr.length ? all2Arr : [null];
      const all3Vals = all3Arr.length ? all3Arr : [null];
      
      for (const a1 of all1Vals) {
        for (const a2 of all2Vals) {
          for (const a3 of all3Vals) {
            explodedResults.push({
              O: route.O,
              A: route.A,
              h1: route.h1,
              h2: route.h2,
              B: route.B,
              D: route.D,
              all1: a1 !== null ? [a1] : [],
              all2: a2 !== null ? [a2] : [],
              all3: a3 !== null ? [a3] : [],
              cumulativeDistance: route.cumulativeDistance,
              caseType: route.caseType,
            });
          }
        }
      }
    }
    performanceMonitor.endRoute('explosion', { 
      inputCount: filteredResults.length, 
      outputCount: explodedResults.length 
    });

    // Group segments by departure airport (except those ending at input destination)
    performanceMonitor.startRoute('grouping');
    const segmentMap: Record<string, Set<string>> = {};
    // Group segments by destination (for those ending at input destination)
    const destMap: Record<string, Set<string>> = {};
    
    for (const route of explodedResults) {
      const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
      for (let i = 0; i < codes.length - 1; i++) {
        const from = codes[i]!; // Safe due to filter above
        const to = codes[i + 1]!; // Safe due to filter above
        if (to === destination) {
          if (!destMap[to]) destMap[to] = new Set();
          destMap[to].add(from);
        } else {
          if (!segmentMap[from]) segmentMap[from] = new Set();
          segmentMap[from].add(to);
        }
      }
    }

    // Use the grouping service for advanced merging
    const groupingService = new RouteGroupingService();
    const { groups, queryParams } = groupingService.processRouteGrouping(segmentMap, destMap);
    const queryParamsArr = queryParams;

    performanceMonitor.endRoute('grouping', { groupsCount: groups.length });
    performanceMonitor.logRouteSummary();

    return { routes: explodedResults, queryParamsArr, cached: false };
  }
}
