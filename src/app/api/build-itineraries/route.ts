import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { FullRoutePathResult } from '@/types/route';
import { createHash } from 'crypto';
import * as Sentry from '@sentry/nextjs';

import { parseISO, isBefore, isEqual, startOfDay, endOfDay } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import Redis from 'ioredis';
import { parse } from 'url';
import { CONCURRENCY_CONFIG, PERFORMANCE_MONITORING } from '@/lib/concurrency-config';
import { getSanitizedEnv, getRedisConfig } from '@/lib/env-utils';
import { smartRateLimit } from '@/lib/smart-rate-limiter';
import { getAvailableProKey, updateProKeyRemaining } from '@/lib/supabase-admin';
import { getReliabilityTableCached, getReliabilityMap } from '@/lib/reliability-cache';
import { buildAirportMapAndDirectDistance } from '@/lib/route-helpers';
import { filterUnreliableSegments, isUnreliableFlight } from '@/lib/early-filter';
import { pool } from '@/lib/pool';
import { fetchAvailabilityForGroups } from '@/lib/availability/fetch';
import {
  getRedisClient,
  CACHE_TTL_SECONDS,
  getCacheKey,
  cacheItineraries,
  getCachedItineraries,
  getOptimizedCacheKey,
  cacheOptimizedItineraries,
  getCachedOptimizedItineraries,
  getCachedAvailabilityV2Response,
  saveAvailabilityV2ResponseToCache,
} from '@/lib/cache';
import type { Airport } from '@/types/route';
import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getFlightUUID } from '@/lib/itineraries/ids';
import { getClassPercentages } from '@/lib/itineraries/class-percentages';
import { filterReliableItineraries } from '@/lib/itineraries/reliability';
import { parseCsvParam, parseNumberCsvParam } from '@/lib/http/params';
import { buildFilterParamsFromUrl } from '@/lib/http/request';
import { extractFilterMetadata } from '@/lib/itineraries/filter-metadata';
import { filterItinerariesByDate, buildFlightsPage, buildResponse, dedupeAndPruneOutput, pruneUnusedFlights, collectUsedFlightUUIDs } from '@/lib/itineraries/postprocess';
import { setInitialSentryContext, setRequestSentryContext, reportPerformance, addPerformanceBreadcrumb, captureBuildError, reportItineraryBreakdown } from '@/lib/observability/perf';
import { createPerformanceMetrics, createItineraryMetrics, finalizePostProcessingMetrics } from '@/lib/observability/metrics';
import { cacheFullResponse } from '@/lib/itineraries/response-cache';
import { prefilterValidRoutes } from '@/lib/itineraries/route-prefilter';
import { buildDirectItineraries } from '@/lib/itineraries/direct';
import { buildOptimizedFromCached } from '@/lib/itineraries/cached-response';
import { precomputeFlightMetadata, canGroupsConnect as extCanGroupsConnect, buildGroupConnectionMatrix as extBuildGroupConnectionMatrix, buildConnectionMatrix as extBuildConnectionMatrix, FlightMetadata } from '@/lib/itineraries/connections';
import { composeItineraries as extComposeItineraries } from '@/lib/itineraries/construction';
import { buildItinerariesAcrossRoutes } from '@/lib/itineraries/build';

// moved to '@/lib/itineraries/class-percentages'

// moved to '@/lib/validation/build-itineraries'
import { buildItinerariesSchema } from '@/lib/validation/build-itineraries';

// Types for availability response
// moved to '@/types/availability'

// moved to '@/lib/itineraries/ids'

// moved to '@/lib/itineraries/connections'

// early filtering moved to '@/lib/early-filter'

/**
 * Check if two groups can potentially connect based on their timing metadata
 * This eliminates impossible group combinations before checking individual flights
 * IMPORTANT: Only eliminate if NO possible connection exists between ANY flights in the groups
 */
