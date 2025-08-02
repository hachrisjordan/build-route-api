import { NextRequest, NextResponse } from 'next/server';
import { createFullRoutePathSchema } from './schema';
import { createClient } from '@supabase/supabase-js';
import { getHaversineDistance, fetchAirportByIata, fetchPaths, fetchPathsOptimized, fetchPathsByMaxStop, fetchIntraRoutes, SupabaseClient, batchFetchAirportsByIata, batchFetchIntraRoutes } from '@/lib/route-helpers';
import { FullRoutePathResult, Path, IntraRoute } from '@/types/route';

// Use environment variables for Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// In-memory per-request caches
interface RoutePathCache {
  airport: Map<string, any>;
  intraRoute: Map<string, IntraRoute[]>;
  path: Map<string, Path[]>;
}

// Helper function to fetch airport with cache
async function fetchAirportCached(supabase: SupabaseClient, iata: string, cache: RoutePathCache) {
  if (cache.airport.has(iata)) return cache.airport.get(iata);
  const airport = await fetchAirportByIata(supabase, iata);
  cache.airport.set(iata, airport);
  return airport;
}

// Helper function to fetch intra routes with cache
async function fetchIntraRoutesCached(supabase: SupabaseClient, origin: string, destination: string, cache: RoutePathCache) {
  const key = `${origin}-${destination}`;
  if (cache.intraRoute.has(key)) return cache.intraRoute.get(key)!;
  const routes = await fetchIntraRoutes(supabase, origin, destination);
  cache.intraRoute.set(key, routes);
  return routes;
}

// Helper function to fetch paths with cache
async function fetchPathsCached(supabase: SupabaseClient, originRegion: string, destinationRegion: string, maxDistance: number, cache: RoutePathCache, origin: string, destination: string, maxStop: number) {
  const key = `${originRegion}-${destinationRegion}-${maxDistance}-${origin}-${destination}-${maxStop}`;
  if (cache.path.has(key)) return cache.path.get(key)!;
  
  // Use maxStop filtering for better performance with large datasets
  const paths = await fetchPathsByMaxStop(supabase, origin, destination, maxStop, originRegion, destinationRegion, maxDistance);
  
  cache.path.set(key, paths);
  return paths;
}

// Batch fetch all intra routes needed for a set of airport pairs
async function batchFetchIntraRoutesCached(
  supabase: SupabaseClient,
  pairs: { origin: string; destination: string }[],
  cache: RoutePathCache
): Promise<Record<string, IntraRoute[]>> {
  const uniquePairs = Array.from(new Set(pairs.map(p => `${p.origin}-${p.destination}`)));
  const pairMap: Record<string, IntraRoute[]> = {};
  
  // Check cache first
  const uncachedPairs = uniquePairs.filter(pair => !cache.intraRoute.has(pair));
  const cachedPairs = uniquePairs.filter(pair => cache.intraRoute.has(pair));
  
  // Get cached results
  cachedPairs.forEach(pair => {
    pairMap[pair] = cache.intraRoute.get(pair)!;
  });
  
  // Fetch uncached pairs in parallel
  if (uncachedPairs.length > 0) {
    const uncachedPairsArray = uncachedPairs.map(pair => {
      const [origin, destination] = pair.split('-');
      return { origin, destination };
    });
    
    const fetchedResults = await batchFetchIntraRoutes(supabase, uncachedPairsArray);
    
    // Store in cache and result map
    Object.entries(fetchedResults).forEach(([pair, routes]) => {
      cache.intraRoute.set(pair, routes);
      pairMap[pair] = routes;
    });
  }
  
  return pairMap;
}

// Helper to ensure value is array
function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Pre-fetch all airports for all origin-destination pairs
async function preFetchAirports(
  supabase: SupabaseClient,
  originList: string[],
  destinationList: string[],
  cache: RoutePathCache
): Promise<void> {
  const allAirportCodes = [...new Set([...originList, ...destinationList])];
  const airportsToFetch = allAirportCodes.filter(code => !cache.airport.has(code));
  
  if (airportsToFetch.length > 0) {
    const airportsMap = await batchFetchAirportsByIata(supabase, airportsToFetch);
    Object.entries(airportsMap).forEach(([code, airport]) => {
      cache.airport.set(code, airport);
    });
  }
}

