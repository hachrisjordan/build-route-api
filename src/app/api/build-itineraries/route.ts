import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { FullRoutePathResult } from '@/types/route';
import { createHash } from 'crypto';
import Valkey from 'iovalkey';

// Input validation schema
const buildItinerariesSchema = z.object({
  origin: z.string().min(2),
  destination: z.string().min(2),
  maxStop: z.number().min(0).max(4),
  startDate: z.string().min(8),
  endDate: z.string().min(8),
  apiKey: z.string().min(8),
  cabin: z.string().optional(),
  carriers: z.string().optional(),
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
  if (segments.length === 0 || segmentAvail.some(arr => arr.length === 0)) return results;

  // Helper: recursively build combinations
  function dfs(
    segIdx: number,
    path: string[],
    usedAirports: Set<string>,
    prevArrival: string | null,
    date: string
  ) {
    if (segIdx === segments.length) {
      // Valid itinerary
      if (!results[date]) results[date] = [];
      results[date].push([...path]);
      return;
    }
    const [from, to] = segments[segIdx];
    const allowedAlliances = alliances[segIdx];
    for (const group of segmentAvail[segIdx]) {
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
  const firstSegmentDates = new Set(segmentAvail[0].map(g => g.date));
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
  valkey = new Valkey({ host, port, password });
  return valkey;
}

async function saveRouteIdToRedis(routeId: string) {
  const client = getValkeyClient();
  if (!client) return;
  try {
    await client.sadd('availability_v2_routeids', routeId);
    await client.expire('availability_v2_routeids', 86400);
  } catch (err) {
    // Non-blocking, log only
    console.error('Valkey saveRouteIdToRedis error:', err);
  }
}

/**
 * POST /api/build-itineraries
 * Orchestrates route finding and availability composition.
 */
export async function POST(req: NextRequest) {
  try {
    // 1. Validate input
    const body = await req.json();
    const parseResult = buildItinerariesSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    const { origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers } = parseResult.data;

    // Build absolute base URL for internal fetches
    let baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    if (!baseUrl) {
      const proto = req.headers.get('x-forwarded-proto') || 'http';
      const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000';
      baseUrl = `${proto}://${host}`;
    }

    // 2. Call create-full-route-path API
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

    // 3. Extract query params (route groups)
    if (!Array.isArray(routePathData.queryParamsArr) || routePathData.queryParamsArr.length === 0) {
      return NextResponse.json({ error: 'No route groups found in create-full-route-path response' }, { status: 500 });
    }
    const routeGroups: string[] = routePathData.queryParamsArr;

    // 4. For each group, call availability-v2 in parallel (limit 10 at a time)
    const availabilityTasks = routeGroups.map((routeId) => async () => {
      // Save routeId to Redis/Valkey (non-blocking)
      saveRouteIdToRedis(routeId).catch(() => {});
      const params = {
        routeId,
        startDate,
        endDate,
        ...(cabin ? { cabin } : {}),
        ...(carriers ? { carriers } : {}),
      };
      try {
        const res = await fetch(`${baseUrl}/api/availability-v2`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'partner-authorization': apiKey,
          },
          body: JSON.stringify(params),
        });
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
    const availabilityResults = await pool(availabilityTasks, 10);

    // 5. Build a pool of all segment availabilities from all responses
    const segmentPool: Record<string, AvailabilityGroup[]> = {};
    for (const result of availabilityResults) {
      if (!result.error) {
        for (const group of result.data as AvailabilityGroup[]) {
          const segKey = `${group.originAirport}-${group.destinationAirport}`;
          if (!segmentPool[segKey]) segmentPool[segKey] = [];
          segmentPool[segKey].push(group);
        }
      }
    }

    // 6. Compose itineraries for each route path
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
      output[routeKey] = composeItineraries(segments, segmentAvail, alliances, flightMap);
    }

    // Remove empty route keys
    Object.keys(output).forEach((key) => {
      if (!output[key] || Object.keys(output[key]).length === 0) {
        delete output[key];
      }
    });

    // Return itineraries and flights map
    return NextResponse.json({ itineraries: output, flights: Object.fromEntries(flightMap) });
  } catch (err) {
    console.error('Error in /api/build-itineraries:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 