function canGroupsConnect(
  groupA: AvailabilityGroup,
  groupB: AvailabilityGroup,
  minConnectionMinutes = 45
): boolean {
  // If metadata is missing, fall back to individual flight checking
  if (!groupA.earliestArrival || !groupA.latestArrival || 
      !groupB.earliestDeparture || !groupB.latestDeparture) {
    return true;
  }
  
  const earliestArrivalA = new Date(groupA.earliestArrival).getTime();
  const latestArrivalA = new Date(groupA.latestArrival).getTime();
  const earliestDepartureB = new Date(groupB.earliestDeparture).getTime();
  const latestDepartureB = new Date(groupB.latestDeparture).getTime();
  
  // Calculate the range of possible connection times
  const shortestConnection = (earliestDepartureB - latestArrivalA) / 60000;  // worst case
  const longestConnection = (latestDepartureB - earliestArrivalA) / 60000;   // best case
  
  // Groups CAN connect if there's any overlap with the valid connection window (45min to 24h)
  // Only eliminate if ALL possible connections are outside the valid window
  const canConnect = (
    // Some connection is long enough (≥ 45 min)
    longestConnection >= minConnectionMinutes &&
    // Some connection is short enough (≤ 24 hours)  
    shortestConnection <= 24 * 60
  );
  
  return canConnect;
}

/**
 * Build group-level connection matrix EFFICIENTLY - only check groups that could actually connect
 * Groups can only connect if destination of A = origin of B
 */
function buildGroupConnectionMatrix(
  segmentPool: Record<string, AvailabilityGroup[]>,
  minConnectionMinutes = 45
): Map<string, Set<string>> {
  console.log('[build-itineraries] Building optimized group connection matrix...');
  const startTime = Date.now();
  
  const groupConnections = new Map<string, Set<string>>();
  
  // Pre-process groups and parse timing metadata once
  interface GroupWithTiming {
    group: AvailabilityGroup;
    key: string;
    segmentKey: string;
    earliestArrivalTime?: number;
    latestArrivalTime?: number;
    earliestDepartureTime?: number;
    latestDepartureTime?: number;
  }
  
  // Index groups by their destination airports for efficient lookup
  const groupsByDestination = new Map<string, GroupWithTiming[]>();
  const groupsByOrigin = new Map<string, GroupWithTiming[]>();
  const allGroupKeys: string[] = [];
  const groupsWithTiming: GroupWithTiming[] = [];
  let groupIndex = 0;
  
  for (const [segmentKey, groups] of Object.entries(segmentPool)) {
    for (const group of groups) {
      const groupKey = `${segmentKey}:${group.date}:${group.alliance}:${groupIndex}`;
      allGroupKeys.push(groupKey);
      
      // Pre-parse timing metadata
      const earliestArrivalTime = group.earliestArrival ? new Date(group.earliestArrival).getTime() : undefined;
      const latestArrivalTime = group.latestArrival ? new Date(group.latestArrival).getTime() : undefined;
      const earliestDepartureTime = group.earliestDeparture ? new Date(group.earliestDeparture).getTime() : undefined;
      const latestDepartureTime = group.latestDeparture ? new Date(group.latestDeparture).getTime() : undefined;
      
      const groupData = { group, key: groupKey, segmentKey, earliestArrivalTime, latestArrivalTime, earliestDepartureTime, latestDepartureTime };
      groupsWithTiming.push(groupData);
      
      // Index by destination airport
      if (!groupsByDestination.has(group.destinationAirport)) {
        groupsByDestination.set(group.destinationAirport, []);
      }
      groupsByDestination.get(group.destinationAirport)!.push(groupData);
      
      // Index by origin airport
      if (!groupsByOrigin.has(group.originAirport)) {
        groupsByOrigin.set(group.originAirport, []);
      }
      groupsByOrigin.get(group.originAirport)!.push(groupData);
      
      groupIndex++;
    }
  }
  
  let totalGroupPairs = 0;
  let validGroupPairs = 0;
  
  // Only compare groups where destination of A = origin of B
  for (const groupA of groupsWithTiming) {
    const validConnections = new Set<string>();
    
    // Find groups that originate from this group's destination
    const potentialConnections = groupsByOrigin.get(groupA.group.destinationAirport);
    if (!potentialConnections) {
      groupConnections.set(groupA.key, validConnections);
        continue;
      }
      
    for (const groupB of potentialConnections) {
      if (groupA.key === groupB.key) continue; // Can't connect to self
      
      totalGroupPairs++;
      
      // Fast timing check using pre-parsed timestamps with correct range logic
      if (groupA.earliestArrivalTime && groupA.latestArrivalTime && 
          groupB.earliestDepartureTime && groupB.latestDepartureTime) {
        
        // Calculate range of possible connections using all pre-parsed values
        const shortestConnection = (groupB.earliestDepartureTime - groupA.latestArrivalTime) / 60000;
        const longestConnection = (groupB.latestDepartureTime - groupA.earliestArrivalTime) / 60000;
        
        // Groups can connect if any connection is within valid window
        if (longestConnection >= minConnectionMinutes && shortestConnection <= 24 * 60) {
          validConnections.add(groupB.key);
          validGroupPairs++;
        }
      } else {
        // Fallback to original function if metadata missing
        if (canGroupsConnect(groupA.group, groupB.group, minConnectionMinutes)) {
          validConnections.add(groupB.key);
          validGroupPairs++;
        }
      }
    }
    
    groupConnections.set(groupA.key, validConnections);
  }
  
  // Initialize empty connections for groups that weren't processed
  for (const groupKey of allGroupKeys) {
    if (!groupConnections.has(groupKey)) {
      groupConnections.set(groupKey, new Set<string>());
    }
  }
  
  const buildTime = Date.now() - startTime;
  const reductionPercent = totalGroupPairs > 0 ? Math.round((1 - validGroupPairs / totalGroupPairs) * 100) : 0;
  console.log(`[build-itineraries] Optimized group connection matrix: ${validGroupPairs}/${totalGroupPairs} valid group pairs (${reductionPercent}% eliminated) in ${buildTime}ms`);
  console.log(`[build-itineraries] Processed ${groupsWithTiming.length} total groups with smart connection filtering`);
  
  return groupConnections;
}

