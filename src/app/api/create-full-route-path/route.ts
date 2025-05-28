import { NextRequest, NextResponse } from 'next/server';
import { createFullRoutePathSchema } from './schema';
import { createClient } from '@supabase/supabase-js';
import { getHaversineDistance, fetchAirportByIata, fetchPaths, fetchIntraRoutes, SupabaseClient } from '../../../lib/route-helpers';
import { FullRoutePathResult, Path, IntraRoute } from '../../../types/route';
import Valkey from 'iovalkey';

// Use environment variables for Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// --- Valkey (iovalkey) setup ---
let valkey: any = null;
function getValkeyClient(): any {
  if (valkey) return valkey;
  const host = process.env.VALKEY_HOST;
  const port = process.env.VALKEY_PORT ? parseInt(process.env.VALKEY_PORT, 10) : 6379;
  const password = process.env.VALKEY_PASSWORD;
  if (!host) return null;
  valkey = new Valkey({ host, port, password });
  return valkey;
}

/**
 * Get cached route result from Valkey.
 */
async function getCachedRoute(origin: string, destination: string): Promise<FullRoutePathResult[] | null> {
  const client = getValkeyClient();
  if (!client) return null;
  try {
    const key = `route:${origin}:${destination}`;
    const cached = await client.get(key);
    if (cached) {
      return JSON.parse(cached) as FullRoutePathResult[];
    }
    return null;
  } catch (err) {
    console.error('Valkey cache get error:', err);
    return null;
  }
}

/**
 * Set cached route result in Valkey with TTL (15 min).
 */
async function setCachedRoute(origin: string, destination: string, data: FullRoutePathResult[]): Promise<void> {
  const client = getValkeyClient();
  if (!client) return;
  try {
    const key = `route:${origin}:${destination}`;
    await client.set(key, JSON.stringify(data), 'EX', 900); // 900s = 15min
  } catch (err) {
    console.error('Valkey cache set error:', err);
  }
}

