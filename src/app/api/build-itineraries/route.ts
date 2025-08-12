import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { FullRoutePathResult } from '@/types/route';
import { createHash } from 'crypto';
import zlib from 'zlib';
import { parseISO, startOfDay, endOfDay } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import { CONCURRENCY_CONFIG, PERFORMANCE_MONITORING } from '@/lib/concurrency-config';

import { AvailabilityFlight, AvailabilityGroup } from '@/lib/build-itineraries/types';
import { getClassPercentages } from '@/lib/build-itineraries/class-percentages';
import { composeItineraries } from '@/lib/build-itineraries/compose';
import { getReliabilityTableCached, getReliabilityMap, filterReliableItineraries } from '@/lib/build-itineraries/reliability';
import {
  getCacheKey,
  cacheItineraries,
  getCachedItineraries,
  getOptimizedCacheKey,
  cacheOptimizedItineraries,
  getCachedOptimizedItineraries,
} from '@/lib/build-itineraries/cache';
import { parseCsvParam, parseNumberCsvParam } from '@/lib/params';
import { precomputeItineraryMetadata, optimizedFilterSortSearchPaginate, extractFilterMetadata } from '@/lib/build-itineraries/processing';
import { pool } from '@/lib/pool';
import { getCachedAvailabilityV2Response } from '@/lib/valkey';

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

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let usedProKey: string | null = null;
  let usedProKeyRowId: string | null = null;

  console.log('[build-itineraries] Starting request processing...');

  try {
    const body = await req.json();
    const parseResult = buildItinerariesSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    let { origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers, minReliabilityPercent } = parseResult.data;
    if (typeof minReliabilityPercent !== 'number' || isNaN(minReliabilityPercent)) {
      minReliabilityPercent = 85;
    }

    const { searchParams } = new URL(req.url);
    const stops = parseNumberCsvParam(searchParams.get('stops'));
    const includeAirlines = parseCsvParam(searchParams.get('includeAirlines')).map((s) => s.toUpperCase());
    const excludeAirlines = parseCsvParam(searchParams.get('excludeAirlines')).map((s) => s.toUpperCase());
    const maxDuration = searchParams.get('maxDuration') ? Number(searchParams.get('maxDuration')) : undefined;
    const minYPercent = searchParams.get('minYPercent') ? Number(searchParams.get('minYPercent')) : undefined;
    const minWPercent = searchParams.get('minWPercent') ? Number(searchParams.get('minWPercent')) : undefined;
    const minJPercent = searchParams.get('minJPercent') ? Number(searchParams.get('minJPercent')) : undefined;
    const minFPercent = searchParams.get('minFPercent') ? Number(searchParams.get('minFPercent')) : undefined;
    const depTimeMin = searchParams.get('depTimeMin') ? Number(searchParams.get('depTimeMin')) : undefined;
    const depTimeMax = searchParams.get('depTimeMax') ? Number(searchParams.get('depTimeMax')) : undefined;
    const arrTimeMin = searchParams.get('arrTimeMin') ? Number(searchParams.get('arrTimeMin')) : undefined;
    const arrTimeMax = searchParams.get('arrTimeMax') ? Number(searchParams.get('arrTimeMax')) : undefined;
    const includeOrigin = parseCsvParam(searchParams.get('includeOrigin'));
    const includeDestination = parseCsvParam(searchParams.get('includeDestination'));
    const includeConnection = parseCsvParam(searchParams.get('includeConnection'));
    const excludeOrigin = parseCsvParam(searchParams.get('excludeOrigin'));
    const excludeDestination = parseCsvParam(searchParams.get('excludeDestination'));
    const excludeConnection = parseCsvParam(searchParams.get('excludeConnection'));
    const search = searchParams.get('search') || undefined;
    let sortBy = searchParams.get('sortBy') || undefined;
    let sortOrder = (searchParams.get('sortOrder') as 'asc' | 'desc') || 'asc';
    if (!sortBy) {
      sortBy = 'duration';
      sortOrder = 'asc';
    }
    let page = parseInt(searchParams.get('page') || '1', 10);
    page = isNaN(page) || page < 1 ? 1 : page;
    const pageSize = parseInt(searchParams.get('pageSize') || '10', 10);

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

    const optimizedCacheKey = getOptimizedCacheKey(
      { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent },
      filterParams
    );
    let cachedOptimized = await getCachedOptimizedItineraries(optimizedCacheKey);
    if (cachedOptimized) {
      console.log('[build-itineraries] Cache HIT - optimized result found');
      return NextResponse.json(cachedOptimized);
    }
    console.log('[build-itineraries] Cache MISS - optimized result not found, checking raw cache...');

    const cacheKey = getCacheKey({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent });
    let cached = await getCachedItineraries(cacheKey);
    if (cached) {
      console.log('[build-itineraries] Cache HIT - raw data found, processing with optimized logic...');
      const { itineraries, flights, minRateLimitRemaining, minRateLimitReset, totalSeatsAeroHttpRequests } = cached;
      const reliabilityTable = await getReliabilityTableCached();
      const reliabilityMap = getReliabilityMap(reliabilityTable);

      const optimizedItineraries = precomputeItineraryMetadata(itineraries, flights, reliabilityMap, minReliabilityPercent);
      const { total, data } = optimizedFilterSortSearchPaginate(optimizedItineraries, filterParams);

      const flightUUIDs = new Set<string>();
      data.forEach((card: { itinerary: string[] }) => {
        card.itinerary.forEach((uuid: string) => flightUUIDs.add(uuid));
      });
      const flightsPage: Record<string, any> = {};
      flightUUIDs.forEach((uuid) => {
        if (flights[uuid]) flightsPage[uuid] = flights[uuid];
      });

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

      await cacheOptimizedItineraries(optimizedCacheKey, response);

      return NextResponse.json(response);
    }

    if (apiKey === null) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!supabaseUrl || !supabaseServiceRoleKey) {
        return NextResponse.json({ error: 'Supabase credentials not set' }, { status: 500 });
      }
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
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

    let baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    if (!baseUrl) {
      const proto = req.headers.get('x-forwarded-proto') || 'http';
      const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000';
      const sanitizedProto = proto.replace(/[^\x00-\x7F]/g, '');
      const sanitizedHost = host.replace(/[^\x00-\x7F]/g, '');
      baseUrl = `${sanitizedProto}://${sanitizedHost}`;
    }

    try {
      new URL(baseUrl);
    } catch (error) {
      console.error('[build-itineraries] Invalid baseUrl constructed:', baseUrl);
      baseUrl = 'http://localhost:3000';
    }

    const fullRoutePathUrl = `${baseUrl}/api/create-full-route-path`;
    console.log('[build-itineraries] Calling create-full-route-path with URL:', fullRoutePathUrl);

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

    if (!Array.isArray(routePathData.queryParamsArr) || routePathData.queryParamsArr.length === 0) {
      return NextResponse.json({ error: 'No route groups found in create-full-route-path response' }, { status: 500 });
    }
    const routeGroups: string[] = routePathData.queryParamsArr;

    console.log('[build-itineraries] Total seats.aero API links to run:', routeGroups.length);

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
      const cached = await getCachedAvailabilityV2Response(params);
      if (cached) {
        return { routeId, error: false, data: cached };
      }
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (typeof apiKey === 'string') headers['partner-authorization'] = apiKey;
        const res = await fetch(`${baseUrl}/api/availability-v2`, {
          method: 'POST',
          headers,
          body: JSON.stringify(params),
        });
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

    PERFORMANCE_MONITORING.start();
    const availabilityResults = await pool(availabilityTasks, CONCURRENCY_CONFIG.AVAILABILITY_CONCURRENT_REQUESTS);
    PERFORMANCE_MONITORING.logMetrics();
    const afterAvailabilityTime = Date.now();

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

    const output: Record<string, Record<string, string[][]>> = {};
    const flightMap = new Map<string, AvailabilityFlight>();
    for (const route of routes as FullRoutePathResult[]) {
      const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
      if (codes.length < 2) continue;
      const segments: [string, string][] = [];
      for (let i = 0; i < codes.length - 1; i++) {
        const code1 = codes[i];
        const code2 = codes[i + 1];
        if (code1 && code2) segments.push([code1, code2]);
      }
      const segmentAvail: AvailabilityGroup[][] = segments.map(([from, to]) => {
        const segKey = `${from}-${to}`;
        return segmentPool[segKey] || [];
      });
      const alliances: (string[] | null)[] = [];
      for (const [from, to] of segments) {
        if (route.O && route.A && from === route.O && to === route.A) {
          alliances.push(Array.isArray(route.all1) ? route.all1 : route.all1 ? [route.all1] : null);
        } else if (route.B && route.D && from === route.B && to === route.D) {
          alliances.push(Array.isArray(route.all3) ? route.all3 : route.all3 ? [route.all3] : null);
        } else {
          alliances.push(Array.isArray(route.all2) ? route.all2 : route.all2 ? [route.all2] : null);
        }
      }
      const routeKey = codes.join('-');
      const itineraries = composeItineraries(segments, segmentAvail, alliances, flightMap);
      if (!output[routeKey]) output[routeKey] = {};
      for (const [date, itinerariesForDate] of Object.entries(itineraries)) {
        if (!output[routeKey][date]) output[routeKey][date] = [];
        output[routeKey][date].push(...itinerariesForDate);
      }
    }

    for (const routeKey of Object.keys(output)) {
      for (const date of Object.keys(output[routeKey])) {
        const seen = new Set<string>();
        output[routeKey][date] = output[routeKey][date].filter((itin) => {
          const key = itin.join('>');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    }

    Object.keys(output).forEach((key) => {
      if (!output[key] || Object.keys(output[key]).length === 0) {
        delete output[key];
      }
    });

    const usedFlightUUIDs = new Set<string>();
    for (const routeKey of Object.keys(output)) {
      for (const date of Object.keys(output[routeKey])) {
        for (const itin of output[routeKey][date]) {
          for (const uuid of itin) usedFlightUUIDs.add(uuid);
        }
      }
    }
    for (const uuid of Array.from(flightMap.keys())) {
      if (!usedFlightUUIDs.has(uuid)) {
        flightMap.delete(uuid);
      }
    }

    const startDateObj = startOfDay(parseISO(startDate));
    const endDateObj = endOfDay(parseISO(endDate));
    for (const routeKey of Object.keys(output)) {
      for (const date of Object.keys(output[routeKey])) {
        output[routeKey][date] = output[routeKey][date].filter((itin) => {
          if (!itin.length) return false;
          const firstFlightUUID = itin[0];
          const firstFlight = flightMap.get(firstFlightUUID);
          if (!firstFlight || !firstFlight.DepartsAt) return false;
          const depDate = new Date(firstFlight.DepartsAt);
          return depDate >= startDateObj && depDate <= endDateObj;
        });
        if (output[routeKey][date].length === 0) {
          delete output[routeKey][date];
        }
      }
      if (Object.keys(output[routeKey]).length === 0) {
        delete output[routeKey];
      }
    }

    const reliabilityTable = await getReliabilityTableCached();
    const reliabilityMap = getReliabilityMap(reliabilityTable);
    const filteredOutput = filterReliableItineraries(output, flightMap, reliabilityMap, minReliabilityPercent);
    Object.keys(filteredOutput).forEach((key) => {
      if (!filteredOutput[key] || Object.keys(filteredOutput[key]).length === 0) {
        delete filteredOutput[key];
      }
    });

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
          console.log(
            `[pro_key] Updated: pro_key=${usedProKeyRowId}, remaining=${minRateLimitRemaining}, last_updated=${new Date().toISOString()}`,
            updateResult
          );
        }
      } catch (err) {
        console.error('Failed to update pro_key remaining:', err);
      }
    }

    const responseObj = {
      itineraries: filteredOutput,
      flights: Object.fromEntries(flightMap),
    };

    await cacheItineraries(cacheKey, responseObj);

    const optimizedItineraries = precomputeItineraryMetadata(
      filteredOutput,
      Object.fromEntries(flightMap),
      reliabilityMap,
      minReliabilityPercent
    );
    const { total, data } = optimizedFilterSortSearchPaginate(optimizedItineraries, filterParams);

    const flightUUIDs = new Set<string>();
    data.forEach((card: { itinerary: string[] }) => {
      card.itinerary.forEach((uuid: string) => flightUUIDs.add(uuid));
    });
    const flightsPage: Record<string, any> = {};
    const allFlights = Object.fromEntries(flightMap);
    flightUUIDs.forEach((uuid) => {
      if (allFlights[uuid]) flightsPage[uuid] = allFlights[uuid];
    });

    const filterMetadata = extractFilterMetadata(filteredOutput, Object.fromEntries(flightMap));

    const response = {
      itineraries: data,
      flights: flightsPage,
      total,
      page,
      pageSize,
      filterMetadata,
    };

    await cacheOptimizedItineraries(optimizedCacheKey, response);

    return NextResponse.json(response);
  } catch (err) {
    console.error('[build-itineraries] Error in /api/build-itineraries:', err);
    console.error('[build-itineraries] Error stack:', (err as Error).stack);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 