/**
 * Build connection validation matrix to eliminate repeated connection time calculations
 * Pre-computes valid connections between all flight pairs (optimized with group pre-filtering)
 */
function buildConnectionMatrix(
  metadata: Map<string, FlightMetadata>,
  segmentPool: Record<string, AvailabilityGroup[]>,
  groupConnections: Map<string, Set<string>>,
  minConnectionMinutes = 45
): Map<string, Set<string>> {
  console.log('[build-itineraries] Building optimized flight connection matrix...');
  const startTime = Date.now();
  const connections = new Map<string, Set<string>>();
  
  // Create flight-to-group mapping for efficient group lookup
  const flightToGroup = new Map<string, string>();
  const groupToFlights = new Map<string, string[]>();
  
  let groupIndex = 0;
  for (const [segmentKey, groups] of Object.entries(segmentPool)) {
    for (const group of groups) {
      const groupKey = `${segmentKey}:${group.date}:${group.alliance}:${groupIndex}`;
      const groupFlights: string[] = [];
      
      for (const flight of group.flights) {
        const uuid = getFlightUUID(flight);
        flightToGroup.set(uuid, groupKey);
        groupFlights.push(uuid);
      }
      
      groupToFlights.set(groupKey, groupFlights);
      groupIndex++;
    }
  }
  
  let totalFlightPairs = 0;
  let validFlightPairs = 0;
  let skippedByGroupFilter = 0;
  
  // Build connections only between flights from connectable groups
  for (const [flightUuid, flightMeta] of metadata) {
    const fromGroupKey = flightToGroup.get(flightUuid);
    if (!fromGroupKey) continue;
    
    const validConnections = new Set<string>();
    const connectedGroups = groupConnections.get(fromGroupKey);
    if (!connectedGroups) continue;
    
    // Only check flights from groups that can connect
    for (const toGroupKey of connectedGroups) {
      const groupFlights = groupToFlights.get(toGroupKey);
      if (!groupFlights) continue;
      
      for (const toFlightUuid of groupFlights) {
        if (flightUuid === toFlightUuid) continue; // Can't connect to self
        
        const toFlightMeta = metadata.get(toFlightUuid);
        if (!toFlightMeta) continue;
        
        totalFlightPairs++;
        const diffMinutes = (toFlightMeta.departureTime - flightMeta.arrivalTime) / 60000;
        
        // Valid connection time window: 45 minutes to 24 hours
        if (diffMinutes >= minConnectionMinutes && diffMinutes <= 24 * 60) {
          validConnections.add(toFlightUuid);
          validFlightPairs++;
        }
      }
    }
    
    // Count flights that were skipped due to group filtering
    const totalPossibleFlights = metadata.size - 1; // exclude self
    const checkedFlights = totalFlightPairs;
    skippedByGroupFilter += (totalPossibleFlights - checkedFlights);
    
    connections.set(flightUuid, validConnections);
  }
  
  const buildTime = Date.now() - startTime;
  const totalConnections = Array.from(connections.values()).reduce((sum, set) => sum + set.size, 0);
  const reductionPercent = totalFlightPairs > 0 ? Math.round((1 - totalFlightPairs / (metadata.size * metadata.size)) * 100) : 0;
  console.log(`[build-itineraries] Built optimized connection matrix: ${totalConnections} valid connections from ${totalFlightPairs} checked pairs (${reductionPercent}% flight pairs eliminated by group filtering) in ${buildTime}ms`);
  
  return connections;
}

