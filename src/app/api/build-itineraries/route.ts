import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { FullRoutePathResult } from '@/types/route';
import { createHash } from 'crypto';
import zlib from 'zlib';
import Valkey from 'iovalkey';
import { parseISO, isBefore, isEqual, startOfDay, endOfDay } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import Redis from 'ioredis';
import { parse } from 'url';

function getClassPercentages(
  flights: any[],
  reliability?: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number = 100
) {
  // Calculate total flight duration (excluding layover time)
  const totalFlightDuration = flights.reduce((sum, f) => sum + f.TotalDuration, 0);
  
  if (!reliability) {
    // fallback to original logic if no reliability data
    // Y: 100% if all flights have YCount > 0, else 0%
    const y = flights.every(f => f.YCount > 0) ? 100 : 0;

    // W: percentage of total flight duration where WCount > 0
    let w = 0;
    if (flights.some(f => f.WCount > 0)) {
      const wDuration = flights.filter(f => f.WCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
      w = Math.round((wDuration / totalFlightDuration) * 100);
    }

    // J: percentage of total flight duration where JCount > 0
    let j = 0;
    if (flights.some(f => f.JCount > 0)) {
      const jDuration = flights.filter(f => f.JCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
      j = Math.round((jDuration / totalFlightDuration) * 100);
    }

    // F: percentage of total flight duration where FCount > 0
    let f = 0;
    if (flights.some(f => f.FCount > 0)) {
      const fDuration = flights.filter(f => f.FCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
      f = Math.round((fDuration / totalFlightDuration) * 100);
    }
    return { y, w, j, f };
  }

  // Apply the reliability rule: if segment > 15% of total flight time AND class shows triangle, count = 0
  const threshold = 0.15 * totalFlightDuration; // 15% of total flight duration
  
  // For each segment, adjust counts for each class as per the rule
  const adjusted = flights.map(f => {
    const code = f.FlightNumbers.slice(0, 2);
    const rel = reliability[code];
    const min = rel?.min_count ?? 1;
    const exemption = rel?.exemption || '';
    
    // Determine minimum counts for each class
    const minY = exemption.includes('Y') ? 1 : min;
    const minW = exemption.includes('W') ? 1 : min;
    const minJ = exemption.includes('J') ? 1 : min;
    const minF = exemption.includes('F') ? 1 : min;
    
    // Check if this segment is > 15% of total flight duration
    const overThreshold = f.TotalDuration > threshold;
    
    return {
      YCount: overThreshold && f.YCount < minY ? 0 : f.YCount,
      WCount: overThreshold && f.WCount < minW ? 0 : f.WCount,
      JCount: overThreshold && f.JCount < minJ ? 0 : f.JCount,
      FCount: overThreshold && f.FCount < minF ? 0 : f.FCount,
      TotalDuration: f.TotalDuration,
    };
  });

  // Now calculate percentages using the adjusted data
  const y = adjusted.every(f => f.YCount > 0) ? 100 : 0;
  
  let w = 0;
  if (adjusted.some(f => f.WCount > 0)) {
    const wDuration = adjusted.filter(f => f.WCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
    w = Math.round((wDuration / totalFlightDuration) * 100);
  }
  
  let j = 0;
  if (adjusted.some(f => f.JCount > 0)) {
    const jDuration = adjusted.filter(f => f.JCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
    j = Math.round((jDuration / totalFlightDuration) * 100);
  }
  
  let f = 0;
  if (adjusted.some(flt => flt.FCount > 0)) {
    const fDuration = adjusted.filter(flt => flt.FCount > 0).reduce((sum, flt) => sum + flt.TotalDuration, 0);
    f = Math.round((fDuration / totalFlightDuration) * 100);
  }
  
  return { y, w, j, f };
}

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

// --- Redis setup ---
const redis = new Redis({ host: '127.0.0.1', port: 6379 }); // Adjust host/port as needed
const CACHE_TTL_SECONDS = 1800; // 30 minutes

function getCacheKey(params: any) {
  const { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent } = params;
  const hash = createHash('sha256').update(JSON.stringify({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent })).digest('hex');
  return `build-itins:${origin}:${destination}:${hash}`;
}

async function cacheItineraries(key: string, data: any, ttlSeconds = CACHE_TTL_SECONDS) {
  const compressed = zlib.gzipSync(JSON.stringify(data));
  await redis.set(key, compressed, 'EX', ttlSeconds);
}

async function getCachedItineraries(key: string) {
  const compressed = await redis.getBuffer(key);
  if (!compressed) return null;
  const json = zlib.gunzipSync(compressed).toString();
  return JSON.parse(json);
}

// --- Helper: Parse comma-separated query param to array ---
function parseCsvParam(param: string | null): string[] {
  if (!param) return [];
  return param.split(',').map(s => s.trim()).filter(Boolean);
}

// --- Helper: Parse number array from CSV ---
function parseNumberCsvParam(param: string | null): number[] {
  return parseCsvParam(param).map(Number).filter(n => !isNaN(n));
}

// --- Sorting helpers (copied from client, self-contained) ---
function getTotalDuration(flights: (any | undefined)[]): number {
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

function getSortValue(
  card: any,
  flights: Record<string, any>,
  sortBy: string,
  reliability: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number
) {
  const flightObjs = card.itinerary.map((id: string) => flights[id]);
  if (sortBy === "duration") {
    return getTotalDuration(flightObjs);
  }
  if (sortBy === "departure") {
    return new Date(flightObjs[0].DepartsAt).getTime();
  }
  if (sortBy === "arrival") {
    return new Date(flightObjs[flightObjs.length - 1].ArrivesAt).getTime();
  }
  if (["y", "w", "j", "f"].includes(sortBy)) {
    return getClassPercentages(flightObjs, reliability, minReliabilityPercent)[sortBy as "y" | "w" | "j" | "f"];
  }
  return 0;
}

// --- Filtering, sorting, searching logic (server-side, matches client) ---
function filterSortSearchPaginate(
  cards: Array<{ route: string; date: string; itinerary: string[] }>,
  flights: Record<string, any>,
  reliability: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number,
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
  },
  getSortValue: (card: any, flights: Record<string, any>, sortBy: string, reliability: Record<string, { min_count: number; exemption?: string }>, minReliabilityPercent: number) => number,
  getTotalDuration: (flightsArr: any[]) => number,
  getClassPercentages: (flightsArr: any[], reliability: any, minReliabilityPercent: number) => { y: number; w: number; j: number; f: number }
) {
  let result = cards;
  // Stops
  if (query.stops && query.stops.length > 0) {
    result = result.filter(card => query.stops!.includes(card.route.split('-').length - 2));
  }
  // Airlines include/exclude
  if (query.includeAirlines && query.includeAirlines.length > 0) {
    result = result.filter(card => {
      const airlineCodes = card.itinerary.map(fid => flights[fid]?.FlightNumbers.slice(0, 2).toUpperCase());
      return airlineCodes.some(code => query.includeAirlines!.includes(code));
    });
  }
  if (query.excludeAirlines && query.excludeAirlines.length > 0) {
    result = result.filter(card => {
      const airlineCodes = card.itinerary.map(fid => flights[fid]?.FlightNumbers.slice(0, 2).toUpperCase());
      return !airlineCodes.some(code => query.excludeAirlines!.includes(code));
    });
  }
  // Duration
  if (typeof query.maxDuration === 'number') {
    result = result.filter(card => {
      const flightsArr = card.itinerary.map(fid => flights[fid]).filter(Boolean);
      return getTotalDuration(flightsArr) <= query.maxDuration!;
    });
  }
  // Cabin class percentages
  if (
    (typeof query.minYPercent === 'number' && query.minYPercent > 0) ||
    (typeof query.minWPercent === 'number' && query.minWPercent > 0) ||
    (typeof query.minJPercent === 'number' && query.minJPercent > 0) ||
    (typeof query.minFPercent === 'number' && query.minFPercent > 0)
  ) {
    result = result.filter(card => {
      const flightsArr = card.itinerary.map(fid => flights[fid]).filter(Boolean);
      if (flightsArr.length === 0) return false;
      const { y, w, j, f } = getClassPercentages(flightsArr, reliability, minReliabilityPercent);
      return (
        (typeof query.minYPercent !== 'number' || y >= query.minYPercent) &&
        (typeof query.minWPercent !== 'number' || w >= query.minWPercent) &&
        (typeof query.minJPercent !== 'number' || j >= query.minJPercent) &&
        (typeof query.minFPercent !== 'number' || f >= query.minFPercent)
      );
    });
  }
  // Departure/Arrival time
  if (typeof query.depTimeMin === 'number' || typeof query.depTimeMax === 'number' || typeof query.arrTimeMin === 'number' || typeof query.arrTimeMax === 'number') {
    result = result.filter(card => {
      const flightsArr = card.itinerary.map(fid => flights[fid]).filter(Boolean);
      if (!flightsArr.length) return false;
      const dep = new Date(flightsArr[0].DepartsAt).getTime();
      const arr = new Date(flightsArr[flightsArr.length - 1].ArrivesAt).getTime();
      if (typeof query.depTimeMin === 'number' && dep < query.depTimeMin) return false;
      if (typeof query.depTimeMax === 'number' && dep > query.depTimeMax) return false;
      if (typeof query.arrTimeMin === 'number' && arr < query.arrTimeMin) return false;
      if (typeof query.arrTimeMax === 'number' && arr > query.arrTimeMax) return false;
      return true;
    });
  }
  // Airport filters (include)
  if ((query.includeOrigin && query.includeOrigin.length) || (query.includeDestination && query.includeDestination.length) || (query.includeConnection && query.includeConnection.length)) {
    result = result.filter(card => {
      const segs = card.route.split('-');
      const origin = segs[0];
      const destination = segs[segs.length-1];
      const connections = segs.slice(1, -1);
      let match = true;
      if (query.includeOrigin && query.includeOrigin.length) match = match && query.includeOrigin.includes(origin);
      if (query.includeDestination && query.includeDestination.length) match = match && query.includeDestination.includes(destination);
      if (query.includeConnection && query.includeConnection.length) match = match && connections.some(c => query.includeConnection!.includes(c));
      return match;
    });
  }
  // Airport filters (exclude)
  if ((query.excludeOrigin && query.excludeOrigin.length) || (query.excludeDestination && query.excludeDestination.length) || (query.excludeConnection && query.excludeConnection.length)) {
    result = result.filter(card => {
      const segs = card.route.split('-');
      const origin = segs[0];
      const destination = segs[segs.length-1];
      const connections = segs.slice(1, -1);
      let match = true;
      if (query.excludeOrigin && query.excludeOrigin.length) match = match && !query.excludeOrigin.includes(origin);
      if (query.excludeDestination && query.excludeDestination.length) match = match && !query.excludeDestination.includes(destination);
      if (query.excludeConnection && query.excludeConnection.length) match = match && !connections.some(c => query.excludeConnection!.includes(c));
      return match;
    });
  }
  // Free-text search
  if (query.search && query.search.trim()) {
    const terms = query.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    result = result.filter(card => {
      return terms.every(term => {
        if (card.route.toLowerCase().includes(term)) return true;
        if (card.date.toLowerCase().includes(term)) return true;
        return card.itinerary.some(fid => {
          const flight = flights[fid];
          return flight && flight.FlightNumbers.toLowerCase().includes(term);
        });
      });
    });
  }
  // Sorting
  if (query.sortBy) {
    result = result.sort((a, b) => {
      const aVal = getSortValue(a, flights, query.sortBy!, reliability, minReliabilityPercent);
      const bVal = getSortValue(b, flights, query.sortBy!, reliability, minReliabilityPercent);
      if (aVal !== bVal) {
        // For arrival, y, w, j, f: always descending (higher is better)
        if (["arrival", "y", "w", "j", "f"].includes(query.sortBy!)) {
          return query.sortOrder === 'asc' ? bVal - aVal : bVal - aVal;
        }
        // For duration and departure: ascending (lower is better)
        if (["duration", "departure"].includes(query.sortBy!)) {
          return query.sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
        }
        // For all others, default
        return query.sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      }
      // Tiebreaker: total duration ascending
      const aFlights = a.itinerary.map((fid: string) => flights[fid]).filter(Boolean);
      const bFlights = b.itinerary.map((fid: string) => flights[fid]).filter(Boolean);
      const aDur = getTotalDuration(aFlights);
      const bDur = getTotalDuration(bFlights);
      return aDur - bDur;
    });
  }
  // Pagination
  const total = result.length;
  const page = query.page || 1;
  const pageSize = query.pageSize || 10;
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const pageData = result.slice(start, end);
  return { total, page, pageSize, data: pageData };
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
    const body = await req.json();
    const parseResult = buildItinerariesSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    let { origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers, minReliabilityPercent } = parseResult.data;
    if (typeof minReliabilityPercent !== 'number' || isNaN(minReliabilityPercent)) {
      minReliabilityPercent = 85;
    }

    // --- Extract query params for pagination/filter/sort/search ---
    const { searchParams } = new URL(req.url);
    // Stops
    const stops = parseNumberCsvParam(searchParams.get('stops'));
    // Airlines
    const includeAirlines = parseCsvParam(searchParams.get('includeAirlines')).map(s => s.toUpperCase());
    const excludeAirlines = parseCsvParam(searchParams.get('excludeAirlines')).map(s => s.toUpperCase());
    // Duration
    const maxDuration = searchParams.get('maxDuration') ? Number(searchParams.get('maxDuration')) : undefined;
    // Cabin class %
    const minYPercent = searchParams.get('minYPercent') ? Number(searchParams.get('minYPercent')) : undefined;
    const minWPercent = searchParams.get('minWPercent') ? Number(searchParams.get('minWPercent')) : undefined;
    const minJPercent = searchParams.get('minJPercent') ? Number(searchParams.get('minJPercent')) : undefined;
    const minFPercent = searchParams.get('minFPercent') ? Number(searchParams.get('minFPercent')) : undefined;
    // Dep/Arr time
    const depTimeMin = searchParams.get('depTimeMin') ? Number(searchParams.get('depTimeMin')) : undefined;
    const depTimeMax = searchParams.get('depTimeMax') ? Number(searchParams.get('depTimeMax')) : undefined;
    const arrTimeMin = searchParams.get('arrTimeMin') ? Number(searchParams.get('arrTimeMin')) : undefined;
    const arrTimeMax = searchParams.get('arrTimeMax') ? Number(searchParams.get('arrTimeMax')) : undefined;
    // Airport filters
    const includeOrigin = parseCsvParam(searchParams.get('includeOrigin'));
    const includeDestination = parseCsvParam(searchParams.get('includeDestination'));
    const includeConnection = parseCsvParam(searchParams.get('includeConnection'));
    const excludeOrigin = parseCsvParam(searchParams.get('excludeOrigin'));
    const excludeDestination = parseCsvParam(searchParams.get('excludeDestination'));
    const excludeConnection = parseCsvParam(searchParams.get('excludeConnection'));
    // Search
    const search = searchParams.get('search') || undefined;
    // Sort
    let sortBy = searchParams.get('sortBy') || undefined;
    let sortOrder = (searchParams.get('sortOrder') as 'asc' | 'desc') || 'asc';
    // Set default sort to duration if not provided
    if (!sortBy) {
      sortBy = 'duration';
      sortOrder = 'asc';
    }
    // Pagination
    let page = parseInt(searchParams.get('page') || '1', 10);
    page = isNaN(page) || page < 1 ? 1 : page;
    const pageSize = parseInt(searchParams.get('pageSize') || '10', 10);

    // --- Generate cache key ---
    const cacheKey = getCacheKey({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent });
    let cached = await getCachedItineraries(cacheKey);
    if (cached) {
      const { itineraries, flights, minRateLimitRemaining, minRateLimitReset, totalSeatsAeroHttpRequests } = cached;
      // Fetch reliability table for cached path too
      const reliabilityTable = await getReliabilityTableCached();
      const reliabilityMap = getReliabilityMap(reliabilityTable);
      // --- Flatten all itineraries into a single array for global sorting ---
      let allItins = [];
      for (const routeKey of Object.keys(itineraries)) {
        for (const date of Object.keys(itineraries[routeKey])) {
          allItins.push(...itineraries[routeKey][date].map((itinerary: string[]) => ({ route: routeKey, date, itinerary })));
        }
      }
      // --- Now sort allItins globally by the selected sort field ---
      const { total, data } = filterSortSearchPaginate(
        allItins,
        flights,
        reliabilityMap, // Pass the actual reliability data
        minReliabilityPercent,
        {
          stops,
          includeAirlines,
          excludeAirlines,
          maxDuration,
          minYPercent,
          minWPercent,
          minJPercent,
          minFPercent,
          depTimeMin,
          depTimeMax,
          arrTimeMin,
          arrTimeMax,
          includeOrigin,
          includeDestination,
          includeConnection,
          excludeOrigin,
          excludeDestination,
          excludeConnection,
          search,
          sortBy,
          sortOrder,
          page,
          pageSize,
        },
        (card, flights, sortBy, reliability, minReliabilityPercent) => {
          const flightsArr = card.itinerary.map((fid: string) => flights[fid]);
          if (sortBy === 'duration') {
            let total = 0;
            for (let i = 0; i < flightsArr.length; i++) {
              const flight = flightsArr[i];
              if (!flight) continue;
              total += flight.TotalDuration;
              if (i > 0 && flightsArr[i - 1]) {
                const prevArrive = new Date(flightsArr[i - 1].ArrivesAt).getTime();
                const currDepart = new Date(flight.DepartsAt).getTime();
                const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
                total += layover;
              }
            }
            return total;
          }
          if (sortBy === 'arrival') {
            return flightsArr.length ? new Date(flightsArr[flightsArr.length - 1].ArrivesAt).getTime() : 0;
          }
          if (sortBy === 'departure') {
            return flightsArr.length ? new Date(flightsArr[0].DepartsAt).getTime() : 0;
          }
          if (["y", "w", "j", "f"].includes(sortBy)) {
            const { y, w, j, f } = getClassPercentages(flightsArr, reliability, minReliabilityPercent);
            if (sortBy === 'y') return y;
            if (sortBy === 'w') return w;
            if (sortBy === 'j') return j;
            if (sortBy === 'f') return f;
          }
          return 0;
        },
        (flightsArr: any[]) => {
          let total = 0;
          for (let i = 0; i < flightsArr.length; i++) {
            const flight = flightsArr[i];
            if (!flight) continue;
            total += flight.TotalDuration;
            if (i > 0 && flightsArr[i - 1]) {
              const prevArrive = new Date(flightsArr[i - 1].ArrivesAt).getTime();
              const currDepart = new Date(flight.DepartsAt).getTime();
              const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
              total += layover;
            }
          }
          return total;
        },
        getClassPercentages
      );
      // Collect all unique flight UUIDs from current page
      const flightUUIDs = new Set<string>();
      data.forEach((card: { itinerary: string[] }) => {
        card.itinerary.forEach((uuid: string) => flightUUIDs.add(uuid));
      });
      const flightsPage: Record<string, any> = {};
      flightUUIDs.forEach(uuid => {
        if (flights[uuid]) flightsPage[uuid] = flights[uuid];
      });
      // Extract filter metadata from cached data
      const filterMetadata = extractFilterMetadata(itineraries, flights);
      
      return NextResponse.json({
        itineraries: data,
        flights: flightsPage,
        total,
        page,
        pageSize,
        minRateLimitRemaining,
        minRateLimitReset,
        totalSeatsAeroHttpRequests,
        filterMetadata,
      });
    }

    // If apiKey is null, fetch pro_key with largest remaining from Supabase
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
    const availabilityResults = await pool(availabilityTasks, 10);
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
      const itineraries = composeItineraries(segments, segmentAvail, alliances, flightMap);
      if (!output[routeKey]) output[routeKey] = {};
      for (const [date, itinerariesForDate] of Object.entries(itineraries)) {
        if (!output[routeKey][date]) output[routeKey][date] = [];
        output[routeKey][date].push(...itinerariesForDate);
      }
    }

    // Deduplicate itineraries for each date
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

    // Remove empty route keys after filtering
    Object.keys(output).forEach((key) => {
      if (!output[key] || Object.keys(output[key]).length === 0) {
        delete output[key];
      }
    });

    // Remove flights that are not in any itinerary (after all filtering)
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

    // Filter itineraries to only include those whose first flight departs between startDate and endDate (inclusive), using raw UTC date math
    const startDateObj = startOfDay(parseISO(startDate));
    const endDateObj = endOfDay(parseISO(endDate));
    for (const routeKey of Object.keys(output)) {
      for (const date of Object.keys(output[routeKey])) {
        output[routeKey][date] = output[routeKey][date].filter(itin => {
          if (!itin.length) return false;
          const firstFlightUUID = itin[0];
          const firstFlight = flightMap.get(firstFlightUUID);
          if (!firstFlight || !firstFlight.DepartsAt) return false;
          const depDate = new Date(firstFlight.DepartsAt);
          return depDate >= startDateObj && depDate <= endDateObj;
        });
        // Remove empty date keys
        if (output[routeKey][date].length === 0) {
          delete output[routeKey][date];
        }
      }
      // Remove empty route keys after filtering
      if (Object.keys(output[routeKey]).length === 0) {
        delete output[routeKey];
      }
    }

    // --- SERVER-SIDE RELIABILITY FILTERING ---
    // Fetch reliability table and filter itineraries
    const reliabilityTable = await getReliabilityTableCached();
    const reliabilityMap = getReliabilityMap(reliabilityTable);
    const filteredOutput = filterReliableItineraries(output, flightMap, reliabilityMap, minReliabilityPercent);
    // Remove empty route keys after filtering
    Object.keys(filteredOutput).forEach((key) => {
      if (!filteredOutput[key] || Object.keys(filteredOutput[key]).length === 0) {
        delete filteredOutput[key];
      }
    });

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
    
    // Extract filter metadata from the full response
    const filterMetadata = extractFilterMetadata(filteredOutput, Object.fromEntries(flightMap));
    
    // Cache the full result in Redis (compressed)
    await cacheItineraries(cacheKey, responseObj);
    // After building and caching, do the same filtering/sorting/searching/pagination
    let allItins: Array<{ route: string; date: string; itinerary: string[] }> = [];
    for (const routeKey of Object.keys(filteredOutput)) {
      for (const date of Object.keys(filteredOutput[routeKey])) {
        allItins.push(...(filteredOutput[routeKey][date] as string[][]).map((itinerary: string[]) => ({ route: routeKey, date, itinerary })));
      }
    }
    const { total, data } = filterSortSearchPaginate(
      allItins,
      Object.fromEntries(flightMap),
      reliabilityMap, // Pass the actual reliability data
      minReliabilityPercent,
      {
        stops,
        includeAirlines,
        excludeAirlines,
        maxDuration,
        minYPercent,
        minWPercent,
        minJPercent,
        minFPercent,
        depTimeMin,
        depTimeMax,
        arrTimeMin,
        arrTimeMax,
        includeOrigin,
        includeDestination,
        includeConnection,
        excludeOrigin,
        excludeDestination,
        excludeConnection,
        search,
        sortBy,
        sortOrder,
        page,
        pageSize,
      },
      // Only override for 'duration' and 'arrival', let default handle y/w/j/f
      (card, flights, sortBy, reliability, minReliabilityPercent) => {
        const flightsArr = card.itinerary.map((fid: string) => flights[fid]).filter(Boolean);
        if (sortBy === 'duration') {
          let total = 0;
          for (let i = 0; i < flightsArr.length; i++) {
            const flight = flightsArr[i];
            if (!flight) continue;
            total += flight.TotalDuration;
            if (i > 0 && flightsArr[i - 1]) {
              const prevArrive = new Date(flightsArr[i - 1].ArrivesAt).getTime();
              const currDepart = new Date(flight.DepartsAt).getTime();
              const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
              total += layover;
            }
          }
          return total;
        }
        if (sortBy === 'arrival') {
          return flightsArr.length ? new Date(flightsArr[flightsArr.length - 1].ArrivesAt).getTime() : 0;
        }
        if (sortBy === 'departure') {
          return flightsArr.length ? new Date(flightsArr[0].DepartsAt).getTime() : 0;
        }
        if (["y", "w", "j", "f"].includes(sortBy)) {
          const { y, w, j, f } = getClassPercentages(flightsArr, reliability, minReliabilityPercent);
          if (sortBy === 'y') return y;
          if (sortBy === 'w') return w;
          if (sortBy === 'j') return j;
          if (sortBy === 'f') return f;
        }
        return 0;
      },
      (flightsArr: any[]) => {
        let total = 0;
        for (let i = 0; i < flightsArr.length; i++) {
          const flight = flightsArr[i];
          if (!flight) continue;
          total += flight.TotalDuration;
          if (i > 0 && flightsArr[i - 1]) {
            const prevArrive = new Date(flightsArr[i - 1].ArrivesAt).getTime();
            const currDepart = new Date(flight.DepartsAt).getTime();
            const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
            total += layover;
          }
        }
        return total;
      },
      (flightsArr: any[], reliability: any, minReliabilityPercent: number) => {
        return { y: 100, w: 100, j: 100, f: 100 };
      }
    );
    // Collect all unique flight UUIDs from current page
    const flightUUIDs = new Set<string>();
    data.forEach((card: { itinerary: string[] }) => {
      card.itinerary.forEach((uuid: string) => flightUUIDs.add(uuid));
    });
    const flightsPage: Record<string, any> = {};
    const allFlights = Object.fromEntries(flightMap);
    flightUUIDs.forEach(uuid => {
      if (allFlights[uuid]) flightsPage[uuid] = allFlights[uuid];
    });
    return NextResponse.json({
      itineraries: data,
      flights: flightsPage,
      total,
      page,
      pageSize,
      minRateLimitRemaining,
      minRateLimitReset,
      totalSeatsAeroHttpRequests,
      filterMetadata,
    });
  } catch (err) {
    console.error('Error in /api/build-itineraries:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
}

// --- Helper: Extract filter metadata from full response ---
function extractFilterMetadata(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Record<string, AvailabilityFlight>
) {
  const metadata = {
    stops: new Set<number>(),
    airlines: new Set<string>(),
    airports: {
      origins: new Set<string>(),
      destinations: new Set<string>(),
      connections: new Set<string>(),
    },
    duration: {
      min: Infinity,
      max: -Infinity,
    },
    departure: {
      min: Infinity,
      max: -Infinity,
    },
    arrival: {
      min: Infinity,
      max: -Infinity,
    },
    cabinClasses: {
      y: { min: 0, max: 100 },
      w: { min: 0, max: 100 },
      j: { min: 0, max: 100 },
      f: { min: 0, max: 100 },
    },
  };

  // Process all itineraries to extract metadata
  for (const routeKey of Object.keys(itineraries)) {
    const routeSegments = routeKey.split('-');
    const stopCount = routeSegments.length - 2;
    metadata.stops.add(stopCount);

    // Extract airports
    metadata.airports.origins.add(routeSegments[0]);
    metadata.airports.destinations.add(routeSegments[routeSegments.length - 1]);
    for (let i = 1; i < routeSegments.length - 1; i++) {
      metadata.airports.connections.add(routeSegments[i]);
    }

    for (const date of Object.keys(itineraries[routeKey])) {
      for (const itinerary of itineraries[routeKey][date]) {
        const flightObjs = itinerary.map(uuid => flights[uuid]).filter(Boolean);
        if (flightObjs.length === 0) continue;

        // Extract airline codes
        flightObjs.forEach(flight => {
          const airlineCode = flight.FlightNumbers.slice(0, 2).toUpperCase();
          metadata.airlines.add(airlineCode);
        });

        // Calculate total duration (including layovers)
        let totalDuration = 0;
        for (let i = 0; i < flightObjs.length; i++) {
          totalDuration += flightObjs[i].TotalDuration;
          if (i > 0) {
            const prevArrive = new Date(flightObjs[i - 1].ArrivesAt).getTime();
            const currDepart = new Date(flightObjs[i].DepartsAt).getTime();
            const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
            totalDuration += layover;
          }
        }
        metadata.duration.min = Math.min(metadata.duration.min, totalDuration);
        metadata.duration.max = Math.max(metadata.duration.max, totalDuration);

        // Extract departure/arrival times
        const depTime = new Date(flightObjs[0].DepartsAt).getTime();
        const arrTime = new Date(flightObjs[flightObjs.length - 1].ArrivesAt).getTime();
        metadata.departure.min = Math.min(metadata.departure.min, depTime);
        metadata.departure.max = Math.max(metadata.departure.max, depTime);
        metadata.arrival.min = Math.min(metadata.arrival.min, arrTime);
        metadata.arrival.max = Math.max(metadata.arrival.max, arrTime);
      }
    }
  }

  // Convert sets to sorted arrays and handle edge cases
  return {
    stops: Array.from(metadata.stops).sort((a, b) => a - b),
    airlines: Array.from(metadata.airlines).sort(),
    airports: {
      origins: Array.from(metadata.airports.origins).sort(),
      destinations: Array.from(metadata.airports.destinations).sort(),
      connections: Array.from(metadata.airports.connections).sort(),
    },
    duration: {
      min: metadata.duration.min === Infinity ? 0 : metadata.duration.min,
      max: metadata.duration.max === -Infinity ? 0 : metadata.duration.max,
    },
    departure: {
      min: metadata.departure.min === Infinity ? Date.now() : metadata.departure.min,
      max: metadata.departure.max === -Infinity ? Date.now() : metadata.departure.max,
    },
    arrival: {
      min: metadata.arrival.min === Infinity ? Date.now() : metadata.arrival.min,
      max: metadata.arrival.max === -Infinity ? Date.now() : metadata.arrival.max,
    },
    cabinClasses: metadata.cabinClasses, // These will be calculated based on reliability rules
  };
} 