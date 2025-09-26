import { NextRequest, NextResponse } from 'next/server';
import { availabilityV2Schema } from '@/lib/availability-v2/schema';
import { validateApiKeyWithResponse } from '@/lib/http/auth';
import { parseDateRange } from '@/lib/availability-v2/date-utils';
import { parseRouteId } from '@/lib/routes/parse-route-id';
import { createSeatsAeroClient, paginateSearch } from '@/lib/clients/seats-aero';
import { CONCURRENCY_CONFIG } from '@/lib/concurrency-config';
import { getSupabaseConfig } from '@/lib/env-utils';
import { getReliabilityTableCached } from '@/lib/reliability-cache';
import { processAvailabilityData } from '@/lib/availability-v2/processing';
import { mergeProcessedTrips } from '@/lib/availability-v2/merge';
import { groupAndDeduplicate } from '@/lib/availability-v2/group';
import { buildAvailabilityResponse } from '@/lib/availability-v2/response-builder';
import { handleAvailabilityError } from '@/lib/availability-v2/sentry-helper';
import { createValidationErrorResponse } from '@/lib/availability-v2/zod-error-mapper';
import { adjustSeatCountsForUA } from '@/lib/airlines/ua-seat-adjust';
import { fetchUaPzRecords } from '@/lib/supabase/pz-service';
import { AvailabilityV2Request } from '@/types/availability-v2';
import { API_CONFIG, REQUEST_CONFIG, PERFORMANCE_CONFIG, LOGGING_CONFIG } from '@/lib/config/availability-v2';

/**
 * POST /api/availability-v2
 * Orchestrates the availability search workflow using modular services
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();
  let parseResult: any = null;
  let seatsAeroRequests = 0;
  
  console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} API Request started at ${new Date().toISOString()}`);
  
  try {
    // 1. Authentication & Validation
    const { apiKey, errorResponse } = validateApiKeyWithResponse(req);
    if (errorResponse) return errorResponse;
    
    const body = await req.json();
    parseResult = availabilityV2Schema.safeParse(body);
    if (!parseResult.success) {
      const errorResponse = createValidationErrorResponse(parseResult.error);
      return NextResponse.json(errorResponse, { status: 400 });
    }
    
    const { routeId, startDate, endDate, cabin, carriers, seats: seatsRaw, united } = parseResult.data;
    const seats = typeof seatsRaw === 'number' && seatsRaw > 0 ? seatsRaw : REQUEST_CONFIG.DEFAULT_SEATS;
    
    if (united) {
      console.log(`${LOGGING_CONFIG.UNITED_PREFIX} United parameter enabled - will adjust seat counts for UA flights based on pz table data`);
    }

    // 2. Data Preparation
    const parsedDates = parseDateRange(startDate, endDate);
    const { seatsAeroEndDate, sevenDaysAgo } = parsedDates;
    const { originAirports, destinationSegments, middleSegments } = parseRouteId(routeId);

    // 3. External Data Fetching
    const reliabilityTable = await getReliabilityTableCached();
    
    let pzData: any[] = [];
    if (united) {
      try {
        pzData = await fetchUaPzRecords(startDate, endDate);
        console.log(`[PERF] PZ data fetch completed. Found ${pzData.length} records`);
      } catch (error) {
        console.error('Error fetching pz data:', error);
      }
    }

    // 4. Seats.aero API Integration
    const allOrigins = [...originAirports];
    const allDestinations = [...destinationSegments];
    middleSegments.forEach((segment: string[]) => {
      allOrigins.push(...segment);
      allDestinations.unshift(...segment);
    });

    const baseParams: Record<string, string> = {
      origin_airport: allOrigins.join(','),
      destination_airport: allDestinations.join(','),
      start_date: startDate,
      end_date: seatsAeroEndDate,
      take: API_CONFIG.DEFAULT_PAGE_SIZE.toString(),
      include_trips: 'true',
      only_direct_flights: 'true',
      include_filtered: 'true',
      carriers: REQUEST_CONFIG.SUPPORTED_CARRIERS.join('%2C'),
      disable_live_filtering: 'true'
    };
    
    if (cabin) baseParams.cabin = cabin;
    if (carriers) baseParams.carriers = carriers;

    const client = createSeatsAeroClient(apiKey!);
    const { pages: allPages, requestCount, rateLimit } = await paginateSearch(
      client,
      API_CONFIG.SEATS_AERO_BASE_URL,
      baseParams,
      API_CONFIG.MAX_PAGINATION_PAGES
    );
    seatsAeroRequests += requestCount;

    // 5. Data Processing Pipeline
    const { results, stats } = processAvailabilityData(
      allPages,
      cabin,
      seats,
      sevenDaysAgo,
      reliabilityTable
    );
    console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Processing completed - Items: ${stats.totalItems}, Trips: ${stats.totalTrips}, Filtered: ${stats.filteredTrips}`);

    const mergedMap = mergeProcessedTrips(results, reliabilityTable);
    console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Merging completed - Merged results: ${mergedMap.size}`);

    const groupedResults = groupAndDeduplicate(mergedMap);
    console.log(`${LOGGING_CONFIG.PERFORMANCE_PREFIX} Grouping completed - Final groups: ${groupedResults.length}`);

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
    return buildAvailabilityResponse({
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
      startTime
    });

  } catch (error: any) {
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