/**
 * Optimized compose function with pre-computed metadata and connection matrix
 * @param segments Array of [from, to] pairs (e.g., [[HAN, SGN], [SGN, BKK]])
 * @param segmentAvail Array of arrays of AvailabilityGroup (one per segment)
 * @param alliances Array of arrays of allowed alliances for each segment
 * @param flightMap Map to store all unique flights
 * @param flightMetadata Pre-computed flight metadata for fast lookups
 * @param connectionMatrix Pre-computed valid connections between flights
 * @returns Map of date to array of valid itineraries (each as array of UUIDs)
 */
function composeItineraries(
  segments: [string, string][],
  segmentAvail: AvailabilityGroup[][],
  alliances: (string[] | null)[],
  flightMap: Map<string, AvailabilityFlight>,
  flightMetadata: Map<string, FlightMetadata>,
  connectionMatrix: Map<string, Set<string>>,
  minConnectionMinutes = 45
): Record<string, string[][]> {
  const results: Record<string, string[][]> = {};
  if (segments.length === 0 || segmentAvail.some(arr => arr.length === 0)) return results;

  // Pre-filter and index segments by from-to for faster lookups
  const segmentMap = new Map<string, { groups: AvailabilityGroup[]; allowedAlliances: string[] | null }>();
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const [from, to] = segment;
    const key = `${from}-${to}`;
    const groups = segmentAvail[i]?.filter(g => g.originAirport === from && g.destinationAirport === to) || [];
    const allowedAlliances = alliances[i] || null;
    segmentMap.set(key, { groups, allowedAlliances });
  }

  // Early termination if any segment has no valid groups
  if (segmentMap.size !== segments.length || Array.from(segmentMap.values()).some(seg => seg.groups.length === 0)) {
    return results;
  }

  // Use iterative approach instead of recursive for better performance
  const firstSegment = segments[0];
  if (!firstSegment) return results;
  const firstSegmentKey = `${firstSegment[0]}-${firstSegment[1]}`;
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
      const firstSegment = segments[0];
      if (!firstSegment) continue;
      const [from, to] = firstSegment;
      stack.push({
        segIdx: 1,
        path: [uuid],
        usedAirports: new Set([from, to]),
        prevArrival: uuid // Store UUID for connection matrix lookup
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

      const currentSegment = segments[current.segIdx];
      if (!currentSegment) continue;
      const [from, to] = currentSegment;
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
          const uuid = getFlightUUID(flight);
          
          // OPTIMIZATION: Use pre-computed connection matrix for instant validation
          if (current.prevArrival) {
            const validConnections = connectionMatrix.get(current.prevArrival);
            if (!validConnections || !validConnections.has(uuid)) {
              continue; // Invalid connection - skip immediately
            }
          }

          if (!flightMap.has(uuid)) {
            flightMap.set(uuid, flight);
          }

          // OPTIMIZATION: Use more efficient data structures
          const newUsedAirports = new Set(current.usedAirports);
          newUsedAirports.add(to);
          
          stack.push({
            segIdx: current.segIdx + 1,
            path: [...current.path, uuid],
            usedAirports: newUsedAirports,
            prevArrival: uuid // Store UUID instead of timestamp for connection matrix lookup
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

// moved to '@/lib/pool'

// moved to '@/lib/cache'

// Note: Reliability table caching moved to shared service at @/lib/reliability-cache

// moved to '@/lib/early-filter'

// moved to '@/lib/itineraries/reliability'

// moved to '@/lib/cache'

// moved to '@/lib/http/params'

// moved to '@/lib/itineraries/processing'
import { getTotalDuration, precomputeItineraryMetadata, optimizedFilterSortSearchPaginate } from '@/lib/itineraries/processing';
import { filterSortSearchPaginate as serverFilterSortSearchPaginate, getSortValue as serverGetSortValue } from '@/lib/itineraries/filters';

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

// moved to '@/lib/itineraries/filters'

// moved to '@/lib/cache'

// moved to '@/lib/itineraries/processing'

// moved to '@/lib/cache'

/**
 * POST /api/build-itineraries
 * Orchestrates route finding and availability composition.
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let usedProKey: string | null = null;
  let usedProKeyRowId: string | null = null;
  let parseResult: any = null;
  
  // Performance monitoring variables
  const performanceMetrics = createPerformanceMetrics();
  
  // Set Sentry context for performance tracking
  Sentry.setContext('performance', {
    route: 'build-itineraries',
    origin: 'pending',
    destination: 'pending',
    maxStop: 'pending',
  });
  
  console.log('[build-itineraries] Starting request processing...');
  
  try {
    // 1. Validate input
    const body = await req.json();
    parseResult = buildItinerariesSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    let { origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers, minReliabilityPercent } = parseResult.data;
    const seats = typeof parseResult.data.seats === 'number' && parseResult.data.seats > 0 ? parseResult.data.seats : 1;
    const united = parseResult.data.united || false;
    
    if (united) {
      console.log(`[UNITED] United parameter enabled - will adjust seat counts for UA flights based on pz table data`);
    }

    // 2. Apply smart rate limiting and null API key restrictions
    const rateLimitResult = await smartRateLimit(req, parseResult.data);
    if (!rateLimitResult.allowed) {
      return NextResponse.json({ 
        error: rateLimitResult.reason || 'Rate limit exceeded',
        ...(rateLimitResult.retryAfter && { retryAfter: rateLimitResult.retryAfter })
      }, { status: 429 });
    }
    if (typeof minReliabilityPercent !== 'number' || isNaN(minReliabilityPercent)) {
      minReliabilityPercent = 85;
    }

    // --- Extract query params for pagination/filter/sort/search ---
    const filterParams = buildFilterParamsFromUrl(req.url);

    // --- Try optimized cache first (includes filter parameters) ---
    const optimizedCacheKey = getOptimizedCacheKey({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent, seats, united }, filterParams);
    let cachedOptimized = await getCachedOptimizedItineraries(optimizedCacheKey);
    if (cachedOptimized) {
      console.log('[build-itineraries] Cache HIT - optimized result found');
      return NextResponse.json(cachedOptimized);
    }
    console.log('[build-itineraries] Cache MISS - optimized result not found, checking raw cache...');

    // --- Fallback to original cache for raw data ---
    const cacheKey = getCacheKey({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent, seats, united });
    let cached = await getCachedItineraries(cacheKey);
    if (cached) {
      console.log('[build-itineraries] Cache HIT - raw data found, processing with optimized logic...');
      const { itineraries, flights, minRateLimitRemaining, minRateLimitReset, totalSeatsAeroHttpRequests } = cached;
      const reliabilityTable = await getReliabilityTableCached();
      const reliabilityMap = getReliabilityMap(reliabilityTable);
      const { total, data, filterMetadata, flightsPage } = buildOptimizedFromCached(itineraries, flights, reliabilityMap, minReliabilityPercent, filterParams);
      const response = {
        itineraries: data,
        flights: flightsPage,
        total,
        page: filterParams.page,
        pageSize: filterParams.pageSize,
        minRateLimitRemaining,
        minRateLimitReset,
        totalSeatsAeroHttpRequests,
        filterMetadata,
      };
      await cacheOptimizedItineraries(optimizedCacheKey, response);
      return NextResponse.json(response);
    }

    // If apiKey is null, fetch pro_key with largest remaining using admin client
    if (apiKey === null) {
      try {
        const proKeyData = await getAvailableProKey();
        if (!proKeyData || !proKeyData.pro_key) {
          return NextResponse.json({ 
            error: 'No available pro_key found',
            details: 'All API keys may have reached their quota limits'
          }, { status: 500 });
        }
        
        apiKey = proKeyData.pro_key;
        usedProKey = proKeyData.pro_key;
        usedProKeyRowId = proKeyData.pro_key; // pro_key is the primary key
        
        console.log(`[build-itineraries] Using pro_key with ${proKeyData.remaining} remaining quota`);
      } catch (error) {
        console.error('[build-itineraries] Failed to get pro_key:', error);
        return NextResponse.json({ 
          error: 'Failed to retrieve API key',
          details: 'Database connection error'
        }, { status: 500 });
      }
    }

    // Build absolute base URL for internal fetches
    let baseUrl = getSanitizedEnv('NEXT_PUBLIC_BASE_URL');
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
    // Start performance monitoring
    PERFORMANCE_MONITORING.start();
    
    const { results: availabilityResults, minRateLimitRemaining: minRateLimitRemainingFetched, minRateLimitReset: minRateLimitResetFetched } = await fetchAvailabilityForGroups(routeGroups, {
      baseUrl,
      apiKey,
        startDate,
        endDate,
      cabin,
      carriers,
      seats,
      united,
      concurrency: CONCURRENCY_CONFIG.AVAILABILITY_CONCURRENT_REQUESTS,
    });
    let minRateLimitRemaining: number | null = minRateLimitRemainingFetched;
    let minRateLimitReset: number | null = minRateLimitResetFetched;
    
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

    // Track availability fetch performance
    performanceMetrics.availabilityFetch = afterAvailabilityTime - t0;
    Sentry.setContext('performance', {
      route: 'build-itineraries',
      availabilityFetchMs: performanceMetrics.availabilityFetch,
      totalSeatsAeroRequests: totalSeatsAeroHttpRequests,
    });

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

    // EARLY FILTERING: Remove unreliable intermediate segments from availability pool
    // This requires reliability data, so fetch it first
    const reliabilityStart = Date.now();
    const reliabilityTable = await getReliabilityTableCached();
    const reliabilityMap = getReliabilityMap(reliabilityTable);
    performanceMetrics.reliabilityCache = Date.now() - reliabilityStart;
    
    // Compute direct distance for O/D threshold and prepare airport cache
    const { airportMap, directDistanceMiles } = await buildAirportMapAndDirectDistance(
      origin,
      destination,
      segmentPool,
      getSanitizedEnv('NEXT_PUBLIC_SUPABASE_URL')!,
      getSanitizedEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')!
    );

    // Filter segments: remove unreliable intermediate segments but prune long unreliable O/D segments
    const segmentFilterStart = Date.now();
    const filteredSegmentPool = filterUnreliableSegments(segmentPool, reliabilityMap, origin, destination, minReliabilityPercent, airportMap, directDistanceMiles);
    performanceMetrics.segmentFiltering = Date.now() - segmentFilterStart;

    // PHASE 1 OPTIMIZATION: Pre-compute flight metadata and connection matrices from filtered pool
    const groupConnectionStart = Date.now();
    const groupConnectionMatrix = buildGroupConnectionMatrix(filteredSegmentPool);
    performanceMetrics.groupConnectionMatrix = Date.now() - groupConnectionStart;
    
    const flightMetadataStart = Date.now();
    const flightMetadata = precomputeFlightMetadata(filteredSegmentPool);
    performanceMetrics.flightMetadata = Date.now() - flightMetadataStart;
    
    const flightConnectionStart = Date.now();
    const connectionMatrix = buildConnectionMatrix(flightMetadata, filteredSegmentPool, groupConnectionMatrix);
    performanceMetrics.flightConnectionMatrix = Date.now() - flightConnectionStart;

    // 6. Pre-filter routes based on segment availability (fail-fast optimization)
    const preFilterStart = Date.now();
    const { allRoutes, validRoutes } = prefilterValidRoutes(routes as FullRoutePathResult[], filteredSegmentPool);
    
    const preFilterTime = Date.now() - preFilterStart;
    performanceMetrics.routePreFiltering = preFilterTime;
    console.log(`[build-itineraries] Route pre-filtering: ${allRoutes.length} → ${validRoutes.length} routes (eliminated ${allRoutes.length - validRoutes.length} impossible routes) in ${preFilterTime}ms`);

    // 7. Optimized parallel route processing
    const output: Record<string, Record<string, string[][]>> = {};
    const flightMap = new Map<string, AvailabilityFlight>();
    const itineraryBuildStart = Date.now();
    let itineraryMetrics: any = createItineraryMetrics();
    
    // Special handling for direct flights (maxStop=0)
    if (maxStop === 0) {
      console.log('[build-itineraries] Processing direct flights (maxStop=0)');
      const direct = buildDirectItineraries(origin, destination, filteredSegmentPool, flightMap);
      Object.assign(output, direct);
      console.log(`[build-itineraries] Direct flight processing completed: ${Object.keys(output).length} routes`);
    } else {
    
    // Build itineraries across routes (parallel or sequential)
    const built = await buildItinerariesAcrossRoutes(
      validRoutes,
      filteredSegmentPool,
      flightMap,
      connectionMatrix,
      { parallel: CONCURRENCY_CONFIG.PARALLEL_ROUTE_PROCESSING }
    );
    Object.assign(output, built.output);
    itineraryMetrics = built.itineraryMetrics;
    } // End of else block for maxStop > 0

    // NOTE: While composeItineraries deduplicates within its own results, 
    // we need to deduplicate across multiple route processing calls
    // to prevent the same itineraries from being added multiple times
    
    // Track used flights for cleanup
    const usedFlightUUIDs = collectUsedFlightUUIDs(output);
    
    // Remove empty route keys after processing and prune unused flights
    dedupeAndPruneOutput(output);
    pruneUnusedFlights(flightMap, usedFlightUUIDs);
    
    // Deduplicate itineraries across all routes and dates
    dedupeAndPruneOutput(output);

    // Filter itineraries by date range
    filterItinerariesByDate(output, flightMap, startDate, endDate);

    // Track post-processing performance
    const postProcessingStart = Date.now();
    
    // --- SERVER-SIDE RELIABILITY FILTERING ---
    // Use previously fetched reliability data for final itinerary filtering
    const filteredOutput = filterReliableItineraries(output, flightMap, reliabilityMap, minReliabilityPercent, isUnreliableFlight);
    // Remove empty route keys after filtering
    Object.keys(filteredOutput).forEach((key) => {
      if (!filteredOutput[key] || Object.keys(filteredOutput[key]).length === 0) {
        delete filteredOutput[key];
      }
    });

    // After all processing, if we used a pro_key, update its remaining quota using admin client
    if (usedProKey && usedProKeyRowId && typeof minRateLimitRemaining === 'number') {
      try {
        const updateSuccess = await updateProKeyRemaining(usedProKeyRowId, minRateLimitRemaining);
        if (updateSuccess) {
          console.log(`[build-itineraries] Updated pro_key quota: ${usedProKeyRowId} -> ${minRateLimitRemaining} remaining`);
        } else {
          console.warn(`[build-itineraries] Failed to update pro_key quota for ${usedProKeyRowId}`);
        }
      } catch (error) {
        console.error('[build-itineraries] Error updating pro_key quota:', error);
      }
    }

    // Complete post-processing timing
    const postProcessingTime = Date.now() - postProcessingStart;
    finalizePostProcessingMetrics(itineraryMetrics, postProcessingTime, itineraryBuildStart);
    
    // Calculate final totals
    // totals.totalTimeMs set by finalize above
    
    // Return itineraries and flights map
    const itineraryBuildTimeMs = Date.now() - afterAvailabilityTime;
    const totalTimeMs = Date.now() - t0;
    
    // Update performance metrics
    performanceMetrics.itineraryBuild = itineraryBuildTimeMs;
    performanceMetrics.totalTime = totalTimeMs;
    
    // Calculate total itineraries count
    const totalItineraries = Object.keys(filteredOutput).reduce((sum, key) => {
      const routeItineraries = filteredOutput[key];
      if (!routeItineraries) return sum;
      return sum + Object.keys(routeItineraries).reduce((routeSum, date) => {
        const dateItineraries = routeItineraries[date];
        return routeSum + (dateItineraries ? dateItineraries.length : 0);
      }, 0);
    }, 0);
    
    console.log(`[build-itineraries] Itinerary build time (ms):`, itineraryBuildTimeMs);
    console.log(`[build-itineraries] Total running time (ms):`, totalTimeMs);
    console.log(`[build-itineraries] Total itineraries found:`, totalItineraries);
    console.log(`[build-itineraries] Total unique flights:`, flightMap.size);
    
    // Send comprehensive performance metrics to Sentry
    reportPerformance(performanceMetrics, {
      origin: parseResult?.data?.origin || 'unknown',
      destination: parseResult?.data?.destination || 'unknown',
      maxStop: parseResult?.data?.maxStop || 'unknown',
      totalSeatsAeroRequests: totalSeatsAeroHttpRequests,
      totalItineraries,
      totalUniqueFlights: flightMap.size,
    });
    
    // Send detailed itinerary building breakdown to Sentry
    reportItineraryBreakdown((itineraryMetrics as any), CONCURRENCY_CONFIG.PARALLEL_ROUTE_PROCESSING && validRoutes.length > 10 ? 'parallel' : 'sequential');
    
    // Log performance metrics to Sentry for monitoring
    addPerformanceBreadcrumb(performanceMetrics);

    // --- RESPONSE COMPRESSION LOGIC ---
    const responseObj = await cacheFullResponse(cacheKey, {
      itineraries: filteredOutput,
      flights: Object.fromEntries(flightMap),
      minRateLimitRemaining,
      minRateLimitReset,
      totalSeatsAeroHttpRequests,
    });
    
    // Extract filter metadata from the full response
    const filterMetadata = extractFilterMetadata(filteredOutput, Object.fromEntries(flightMap));
    
    // Cache the full result in Redis (compressed)
    // already cached via cacheFullResponse
    
    // --- Use optimized processing for new data ---
    const optimizedItineraries = precomputeItineraryMetadata(filteredOutput, Object.fromEntries(flightMap), reliabilityMap, minReliabilityPercent, getClassPercentages);
    const { total, data } = optimizedFilterSortSearchPaginate(optimizedItineraries, filterParams);
    
    const allFlights = Object.fromEntries(flightMap);
    const flightsPage = buildFlightsPage(data as any, allFlights);
    const response = buildResponse({
      data,
      total,
      page: filterParams.page,
      pageSize: filterParams.pageSize,
      minRateLimitRemaining,
      minRateLimitReset,
      totalSeatsAeroHttpRequests,
      filterMetadata,
      flightsPage,
    });
    
    // Cache the optimized result
    await cacheOptimizedItineraries(optimizedCacheKey, response);
    
    return NextResponse.json(response);
  } catch (err) {
    console.error('[build-itineraries] Error in /api/build-itineraries:', err);
    console.error('[build-itineraries] Error stack:', (err as Error).stack);
    
    // Capture error in Sentry with additional context
    captureBuildError(err, {
      reqUrl: req.url,
        userAgent: req.headers.get('user-agent'),
        requestId: req.headers.get('x-request-id'),
        processingTime: Date.now() - t0,
      origin: parseResult?.data?.origin,
      destination: parseResult?.data?.destination,
      maxStop: parseResult?.data?.maxStop,
      startDate: parseResult?.data?.startDate,
      endDate: parseResult?.data?.endDate,
    });
    
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
}

// moved to '@/lib/itineraries/filter-metadata'