import { NextRequest, NextResponse } from 'next/server';
import type { FullRoutePathResult } from '@/types/route';
import * as Sentry from '@sentry/nextjs';

import { CONCURRENCY_CONFIG, PERFORMANCE_MONITORING } from '@/lib/concurrency-config';
import { buildBaseUrl } from '@/lib/http/base-url';
import { enforceRateLimit } from '@/lib/http/rate-limit-policy';
import { getAvailableProKey, updateProKeyRemaining } from '@/lib/supabase-admin';
import { getReliabilityData } from '@/lib/reliability/service';
import { getAirportData } from '@/lib/airports/service';
import { filterUnreliableSegments, isUnreliableFlight } from '@/lib/early-filter';
import { fetchAvailabilityForGroups } from '@/lib/availability/fetch';
import { buildSegmentPool } from '@/lib/availability/segment-pool';
import { getCacheKey, cacheItineraries, getCachedItineraries, getOptimizedCacheKey, cacheOptimizedItineraries, getCachedOptimizedItineraries } from '@/lib/cache';
import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getClassPercentages } from '@/lib/itineraries/class-percentages';
import { filterReliableItineraries } from '@/lib/itineraries/reliability';
import { buildFilterParamsFromUrl } from '@/lib/http/request';
import { extractFilterMetadata } from '@/lib/itineraries/filter-metadata';
import { filterItinerariesByDate, buildFlightsPage, buildResponse, dedupeAndPruneOutput, pruneUnusedFlights, collectUsedFlightUUIDs } from '@/lib/itineraries/postprocess';
import { setInitialSentryContext, setRequestSentryContext, reportPerformance, addPerformanceBreadcrumb, captureBuildError, reportItineraryBreakdown } from '@/lib/observability/perf';
import { createPerformanceMetrics, createItineraryMetrics, finalizePostProcessingMetrics } from '@/lib/observability/metrics';
import { prefilterValidRoutes } from '@/lib/itineraries/route-prefilter';
import { buildDirectItineraries } from '@/lib/itineraries/direct';
import { buildOptimizedFromCached } from '@/lib/itineraries/cached-response';
import { precomputeFlightMetadata, buildGroupConnectionMatrix as extBuildGroupConnectionMatrix, buildConnectionMatrix as extBuildConnectionMatrix } from '@/lib/itineraries/connections';
import { initializeCityGroups, isCityCode, getCityAirports } from '@/lib/airports/city-groups';
import { buildItinerariesAcrossRoutes } from '../../../lib/itineraries/build';
import { fetchRoutePaths } from '@/lib/clients/route-path';
import { parseBuildItinerariesRequest } from '@/lib/http/build-itineraries-request';
import { getTotalDuration, precomputeItineraryMetadata, optimizedFilterSortSearchPaginate } from '@/lib/itineraries/processing';

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