// Proper mergeGroups function for grouping logic
function mergeGroups(groups: { keys: string[], dests: string[] }[]): { keys: string[], dests: string[] }[] {
  let merged = [...groups];
  let changed = true;
  
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i++) {
      for (let j = 0; j < merged.length; j++) {
        if (i === j) continue;
        
        // If i's dests are a subset of j's dests
        const setI = new Set(merged[i].dests);
        const setJ = new Set(merged[j].dests);
        if ([...setI].every(d => setJ.has(d))) {
          // Check if merging would exceed the 60 limit
          const combinedKeys = new Set([...merged[j].keys, ...merged[i].keys]);
          const combinedDests = new Set([...merged[j].dests, ...merged[i].dests]);
          if (combinedKeys.size * combinedDests.size <= 60) {
            // Merge i into j
            merged[j].keys = Array.from(combinedKeys).sort();
            merged[j].dests = Array.from(combinedDests).sort();
            // Remove i
            merged.splice(i, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
  }
  
  return merged;
}

// Helper function to check if a group exceeds the size limit
function exceedsSizeLimit(keys: string[], dests: string[]): boolean {
  return keys.length * dests.length > 60;
}

// Optimized route finding logic
async function getFullRoutePath({
  origin,
  destination,
  maxStop,
  supabase,
  cache,
}: {
  origin: string;
  destination: string;
  maxStop: number;
  supabase: SupabaseClient;
  cache: RoutePathCache;
}): Promise<{ routes: any[]; queryParamsArr: string[]; cached: boolean }> {
  const routeStart = performance.now();
  
  // Get airports from cache (pre-fetched)
  const originAirport = cache.airport.get(origin);
  const destinationAirport = cache.airport.get(destination);
  
  if (!originAirport || !destinationAirport) {
    throw new Error('Origin or destination airport not found');
  }

  const results: FullRoutePathResult[] = [];
  
  // Calculate direct distance and fetch paths in parallel
  const distanceStart = performance.now();
  const directDistance = getHaversineDistance(
    originAirport.latitude,
    originAirport.longitude,
    destinationAirport.latitude,
    destinationAirport.longitude
  );
  const maxDistance = 2 * directDistance;
  console.log(`[${origin}-${destination}] Distance calculation: ${(performance.now() - distanceStart).toFixed(2)}ms`);
  
  // Fetch all data in parallel
  const dataFetchStart = performance.now();
  const [directIntraRoutes, paths] = await Promise.all([
    fetchIntraRoutesCached(supabase, origin, destination, cache),
    fetchPathsCached(supabase, originAirport.region, destinationAirport.region, maxDistance, cache, origin, destination, maxStop)
  ]);
  console.log(`[${origin}-${destination}] Data fetch: ${(performance.now() - dataFetchStart).toFixed(2)}ms (${paths.length} paths, ${directIntraRoutes.length} direct routes)`);

  // Case 4: Direct intra_route (origin to destination)
  const case4Start = performance.now();
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
  console.log(`[${origin}-${destination}] Case 4 processing: ${(performance.now() - case4Start).toFixed(2)}ms`);

  // Case 1: Direct path
  const case1Start = performance.now();
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
  console.log(`[${origin}-${destination}] Case 1 processing: ${(performance.now() - case1Start).toFixed(2)}ms (${case1Paths.length} paths)`);

  // Prepare all intra route pairs for batch fetching
  const intraRoutePairs: { origin: string; destination: string }[] = [];
  
  // Case 2A: path.destination === destination, path.origin != origin
  const case2APaths = paths.filter(p => p.destination === destination && p.origin !== origin);
  case2APaths.forEach(p => intraRoutePairs.push({ origin, destination: p.origin }));
  
  // Case 2B: path.origin === origin, path.destination != destination
  const case2BPaths = paths.filter(p => p.origin === origin && p.destination !== destination);
  case2BPaths.forEach(p => intraRoutePairs.push({ origin: p.destination, destination }));
  
  // Case 3: path.origin != origin && path.destination != destination
  const case3Paths = paths.filter(p => p.origin !== origin && p.destination !== destination);
  case3Paths.forEach(p => {
    intraRoutePairs.push({ origin, destination: p.origin });
    intraRoutePairs.push({ origin: p.destination, destination });
  });

  console.log(`[${origin}-${destination}] Intra route pairs prepared: ${intraRoutePairs.length} pairs`);

  // Batch fetch all intra routes
  const intraFetchStart = performance.now();
  const intraRoutesMap = await batchFetchIntraRoutesCached(supabase, intraRoutePairs, cache);
  console.log(`[${origin}-${destination}] Intra routes fetch: ${(performance.now() - intraFetchStart).toFixed(2)}ms`);

  // Process Case 2A
  const case2AStart = performance.now();
  for (const p of case2APaths) {
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
  console.log(`[${origin}-${destination}] Case 2A processing: ${(performance.now() - case2AStart).toFixed(2)}ms`);

  // Process Case 2B
  const case2BStart = performance.now();
  for (const p of case2BPaths) {
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
  console.log(`[${origin}-${destination}] Case 2B processing: ${(performance.now() - case2BStart).toFixed(2)}ms`);

  // Process Case 3
  const case3Start = performance.now();
  for (const p of case3Paths) {
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
  console.log(`[${origin}-${destination}] Case 3 processing: ${(performance.now() - case3Start).toFixed(2)}ms`);

  // Filter by maxStop and ensure unique airports
  const filterStart = performance.now();
  const filteredResults = results.filter(route => {
    const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D]
      .filter(x => x !== null && typeof x === 'string' && x.trim() !== '');
    const stops = codes.length;
    const uniqueCodes = new Set(codes);
    return stops <= (maxStop + 2) && uniqueCodes.size === codes.length;
  });
  console.log(`[${origin}-${destination}] Filtering: ${(performance.now() - filterStart).toFixed(2)}ms (${results.length} → ${filteredResults.length} routes)`);

  if (filteredResults.length === 0) {
    throw new Error('No valid route found for the given maxStop');
  }

  // Explode all combinations of all1, all2, all3
  const explodeStart = performance.now();
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
  console.log(`[${origin}-${destination}] Explosion: ${(performance.now() - explodeStart).toFixed(2)}ms (${filteredResults.length} → ${explodedResults.length} routes)`);

  // Group segments by departure airport (except those ending at input destination)
  const groupingStart = performance.now();
  const segmentMap: Record<string, Set<string>> = {};
  // Group segments by destination (for those ending at input destination)
  const destMap: Record<string, Set<string>> = {};
  
  for (const route of explodedResults) {
    const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
    for (let i = 0; i < codes.length - 1; i++) {
      const from = codes[i];
      const to = codes[i + 1];
      if (to === destination) {
        if (!destMap[to]) destMap[to] = new Set();
        destMap[to].add(from);
      } else {
        if (!segmentMap[from]) segmentMap[from] = new Set();
        segmentMap[from].add(to);
      }
    }
  }

  // Build the initial groups
  const groups: { keys: string[], dests: string[] }[] = [];
  Object.entries(segmentMap).forEach(([from, tos]) => {
    groups.push({ keys: [from], dests: Array.from(tos).sort() });
  });
  Object.entries(destMap).forEach(([to, froms]) => {
    groups.push({ keys: Array.from(froms).sort(), dests: [to] });
  });

  // Merge groups
  let mergedGroups = mergeGroups(groups);

  // Advanced merging: merge groups where keys of one are a subset of another's, combining destinations
  let changed = true;
  while (changed) {
    changed = false;
    // Sort by keys length ascending (bottom-up)
    mergedGroups = mergedGroups.sort((a, b) => a.keys.length - b.keys.length);
    outer: for (let i = 0; i < mergedGroups.length; i++) {
      for (let j = 0; j < mergedGroups.length; j++) {
        if (i === j) continue;
        
        const setI = new Set(mergedGroups[i].keys);
        const setJ = new Set(mergedGroups[j].keys);
        // If i's keys are a subset of j's keys
        if ([...setI].every(k => setJ.has(k))) {
          // Check if merging would exceed the 60 limit
          const combinedKeys = new Set([...mergedGroups[j].keys, ...mergedGroups[i].keys]);
          const combinedDests = new Set([...mergedGroups[j].dests, ...mergedGroups[i].dests]);
          if (combinedKeys.size * combinedDests.size <= 60) {
            // Merge i's dests into j's dests (deduped)
            mergedGroups[j].dests = Array.from(combinedDests).sort();
            // The superset group (j) keeps its keys (origins)
            // Remove i (the subset group)
            mergedGroups.splice(i, 1);
            changed = true;
            break outer;
          }
        }
        // If j's keys are a subset of i's keys, merge j into i
        if ([...setJ].every(k => setI.has(k))) {
          // Check if merging would exceed the 60 limit
          const combinedKeys = new Set([...mergedGroups[i].keys, ...mergedGroups[j].keys]);
          const combinedDests = new Set([...mergedGroups[i].dests, ...mergedGroups[j].dests]);
          if (combinedKeys.size * combinedDests.size <= 60) {
            mergedGroups[i].dests = Array.from(combinedDests).sort();
            // The superset group (i) keeps its keys (origins)
            mergedGroups.splice(j, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
  }

  // Filter out groups that exceed the size limit
  mergedGroups = mergedGroups.filter(group => !exceedsSizeLimit(group.keys, group.dests));

  // Generate query params
  const queryParamsArr = mergedGroups
    .sort((a, b) => b.dests.length - a.dests.length || a.keys.join('/').localeCompare(b.keys.join('/')))
    .map(g => `${g.keys.join('/')}-${g.dests.join('/')}`);

  console.log(`[${origin}-${destination}] Grouping: ${(performance.now() - groupingStart).toFixed(2)}ms (${groups.length} → ${mergedGroups.length} groups)`);
  console.log(`[${origin}-${destination}] Total route processing: ${(performance.now() - routeStart).toFixed(2)}ms`);

  return { routes: explodedResults, queryParamsArr, cached: false };
}

export async function POST(req: NextRequest) {
  const startTime = performance.now();
  try {
    // 1. Validate input
    const validationStart = performance.now();
    const body = await req.json();
    const parseResult = createFullRoutePathSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    let { origin, destination, maxStop: inputMaxStop } = parseResult.data;
    const maxStop = Math.max(0, Math.min(4, inputMaxStop ?? 4));
    console.log(`Input validation took: ${(performance.now() - validationStart).toFixed(2)}ms`);

    // Support multi-origin/destination (slash-separated)
    const originList = origin.split('/').map((s: string) => s.trim()).filter(Boolean);
    const destinationList = destination.split('/').map((s: string) => s.trim()).filter(Boolean);
    if (originList.length === 0 || destinationList.length === 0) {
      return NextResponse.json({ error: 'Origin or destination cannot be empty' }, { status: 400 });
    }

    console.log(`Processing ${originList.length} origins × ${destinationList.length} destinations = ${originList.length * destinationList.length} pairs`);

    // 2. Create Supabase client
    const clientStart = performance.now();
    const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);
    console.log(`Supabase client creation took: ${(performance.now() - clientStart).toFixed(2)}ms`);

    // 2.5. Create per-request cache
    const cache: RoutePathCache = {
      airport: new Map(),
      intraRoute: new Map(),
      path: new Map(),
    };

    // 2.6. Pre-fetch all airports for all origin-destination pairs
    const preFetchStart = performance.now();
    await preFetchAirports(supabase, originList, destinationList, cache);
    console.log(`Pre-fetch airports took: ${(performance.now() - preFetchStart).toFixed(2)}ms`);
    console.log(`Airport cache size: ${cache.airport.size}`);

    // 3. Process all origin-destination pairs in parallel
    const pairProcessingStart = performance.now();
    const pairPromises = [];
    for (const o of originList) {
      for (const d of destinationList) {
        pairPromises.push(getFullRoutePath({ origin: o, destination: d, maxStop, supabase, cache }));
      }
    }
    const pairResults = await Promise.allSettled(pairPromises);
    console.log(`Pair processing took: ${(performance.now() - pairProcessingStart).toFixed(2)}ms`);

    const allRoutes: any[] = [];
    let anyError = null;
    for (const result of pairResults) {
      if (result.status === 'fulfilled') {
        allRoutes.push(...result.value.routes);
      } else {
        anyError = result.reason;
      }
    }
    console.log(`Total routes found: ${allRoutes.length}`);
    console.log(`Intra route cache size: ${cache.intraRoute.size}`);
    console.log(`Path cache size: ${cache.path.size}`);

    if (allRoutes.length === 0) {
      return NextResponse.json({ error: 'No valid route found for any origin-destination pair', details: anyError ? (anyError as Error).message : undefined }, { status: 404 });
    }

    // 4. Generate queryParamsArr from all routes
    const groupingStart = performance.now();
    // Group segments by departure airport (except those ending at any input destination)
    const segmentMap: Record<string, Set<string>> = {};
    // Group segments by destination (for those ending at any input destination)
    const destMap: Record<string, Set<string>> = {};
    
    for (const route of allRoutes) {
      const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
      for (let i = 0; i < codes.length - 1; i++) {
        const from = codes[i];
        const to = codes[i + 1];
        if (destinationList.includes(to)) {
          if (!destMap[to]) destMap[to] = new Set();
          destMap[to].add(from);
        } else {
          if (!segmentMap[from]) segmentMap[from] = new Set();
          segmentMap[from].add(to);
        }
      }
    }

    console.log(`Segment map size: ${Object.keys(segmentMap).length}`);
    console.log(`Destination map size: ${Object.keys(destMap).length}`);

    // Build the initial groups
    const groups: { keys: string[], dests: string[] }[] = [];
    Object.entries(segmentMap).forEach(([from, tos]) => {
      groups.push({ keys: [from], dests: Array.from(tos).sort() });
    });
    Object.entries(destMap).forEach(([to, froms]) => {
      groups.push({ keys: Array.from(froms).sort(), dests: [to] });
    });

    console.log(`Initial groups count: ${groups.length}`);

    // Merge groups
    const mergeStart = performance.now();
    let mergedGroups = mergeGroups(groups);
    console.log(`Basic merge took: ${(performance.now() - mergeStart).toFixed(2)}ms`);
    console.log(`After basic merge: ${mergedGroups.length} groups`);

    // Split mergedGroups into those with all dests in destinationList and the rest
    const [inputDestGroups, otherGroups] = mergedGroups.reduce<[
      { keys: string[]; dests: string[] }[],
      { keys: string[]; dests: string[] }[]
    ]>(
      (acc, group) => {
        if (group.dests.every(d => destinationList.includes(d))) {
          acc[0].push(group);
        } else {
          acc[1].push(group);
        }
        return acc;
      },
      [[], []]
    );

    console.log(`Input destination groups: ${inputDestGroups.length}, Other groups: ${otherGroups.length}`);

    // Advanced merging: only for input destination groups
    const advancedMergeStart = performance.now();
    let mergedInputDestGroups = mergeGroups(inputDestGroups);
    let changed = true;
    let mergeIterations = 0;
    while (changed) {
      changed = false;
      mergeIterations++;
      mergedInputDestGroups = mergedInputDestGroups.sort((a, b) => a.keys.length - b.keys.length);
      outer: for (let i = 0; i < mergedInputDestGroups.length; i++) {
        for (let j = i + 1; j < mergedInputDestGroups.length; j++) {
          const setI = new Set(mergedInputDestGroups[i].keys);
          const setJ = new Set(mergedInputDestGroups[j].keys);
          if ([...setI].every(k => setJ.has(k))) {
            // Check if merging would exceed the 60 limit
            const combinedKeys = new Set([...mergedInputDestGroups[j].keys, ...mergedInputDestGroups[i].keys]);
            const combinedDests = new Set([...mergedInputDestGroups[j].dests, ...mergedInputDestGroups[i].dests]);
            if (combinedKeys.size * combinedDests.size <= 60) {
              mergedInputDestGroups[j].dests = Array.from(combinedDests).sort();
              mergedInputDestGroups.splice(i, 1);
              changed = true;
              break outer;
            }
          }
          if ([...setJ].every(k => setI.has(k))) {
            // Check if merging would exceed the 60 limit
            const combinedKeys = new Set([...mergedInputDestGroups[i].keys, ...mergedInputDestGroups[j].keys]);
            const combinedDests = new Set([...mergedInputDestGroups[i].dests, ...mergedInputDestGroups[j].dests]);
            if (combinedKeys.size * combinedDests.size <= 60) {
              mergedInputDestGroups[i].dests = Array.from(combinedDests).sort();
              mergedInputDestGroups.splice(j, 1);
              changed = true;
              break outer;
            }
          }
        }
      }
    }
    console.log(`Advanced merge took: ${(performance.now() - advancedMergeStart).toFixed(2)}ms (${mergeIterations} iterations)`);
    console.log(`After advanced merge: ${mergedInputDestGroups.length} groups`);

    // Filter out groups that exceed the size limit
    const filterStart = performance.now();
    mergedInputDestGroups = mergedInputDestGroups.filter(group => !exceedsSizeLimit(group.keys, group.dests));
    let filteredOtherGroups = otherGroups.filter(group => !exceedsSizeLimit(group.keys, group.dests));
    console.log(`Filtering took: ${(performance.now() - filterStart).toFixed(2)}ms`);
    console.log(`After filtering: ${mergedInputDestGroups.length} input dest groups, ${filteredOtherGroups.length} other groups`);

    // Combine merged input destination groups and other groups
    const finalGroups = [...mergedInputDestGroups, ...filteredOtherGroups];

    // Generate query params
    const queryParamsStart = performance.now();
    const queryParamsArr = finalGroups
      .sort((a, b) => b.dests.length - a.dests.length || a.keys.join('/').localeCompare(b.keys.join('/')))
      .map(g => `${g.keys.join('/')}-${g.dests.join('/')}`);
    console.log(`Query params generation took: ${(performance.now() - queryParamsStart).toFixed(2)}ms`);

    console.log(`Grouping total took: ${(performance.now() - groupingStart).toFixed(2)}ms`);
    console.log(`Final query params count: ${queryParamsArr.length}`);

    console.log(`Total API execution time: ${(performance.now() - startTime).toFixed(2)}ms`);
    return NextResponse.json({ routes: allRoutes, queryParamsArr });
  } catch (err) {
    console.error(`Error occurred after ${(performance.now() - startTime).toFixed(2)}ms:`, err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 