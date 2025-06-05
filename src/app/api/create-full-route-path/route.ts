import { NextRequest, NextResponse } from 'next/server';
import { createFullRoutePathSchema } from './schema';
import { createClient } from '@supabase/supabase-js';
import { getHaversineDistance, fetchAirportByIata, fetchPaths, fetchIntraRoutes, SupabaseClient } from '@/lib/route-helpers';
import { FullRoutePathResult, Path, IntraRoute } from '@/types/route';

// Use environment variables for Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Helper function to batch fetch intra routes
async function batchFetchIntraRoutes(
  supabase: SupabaseClient,
  pairs: { origin: string; destination: string }[]
): Promise<Record<string, IntraRoute[]>> {
  const uniquePairs = Array.from(new Set(pairs.map(p => `${p.origin}-${p.destination}`)));
  const allRoutes = await fetchIntraRoutes(supabase, '', '');
  const pairMap: Record<string, IntraRoute[]> = {};
  for (const pair of uniquePairs) {
    const [origin, destination] = pair.split('-');
    pairMap[pair] = allRoutes.filter(ir => ir.Origin === origin && ir.Destination === destination);
  }
  return pairMap;
}

// Helper to get total unique airports in a group (from + to)
function totalAirports(key: string, set: Set<string>) {
  // key is the from or to airport, set is the set of destinations or sources
  // Return the size of the set plus 1 (for the key itself)
  return set.size + 1;
}

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
          // Merge i into j
          merged[j].keys = Array.from(new Set([...merged[j].keys, ...merged[i].keys])).sort();
          // Remove i
          merged.splice(i, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return merged;
}

// Instead of grouping, explode all combinations of all1, all2, all3 for each route
// Helper to ensure value is array
function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Core route-finding logic for a single origin-destination pair.
 * Returns { routes, queryParamsArr, cached }
 */