/**
 * POST /api/build-itineraries
 * Orchestrates route finding and availability composition.
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let usedProKey: string | null = null;
  let usedProKeyRowId: string | null = null;
  let requestData: any = null;
  
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
    requestData = await parseBuildItinerariesRequest(req);
    let { origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers, minReliabilityPercent } = requestData;
    const seats = typeof requestData.seats === 'number' && requestData.seats > 0 ? requestData.seats : 1;
    const united = requestData.united || false;
    
    if (united) {
      console.log(`[UNITED] United parameter enabled - will adjust seat counts for UA flights based on pz table data`);
    }

    // 2. Apply smart rate limiting and null API key restrictions
    const rateLimitResult = await enforceRateLimit(req, requestData);
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
      const { table: reliabilityTable, map: reliabilityMap } = await getReliabilityData();
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
        usedProKeyRowId = proKeyData.pro_key;
        
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
    const baseUrl = buildBaseUrl(req);

    // 2. Call create-full-route-path API
    const routePathData = await fetchRoutePaths(baseUrl, { origin, destination, maxStop });
    const { routes } = routePathData;
    if (!routes || !Array.isArray(routes) || routes.length === 0) {
      return NextResponse.json({ error: 'No eligible routes found' }, { status: 404 });
    }

    // 2.5. Keep city-coded routes and prepare for segment expansion
    await initializeCityGroups(); // Ensure city groups are loaded
    
    const processedRoutes: FullRoutePathResult[] = [];
    const routeToOriginalMap = new Map<FullRoutePathResult, FullRoutePathResult>();
    
    for (const route of routes) {
      // Keep the original city-coded route as-is
      processedRoutes.push(route);
      routeToOriginalMap.set(route, route);
    }
    
    console.log(`[build-itineraries] Processing ${routes.length} city-coded routes`);

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
    const segmentPool = buildSegmentPool(availabilityResults as any);

    // EARLY FILTERING: Remove unreliable intermediate segments from availability pool
    // This requires reliability data, so fetch it first
    const reliabilityStart = Date.now();
    const { table: reliabilityTable, map: reliabilityMap } = await getReliabilityData();
    performanceMetrics.reliabilityCache = Date.now() - reliabilityStart;
    
    // Compute direct distance for O/D threshold and prepare airport cache
    const { airportMap, directDistanceMiles } = await getAirportData(
      origin,
      destination,
      segmentPool,
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    // Filter segments: remove unreliable intermediate segments but prune long unreliable O/D segments
    const segmentFilterStart = Date.now();
    const filteredSegmentPool = filterUnreliableSegments(segmentPool, reliabilityMap, origin, destination, minReliabilityPercent, airportMap, directDistanceMiles);
    performanceMetrics.segmentFiltering = Date.now() - segmentFilterStart;

    // PHASE 1 OPTIMIZATION: Pre-compute flight metadata and connection matrices from filtered pool
    const groupConnectionStart = Date.now();
    const groupConnectionMatrix = extBuildGroupConnectionMatrix(filteredSegmentPool);
    performanceMetrics.groupConnectionMatrix = Date.now() - groupConnectionStart;
    
    const flightMetadataStart = Date.now();
    const flightMetadata = precomputeFlightMetadata(filteredSegmentPool);
    performanceMetrics.flightMetadata = Date.now() - flightMetadataStart;
    
    const flightConnectionStart = Date.now();
    const connectionMatrix = await extBuildConnectionMatrix(flightMetadata, filteredSegmentPool, groupConnectionMatrix);
    performanceMetrics.flightConnectionMatrix = Date.now() - flightConnectionStart;

    // 6. Pre-filter routes based on segment availability (fail-fast optimization)
    const preFilterStart = Date.now();
    const { allRoutes, validRoutes } = prefilterValidRoutes(processedRoutes as FullRoutePathResult[], filteredSegmentPool);
    
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
      const direct = await buildDirectItineraries(origin, destination, filteredSegmentPool, flightMap);
      Object.assign(output, direct);
      console.log(`[build-itineraries] Direct flight processing completed: ${Object.keys(output).length} routes`);
    } else {
    
    // Build itineraries across routes (parallel or sequential)
    const built = await buildItinerariesAcrossRoutes(
      validRoutes,
      filteredSegmentPool,
      flightMap,
      connectionMatrix,
      routeToOriginalMap,
      { parallel: CONCURRENCY_CONFIG.PARALLEL_ROUTE_PROCESSING }
    );
    Object.assign(output, built.output);
    itineraryMetrics = built.metrics;
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
      origin: requestData?.origin || 'unknown',
      destination: requestData?.destination || 'unknown',
      maxStop: requestData?.maxStop || 'unknown',
      totalSeatsAeroRequests: totalSeatsAeroHttpRequests,
      totalItineraries,
      totalUniqueFlights: flightMap.size,
    });
    
    // Send detailed itinerary building breakdown to Sentry
    reportItineraryBreakdown((itineraryMetrics as any), CONCURRENCY_CONFIG.PARALLEL_ROUTE_PROCESSING && validRoutes.length > 10 ? 'parallel' : 'sequential');
    
    // Log performance metrics to Sentry for monitoring
    addPerformanceBreadcrumb(performanceMetrics);

    // --- RESPONSE COMPRESSION LOGIC ---
    const responseObj = await cacheItineraries(cacheKey, {
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
      origin: requestData?.origin,
      destination: requestData?.destination,
      maxStop: requestData?.maxStop,
      startDate: requestData?.startDate,
      endDate: requestData?.endDate,
    });
    
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
}