// Helper function to batch fetch intra routes
async function batchFetchIntraRoutes(supabase: SupabaseClient, pairs: { origin: string; destination: string }[]) {
  const uniquePairs = Array.from(new Set(pairs.map(p => `${p.origin}-${p.destination}`)));
  const allRoutes = await fetchIntraRoutes(supabase, '', '');
  return uniquePairs.map(pair => {
    const [origin, destination] = pair.split('-');
    return allRoutes.find(ir => ir.Origin === origin && ir.Destination === destination);
  }).filter(Boolean) as IntraRoute[];
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
    const { origin, destination, maxStop: inputMaxStop } = parseResult.data;
    const maxStop = Math.max(0, Math.min(4, inputMaxStop ?? 4));
    console.log(`Input validation took: ${(performance.now() - validationStart).toFixed(2)}ms`);

    // 1.5. Try cache first
    const cacheStart = performance.now();
    const cached = await getCachedRoute(`${origin}:${maxStop}`, destination);
    if (cached) {
      // We need to reconstruct the mergedGroups logic for logging
      const segmentMap: Record<string, Set<string>> = {};
      const destMap: Record<string, Set<string>> = {};
      for (const route of cached) {
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
      const groups: { keys: string[], dests: string[] }[] = [];
      Object.entries(segmentMap).forEach(([from, tos]) => {
        groups.push({ keys: [from], dests: Array.from(tos).sort() });
      });
      Object.entries(destMap).forEach(([to, froms]) => {
        groups.push({ keys: Array.from(froms).sort(), dests: [to] });
      });
      const mergedGroups = mergeGroups(groups);
      const queryParamsArr = mergedGroups
        .sort((a, b) => b.dests.length - a.dests.length || a.keys.join('/').localeCompare(b.keys.join('/')))
        .map(g => `${g.keys.join('/')}-${g.dests.join('/')}`);
      const queryParamsLog = `query params: {${queryParamsArr.map(s => `"${s}"`).join(",\n")}}`;
      console.log(queryParamsLog);

      // Group cached results by (O, A, h1, h2, B, D) and aggregate all1, all2, all3 as arrays
      const groupedMap = new Map<string, any>();
      for (const route of cached) {
        const key = [route.O, route.A, route.h1, route.h2, route.B, route.D].join('|');
        if (!groupedMap.has(key)) {
          groupedMap.set(key, {
            O: route.O,
            A: route.A,
            h1: route.h1,
            h2: route.h2,
            B: route.B,
            D: route.D,
            all1: [],
            all2: [],
            all3: [],
            cumulativeDistance: route.cumulativeDistance,
            caseType: route.caseType,
          });
        }
        const group = groupedMap.get(key);
        if (route.all1 && !group.all1.includes(route.all1)) group.all1.push(route.all1);
        if (route.all2 && !group.all2.includes(route.all2)) group.all2.push(route.all2);
        if (route.all3 && !group.all3.includes(route.all3)) group.all3.push(route.all3);
      }
      const groupedResults = Array.from(groupedMap.values());
      return NextResponse.json({ routes: groupedResults, cached: true });
    }
    console.log(`Cache miss for ${origin}-${destination} (took ${(performance.now() - cacheStart).toFixed(2)}ms)`);

    // 2. Create Supabase client
    const clientStart = performance.now();
    const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);
    console.log(`Supabase client creation took: ${(performance.now() - clientStart).toFixed(2)}ms`);

    // 3. Fetch airport info
    const airportStart = performance.now();
    const [originAirport, destinationAirport] = await Promise.all([
      fetchAirportByIata(supabase, origin),
      fetchAirportByIata(supabase, destination),
    ]);
    if (!originAirport || !destinationAirport) {
      return NextResponse.json({ error: 'Origin or destination airport not found' }, { status: 404 });
    }
    console.log(`Airport info fetch took: ${(performance.now() - airportStart).toFixed(2)}ms`);

    // 4. Calculate direct distance
    const distanceStart = performance.now();
    const directDistance = getHaversineDistance(
      originAirport.latitude,
      originAirport.longitude,
      destinationAirport.latitude,
      destinationAirport.longitude
    );
    const maxDistance = 2 * directDistance;
    console.log(`Distance calculation took: ${(performance.now() - distanceStart).toFixed(2)}ms`);

    // 5. Get regions
    const regionStart = performance.now();
    const originRegion = originAirport.region;
    const destinationRegion = destinationAirport.region;
    console.log(`Region extraction took: ${(performance.now() - regionStart).toFixed(2)}ms`);

    // 6. Fetch candidate paths
    const pathsStart = performance.now();
    const paths = await fetchPaths(supabase, originRegion, destinationRegion, maxDistance);
    console.log(`Paths fetch took: ${(performance.now() - pathsStart).toFixed(2)}ms`);

    // 7. Case 1: Direct path
    const case1Start = performance.now();
    const case1Paths = paths.filter(
      (p) => p.origin === origin && p.destination === destination
    );
    const results: FullRoutePathResult[] = [];
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
    console.log(`Case 1 processing took: ${(performance.now() - case1Start).toFixed(2)}ms`);

    // 8. Case 2A: path.destination === destination, path.origin != origin
    const case2AStart = performance.now();
    const case2APaths = paths.filter((p) => p.destination === destination && p.origin !== origin);
    if (case2APaths.length > 0) {
      const intraRoutes = await batchFetchIntraRoutes(supabase, 
        case2APaths.map(p => ({ origin, destination: p.origin }))
      );
      
      for (const p of case2APaths) {
        const intraMatches = intraRoutes.filter(ir => ir.Origin === origin && ir.Destination === p.origin);
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
    console.log(`Case 2A processing took: ${(performance.now() - case2AStart).toFixed(2)}ms`);

    // 9. Case 2B: path.origin === origin, path.destination != destination
    const case2BStart = performance.now();
    const case2BPaths = paths.filter((p) => p.origin === origin && p.destination !== destination);
    if (case2BPaths.length > 0) {
      const intraRoutes = await batchFetchIntraRoutes(supabase,
        case2BPaths.map(p => ({ origin: p.destination, destination }))
      );

      for (const p of case2BPaths) {
        const intraMatches = intraRoutes.filter(ir => ir.Origin === p.destination && ir.Destination === destination);
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
    console.log(`Case 2B processing took: ${(performance.now() - case2BStart).toFixed(2)}ms`);

    // 10. Case 3: path.origin != origin && path.destination != destination
    const case3Start = performance.now();
    const case3Paths = paths.filter((p) => p.origin !== origin && p.destination !== destination);
    if (case3Paths.length > 0) {
      // Prepare all pairs for batch fetching
      const allPairs = case3Paths.flatMap(p => [
        { origin, destination: p.origin },
        { origin: p.destination, destination }
      ]);
      
      const intraRoutes = await batchFetchIntraRoutes(supabase, allPairs);

      for (const p of case3Paths) {
        const intraLeftMatches = intraRoutes.filter(ir => ir.Origin === origin && ir.Destination === p.origin);
        const intraRightMatches = intraRoutes.filter(ir => ir.Origin === p.destination && ir.Destination === destination);
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
    console.log(`Case 3 processing took: ${(performance.now() - case3Start).toFixed(2)}ms`);

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
      return NextResponse.json({ error: 'No valid route found for the given maxStop' }, { status: 404 });
    }

    // Store in cache (fire and forget)
    setCachedRoute(`${origin}:${maxStop}`, destination, filteredResults).catch((err) => {
      console.error('Valkey cache set error (non-blocking):', err);
    });

    // Group by (O, A, h1, h2, B, D) and aggregate all1, all2, all3 as arrays
    const groupedMap = new Map<string, any>();
    for (const route of filteredResults) {
      const key = [route.O, route.A, route.h1, route.h2, route.B, route.D].join('|');
      if (!groupedMap.has(key)) {
        groupedMap.set(key, {
          O: route.O,
          A: route.A,
          h1: route.h1,
          h2: route.h2,
          B: route.B,
          D: route.D,
          all1: [],
          all2: [],
          all3: [],
          cumulativeDistance: route.cumulativeDistance,
          caseType: route.caseType,
        });
      }
      const group = groupedMap.get(key);
      if (route.all1 && !group.all1.includes(route.all1)) group.all1.push(route.all1);
      if (route.all2 && !group.all2.includes(route.all2)) group.all2.push(route.all2);
      if (route.all3 && !group.all3.includes(route.all3)) group.all3.push(route.all3);
    }
    const groupedResults = Array.from(groupedMap.values());

    // Group segments by departure airport (except those ending at input destination)
    const segmentMap: Record<string, Set<string>> = {};
    // Group segments by destination (for those ending at input destination)
    const destMap: Record<string, Set<string>> = {};

    for (const route of groupedResults) {
      const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);

      for (let i = 0; i < codes.length - 1; i++) {
        const from = codes[i];
        const to = codes[i + 1];
        if (to === destination) {
          // Group by destination for segments ending at input destination
          if (!destMap[to]) destMap[to] = new Set();
          destMap[to].add(from);
        } else {
          // Group by departure for all other segments
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
    const mergedGroups = mergeGroups(groups);

    // Log the merged groups
    mergedGroups
      .sort((a, b) => b.dests.length - a.dests.length || a.keys.join('/').localeCompare(b.keys.join('/')))
      .forEach(g => {
        console.log(`${g.keys.join('/')}-${g.dests.join('/')}`);
      });

    // After mergedGroups is built and before returning response, log query params
    const queryParamsArr = mergedGroups
      .sort((a, b) => b.dests.length - a.dests.length || a.keys.join('/').localeCompare(b.keys.join('/')))
      .map(g => `${g.keys.join('/')}-${g.dests.join('/')}`);
    const queryParamsLog = `query params: {${queryParamsArr.map(s => `"${s}"`).join(",\n")}}`;
    console.log(queryParamsLog);

    console.log(`Total API execution time: ${(performance.now() - startTime).toFixed(2)}ms`);
    return NextResponse.json({ routes: groupedResults });
  } catch (err) {
    console.error(`Error occurred after ${(performance.now() - startTime).toFixed(2)}ms:`, err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 