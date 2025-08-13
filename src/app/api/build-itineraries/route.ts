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
import { CONCURRENCY_CONFIG, PERFORMANCE_MONITORING } from '@/lib/concurrency-config';

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

  // Apply the reliability rule: if segment > (100 - minReliabilityPercent)% of total flight time, mark as unreliable for percentage calculation
  const reliabilityThreshold = (100 - minReliabilityPercent) / 100; // Convert percentage to decimal
  const threshold = reliabilityThreshold * totalFlightDuration;
  
  // For each segment, adjust counts for each class as per the rule
  const adjusted = flights.map((f, index) => {
    const code = f.FlightNumbers.slice(0, 2);
    const rel = reliability[code];
    const min = rel?.min_count ?? 1;
    const exemption = rel?.exemption || '';
    
    // Determine minimum counts for each class
    const minY = exemption.includes('Y') ? 1 : min;
    const minW = exemption.includes('W') ? 1 : min;
    const minJ = exemption.includes('J') ? 1 : min;
    const minF = exemption.includes('F') ? 1 : min;
    
    // Check if this segment is > (100 - minReliabilityPercent)% of total flight duration
    const overThreshold = f.TotalDuration > threshold;
    
    // RULE: For percentage calculation, ANY segment over threshold is marked as unreliable
    // For itinerary filtering, middle segments that are unreliable disqualify the itinerary
    const isFirstSegment = index === 0;
    const isLastSegment = index === flights.length - 1;
    const isMiddleSegment = !isFirstSegment && !isLastSegment;
    
    // For percentage calculation: mark as unreliable if over threshold
    const markAsUnreliable = overThreshold;
    
    return {
      YCount: markAsUnreliable && f.YCount < minY ? 0 : f.YCount,
      WCount: markAsUnreliable && f.WCount < minW ? 0 : f.WCount,
      JCount: markAsUnreliable && f.JCount < minJ ? 0 : f.JCount,
      FCount: markAsUnreliable && f.FCount < minF ? 0 : f.FCount,
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

// UUID cache to avoid redundant hash calculations
const uuidCache = new Map<string, string>();

function getFlightUUID(flight: AvailabilityFlight): string {
  const key = `${flight.FlightNumbers}|${flight.DepartsAt}|${flight.ArrivesAt}`;
  
  // Check cache first
  let uuid = uuidCache.get(key);
  if (uuid) return uuid;
  
  // Generate and cache
  uuid = createHash('md5').update(key).digest('hex');
  uuidCache.set(key, uuid);
  
  // Prevent memory leaks by limiting cache size
  if (uuidCache.size > 50000) {
    // Clear oldest 10% of entries
    const keysToDelete = Array.from(uuidCache.keys()).slice(0, 5000);
    keysToDelete.forEach(k => uuidCache.delete(k));
  }
  
  return uuid;
}

/**
 * Optimized compose function with early filtering and reduced allocations
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

  // Pre-filter and index segments by from-to for faster lookups
  const segmentMap = new Map<string, { groups: AvailabilityGroup[]; allowedAlliances: string[] | null }>();
  for (let i = 0; i < segments.length; i++) {
    const [from, to] = segments[i];
    const key = `${from}-${to}`;
    const groups = segmentAvail[i]?.filter(g => g.originAirport === from && g.destinationAirport === to) || [];
    segmentMap.set(key, { groups, allowedAlliances: alliances[i] });
  }

  // Early termination if any segment has no valid groups
  if (segmentMap.size !== segments.length || Array.from(segmentMap.values()).some(seg => seg.groups.length === 0)) {
    return results;
  }

  // Use iterative approach instead of recursive for better performance
  const firstSegmentKey = `${segments[0][0]}-${segments[0][1]}`;
  const firstSegmentData = segmentMap.get(firstSegmentKey);
  if (!firstSegmentData) return results;

  // Group flights by date for faster processing
  const flightsByDate = new Map<string, AvailabilityFlight[]>();
  for (const group of firstSegmentData.groups) {
    if (!flightsByDate.has(group.date)) {
      flightsByDate.set(group.date, []);
    }
    // Pre-filter by alliance
    const validFlights = firstSegmentData.allowedAlliances && firstSegmentData.allowedAlliances.length > 0
      ? group.flights.filter(f => firstSegmentData.allowedAlliances!.includes(group.alliance))
      : group.flights;
    flightsByDate.get(group.date)!.push(...validFlights);
  }

  // Build itineraries for each date
  for (const [date, firstFlights] of flightsByDate) {
    const dateResults: string[][] = [];
    
    // Use stack-based iteration instead of recursion
    const stack: {
      segIdx: number;
      path: string[];
      usedAirports: Set<string>;
      prevArrival: string | null;
    }[] = [];

    // Initialize with first segment flights
    for (const flight of firstFlights) {
      const uuid = getFlightUUID(flight);
      if (!flightMap.has(uuid)) {
        flightMap.set(uuid, flight);
      }
      const [from, to] = segments[0];
      stack.push({
        segIdx: 1,
        path: [uuid],
        usedAirports: new Set([from, to]),
        prevArrival: flight.ArrivesAt
      });
    }

    // Process stack
    while (stack.length > 0) {
      const current = stack.pop()!;
      
      if (current.segIdx === segments.length) {
        // Complete itinerary found
        dateResults.push([...current.path]);
        continue;
      }

      const [from, to] = segments[current.segIdx];
      const segmentKey = `${from}-${to}`;
      const segmentData = segmentMap.get(segmentKey);
      if (!segmentData) continue;

      // Skip if destination already visited (avoid loops)
      if (current.usedAirports.has(to)) continue;

      for (const group of segmentData.groups) {
        // Alliance filter
        if (segmentData.allowedAlliances && segmentData.allowedAlliances.length > 0 && 
            !segmentData.allowedAlliances.includes(group.alliance)) {
          continue;
        }

        for (const flight of group.flights) {
          // Connection time check with cached Date objects
          if (current.prevArrival) {
            const prevTime = new Date(current.prevArrival).getTime();
            const depTime = new Date(flight.DepartsAt).getTime();
            const diffMinutes = (depTime - prevTime) / 60000;
            if (diffMinutes < minConnectionMinutes || diffMinutes > 24 * 60) {
              continue;
            }
          }

          const uuid = getFlightUUID(flight);
          if (!flightMap.has(uuid)) {
            flightMap.set(uuid, flight);
          }

          // Create new state for next iteration
          const newUsedAirports = new Set(current.usedAirports);
          newUsedAirports.add(to);
          
          stack.push({
            segIdx: current.segIdx + 1,
            path: [...current.path, uuid],
            usedAirports: newUsedAirports,
            prevArrival: flight.ArrivesAt
          });
        }
      }
    }

    // Deduplicate using more efficient method
    if (dateResults.length > 0) {
      const uniqueResults = Array.from(
        new Map(dateResults.map(itin => [itin.join('>'), itin])).values()
      );
      results[date] = uniqueResults;
    }
  }

  return results;
}

// Optimized concurrency pool with better memory management
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  if (tasks.length === 0) return [];
  if (tasks.length <= limit) {
    // If tasks are fewer than limit, run all in parallel
    return Promise.all(tasks.map(task => task()));
  }

  const results: T[] = new Array(tasks.length);
  let completed = 0;
  let started = 0;
  
  return new Promise((resolve, reject) => {
    const startNext = () => {
      if (started >= tasks.length) return;
      
      const index = started++;
      const task = tasks[index];
      
      task()
        .then(result => {
          results[index] = result;
          completed++;
          
          if (completed === tasks.length) {
            resolve(results);
          } else {
            startNext();
          }
        })
        .catch(reject);
    };
    
    // Start initial batch
    for (let i = 0; i < Math.min(limit, tasks.length); i++) {
      startNext();
    }
  });
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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/[^\x00-\x7F]/g, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/[^\x00-\x7F]/g, '');
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
    const routeItineraries = itineraries[routeKey];
    if (!routeItineraries) continue;
    for (const date of Object.keys(routeItineraries)) {
      const dateItineraries = routeItineraries[date];
      if (!dateItineraries) continue;
      const keptItins: string[][] = [];
      for (const itin of dateItineraries) {
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
let redis: Redis | null = null;

function getRedisClient(): Redis | null {
  if (redis) return redis;
  
  // Hardcoded Redis connection for Docker
  const host = 'redis'; // Docker service name
  const port = 6379;    // Container port
  const password = process.env.REDIS_PASSWORD;
  
  try {
    redis = new Redis({ 
      host, 
      port, 
      password: password || undefined,
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: true
    });
    
    redis.on('error', (err) => {
      console.warn('Redis connection error:', err.message);
    });
    
    return redis;
  } catch (error) {
    console.warn('Failed to create Redis client:', error);
    return null;
  }
}

const CACHE_TTL_SECONDS = 1800; // 30 minutes

function getCacheKey(params: any) {
  const { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent } = params;
  const hash = createHash('sha256').update(JSON.stringify({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent })).digest('hex');
  return `build-itins:${origin}:${destination}:${hash}`;
}

async function cacheItineraries(key: string, data: any, ttlSeconds = CACHE_TTL_SECONDS) {
  const redisClient = getRedisClient();
  if (!redisClient) return;
  
  try {
    const compressed = zlib.gzipSync(JSON.stringify(data));
    await redisClient.set(key, compressed, 'EX', ttlSeconds);
  } catch (error) {
    console.warn('Failed to cache data:', error);
  }
}

async function getCachedItineraries(key: string) {
  const redisClient = getRedisClient();
  if (!redisClient) return null;
  
  try {
    const compressed = await redisClient.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (error) {
    console.warn('Failed to get cached data:', error);
    return null;
  }
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
      const origin = segs[0] || '';
      const destination = segs[segs.length-1] || '';
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
      const origin = segs[0] || '';
      const destination = segs[segs.length-1] || '';
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

// --- Optimized caching with filter parameters ---
function getOptimizedCacheKey(params: any, filterParams: any) {
  const { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent } = params;
  const baseHash = createHash('sha256').update(JSON.stringify({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent })).digest('hex');
  
  // Include filter parameters in cache key for smart caching
  const filterHash = createHash('sha256').update(JSON.stringify(filterParams)).digest('hex');
  return `build-itins:${origin}:${destination}:${baseHash}:${filterHash}`;
}

// --- Optimized data structure and processing ---
interface OptimizedItinerary {
  route: string;
  date: string;
  itinerary: string[];
  // Pre-computed values for faster filtering/sorting
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

// --- Pre-compute itinerary metadata for faster processing ---
function precomputeItineraryMetadata(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Record<string, AvailabilityFlight>,
  reliability: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number
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
        
        // Pre-compute expensive values
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

// --- Optimized filtering and sorting (single-pass processing) ---
function optimizedFilterSortSearchPaginate(
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
  
  // Single-pass filtering with early termination
  if (query.stops?.length || query.includeAirlines?.length || query.excludeAirlines?.length || 
      query.maxDuration !== undefined || query.minYPercent !== undefined || query.minWPercent !== undefined || 
      query.minJPercent !== undefined || query.minFPercent !== undefined || query.depTimeMin !== undefined || 
      query.depTimeMax !== undefined || query.arrTimeMin !== undefined || query.arrTimeMax !== undefined ||
      query.includeOrigin?.length || query.includeDestination?.length || query.includeConnection?.length ||
      query.excludeOrigin?.length || query.excludeDestination?.length || query.excludeConnection?.length) {
    
    result = result.filter(item => {
      // Stops filter
      if (query.stops?.length && !query.stops.includes(item.stopCount)) return false;
      
      // Airlines filter
      if (query.includeAirlines?.length && !item.airlineCodes.some(code => query.includeAirlines!.includes(code))) return false;
      if (query.excludeAirlines?.length && item.airlineCodes.some(code => query.excludeAirlines!.includes(code))) return false;
      
      // Duration filter
      if (query.maxDuration !== undefined && item.totalDuration > query.maxDuration) return false;
      
      // Cabin class filters
      if (query.minYPercent !== undefined && item.classPercentages.y < query.minYPercent) return false;
      if (query.minWPercent !== undefined && item.classPercentages.w < query.minWPercent) return false;
      if (query.minJPercent !== undefined && item.classPercentages.j < query.minJPercent) return false;
      if (query.minFPercent !== undefined && item.classPercentages.f < query.minFPercent) return false;
      
      // Time filters
      if (query.depTimeMin !== undefined && item.departureTime < query.depTimeMin) return false;
      if (query.depTimeMax !== undefined && item.departureTime > query.depTimeMax) return false;
      if (query.arrTimeMin !== undefined && item.arrivalTime < query.arrTimeMin) return false;
      if (query.arrTimeMax !== undefined && item.arrivalTime > query.arrTimeMax) return false;
      
      // Airport filters
      if (query.includeOrigin?.length && !query.includeOrigin.includes(item.origin)) return false;
      if (query.includeDestination?.length && !query.includeDestination.includes(item.destination)) return false;
      if (query.includeConnection?.length && !item.connections.some(c => query.includeConnection!.includes(c))) return false;
      if (query.excludeOrigin?.length && query.excludeOrigin.includes(item.origin)) return false;
      if (query.excludeDestination?.length && query.excludeDestination.includes(item.destination)) return false;
      if (query.excludeConnection?.length && item.connections.some(c => query.excludeConnection!.includes(c))) return false;
      
      return true;
    });
  }
  
  // Search filter
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
  
  // Sorting with optimized comparison
  if (query.sortBy) {
    result = result.sort((a, b) => {
      let aVal: number, bVal: number;
      
      switch (query.sortBy) {
        case 'duration':
          aVal = a.totalDuration;
          bVal = b.totalDuration;
          break;
        case 'departure':
          aVal = a.departureTime;
          bVal = b.departureTime;
          break;
        case 'arrival':
          aVal = a.arrivalTime;
          bVal = b.arrivalTime;
          break;
        case 'y':
          aVal = a.classPercentages.y;
          bVal = b.classPercentages.y;
          break;
        case 'w':
          aVal = a.classPercentages.w;
          bVal = b.classPercentages.w;
          break;
        case 'j':
          aVal = a.classPercentages.j;
          bVal = b.classPercentages.j;
          break;
        case 'f':
          aVal = a.classPercentages.f;
          bVal = b.classPercentages.f;
          break;
        default:
          aVal = 0;
          bVal = 0;
      }
      
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
      return a.totalDuration - b.totalDuration;
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

// --- Optimized cache functions ---
async function cacheOptimizedItineraries(key: string, data: any, ttlSeconds = CACHE_TTL_SECONDS) {
  const redisClient = getRedisClient();
  if (!redisClient) return;
  
  try {
    const compressed = zlib.gzipSync(JSON.stringify(data));
    await redisClient.set(key, compressed, 'EX', ttlSeconds);
  } catch (error) {
    console.warn('Failed to cache optimized data:', error);
  }
}

async function getCachedOptimizedItineraries(key: string) {
  const redisClient = getRedisClient();
  if (!redisClient) return null;
  
  try {
    const compressed = await redisClient.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (error) {
    console.warn('Failed to get cached optimized data:', error);
    return null;
  }
}

/**
 * POST /api/build-itineraries
 * Orchestrates route finding and availability composition.
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let usedProKey: string | null = null;
  let usedProKeyRowId: string | null = null;
  
  console.log('[build-itineraries] Starting request processing...');
  
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

    // --- Build filter parameters object for optimized caching ---
    const filterParams = {
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
    };

    // --- Try optimized cache first (includes filter parameters) ---
    const optimizedCacheKey = getOptimizedCacheKey({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent }, filterParams);
    let cachedOptimized = await getCachedOptimizedItineraries(optimizedCacheKey);
    if (cachedOptimized) {
      console.log('[build-itineraries] Cache HIT - optimized result found');
      return NextResponse.json(cachedOptimized);
    }
    console.log('[build-itineraries] Cache MISS - optimized result not found, checking raw cache...');

    // --- Fallback to original cache for raw data ---
    const cacheKey = getCacheKey({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent });
    let cached = await getCachedItineraries(cacheKey);
    if (cached) {
      console.log('[build-itineraries] Cache HIT - raw data found, processing with optimized logic...');
      const { itineraries, flights, minRateLimitRemaining, minRateLimitReset, totalSeatsAeroHttpRequests } = cached;
      // Fetch reliability table for cached path too
      const reliabilityTable = await getReliabilityTableCached();
      const reliabilityMap = getReliabilityMap(reliabilityTable);
      
      // --- Use optimized processing for cached data ---
      const optimizedItineraries = precomputeItineraryMetadata(itineraries, flights, reliabilityMap, minReliabilityPercent);
      const { total, data } = optimizedFilterSortSearchPaginate(optimizedItineraries, filterParams);
      
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
      
      const response = {
        itineraries: data,
        flights: flightsPage,
        total,
        page,
        pageSize,
        minRateLimitRemaining,
        minRateLimitReset,
        totalSeatsAeroHttpRequests,
        filterMetadata,
      };
      
      // Cache the optimized result
      await cacheOptimizedItineraries(optimizedCacheKey, response);
      
      return NextResponse.json(response);
    }

    // If apiKey is null, fetch pro_key with largest remaining from Supabase
    if (apiKey === null) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/[^\x00-\x7F]/g, '');
      const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/[^\x00-\x7F]/g, '');
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
    let baseUrl = process.env.NEXT_PUBLIC_BASE_URL?.replace(/[^\x00-\x7F]/g, '');
    if (!baseUrl) {
      const proto = req.headers.get('x-forwarded-proto') || 'http';
      const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000';
      // Sanitize the URL components to remove any invisible Unicode characters
      const sanitizedProto = proto.replace(/[^\x00-\x7F]/g, ''); // Remove non-ASCII characters
      const sanitizedHost = host.replace(/[^\x00-\x7F]/g, ''); // Remove non-ASCII characters
      baseUrl = `${sanitizedProto}://${sanitizedHost}`;
    }
    
    // Additional validation to ensure the URL is valid
    try {
      new URL(baseUrl);
    } catch (error) {
      console.error('[build-itineraries] Invalid baseUrl constructed:', `"${baseUrl}"`);
      console.error('[build-itineraries] URL contains special characters, falling back to localhost');
      // Fallback to a safe default
      baseUrl = 'http://localhost:3000';
    }

    // 2. Call create-full-route-path API
    const fullRoutePathUrl = `${baseUrl}/api/create-full-route-path`;
    console.log('[build-itineraries] Calling create-full-route-path with URL:', fullRoutePathUrl);
    console.log('[build-itineraries] URL length:', fullRoutePathUrl.length);
    console.log('[build-itineraries] URL bytes:', Buffer.from(fullRoutePathUrl, 'utf8').length);
    
    const routePathRes = await fetch(fullRoutePathUrl, {
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
    console.log('[build-itineraries] Total seats.aero API links to run:', routeGroups.length);
    console.log('[build-itineraries] Route groups:', routeGroups.slice(0, 5), routeGroups.length > 5 ? `... and ${routeGroups.length - 5} more` : '');

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
    // Start performance monitoring
    PERFORMANCE_MONITORING.start();
    
    const availabilityResults = await pool(availabilityTasks, CONCURRENCY_CONFIG.AVAILABILITY_CONCURRENT_REQUESTS);
    
    // Log performance metrics
    PERFORMANCE_MONITORING.logMetrics();
    const afterAvailabilityTime = Date.now(); // Time after fetching availability-v2

    console.log('[build-itineraries] Availability fetch completed in', afterAvailabilityTime - t0, 'ms');

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
    
    console.log('[build-itineraries] Total seats.aero HTTP requests:', totalSeatsAeroHttpRequests);

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

    // 6. Optimized parallel route processing
    const output: Record<string, Record<string, string[][]>> = {};
    const flightMap = new Map<string, AvailabilityFlight>();
    
    // Process routes in parallel if enabled
    if (CONCURRENCY_CONFIG.PARALLEL_ROUTE_PROCESSING && routes.length > 10) {
      const routeTasks = (routes as FullRoutePathResult[]).map(route => async () => {
        // Decompose route into segments
        const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
        if (codes.length < 2) return null;
        
        const segments: [string, string][] = [];
        for (let i = 0; i < codes.length - 1; i++) {
          const code1 = codes[i];
          const code2 = codes[i + 1];
          if (code1 && code2) {
            segments.push([code1, code2]);
          }
        }
        
        // Early exit if any segment has no availability
        const hasAvailability = segments.every(([from, to]) => {
          const segKey = `${from}-${to}`;
          return segmentPool[segKey] && segmentPool[segKey].length > 0;
        });
        if (!hasAvailability) return null;
        
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
        
        // Create local flight map for this route
        const localFlightMap = new Map<string, AvailabilityFlight>();
        const itineraries = composeItineraries(segments, segmentAvail, alliances, localFlightMap);
        const routeKey = codes.join('-');
        
        return { routeKey, itineraries, flights: localFlightMap };
      });
      
      const routeResults = await pool(routeTasks, Math.min(10, Math.ceil(routes.length / 4)));
      
      // Merge results
      for (const result of routeResults) {
        if (!result) continue;
        const { routeKey, itineraries, flights } = result;
        
        // Merge flights into main map
        for (const [uuid, flight] of flights) {
          flightMap.set(uuid, flight);
        }
        
        // Merge itineraries
        if (!output[routeKey]) output[routeKey] = {};
        for (const [date, itinerariesForDate] of Object.entries(itineraries)) {
          if (!output[routeKey][date]) output[routeKey][date] = [];
          output[routeKey][date].push(...itinerariesForDate);
        }
      }
    } else {
      // Sequential processing for smaller datasets
      for (const route of routes as FullRoutePathResult[]) {
        // Decompose route into segments
        const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
        if (codes.length < 2) continue;
        const segments: [string, string][] = [];
        for (let i = 0; i < codes.length - 1; i++) {
          const code1 = codes[i];
          const code2 = codes[i + 1];
          if (code1 && code2) {
            segments.push([code1, code2]);
          }
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
    }

    // Optimized deduplication and cleanup in a single pass
    const usedFlightUUIDs = new Set<string>();
    const cleanedOutput: Record<string, Record<string, string[][]>> = {};
    
    for (const routeKey of Object.keys(output)) {
      const routeData = output[routeKey];
      const cleanedRouteData: Record<string, string[][]> = {};
      
      for (const date of Object.keys(routeData)) {
        // Deduplicate using Map for better performance
        const uniqueItineraries = Array.from(
          new Map(routeData[date].map(itin => [itin.join('>'), itin])).values()
        );
        
        if (uniqueItineraries.length > 0) {
          cleanedRouteData[date] = uniqueItineraries;
          
          // Track used flights
          for (const itin of uniqueItineraries) {
            for (const uuid of itin) {
              usedFlightUUIDs.add(uuid);
            }
          }
        }
      }
      
      // Only keep routes with valid dates
      if (Object.keys(cleanedRouteData).length > 0) {
        cleanedOutput[routeKey] = cleanedRouteData;
      }
    }
    
    // Remove unused flights in batch
    for (const uuid of flightMap.keys()) {
      if (!usedFlightUUIDs.has(uuid)) {
        flightMap.delete(uuid);
      }
    }
    
    // Replace output with cleaned version
    Object.keys(output).forEach(key => delete output[key]);
    Object.assign(output, cleanedOutput);

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
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/[^\x00-\x7F]/g, '');
        const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/[^\x00-\x7F]/g, '');
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
    const totalTimeMs = Date.now() - t0;
    console.log(`[build-itineraries] Itinerary build time (ms):`, itineraryBuildTimeMs);
    console.log(`[build-itineraries] Total running time (ms):`, totalTimeMs);
    console.log(`[build-itineraries] Total itineraries found:`, Object.keys(filteredOutput).reduce((sum, key) => {
      const routeItineraries = filteredOutput[key];
      if (!routeItineraries) return sum;
      return sum + Object.keys(routeItineraries).reduce((routeSum, date) => {
        const dateItineraries = routeItineraries[date];
        return routeSum + (dateItineraries ? dateItineraries.length : 0);
      }, 0);
    }, 0));
    console.log(`[build-itineraries] Total unique flights:`, flightMap.size);

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
    
    // --- Use optimized processing for new data ---
    const optimizedItineraries = precomputeItineraryMetadata(filteredOutput, Object.fromEntries(flightMap), reliabilityMap, minReliabilityPercent);
    const { total, data } = optimizedFilterSortSearchPaginate(optimizedItineraries, filterParams);
    
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
    
    const response = {
      itineraries: data,
      flights: flightsPage,
      total,
      page,
      pageSize,
      minRateLimitRemaining,
      minRateLimitReset,
      totalSeatsAeroHttpRequests,
      filterMetadata,
    };
    
    // Cache the optimized result
    await cacheOptimizedItineraries(optimizedCacheKey, response);
    
    return NextResponse.json(response);
  } catch (err) {
    console.error('[build-itineraries] Error in /api/build-itineraries:', err);
    console.error('[build-itineraries] Error stack:', (err as Error).stack);
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