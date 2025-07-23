import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { FullRoutePathResult } from '@/types/route';
import { createHash } from 'crypto';
import zlib from 'zlib';
import Valkey from 'iovalkey';
import { parseISO, isBefore, isEqual, startOfDay, endOfDay } from 'date-fns';
import { createClient } from '@supabase/supabase-js';

// Input validation schema
const buildItinerariesSchema = z.object({
  origin: z.string().min(2),
  destination: z.string().min(2),
  maxStop: z.number().min(0).max(4),
  startDate: z.string().min(8),
  endDate: z.string().min(8),
  apiKey: z.string().min(8).nullable(),
  cabin: z.string().optional(),
  carriers: z.string().optional(),
  minReliabilityPercent: z.number().min(0).max(100).optional(),
});

// Types for availability response
interface AvailabilityFlight {
  FlightNumbers: string;
  TotalDuration: number;
  Aircraft: string;
  DepartsAt: string;
  ArrivesAt: string;
  YCount: number;
  WCount: number;
  JCount: number;
  FCount: number;
}

interface AvailabilityGroup {
  originAirport: string;
  destinationAirport: string;
  date: string;
  alliance: string;
  flights: AvailabilityFlight[];
}

function getFlightUUID(flight: AvailabilityFlight): string {
  const key = `${flight.FlightNumbers}|${flight.DepartsAt}|${flight.ArrivesAt}`;
  return createHash('md5').update(key).digest('hex');
}

/**
 * Compose all valid itineraries for a given route path.
 * @param segments Array of [from, to] pairs (e.g., [[HAN, SGN], [SGN, BKK]])
 * @param segmentAvail Array of arrays of AvailabilityGroup (one per segment)
 * @param alliances Array of arrays of allowed alliances for each segment
 * @param flightMap Map to store all unique flights
 * @returns Map of date to array of valid itineraries (each as array of UUIDs)
 */
