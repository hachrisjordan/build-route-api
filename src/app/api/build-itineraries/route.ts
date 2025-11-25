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
import { buildSegmentAndPricingPools } from '@/lib/availability/segment-pool';
import { getCacheKey, cacheItineraries, getCachedItineraries, getOptimizedCacheKey, cacheOptimizedItineraries, getCachedOptimizedItineraries } from '@/lib/cache';
import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getClassPercentages } from '@/lib/itineraries/class-percentages';
import { filterReliableItineraries } from '@/lib/itineraries/reliability';
import { buildFilterParamsFromUrl } from '@/lib/http/request';
import { extractFilterMetadata } from '@/lib/itineraries/filter-metadata';
import { filterItinerariesByDate, buildFlightsPage, buildPricingPage, buildResponse, dedupeAndPruneOutput, pruneUnusedFlights, collectUsedFlightUUIDs } from '@/lib/itineraries/postprocess';
import { setInitialSentryContext, setRequestSentryContext, reportPerformance, addPerformanceBreadcrumb, captureBuildError, reportItineraryBreakdown } from '@/lib/observability/perf';
import { createPerformanceMetrics, createItineraryMetrics, finalizePostProcessingMetrics } from '@/lib/observability/metrics';
import { prefilterValidRoutes } from '@/lib/itineraries/route-prefilter';
import { buildDirectItineraries } from '@/lib/itineraries/direct';
import { buildOptimizedFromCached } from '@/lib/itineraries/cached-response';
import { precomputeFlightMetadata, buildGroupConnectionMatrix as extBuildGroupConnectionMatrix, buildConnectionMatrix as extBuildConnectionMatrix } from '@/lib/itineraries/connections';
import { initializeCityGroups, isCityCode, getCityAirports } from '@/lib/airports/city-groups';
import { buildItinerariesAcrossRoutes } from '../../../lib/itineraries/build';
import { fetchRoutePaths, RoutePathResponse } from '@/lib/clients/route-path';
import { parseBuildItinerariesRequest } from '@/lib/http/build-itineraries-request';
import { getTotalDuration, precomputeItineraryMetadata, optimizedFilterSortSearchPaginate } from '@/lib/itineraries/processing';
import { calculatePartnerBooleans } from '@/lib/availability-v2/partner-booking';

