import { NextRequest, NextResponse } from 'next/server';
import { availabilityV2Schema } from '@/lib/availability-v2/schema';
import { validateApiKeyWithResponse } from '@/lib/http/auth';
import { parseDateRange, generateDateRange } from '@/lib/availability-v2/date-utils';
import { parseRouteId } from '@/lib/routes/parse-route-id';
import { createSeatsAeroClient, paginateSearch } from '@/lib/clients/seats-aero';
import { CONCURRENCY_CONFIG, PERFORMANCE_MONITORING } from '@/lib/concurrency-config';
import { getSupabaseConfig } from '@/lib/env-utils';
import { getReliabilityTableCached } from '@/lib/reliability-cache';
import { processAvailabilityData } from '@/lib/availability-v2/processing';
import { processPricingData } from '@/lib/availability-v2/pricing-processor';
import { mergeProcessedTrips } from '@/lib/availability-v2/merge';
import { groupAndDeduplicate } from '@/lib/availability-v2/group';
import { buildAvailabilityResponse } from '@/lib/availability-v2/response-builder';
import { handleAvailabilityError } from '@/lib/availability-v2/sentry-helper';
import { createValidationErrorResponse } from '@/lib/availability-v2/zod-error-mapper';
import { adjustSeatCountsForUA } from '@/lib/airlines/ua-seat-adjust';
import { fetchUaPzRecords } from '@/lib/supabase/pz-service';
import { AvailabilityV2Request, PricingEntry, GroupedResult } from '@/types/availability-v2';
import { API_CONFIG, REQUEST_CONFIG, PERFORMANCE_CONFIG, LOGGING_CONFIG } from '@/lib/config/availability-v2';
import { getCachedAvailabilityGroup, saveCachedAvailabilityGroup, getCachedPricingGroup, saveCachedPricingGroup } from '@/lib/availability-v2/cache-helper';
import { initializeCityGroups, isCityCode, getCityAirports } from '@/lib/airports/city-groups';
import { updateRouteMetrics } from '@/lib/route-metrics/service';