function composeItineraries(
  segments: [string, string][],
  segmentAvail: AvailabilityGroup[][],
  alliances: (string[] | null)[],
  flightMap: Map<string, AvailabilityFlight>,
  minConnectionMinutes = 45
): Record<string, string[][]> {
  const results: Record<string, string[][]> = {};
  if (segments.length === 0 || segmentAvail.some(arr => arr.length === 0)) {
    return results;
  }
  // Helper: recursively build combinations
  function dfs(
    segIdx: number,
    path: string[],
    usedAirports: Set<string>,
    prevArrival: string | null,
    date: string
  ) {
    if (segIdx === segments.length) {
      if (!results[date]) results[date] = [];
      results[date].push([...path]);
      return;
    }
    const seg = segments[segIdx];
    if (!seg) {
      return;
    }
    const [from, to] = seg;
    const allowedAlliances = alliances[segIdx];
    const avail = segmentAvail[segIdx];
    if (!avail) {
      return;
    }
    for (const group of avail) {
      if (group.originAirport !== from || group.destinationAirport !== to) continue;
      // For the first segment, require group.date === date; for later segments, allow any date
      if (segIdx === 0 && group.date !== date) continue;
      for (const flight of group.flights) {
        // Only check for duplicate 'to' (destination), and for 'from' only if it's not the previous segment's destination
        if ((segIdx > 0 && usedAirports.has(to)) || (segIdx === 0 && usedAirports.has(from))) {
          continue;
        }
        // Alliance filter: if allowedAlliances is set and not empty, only allow those
        if (allowedAlliances && allowedAlliances.length > 0 && !allowedAlliances.includes(group.alliance)) {
          continue;
        }
        // Check connection time
        if (prevArrival) {
          const prev = new Date(prevArrival);
          const dep = new Date(flight.DepartsAt);
          const diffMinutes = (dep.getTime() - prev.getTime()) / 60000;
          if (diffMinutes < minConnectionMinutes || diffMinutes > 24 * 60) {
            continue;
          }
        }
        const uuid = getFlightUUID(flight);
        if (!flightMap.has(uuid)) {
          flightMap.set(uuid, flight);
        }
        usedAirports.add(from);
        usedAirports.add(to);
        path.push(uuid);
        dfs(segIdx + 1, path, usedAirports, flight.ArrivesAt, date);
        path.pop();
        usedAirports.delete(from);
        usedAirports.delete(to);
      }
    }
  }
  // For each possible date in the first segment, try to build full itineraries
  const firstAvail = segmentAvail[0];
  if (!firstAvail) {
    return results;
  }
  const firstSegmentDates = new Set(firstAvail.map(g => g.date));
  for (const date of firstSegmentDates) {
    dfs(0, [], new Set(), null, date);
    // Deduplicate itineraries for this date
    if (results[date]) {
      const seen = new Set<string>();
      results[date] = results[date].filter(itinerary => {
        const key = itinerary.join('>');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  return results;
}

// Simple concurrency pool for async tasks
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let i = 0;
  const executing: Promise<void>[] = [];
  async function run(task: () => Promise<T>) {
    const result = await task();
    results.push(result);
  }
  while (i < tasks.length) {
    while (executing.length < limit && i < tasks.length) {
      const p = run(tasks[i++]).finally(() => {
        const idx = executing.indexOf(p);
        if (idx > -1) executing.splice(idx, 1);
      });
      executing.push(p);
    }
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

// --- Valkey (iovalkey) setup ---
let valkey: any = null;
function getValkeyClient(): any {
  if (valkey) return valkey;
  const host = process.env.VALKEY_HOST;
  const port = process.env.VALKEY_PORT ? parseInt(process.env.VALKEY_PORT, 10) : 6379;
  const password = process.env.VALKEY_PASSWORD;
  if (!host) return null;
  valkey = new (require('iovalkey'))({ host, port, password });
  return valkey;
}
async function getCachedAvailabilityV2Response(params: any) {
  const client = getValkeyClient();
  if (!client) return null;
  try {
    const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const key = `availability-v2-response:${hash}`;
    const compressed = await client.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (err) {
    console.error('Valkey getCachedAvailabilityV2Response error:', err);
    return null;
  }
}

// --- Reliability Table In-Memory Cache ---
let reliabilityCache: any[] | null = null;
let reliabilityCacheTimestamp = 0;
const RELIABILITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getReliabilityTableCached() {
  const now = Date.now();
  if (reliabilityCache && now - reliabilityCacheTimestamp < RELIABILITY_CACHE_TTL_MS) {
    return reliabilityCache;
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return [];
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase.from('reliability').select('code, min_count, exemption');
  if (error) {
    console.error('Failed to fetch reliability table:', error);
    reliabilityCache = [];
  } else {
    reliabilityCache = data || [];
  }
  reliabilityCacheTimestamp = now;
  return reliabilityCache;
}

function getReliabilityMap(table: any[]): Record<string, { min_count: number; exemption?: string }> {
  const map: Record<string, { min_count: number; exemption?: string }> = {};
  for (const row of table) {
    map[row.code] = { min_count: row.min_count, exemption: row.exemption };
  }
  return map;
}

function isUnreliableFlight(flight: AvailabilityFlight, reliability: Record<string, { min_count: number; exemption?: string }>) {
  const code = flight.FlightNumbers.slice(0, 2).toUpperCase();
  const rel = reliability[code];
  const min = rel?.min_count ?? 1;
  const exemption = rel?.exemption || '';
  const minY = exemption.includes('Y') ? 1 : min;
  const minW = exemption.includes('W') ? 1 : min;
  const minJ = exemption.includes('J') ? 1 : min;
  const minF = exemption.includes('F') ? 1 : min;
  return (
    (flight.YCount < minY) &&
    (flight.WCount < minW) &&
    (flight.JCount < minJ) &&
    (flight.FCount < minF)
  );
}

function filterReliableItineraries(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Map<string, AvailabilityFlight>,
  reliability: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number
) {
  const filtered: Record<string, Record<string, string[][]>> = {};
  const usedFlightUUIDs = new Set<string>();
  for (const routeKey of Object.keys(itineraries)) {
    for (const date of Object.keys(itineraries[routeKey])) {
      const keptItins: string[][] = [];
      for (const itin of itineraries[routeKey][date]) {
        const flightsArr = itin.map(uuid => flights.get(uuid)).filter(Boolean) as AvailabilityFlight[];
        if (!flightsArr.length) continue;
        const totalDuration = flightsArr.reduce((sum, f) => sum + f.TotalDuration, 0);
        const unreliableDuration = flightsArr.filter(f => isUnreliableFlight(f, reliability)).reduce((sum, f) => sum + f.TotalDuration, 0);
        if (unreliableDuration === 0) {
          keptItins.push(itin);
          itin.forEach(uuid => usedFlightUUIDs.add(uuid));
          continue;
        }
        if (totalDuration === 0) continue;
        const unreliablePct = (unreliableDuration / totalDuration) * 100;
        if (unreliablePct <= (100 - minReliabilityPercent)) {
          keptItins.push(itin);
          itin.forEach(uuid => usedFlightUUIDs.add(uuid));
        }
      }
      if (keptItins.length) {
        if (!filtered[routeKey]) filtered[routeKey] = {};
        filtered[routeKey][date] = keptItins;
      }
    }
  }
  // Remove unused flights
  for (const uuid of Array.from(flights.keys())) {
    if (!usedFlightUUIDs.has(uuid)) {
      flights.delete(uuid);
    }
  }
  return filtered;
}

/**
 * POST /api/build-itineraries
 * Orchestrates route finding and availability composition.
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now(); // Track start time
  let usedProKey: string | null = null;
  let usedProKeyRowId: string | null = null;
  try {
    // 1. Validate input
    const tInputStart = Date.now();
    const body = await req.json();
    const parseResult = buildItinerariesSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    let { origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers, minReliabilityPercent } = parseResult.data;
    if (typeof minReliabilityPercent !== 'number' || isNaN(minReliabilityPercent)) {
      minReliabilityPercent = 85;
    }
    const tInputEnd = Date.now();
    console.log('[build-itineraries] input validation (ms):', tInputEnd - tInputStart);

    // If apiKey is null, fetch pro_key with largest remaining from Supabase
    const tApiKeyStart = Date.now();
    if (apiKey === null) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !supabaseServiceRoleKey) {
        return NextResponse.json({ error: 'Supabase credentials not set' }, { status: 500 });
      }
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
      // Get pro_key with largest remaining
      const { data, error } = await supabase
        .from('pro_key')
        .select('pro_key, remaining, last_updated')
        .order('remaining', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data || !data.pro_key) {
        return NextResponse.json({ error: 'No available pro_key found', details: error?.message }, { status: 500 });
      }
      apiKey = data.pro_key;
      usedProKey = data.pro_key;
      usedProKeyRowId = data.pro_key; // pro_key is the primary key
    }
    const tApiKeyEnd = Date.now();
    console.log('[build-itineraries] apiKey fetch (ms):', tApiKeyEnd - tApiKeyStart);

    // Build absolute base URL for internal fetches
    let baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    if (!baseUrl) {
      const proto = req.headers.get('x-forwarded-proto') || 'http';
      const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000';
      baseUrl = `${proto}://${host}`;
    }

    // 2. Call create-full-route-path API
    const tRoutePathStart = Date.now();
    const routePathRes = await fetch(`${baseUrl}/api/create-full-route-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, destination, maxStop }),
    });
    if (!routePathRes.ok) {
      return NextResponse.json({ error: 'Failed to fetch route paths' }, { status: 500 });
    }
    const routePathData = await routePathRes.json();
    const { routes } = routePathData;
    if (!routes || !Array.isArray(routes) || routes.length === 0) {
      return NextResponse.json({ error: 'No eligible routes found' }, { status: 404 });
    }
    const tRoutePathEnd = Date.now();
    console.log('[build-itineraries] route path fetch (ms):', tRoutePathEnd - tRoutePathStart);

    // 3. Extract query params (route groups)
    const tRouteGroupsStart = Date.now();
    if (!Array.isArray(routePathData.queryParamsArr) || routePathData.queryParamsArr.length === 0) {
      return NextResponse.json({ error: 'No route groups found in create-full-route-path response' }, { status: 500 });
    }
    const routeGroups: string[] = routePathData.queryParamsArr;
    const tRouteGroupsEnd = Date.now();
    console.log('[build-itineraries] route groups extraction (ms):', tRouteGroupsEnd - tRouteGroupsStart);

    // Log the number of seats.aero API links to run
    console.log('[build-itineraries] total seats.aero API links to run:', routeGroups.length);

    // 4. For each group, call availability-v2 in parallel (limit 10 at a time)
    let minRateLimitRemaining: number | null = null;
    let minRateLimitReset: number | null = null;
    const availabilityTasks = routeGroups.map((routeId) => async () => {
      const params = {
        routeId,
        startDate,
        endDate,
        ...(cabin ? { cabin } : {}),
        ...(carriers ? { carriers } : {}),
        ...(body.seats ? { seats: body.seats } : {}),
      };
      // Try Valkey cache first
      const cached = await getCachedAvailabilityV2Response(params);
      if (cached) {
        return { routeId, error: false, data: cached };
      }
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (typeof apiKey === 'string') {
          headers['partner-authorization'] = apiKey;
        }
        const res = await fetch(`${baseUrl}/api/availability-v2`, {
          method: 'POST',
          headers,
          body: JSON.stringify(params),
        });
        // Track rate limit headers
        const rlRemaining = res.headers.get('x-ratelimit-remaining');
        const rlReset = res.headers.get('x-ratelimit-reset');
        if (rlRemaining !== null) {
          const val = parseInt(rlRemaining, 10);
          if (!isNaN(val)) {
            if (minRateLimitRemaining === null || val < minRateLimitRemaining) {
              minRateLimitRemaining = val;
            }
          }
        }
        if (rlReset !== null) {
          const val = parseInt(rlReset, 10);
          if (!isNaN(val)) {
            if (minRateLimitReset === null || val < minRateLimitReset) {
              minRateLimitReset = val;
            }
          }
        }
        if (!res.ok) {
          return { routeId, error: true, data: [] };
        }
        const data = await res.json();
        return { routeId, error: false, data };
      } catch (err) {
        console.error(`Fetch error for routeId ${routeId}:`, err);
        return { routeId, error: true, data: [] };
      }
    });
    const tAvailStart = Date.now();
    const availabilityResults = await pool(availabilityTasks, 10);
    const tAvailEnd = Date.now();
    console.log('[build-itineraries] availability-v2 fetch (ms):', tAvailEnd - tAvailStart);
    const afterAvailabilityTime = Date.now(); // Time after fetching availability-v2

    // Sum up the total number of actual seats.aero HTTP requests (including paginated)
    let totalSeatsAeroHttpRequests = 0;
    for (const result of availabilityResults) {
      if (
        !result.error &&
        result.data &&
        typeof result.data === 'object' &&
        result.data !== null &&
        Array.isArray(result.data.groups) &&
        typeof result.data.seatsAeroRequests === 'number'
      ) {
        totalSeatsAeroHttpRequests += result.data.seatsAeroRequests;
      }
    }

    // 5. Build a pool of all segment availabilities from all responses
    const tSegmentPoolStart = Date.now();
    const segmentPool: Record<string, AvailabilityGroup[]> = {};
    for (const result of availabilityResults) {
      if (
        !result.error &&
        result.data &&
        typeof result.data === 'object' &&
        result.data !== null &&
        Array.isArray(result.data.groups)
      ) {
        for (const group of result.data.groups) {
          const segKey = `${group.originAirport}-${group.destinationAirport}`;
          if (!segmentPool[segKey]) segmentPool[segKey] = [];
          segmentPool[segKey].push(group);
        }
      }
    }
    const tSegmentPoolEnd = Date.now();
    console.log('[build-itineraries] segment pool build (ms):', tSegmentPoolEnd - tSegmentPoolStart);

    // 6. Compose itineraries for each route path
    const tComposeAllStart = Date.now();
    let totalValidItineraries = 0;
    let routePathCount = 0;
    const output: Record<string, Record<string, string[][]>> = {};
    const flightMap = new Map<string, AvailabilityFlight>();
    for (const route of routes as FullRoutePathResult[]) {
      // Decompose route into segments
      const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
      if (codes.length < 2) continue;
      const segments: [string, string][] = [];
      for (let i = 0; i < codes.length - 1; i++) {
        segments.push([codes[i], codes[i + 1]]);
      }
      // For each segment, get the corresponding availability from the pool
      const segmentAvail: AvailabilityGroup[][] = segments.map(([from, to]) => {
        const segKey = `${from}-${to}`;
        return segmentPool[segKey] || [];
      });
      // Alliance arrays: determine for each segment based on from/to
      const alliances: (string[] | null)[] = [];
      for (const [from, to] of segments) {
        if (route.O && route.A && from === route.O && to === route.A) {
          // O-A
          alliances.push(Array.isArray(route.all1) ? route.all1 : (route.all1 ? [route.all1] : null));
        } else if (route.B && route.D && from === route.B && to === route.D) {
          // B-D
          alliances.push(Array.isArray(route.all3) ? route.all3 : (route.all3 ? [route.all3] : null));
        } else {
          // All others
          alliances.push(Array.isArray(route.all2) ? route.all2 : (route.all2 ? [route.all2] : null));
        }
      }
      // Compose itineraries (now with UUIDs)
      const routeKey = codes.join('-');
      const itineraries = composeItineraries(segments, segmentAvail, alliances, flightMap);
      if (!output[routeKey]) output[routeKey] = {};
      for (const [date, itinerariesForDate] of Object.entries(itineraries)) {
        if (!output[routeKey][date]) output[routeKey][date] = [];
        output[routeKey][date].push(...itinerariesForDate);
        totalValidItineraries += itinerariesForDate.length;
      }
      routePathCount++;
    }
    const tComposeAllEnd = Date.now();
    console.log('[build-itineraries] route paths processed:', routePathCount);
    console.log('[build-itineraries] total valid itineraries:', totalValidItineraries);
    console.log('[build-itineraries] total composeItineraries time (ms):', tComposeAllEnd - tComposeAllStart);

    // Deduplicate itineraries for each date
    const tDedupStart = Date.now();
    for (const routeKey of Object.keys(output)) {
      for (const date of Object.keys(output[routeKey])) {
        const seen = new Set<string>();
        output[routeKey][date] = output[routeKey][date].filter(itin => {
          const key = itin.join('>');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    }
    const tDedupEnd = Date.now();
    console.log('[build-itineraries] deduplication (ms):', tDedupEnd - tDedupStart);

    // Remove empty route keys after filtering
    Object.keys(output).forEach((key) => {
      if (!output[key] || Object.keys(output[key]).length === 0) {
        delete output[key];
      }
    });

    // Remove flights that are not in any itinerary (after all filtering)
    const tFlightCleanupStart = Date.now();
    const usedFlightUUIDs = new Set<string>();
    for (const routeKey of Object.keys(output)) {
      for (const date of Object.keys(output[routeKey])) {
        for (const itin of output[routeKey][date]) {
          for (const uuid of itin) {
            usedFlightUUIDs.add(uuid);
          }
        }
      }
    }
    for (const uuid of Array.from(flightMap.keys())) {
      if (!usedFlightUUIDs.has(uuid)) {
        flightMap.delete(uuid);
      }
    }
    const tFlightCleanupEnd = Date.now();
    console.log('[build-itineraries] flight cleanup (ms):', tFlightCleanupEnd - tFlightCleanupStart);

    // Filter itineraries to only include those whose first flight departs between startDate and endDate (inclusive), using raw UTC date math
    const tDateFilterStart = Date.now();
    const startDateObj = startOfDay(parseISO(startDate));
    const endDateObj = endOfDay(parseISO(endDate));
    for (const routeKey of Object.keys(output)) {
      for (const date of Object.keys(output[routeKey])) {
        if (!output[routeKey][date]) continue;
        output[routeKey][date] = output[routeKey][date].filter(itin => {
          if (!itin.length) return false;
          const firstFlightUUID = itin[0];
          if (!firstFlightUUID) return false;
          const firstFlight = flightMap.get(firstFlightUUID);
          if (!firstFlight || !firstFlight.DepartsAt) return false;
          const depDate = new Date(firstFlight.DepartsAt);
          return depDate >= startDateObj && depDate <= endDateObj;
        });
        // Remove empty date keys
        if (!output[routeKey][date] || output[routeKey][date].length === 0) {
          delete output[routeKey][date];
        }
      }
      // Remove empty route keys after filtering
      if (Object.keys(output[routeKey]).length === 0) {
        delete output[routeKey];
      }
    }
    const tDateFilterEnd = Date.now();
    console.log('[build-itineraries] date filter (ms):', tDateFilterEnd - tDateFilterStart);

    // --- SERVER-SIDE RELIABILITY FILTERING ---
    const tReliabilityStart = Date.now();
    const reliabilityTable = await getReliabilityTableCached();
    const reliabilityMap = getReliabilityMap(reliabilityTable);
    const filteredOutput = filterReliableItineraries(output, flightMap, reliabilityMap, minReliabilityPercent);
    // Remove empty route keys after filtering
    Object.keys(filteredOutput).forEach((key) => {
      if (!filteredOutput[key] || Object.keys(filteredOutput[key]).length === 0) {
        delete filteredOutput[key];
      }
    });
    const tReliabilityEnd = Date.now();
    console.log('[build-itineraries] reliability filtering (ms):', tReliabilityEnd - tReliabilityStart);

    // After all processing, if we used a pro_key, update its remaining and last_updated
    if (usedProKey && usedProKeyRowId && typeof minRateLimitRemaining === 'number') {
      try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (supabaseUrl && supabaseServiceRoleKey) {
          const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
          const updateResult = await supabase
            .from('pro_key')
            .update({ remaining: minRateLimitRemaining, last_updated: new Date().toISOString() })
            .eq('pro_key', usedProKeyRowId);
          console.log(`[pro_key] Updated: pro_key=${usedProKeyRowId}, remaining=${minRateLimitRemaining}, last_updated=${new Date().toISOString()}`, updateResult);
        }
      } catch (err) {
        console.error('Failed to update pro_key remaining:', err);
      }
    }

    // Return itineraries and flights map
    const tResponseStart = Date.now();
    const itineraryBuildTimeMs = Date.now() - afterAvailabilityTime;
    const totalTimeMs = Date.now() - startTime;
    console.log(`[build-itineraries] itinerary build time (ms):`, itineraryBuildTimeMs);
    console.log(`[build-itineraries] total running time (ms):`, totalTimeMs);

    // --- RESPONSE COMPRESSION LOGIC ---
    const responseObj = {
      itineraries: filteredOutput,
      flights: Object.fromEntries(flightMap),
      minRateLimitRemaining,
      minRateLimitReset,
      totalSeatsAeroHttpRequests,
    };
    const jsonString = JSON.stringify(responseObj);
    const acceptEncoding = req.headers.get('accept-encoding') || '';
    let compressedBuffer: Buffer | null = null;
    let encoding: string | null = null;
    try {
      if (acceptEncoding.includes('br')) {
        // Brotli
        const zlib = await import('zlib');
        compressedBuffer = zlib.brotliCompressSync(Buffer.from(jsonString));
        encoding = 'br';
      } else if (acceptEncoding.includes('gzip')) {
        // Gzip
        const zlib = await import('zlib');
        compressedBuffer = zlib.gzipSync(Buffer.from(jsonString));
        encoding = 'gzip';
      }
    } catch (err) {
      console.error('Compression error:', err);
      compressedBuffer = null;
      encoding = null;
    }
    const tResponseEnd = Date.now();
    console.log('[build-itineraries] response serialization/compression (ms):', tResponseEnd - tResponseStart);
    if (compressedBuffer && encoding) {
      return new NextResponse(compressedBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': encoding,
          'Vary': 'Accept-Encoding',
        },
      });
    }
    // Fallback: uncompressed JSON
    return new NextResponse(jsonString, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Vary': 'Accept-Encoding',
      },
    });
  } catch (err) {
    console.error('Error in /api/build-itineraries:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 