async function getFullRoutePath({
  origin,
  destination,
  maxStop,
  supabase,
  useCache = true,
}: {
  origin: string;
  destination: string;
  maxStop: number;
  supabase: SupabaseClient;
  useCache?: boolean;
}): Promise<{ routes: any[]; queryParamsArr: string[]; cached: boolean }> {
  // 3. Fetch airport info
  const [originAirport, destinationAirport] = await Promise.all([
    fetchAirportByIata(supabase, origin),
    fetchAirportByIata(supabase, destination),
  ]);
  if (!originAirport || !destinationAirport) {
    throw new Error('Origin or destination airport not found');
  }
  // 3.5. Case 4: Direct intra_route (origin to destination)
  const results: FullRoutePathResult[] = [];
  const directIntraRoutes = await fetchIntraRoutes(supabase, origin, destination);
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
  // 4. Calculate direct distance
  const directDistance = getHaversineDistance(
    originAirport.latitude,
    originAirport.longitude,
    destinationAirport.latitude,
    destinationAirport.longitude
  );
  const maxDistance = 2 * directDistance;
  // 5. Get regions
  const originRegion = originAirport.region;
  const destinationRegion = destinationAirport.region;
  // 6. Fetch candidate paths
  const paths = await fetchPaths(supabase, originRegion, destinationRegion, maxDistance);
  // 7. Case 1: Direct path
  const case1Paths = paths.filter(
    (p) => p.origin === origin && p.destination === destination
  );
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
  // 8. Case 2A: path.destination === destination, path.origin != origin
  const case2APaths = paths.filter((p) => p.destination === destination && p.origin !== origin);
  if (case2APaths.length > 0) {
    const intraRoutesMap = await batchFetchIntraRoutes(supabase, 
      case2APaths.map(p => ({ origin, destination: p.origin }))
    );
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
  }
  // 9. Case 2B: path.origin === origin, path.destination != destination
  const case2BPaths = paths.filter((p) => p.origin === origin && p.destination !== destination);
  if (case2BPaths.length > 0) {
    const intraRoutesMap = await batchFetchIntraRoutes(supabase,
      case2BPaths.map(p => ({ origin: p.destination, destination }))
    );
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
  }
  // 10. Case 3: path.origin != origin && path.destination != destination
  const case3Paths = paths.filter((p) => p.origin !== origin && p.destination !== destination);
  if (case3Paths.length > 0) {
    // Prepare all pairs for batch fetching
    const allPairs = case3Paths.flatMap(p => [
      { origin, destination: p.origin },
      { origin: p.destination, destination }
    ]);
    const intraRoutesMap = await batchFetchIntraRoutes(supabase, allPairs);
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
  }
  // Filter by maxStop: only allow entries with at most (maxStop + 2) non-null, non-empty subentries among O, A, h1, h2, B, D
  // Also ensure each airport appears at most once
  const filteredResults = results.filter(route => {
    const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D]
      .filter(x => x !== null && typeof x === 'string' && x.trim() !== '');
    const stops = codes.length;
    const uniqueCodes = new Set(codes);
    return stops <= (maxStop + 2) && uniqueCodes.size === codes.length;
  });
  if (filteredResults.length === 0) {
    throw new Error('No valid route found for the given maxStop');
  }
  // For each filtered result, create all combinations of all1, all2, all3
  const explodedResults: any[] = [];
  for (const route of filteredResults) {
    const all1Arr = toArray(route.all1);
    const all2Arr = toArray(route.all2);
    const all3Arr = toArray(route.all3);
    // If any are empty, use [null] to preserve the slot
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
  // Group segments by departure airport (except those ending at input destination)
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

  // --- Advanced merging: merge groups where keys of one are a subset of another's, combining destinations ---
  let changed = true;
  while (changed) {
    changed = false;
    // Sort by keys length ascending (bottom-up)
    mergedGroups = mergedGroups.sort((a, b) => a.keys.length - b.keys.length);
    outer: for (let i = 0; i < mergedGroups.length; i++) {
      for (let j = i + 1; j < mergedGroups.length; j++) {
        const setI = new Set(mergedGroups[i].keys);
        const setJ = new Set(mergedGroups[j].keys);
        // If i's keys are a subset of j's keys
        if ([...setI].every(k => setJ.has(k))) {
          // Merge i's dests into j's dests (deduped)
          mergedGroups[j].dests = Array.from(new Set([...mergedGroups[j].dests, ...mergedGroups[i].dests])).sort();
          // The superset group (j) keeps its keys (origins)
          // Remove i (the subset group)
          mergedGroups.splice(i, 1);
          changed = true;
          break outer;
        }
        // If j's keys are a subset of i's keys, merge j into i
        if ([...setJ].every(k => setI.has(k))) {
          mergedGroups[i].dests = Array.from(new Set([...mergedGroups[i].dests, ...mergedGroups[j].dests])).sort();
          // The superset group (i) keeps its keys (origins)
          mergedGroups.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }

  // Generate query params
  const queryParamsArr = mergedGroups
    .sort((a, b) => b.dests.length - a.dests.length || a.keys.join('/').localeCompare(b.keys.join('/')))
    .map(g => `${g.keys.join('/')}-${g.dests.join('/')}`);
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

    // 2. Create Supabase client
    const clientStart = performance.now();
    const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);
    console.log(`Supabase client creation took: ${(performance.now() - clientStart).toFixed(2)}ms`);

    // 3. For each origin-destination pair, run the route-finding logic in parallel
    const pairPromises = [];
    for (const o of originList) {
      for (const d of destinationList) {
        pairPromises.push(getFullRoutePath({ origin: o, destination: d, maxStop, supabase }));
      }
    }
    const pairResults = await Promise.allSettled(pairPromises);

    const allRoutes: any[] = [];
    let anyError = null;
    for (const result of pairResults) {
      if (result.status === 'fulfilled') {
        allRoutes.push(...result.value.routes);
      } else {
        anyError = result.reason;
      }
    }
    if (allRoutes.length === 0) {
      return NextResponse.json({ error: 'No valid route found for any origin-destination pair', details: anyError ? (anyError as Error).message : undefined }, { status: 404 });
    }

    // 4. Generate queryParamsArr from the merged allRoutes
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

    // --- Advanced merging: only for input destination groups ---
    let mergedInputDestGroups = mergeGroups(inputDestGroups);
    let changed = true;
    while (changed) {
      changed = false;
      mergedInputDestGroups = mergedInputDestGroups.sort((a, b) => a.keys.length - b.keys.length);
      outer: for (let i = 0; i < mergedInputDestGroups.length; i++) {
        for (let j = i + 1; j < mergedInputDestGroups.length; j++) {
          const setI = new Set(mergedInputDestGroups[i].keys);
          const setJ = new Set(mergedInputDestGroups[j].keys);
          if ([...setI].every(k => setJ.has(k))) {
            mergedInputDestGroups[j].dests = Array.from(new Set([...mergedInputDestGroups[j].dests, ...mergedInputDestGroups[i].dests])).sort();
            mergedInputDestGroups.splice(i, 1);
            changed = true;
            break outer;
          }
          if ([...setJ].every(k => setI.has(k))) {
            mergedInputDestGroups[i].dests = Array.from(new Set([...mergedInputDestGroups[i].dests, ...mergedInputDestGroups[j].dests])).sort();
            mergedInputDestGroups.splice(j, 1);
            changed = true;
            break outer;
          }
        }
      }
    }

    // Combine merged input destination groups and other groups
    const finalGroups = [...mergedInputDestGroups, ...otherGroups];

    // Generate query params
    const queryParamsArr = finalGroups
      .sort((a, b) => b.dests.length - a.dests.length || a.keys.join('/').localeCompare(b.keys.join('/')))
      .map(g => `${g.keys.join('/')}-${g.dests.join('/')}`);
    // 5. Log the merged query params
    const queryParamsLog = `query params: {${queryParamsArr.map(s => `"${s}"`).join(",\n")}}`;
    console.log(queryParamsLog);
    console.log(`Total API execution time: ${(performance.now() - startTime).toFixed(2)}ms`);
    return NextResponse.json({ routes: allRoutes, queryParamsArr });
  } catch (err) {
    console.error(`Error occurred after ${(performance.now() - startTime).toFixed(2)}ms:`, err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 