/**
 * POST /api/availability-v2
 * Orchestrates the availability search workflow using modular services
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();
  let parseResult: any = null;
  let seatsAeroRequests = 0;
  
  // Track active requests for monitoring
  const activeRequests = (global as any).__activeRequests || 0;
  (global as any).__activeRequests = activeRequests + 1;
  
  // Track memory before request
  const memBefore = process.memoryUsage();
  
  // Increment performance monitoring
  PERFORMANCE_MONITORING.incrementRequest();
  
  try {
    // 1. Authentication & Validation
    const { apiKey, errorResponse } = validateApiKeyWithResponse(req);
    if (errorResponse) {
      (global as any).__activeRequests = Math.max(0, ((global as any).__activeRequests || 1) - 1);
      return errorResponse;
    }
    
    const body = await req.json();
    parseResult = availabilityV2Schema.safeParse(body);
    if (!parseResult.success) {
      const errorResponse = createValidationErrorResponse(parseResult.error);
      return NextResponse.json(errorResponse, { status: 400 });
    }
    
    const { routeId, startDate, endDate, cabin, carriers, seats: seatsRaw, united, binbin, maxStop } = parseResult.data;
    const seats = typeof seatsRaw === 'number' && seatsRaw > 0 ? seatsRaw : REQUEST_CONFIG.DEFAULT_SEATS;
    
    if (united) {
      console.log(`${LOGGING_CONFIG.UNITED_PREFIX} United parameter enabled - will adjust seat counts for UA flights based on pz table data`);
    }

    // 2. Data Preparation
    const parsedDates = parseDateRange(startDate, endDate);
    const { seatsAeroEndDate, sevenDaysAgo } = parsedDates;
    const { originAirports, destinationSegments, middleSegments } = parseRouteId(routeId);

    // 2.5. Early Cache Check
    // Initialize city groups to expand city codes to airports
    await initializeCityGroups();
    
    // Build allOrigins and allDestinations for seats.aero API (keep city codes as-is)
    const allOrigins = [...originAirports];
    const allDestinations = [...destinationSegments];
    middleSegments.forEach((segment: string[]) => {
      allOrigins.push(...segment);
      allDestinations.unshift(...segment);
    });
    
    // Expand city codes to individual airports for cache checking
    const expandToAirports = (codes: string[]): string[] => {
      const airports: string[] = [];
      for (const code of codes) {
        if (isCityCode(code)) {
          airports.push(...getCityAirports(code));
        } else {
          airports.push(code);
        }
      }
      return airports;
    };

    // Expand city codes to individual airports for cache keys
    const uniqueOriginAirports = [...new Set(expandToAirports(allOrigins))];
    const uniqueDestinationAirports = [...new Set(expandToAirports(allDestinations))];
    
    // Check cache for extended date range (same as what gets processed: startDate to seatsAeroEndDate)
    const dates = generateDateRange(startDate, seatsAeroEndDate);

    // Check cache for all airport pair combinations
    const cachedGroups: GroupedResult[] = [];
    const cachedKeys: string[] = [];
    const missingKeys: string[] = [];

    // Check pricing cache if binbin=true
    const cachedPricingEntries: PricingEntry[] = [];
    const cachedPricingKeys: string[] = [];
    const missingPricingKeys: string[] = [];

    const emptyCachedKeys: string[] = []; // Track empty cache hits
    
    // Build array of all cache keys to check in parallel
    const cacheKeys: Array<{ originAirport: string; destinationAirport: string; date: string; key: string }> = [];
    for (const originAirport of uniqueOriginAirports) {
      for (const destinationAirport of uniqueDestinationAirports) {
        for (const date of dates) {
          const key = `${originAirport}-${destinationAirport}-${date}`;
          cacheKeys.push({ originAirport, destinationAirport, date, key });
        }
      }
    }

    // Parallel cache reads for availability
    const availabilityCachePromises = cacheKeys.map(({ originAirport, destinationAirport, date }) =>
      getCachedAvailabilityGroup(originAirport, destinationAirport, date)
    );
    
    // Parallel cache reads for pricing (if binbin=true)
    const pricingCachePromises = binbin === true
      ? cacheKeys.map(({ originAirport, destinationAirport, date }) =>
          getCachedPricingGroup(originAirport, destinationAirport, date)
        )
      : null;

    // Await all cache reads in parallel
    const availabilityCacheResults = await Promise.all(availabilityCachePromises);
    const pricingCacheResults = pricingCachePromises
      ? await Promise.all(pricingCachePromises)
      : null;

    // Process availability cache results
    for (let i = 0; i < cacheKeys.length; i++) {
      const { key } = cacheKeys[i];
      const cached = availabilityCacheResults[i];
      
      // Check availability cache
      // null = not cached, [] = cached but empty, [items] = cached with results
      if (cached !== null) {
        // Cached (either empty or with results)
        if (cached.length > 0) {
          cachedGroups.push(...cached);
          cachedKeys.push(key);
        } else {
          // Empty array = cached but no results (don't fetch again)
          emptyCachedKeys.push(key);
        }
      } else {
        // Not cached = need to fetch
        missingKeys.push(key);
      }
    }

    // Process pricing cache results (if binbin=true)
    if (binbin === true && pricingCacheResults) {
      for (let i = 0; i < cacheKeys.length; i++) {
        const { key } = cacheKeys[i];
        const cachedPricing = pricingCacheResults[i];
        
        if (cachedPricing !== null) {
          // Cached (either empty or with results)
          if (cachedPricing.length > 0) {
            cachedPricingEntries.push(...cachedPricing);
            cachedPricingKeys.push(key);
          }
          // Note: empty pricing cache is fine, we don't track it separately
        } else {
          missingPricingKeys.push(key);
        }
      }
    }

    // If all combinations are cached (including empty results), return early (skip slow path)
    // Note: allAvailabilityCached means all keys are cached (either with results or empty)
    const allAvailabilityCached = missingKeys.length === 0;
    const allPricingCached = binbin === true ? (missingPricingKeys.length === 0) : true;
    
    if (allAvailabilityCached && allPricingCached) {
      const filteredCachedGroups = cachedGroups.filter(group => {
        const groupDate = group.date;
        return groupDate >= startDate && groupDate <= seatsAeroEndDate;
      });
      
      let filteredCachedPricing: PricingEntry[] | null = null;
      if (binbin === true && cachedPricingEntries.length > 0) {
        filteredCachedPricing = cachedPricingEntries.filter(entry => {
          return entry.date >= startDate && entry.date <= seatsAeroEndDate;
        });
      }
      
      console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Cache hit - returning ${filteredCachedGroups.length} cached groups (from ${cachedGroups.length} total, filtered to ${startDate} to ${seatsAeroEndDate})`);
      if (emptyCachedKeys.length > 0) {
        console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Empty cache hits (no results): ${emptyCachedKeys.length} keys`);
      }
      if (binbin === true && filteredCachedPricing) {
        console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Pricing cache hit - returning ${filteredCachedPricing.length} cached pricing entries (from ${cachedPricingEntries.length} total)`);
      }
      
      return buildAvailabilityResponse({
        groupedResults: filteredCachedGroups,
        seatsAeroRequests: 0,
        rateLimit: null,
        routeId,
        startDate,
        endDate,
        cabin,
        carriers,
        seats,
        united,
        startTime,
        pricingData: filteredCachedPricing
      });
    }

    // Log partial cache hits
    if (cachedGroups.length > 0 || emptyCachedKeys.length > 0) {
      console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Partial availability cache hit - ${cachedGroups.length} cached with results, ${emptyCachedKeys.length} cached empty, ${missingKeys.length} missing`);
    }
    
    if (binbin === true && cachedPricingEntries.length > 0) {
      console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Partial pricing cache hit - ${cachedPricingEntries.length} cached, ${missingPricingKeys.length} missing`);
    }

    // 3. External Data Fetching
    const reliabilityTable = await getReliabilityTableCached();
    
    let pzData: any[] = [];
    if (united) {
      try {
        pzData = await fetchUaPzRecords(startDate, endDate);
      } catch (error) {
        console.error('Error fetching pz data:', error);
      }
    }

    // 4. Seats.aero API Integration
    const baseParams: Record<string, string> = {
      origin_airport: allOrigins.join(','),
      destination_airport: allDestinations.join(','),
      start_date: startDate,
      end_date: seatsAeroEndDate,
      take: API_CONFIG.DEFAULT_PAGE_SIZE.toString(),
      include_trips: 'true',
      include_filtered: 'true',
      carriers: REQUEST_CONFIG.SUPPORTED_CARRIERS.join('%2C'),
      disable_live_filtering: 'true'
    };
    // Set only_direct_flights: true if:
    // 1. binbin is false, OR
    // 2. maxStop === 0 (direct flights only), even if binbin is true
    if (binbin === false || maxStop === 0) {
      baseParams.only_direct_flights = 'true';
      if (maxStop === 0 && binbin === true) {
        console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} maxStop=0 detected: Setting only_direct_flights=true even though binbin=true`);
      }
    }
    
    if (cabin) baseParams.cabin = cabin;
    if (carriers) baseParams.carriers = carriers;

    const client = createSeatsAeroClient(apiKey!);
    const fetchStartTime = Date.now();
    
    // Use incremental processing callback to track pages as they arrive
    // (for monitoring and potential future optimization)
    const { pages: allPages, requestCount, rateLimit } = await paginateSearch(
      client,
      API_CONFIG.SEATS_AERO_BASE_URL,
      baseParams,
      API_CONFIG.MAX_PAGINATION_PAGES,
      (page, pageIndex) => {
        // Callback for incremental processing - currently used for monitoring
        // Pages are still accumulated in allPages for processing functions
      }
    );
    seatsAeroRequests += requestCount;
    const fetchTime = Date.now();
    const pageCount = allPages.length; // Capture page count before clearing

    // 4.4. Update route metrics asynchronously (non-blocking)
    // Capture pages data before processing (allPages will be cleared later)
    const pagesForMetrics = [...allPages]; // Shallow copy for metrics collection
    updateRouteMetrics(pagesForMetrics, startDate, seatsAeroEndDate)
      .catch((error) => {
        console.error('[availability-v2] Error updating route metrics (non-blocking):', error);
      });

    // 4.5. Data Processing Pipeline - Process availability and pricing in parallel when both needed
    const processStartTime = Date.now();
    let pricingData = null;
    let results: any[] = [];
    let stats: any = null;

    if (binbin === true) {
      // Parallel processing when both availability and pricing are needed
      const [availabilityResult, pricingResult] = await Promise.all([
        Promise.resolve(processAvailabilityData(
          allPages,
          cabin,
          seats,
          sevenDaysAgo,
          reliabilityTable
        )),
        Promise.resolve(processPricingData(allPages))
      ]);
      
      results = availabilityResult.results;
      stats = availabilityResult.stats;
      pricingData = pricingResult;
      
      // Pricing log is optional - only log if significant
      if (pricingData.length > 0) {
        console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Pricing: ${pricingData.length} entries`);
      }
    } else {
      // Only process availability data
      const availabilityResult = processAvailabilityData(
        allPages,
        cabin,
        seats,
        sevenDaysAgo,
        reliabilityTable
      );
      results = availabilityResult.results;
      stats = availabilityResult.stats;
    }

    const processTime = Date.now();

    // Clear allPages immediately after processing to free memory
    // This is critical to prevent memory accumulation
    allPages.length = 0;

    const mergeStartTime = Date.now();
    const mergedMap = mergeProcessedTrips(results, reliabilityTable);
    const mergeTime = Date.now();

    const groupStartTime = Date.now();
    const groupedResults = await groupAndDeduplicate(mergedMap);
    const groupTime = Date.now();
    
    // Combined processing stats log with page count
    console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Stats: ${stats.totalItems} items (${pageCount} Pages), ${stats.filteredTrips}/${stats.totalTrips} trips → ${mergedMap.size} merged → ${groupedResults.length} groups`);

    // 5.5. Save groups to cache (group by originAirport-destinationAirport-date to combine all alliances)
    const groupsByKey = new Map<string, { originAirport: string; destinationAirport: string; date: string; groups: GroupedResult[] }>();
    for (const group of groupedResults) {
      const key = `${group.originAirport}-${group.destinationAirport}-${group.date}`;
      if (!groupsByKey.has(key)) {
        groupsByKey.set(key, {
          originAirport: group.originAirport,
          destinationAirport: group.destinationAirport,
          date: group.date,
          groups: []
        });
      }
      groupsByKey.get(key)!.groups.push(group);
    }

    // Cache all airport-date combinations that were queried
    // For combinations with results: cache the groups
    // For combinations without results: cache empty array [] to avoid re-fetching
    const cachePromises: Promise<void>[] = [];
    
    // Cache combinations that have results
    for (const { originAirport, destinationAirport, date, groups } of groupsByKey.values()) {
      cachePromises.push(
        saveCachedAvailabilityGroup(
          originAirport,
          destinationAirport,
          date,
          groups,
          1800 // TTL: 30 minutes
        )
      );
    }
    
    // Cache combinations that were queried but returned no results
    // These are airport-date combinations in our query that don't appear in groupedResults
    const queriedDates = generateDateRange(startDate, seatsAeroEndDate);
    for (const originAirport of uniqueOriginAirports) {
      for (const destinationAirport of uniqueDestinationAirports) {
        for (const date of queriedDates) {
          const key = `${originAirport}-${destinationAirport}-${date}`;
          
          // Only cache if:
          // 1. It was in missingKeys (not cached before)
          // 2. It's not in groupsByKey (no results returned)
          if (missingKeys.includes(key) && !groupsByKey.has(key)) {
            cachePromises.push(
              saveCachedAvailabilityGroup(
                originAirport,
                destinationAirport,
                date,
                [], // Empty array = no results found
                1800 // TTL: 30 minutes (same as results)
              )
            );
          }
        }
      }
    }
    
    // Save to cache asynchronously (non-blocking)
    Promise.all(cachePromises)
      .catch(err => {
        console.error('[availability-v2] Error saving groups to cache:', err);
      });

    // 5.6. Save pricing to cache (if binbin=true and pricing was processed)
    if (binbin === true && pricingData && pricingData.length > 0) {
      // Group pricing entries by originAirport-destinationAirport-date
      const pricingByKey = new Map<string, { originAirport: string; destinationAirport: string; date: string; entries: PricingEntry[] }>();
      for (const entry of pricingData) {
        const key = `${entry.departingAirport}-${entry.arrivingAirport}-${entry.date}`;
        if (!pricingByKey.has(key)) {
          pricingByKey.set(key, {
            originAirport: entry.departingAirport,
            destinationAirport: entry.arrivingAirport,
            date: entry.date,
            entries: []
          });
        }
        pricingByKey.get(key)!.entries.push(entry);
      }

      const pricingCachePromises = Array.from(pricingByKey.values()).map(({ originAirport, destinationAirport, date, entries }) => {
        return saveCachedPricingGroup(
          originAirport,
          destinationAirport,
          date,
          entries,
          1800 // TTL: 30 minutes
        );
      });
      // Save to cache asynchronously (non-blocking)
      Promise.all(pricingCachePromises)
        .then(() => {
          console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Pricing cache: ${pricingCachePromises.length} keys, ${pricingData.length} entries`);
        })
        .catch(err => {
          console.error('[availability-v2] Error saving pricing to cache:', err);
        });
    }

    // 6. UA Seat Adjustments (if enabled)
    if (united) {
      let uaAdjustedCount = 0;
      for (const group of groupedResults) {
        for (const flight of group.flights) {
          if (flight.FlightNumbers.startsWith('UA')) {
            const adjusted = adjustSeatCountsForUA(
              united,
              pzData,
              flight.FlightNumbers,
              group.originAirport,
              group.destinationAirport,
              group.date,
              flight.YCount,
              flight.JCount,
              seats
            );
            flight.YCount = adjusted.yCount;
            flight.JCount = adjusted.jCount;
            uaAdjustedCount++;
          }
        }
      }
      console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} UA adjustments completed - Adjusted flights: ${uaAdjustedCount}`);
    }

    // 7. Response Building
    const responseStartTime = Date.now();
    const response = buildAvailabilityResponse({
      groupedResults,
      seatsAeroRequests,
      rateLimit,
      routeId,
      startDate,
      endDate,
      cabin,
      carriers,
      seats,
      united,
      startTime,
      pricingData
    });
    const responseTime = Date.now();
    
    // Final timing summary
    const totalTime = Date.now() - startTime;
    const memAfter = process.memoryUsage();
    console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Total: ${totalTime}ms | Fetch: ${fetchTime - fetchStartTime}ms | Process: ${processTime - processStartTime}ms | Merge: ${mergeTime - mergeStartTime}ms | Group: ${groupTime - groupStartTime}ms | Response: ${responseTime - responseStartTime}ms | Memory: ${Math.round(memAfter.heapUsed / 1024 / 1024)}MB | Active: ${(global as any).__activeRequests || 0}`);
    
    // Decrement active requests
    (global as any).__activeRequests = Math.max(0, ((global as any).__activeRequests || 1) - 1);
    
    return response;

  } catch (error: any) {
    // Decrement active requests on error
    (global as any).__activeRequests = Math.max(0, ((global as any).__activeRequests || 1) - 1);
    
    // Track error in performance monitoring
    PERFORMANCE_MONITORING.incrementError();
    
    return handleAvailabilityError(error, req, {
      route: 'availability-v2',
      routeId: parseResult?.data?.routeId,
      startDate: parseResult?.data?.startDate,
      endDate: parseResult?.data?.endDate,
      cabin: parseResult?.data?.cabin,
      processingTime: Date.now() - startTime,
      seatsAeroRequests: seatsAeroRequests || 0,
    });
  }
}