function getSortValue(
  card: any,
  flights: Record<string, any>,
  sortBy: string,
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
  
  try {
    // 1. Validate input
    requestData = await parseBuildItinerariesRequest(req);
    let { origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers, minReliabilityPercent } = requestData;
    const seats = typeof requestData.seats === 'number' && requestData.seats > 0 ? requestData.seats : 1;
    const united = requestData.united || false;
    const binbin = requestData.binbin ?? false;
    const region = requestData.region ?? false;
    
    // Normalize origin/destination for API calls (convert arrays to strings if needed)
    const originStr = Array.isArray(origin) ? origin.join('/') : origin;
    const destinationStr = Array.isArray(destination) ? destination.join('/') : destination;
    
    if (united) {
      // United parameter enabled - will adjust seat counts for UA flights based on pz table data
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
    const optimizedCacheKey = getOptimizedCacheKey({ origin: originStr, destination: destinationStr, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent, seats, united, binbin, region }, filterParams);
    let cachedOptimized = await getCachedOptimizedItineraries(optimizedCacheKey);
    if (cachedOptimized) {
      return NextResponse.json(cachedOptimized);
    }

    // --- Fallback to original cache for raw data ---
    const cacheKey = getCacheKey({ origin: originStr, destination: destinationStr, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent, seats, united, region });
    let cached = await getCachedItineraries(cacheKey);
    if (cached) {
      const { itineraries, flights, pricing, routeStructures, minRateLimitRemaining, minRateLimitReset, totalSeatsAeroHttpRequests } = cached;
      const { table: reliabilityTable, map: reliabilityMap } = await getReliabilityData();
      
      // Ensure all cached flights have Partner fields calculated
      for (const flightId in flights) {
        const flight = flights[flightId];
        if (flight && (flight.YPartner === undefined || flight.WPartner === undefined || flight.JPartner === undefined || flight.FPartner === undefined)) {
          const airlineCode = flight.FlightNumbers.slice(0, 2);
          const partnerBooleans = calculatePartnerBooleans(
            airlineCode,
            flight.YFare || [],
            flight.WFare || [],
            flight.JFare || [],
            flight.FFare || [],
            flight.YCount,
            flight.WCount,
            flight.JCount,
            flight.FCount
          );
          flight.YPartner = partnerBooleans.YPartner;
          flight.WPartner = partnerBooleans.WPartner;
          flight.JPartner = partnerBooleans.JPartner;
          flight.FPartner = partnerBooleans.FPartner;
        }
      }
      
      const pricingPoolFromCache = pricing ? new Map(Object.entries(pricing)) : new Map();
      const routeStructureMapFromCache = routeStructures ? new Map(Object.entries(routeStructures)) : undefined;
      const { total, data, filterMetadata, flightsPage, pricingPage } = buildOptimizedFromCached(itineraries, flights, minReliabilityPercent, filterParams, pricingPoolFromCache, routeStructureMapFromCache);
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
        pricingPage,
      });
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
        
        // Using pro_key with remaining quota
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
    const routePathData: RoutePathResponse = await fetchRoutePaths(baseUrl, { 
      origin: region ? origin : originStr, 
      destination: region ? destination : destinationStr, 
      maxStop, 
      binbin,
      region
    });
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
    
    // 3. Extract query params (route groups)
    if (!Array.isArray(routePathData.queryParamsArr) || routePathData.queryParamsArr.length === 0) {
      return NextResponse.json({ error: 'No route groups found in create-full-route-path response' }, { status: 500 });
    }
    
    // 3.5. Optimize route groups using star decomposition + aggressive consolidation
    // Note: Use seatsAeroEndDate (endDate + 3 days) to match what availability-v2 actually fetches
    const { optimizeRouteGroups } = await import('@/lib/availability-v2/route-optimizer');
    const { computeSeatsAeroEndDate } = await import('@/lib/availability-v2/date-utils');
    const seatsAeroEndDate = computeSeatsAeroEndDate(endDate);
    
    const optimizedGroups = await optimizeRouteGroups(
      routePathData.queryParamsArr,
      startDate,
      seatsAeroEndDate
    );
    
    // If all routes are cached at the segment level, we still need to fetch cached availability responses
    // Build individual route groups from queryParamsArr so fetchAvailabilityForGroups can retrieve cached responses
    let apiCallGroups: Array<{ routeId: string; dateRange?: { start: string; end: string } }>;
    
    if (optimizedGroups.length === 0) {
      console.log('[build-itineraries] All routes fully cached at segment level, fetching cached availability responses');
      // When all segments are cached, create route groups from queryParamsArr
      // fetchAvailabilityForGroups will retrieve cached responses for these routes
      apiCallGroups = routePathData.queryParamsArr.map(route => ({
        routeId: route,
        dateRange: { start: startDate, end: seatsAeroEndDate }
      }));
      console.log(`[build-itineraries] Created ${apiCallGroups.length} route groups from queryParamsArr for cached data retrieval`);
    } else {
      // Convert optimized groups to API call format
      apiCallGroups = optimizedGroups.map(group => ({
        routeId: `${group.origins.join('/')}-${group.destinations.join('/')}`,
        dateRange: group.dateRange
      }));
      console.log(`[build-itineraries] Optimized ${routePathData.queryParamsArr.length} routes → ${apiCallGroups.length} API calls`);
    }

    // Process seats.aero API links

    // 4. For each group, call availability-v2 in parallel (limit 10 at a time)
    // Start performance monitoring
    PERFORMANCE_MONITORING.start();
    
    const { results: availabilityResults, minRateLimitRemaining: minRateLimitRemainingFetched, minRateLimitReset: minRateLimitResetFetched } = await fetchAvailabilityForGroups(apiCallGroups, {
      baseUrl,
      apiKey,
        startDate,
        endDate,
      cabin,
      carriers,
      seats,
      united,
      binbin,
      maxStop,
      concurrency: CONCURRENCY_CONFIG.AVAILABILITY_CONCURRENT_REQUESTS,
    });
    let minRateLimitRemaining: number | null = minRateLimitRemainingFetched;
    let minRateLimitReset: number | null = minRateLimitResetFetched;
    
    // Log performance metrics
    PERFORMANCE_MONITORING.logMetrics();
    const afterAvailabilityTime = Date.now(); // Time after fetching availability-v2

    // Availability fetch completed

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
    
    // Total seats.aero HTTP requests processed

    // Track availability fetch performance
    performanceMetrics.availabilityFetch = afterAvailabilityTime - t0;
    Sentry.setContext('performance', {
      route: 'build-itineraries',
      availabilityFetchMs: performanceMetrics.availabilityFetch,
      totalSeatsAeroRequests: totalSeatsAeroHttpRequests,
    });

    // 5. Build a pool of all segment availabilities and pricing from all responses
    // Extract airport list from route path data for early pricing filtering
    // For direct flights (maxStop === 0), pass maxStop to skip filtering
    const routeStructure = routePathData.airportList ? { airportList: routePathData.airportList } : undefined;
    const { segmentPool, pricingPool, pricingIndex } = buildSegmentAndPricingPools(availabilityResults as any, routeStructure, maxStop);
    
    // Log pricing pool status for debugging
    console.log(`[build-itineraries] Pricing pool populated: ${pricingPool.size} entries, maxStop: ${maxStop}, binbin: ${binbin}`);
    if (maxStop === 0) {
      console.log(`[build-itineraries] Direct flights mode (maxStop=0): Route structure O/A/B/D:`, 
        routeStructure?.airportList ? {
          O: routeStructure.airportList.O?.length || 0,
          A: routeStructure.airportList.A?.length || 0,
          B: routeStructure.airportList.B?.length || 0,
          D: routeStructure.airportList.D?.length || 0,
        } : 'undefined'
      );
    }

    // EARLY FILTERING: Remove unreliable intermediate segments from availability pool
    // This requires reliability data, so fetch it first
    const reliabilityStart = Date.now();
    const { table: reliabilityTable, map: reliabilityMap } = await getReliabilityData();
    performanceMetrics.reliabilityCache = Date.now() - reliabilityStart;
    
    // Compute direct distance for O/D threshold and prepare airport cache (skip in region mode)
    let airportMap: Record<string, any> = {};
    let directDistanceMiles = 0;
    if (!region) {
      const airportData = await getAirportData(
        originStr,
        destinationStr,
        segmentPool,
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      );
      airportMap = airportData.airportMap;
      directDistanceMiles = airportData.directDistanceMiles;
    }

    // Filter segments: remove unreliable intermediate segments but prune long unreliable O/D segments (skip in region mode)
    const segmentFilterStart = Date.now();
    const filteredSegmentPool = region ? segmentPool : filterUnreliableSegments(segmentPool, originStr, destinationStr, minReliabilityPercent, airportMap, directDistanceMiles);
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
    // Skip pre-filtering in region mode - routes are already validated by subregion query
    const preFilterStart = Date.now();
    let allRoutes: FullRoutePathResult[];
    let validRoutes: FullRoutePathResult[];
    
    if (region) {
      // In region mode, skip pre-filtering since routes are already validated
      allRoutes = processedRoutes as FullRoutePathResult[];
      validRoutes = allRoutes;
      console.log(`[build-itineraries] Skipping route pre-filtering in region mode (${allRoutes.length} routes)`);
    } else {
      const prefilterResult = prefilterValidRoutes(processedRoutes as FullRoutePathResult[], filteredSegmentPool);
      allRoutes = prefilterResult.allRoutes;
      validRoutes = prefilterResult.validRoutes;
      console.log(`[build-itineraries] Route pre-filtering: ${allRoutes.length} → ${validRoutes.length} routes`);
    }
    
    const preFilterTime = Date.now() - preFilterStart;
    performanceMetrics.routePreFiltering = preFilterTime;
    // Route pre-filtering completed

    // 7. Optimized parallel route processing
    console.log(`[build-itineraries] Starting itinerary building with ${validRoutes.length} valid routes, maxStop=${maxStop}, region=${region}`);
    
    const output: Record<string, Record<string, string[][]>> = {};
    const flightMap = new Map<string, AvailabilityFlight>();
    const itineraryBuildStart = Date.now();
    let itineraryMetrics: any = createItineraryMetrics();
    let routeStructureMap = new Map<string, FullRoutePathResult>();
    
    // Special handling for direct flights (maxStop=0)
    if (maxStop === 0) {
      const direct = await buildDirectItineraries(originStr, destinationStr, filteredSegmentPool, flightMap);
      Object.assign(output, direct);
      console.log(`[build-itineraries] Built ${Object.keys(output).length} direct route groups from ${validRoutes.length} routes`);
    } else {
    
    // Build itineraries across routes (parallel or sequential)
    const built = await buildItinerariesAcrossRoutes(
      validRoutes,
      filteredSegmentPool,
      flightMap,
      connectionMatrix,
      routeToOriginalMap,
      { parallel: validRoutes.length > 5 }, // Lower threshold
      { origin: originStr, destination: destinationStr, region }
    );
    Object.assign(output, built.output);
    itineraryMetrics = built.metrics;
    routeStructureMap = built.routeStructureMap;
    console.log(`[build-itineraries] Built ${Object.keys(output).length} route groups from ${validRoutes.length} routes`);
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
    const filteredOutput = filterReliableItineraries(output, flightMap, minReliabilityPercent, isUnreliableFlight);
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
          // Updated pro_key quota
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
    
    // Performance metrics logged to Sentry
    
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
    // Convert routeStructureMap to a plain object for caching
    const routeStructures: Record<string, any> = {};
    routeStructureMap.forEach((value, key) => {
      routeStructures[key] = value;
    });
    
    const responseObj = await cacheItineraries(cacheKey, {
      itineraries: filteredOutput,
      flights: Object.fromEntries(flightMap),
      pricing: Object.fromEntries(pricingPool),
      routeStructures,
      minRateLimitRemaining,
      minRateLimitReset,
      totalSeatsAeroHttpRequests,
    });
    
    // Extract filter metadata from the full response
    const filterMetadata = extractFilterMetadata(filteredOutput, Object.fromEntries(flightMap));
    
    // Cache the full result in Redis (compressed)
    // already cached via cacheFullResponse
    
    // --- Use optimized processing for new data ---
    const optimizedItineraries = precomputeItineraryMetadata(filteredOutput, Object.fromEntries(flightMap), minReliabilityPercent, getClassPercentages, routeStructureMap, pricingIndex);
    const { total, data } = optimizedFilterSortSearchPaginate(optimizedItineraries, filterParams);
    
    const allFlights = Object.fromEntries(flightMap);
    const flightsPage = buildFlightsPage(data as any, allFlights);
    const pricingPage = buildPricingPage(data as any, pricingPool);
    
    // Log pricing page status for debugging
    const itinerariesWithPricing = (data as any[]).filter((item: any) => item.pricingId && item.pricingId.length > 0);
    console.log(`[build-itineraries] Pricing page: ${Object.keys(pricingPage).length} pricing entries, ${itinerariesWithPricing.length}/${data.length} itineraries have pricingIds`);
    
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
      pricingPage,
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