import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { createHash } from 'crypto';
import zlib from 'zlib';
import { addDays, parseISO, format, subDays } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import { CONCURRENCY_CONFIG } from '@/lib/concurrency-config';
import { getSupabaseConfig, getRedisConfig } from '@/lib/env-utils';
import { getReliabilityTableCached } from '@/lib/reliability-cache';
import Redis from 'ioredis';

// Performance optimization caches
const ALLIANCE_MAP = new Map<string, string>([
  // Star Alliance
  ['A3', 'SA'], ['AC', 'SA'], ['CA', 'SA'], ['AI', 'SA'], ['NZ', 'SA'], ['NH', 'SA'], 
  ['OZ', 'SA'], ['OS', 'SA'], ['AV', 'SA'], ['SN', 'SA'], ['CM', 'SA'], ['OU', 'SA'], 
  ['MS', 'SA'], ['ET', 'SA'], ['BR', 'SA'], ['LO', 'SA'], ['LH', 'SA'], ['CL', 'SA'], 
  ['ZH', 'SA'], ['SQ', 'SA'], ['SA', 'SA'], ['LX', 'SA'], ['TP', 'SA'], ['TG', 'SA'], 
  ['TK', 'SA'], ['UA', 'SA'],
  // SkyTeam
  ['AR', 'ST'], ['AM', 'ST'], ['UX', 'ST'], ['AF', 'ST'], ['CI', 'ST'], ['MU', 'ST'], 
  ['DL', 'ST'], ['GA', 'ST'], ['KQ', 'ST'], ['ME', 'ST'], ['KL', 'ST'], ['KE', 'ST'], 
  ['SV', 'ST'], ['SK', 'ST'], ['RO', 'ST'], ['VN', 'ST'], ['VS', 'ST'], ['MF', 'ST'],
  // OneWorld
  ['AS', 'OW'], ['AA', 'OW'], ['BA', 'OW'], ['CX', 'OW'], ['FJ', 'OW'], ['AY', 'OW'], 
  ['IB', 'OW'], ['JL', 'OW'], ['QF', 'OW'], ['QR', 'OW'], ['RJ', 'OW'], ['AT', 'OW'], 
  ['UL', 'OW'], ['MH', 'OW'], ['WY', 'OW'],
  // Individual carriers
  ['EY', 'EY'], ['EK', 'EK'], ['JX', 'JX'], ['B6', 'B6'], ['GF', 'GF'], ['DE', 'DE']
]);

const flightNumberCache = new Map<string, string>();

// Zod schema for request validation
const availabilityV2Schema = z.object({
  routeId: z.string().min(3),
  startDate: z.string().min(8),
  endDate: z.string().min(8),
  cabin: z.string().optional(),
  carriers: z.string().optional(),
  seats: z.coerce.number().int().min(1).default(1).optional(),
});

const SEATS_SEARCH_URL = "https://seats.aero/partnerapi/search?";

if (!SEATS_SEARCH_URL) {
  throw new Error('SEATS_SEARCH_URL environment variable is not set');
}

// Distance-based mileage cost thresholds for DE and JX flights
const DISTANCE_THRESHOLDS = {
  ECONOMY: [
    { maxDistance: 1500, maxMileage: 7500 },
    { maxDistance: 3000, maxMileage: 25000 },
    { maxDistance: 5000, maxMileage: 30000 },
    { maxDistance: 7000, maxMileage: 37500 },
    { maxDistance: 10000, maxMileage: 42500 },
    { maxDistance: Infinity, maxMileage: 65000 }
  ],
  PREMIUM: [
    { maxDistance: 1500, maxMileage: 10000 },
    { maxDistance: 3000, maxMileage: 32500 },
    { maxDistance: 5000, maxMileage: 40000 },
    { maxDistance: 7000, maxMileage: 50000 },
    { maxDistance: 10000, maxMileage: 55000 },
    { maxDistance: Infinity, maxMileage: 85000 }
  ],
  BUSINESS: [
    { maxDistance: 1500, maxMileage: 15000 },
    { maxDistance: 3000, maxMileage: 50000 },
    { maxDistance: 5000, maxMileage: 60000 },
    { maxDistance: 7000, maxMileage: 75000 },
    { maxDistance: 10000, maxMileage: 85000 },
    { maxDistance: Infinity, maxMileage: 130000 }
  ],
  FIRST: [
    { maxDistance: 1500, maxMileage: 22500 },
    { maxDistance: 3000, maxMileage: 75000 },
    { maxDistance: 5000, maxMileage: 90000 },
    { maxDistance: 7000, maxMileage: 110000 },
    { maxDistance: 10000, maxMileage: 130000 },
    { maxDistance: Infinity, maxMileage: 195000 }
  ]
};

/**
 * Checks if a DE or JX flight meets the distance-based mileage cost requirements
 */
function meetsDistanceThresholds(flightPrefix: string, distance: number, mileageCost: number, cabin: string): boolean {
  // Only apply filtering to DE and JX flights
  if (flightPrefix !== 'DE' && flightPrefix !== 'JX') {
    return true;
  }

  // Determine which cabin thresholds to use
  let thresholds;
  switch (cabin.toLowerCase()) {
    case 'economy':
    case 'y':
      thresholds = DISTANCE_THRESHOLDS.ECONOMY;
      break;
    case 'premium':
    case 'w':
      thresholds = DISTANCE_THRESHOLDS.PREMIUM;
      break;
    case 'business':
    case 'j':
      thresholds = DISTANCE_THRESHOLDS.BUSINESS;
      break;
    case 'first':
    case 'f':
      thresholds = DISTANCE_THRESHOLDS.FIRST;
      break;
    default:
      // Default to economy if cabin is not specified
      thresholds = DISTANCE_THRESHOLDS.ECONOMY;
  }

  // Find the appropriate threshold based on distance
  const threshold = thresholds.find(t => distance <= t.maxDistance);
  if (!threshold) {
    // Removed logging to reduce noise
    return false;
  }

  // Check if mileage cost is within the threshold
  const isValid = mileageCost <= threshold.maxMileage;
  // Removed logging to reduce noise
  return isValid;
}

// --- Redis setup ---
let redis: Redis | null = null;

function getRedisClient(): Redis | null {
  if (redis) return redis;
  
  // Use sanitized Redis configuration
  const config = getRedisConfig();
  
  try {
    redis = new Redis({ 
      ...config,
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

// Optimized helper to compress and save response to Redis
async function saveCompressedResponseToRedis(key: string, response: any) {
  const client = getRedisClient();
  if (!client) return;
  try {
    const json = JSON.stringify(response);
    const compressed = zlib.gzipSync(json, { level: 6, memLevel: 8 }); // Optimized compression
    // Use pipeline for atomic operations
    const pipeline = client.pipeline();
    pipeline.set(key, compressed);
    pipeline.expire(key, 86400); // 24h TTL
    await pipeline.exec();
  } catch (err) {
    console.error('Redis saveCompressedResponseToRedis error:', err);
  }
}

/**
 * Normalizes a flight number by removing leading zeros after the airline prefix.
 * E.g., BA015 → BA15, JL001 → JL1
 * Cached for performance optimization.
 */
function normalizeFlightNumber(flightNumber: string): string {
  const cached = flightNumberCache.get(flightNumber);
  if (cached) return cached;
  
  const match = flightNumber.match(/^([A-Z]{2,3})(0*)(\d+)$/i);
  const normalized = match ? 
    `${match[1].toUpperCase()}${parseInt(match[3], 10)}` : 
    flightNumber;
  
  flightNumberCache.set(flightNumber, normalized);
  return normalized;
}

// Use environment variables for Supabase with Unicode sanitization
// Note: Using non-throwing version for build-time compatibility
const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getSupabaseConfig();

// Note: Reliability table caching moved to shared service at @/lib/reliability-cache

/**
 * Returns the count multiplier for a given flight/cabin/source based on reliability table.
 */
function getCountMultiplier({ code, cabin, source, reliabilityTable }: { code: string, cabin: string, source: string, reliabilityTable: any[] }) {
  const entry = reliabilityTable.find((r) => r.code === code);
  if (!entry) return 1;
  if (entry.exemption && typeof entry.exemption === 'string' && entry.exemption.toUpperCase() === (cabin || '').slice(0, 1).toUpperCase()) return 1;
  if (Array.isArray(entry.ffp_program) && entry.ffp_program.length > 0) {
    if (entry.ffp_program.includes(source)) return entry.min_count || 1;
  }
  return 1;
}

/**
 * Gets alliance for a flight prefix using pre-computed map for O(1) lookup.
 */
function getAlliance(flightPrefix: string): string | undefined {
  return ALLIANCE_MAP.get(flightPrefix);
}

/**
 * POST /api/availability-v2
 * @param req NextRequest
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();
  console.log(`[PERF] API Request started at ${new Date().toISOString()}`);
  
  try {
    // Validate API key
    const apiKey = req.headers.get('partner-authorization');
    if (!apiKey) {
      return NextResponse.json({ error: 'API key is required' }, { status: 400 });
    }

    // Parse and validate body
    const validationStartTime = Date.now();
    const body = await req.json();
    const parseResult = availabilityV2Schema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    const { routeId, startDate, endDate, cabin, carriers, seats: seatsRaw } = parseResult.data;
    const seats = typeof seatsRaw === 'number' && seatsRaw > 0 ? seatsRaw : 1;
    console.log(`[PERF] Validation completed in ${Date.now() - validationStartTime}ms`);

    // Compute seatsAeroEndDate as +3 days after user input endDate
    let seatsAeroEndDate: string;
    try {
      // Accept both ISO and YYYY-MM-DD formats
      const parsedEndDate = endDate.length > 10 ? parseISO(endDate) : new Date(endDate);
      seatsAeroEndDate = format(addDays(parsedEndDate, 3), 'yyyy-MM-dd');
    } catch (e) {
      return NextResponse.json({ error: 'Invalid endDate format' }, { status: 400 });
    }

    // Calculate 7 days ago for filtering
    const sevenDaysAgo = subDays(new Date(), 7);

    // Parse route segments
    const segments = routeId.split('-');
    const originAirports = (segments[0] || '').split('/');
    const destinationSegments = (segments[segments.length - 1] || '').split('/');
    const middleSegments = segments.slice(1, -1).map(seg => (seg || '').split('/'));

    // Pagination variables
    let hasMore = true;
    let skip = 0;
    let cursor: string | null = null;
    let processedCount = 0;
    const uniqueItems = new Map<string, boolean>();
    const results: any[] = [];
    let seatsAeroRequests = 0;
    let lastResponse: Response | null = null;

    // Fetch reliability table (cached)
    const reliabilityStartTime = Date.now();
    const reliabilityTable = await getReliabilityTableCached();
    console.log(`[PERF] Reliability table fetch completed in ${Date.now() - reliabilityStartTime}ms`);

    // --- Parallelized Paginated Fetches ---
    // Fetch first page to get hasMore and cursor
    const allOrigins = [...originAirports];
    const allDestinations = [...destinationSegments];
    middleSegments.forEach(segment => {
      allOrigins.push(...segment);
      allDestinations.unshift(...segment);
    });
    const baseParams: Record<string, string> = {
      origin_airport: allOrigins.join(','),
      destination_airport: allDestinations.join(','),
      start_date: startDate,
      end_date: seatsAeroEndDate,
      take: '1000',
      include_trips: 'true',
      only_direct_flights: 'true',
      include_filtered: 'false',
      carriers: 'A3%2CEY%2CAC%2CCA%2CAI%2CNZ%2CNH%2COZ%2COS%2CAV%2CSN%2CCM%2COU%2CMS%2CET%2CBR%2CLO%2CLH%2CCL%2CZH%2CSQ%2CSA%2CLX%2CTP%2CTG%2CTK%2CUA%2CAR%2CAM%2CUX%2CAF%2CCI%2CMU%2CDL%2CGA%2CKQ%2CME%2CKL%2CKE%2CSV%2CSK%2CRO%2CMH%2CVN%2CVS%2CMF%2CAS%2CAA%2CBA%2CCX%2CFJ%2CAY%2CIB%2CJL%2CMS%2CQF%2CQR%2CRJ%2CAT%2CUL%2CWY%2CJX%2CEK%2CB6%2CDE%2CGF',
      disable_live_filtering: 'true'
    };
    if (cabin) baseParams.cabin = cabin;
    if (carriers) baseParams.carriers = carriers;
    // Helper to build URL
    const buildUrl = (params: Record<string, string | number>) => {
      const sp = new URLSearchParams(params as any);
      return `https://seats.aero/partnerapi/search?${sp.toString()}`;
    };
    // Fetch first page
    const fetchStartTime = Date.now();
    const firstUrl = buildUrl({ ...baseParams });
    const firstRes = await fetch(firstUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'Partner-Authorization': apiKey,
      },
    });
    seatsAeroRequests++;
    console.log(`[PERF] First page fetch completed in ${Date.now() - fetchStartTime}ms`);
    if (firstRes.status === 429) {
      const retryAfter = firstRes.headers.get('Retry-After');
      return NextResponse.json(
        {
          error: 'Rate limit exceeded. Please try again later.',
          retryAfter: retryAfter ? Number(retryAfter) : undefined,
        },
        { status: 429 }
      );
    }
    if (!firstRes.ok) {
      return NextResponse.json(
        { error: `Seats.aero API Error: ${firstRes.statusText}` },
        { status: firstRes.status }
      );
    }
    const firstData = await firstRes.json();
    lastResponse = firstRes;
    let allPages = [firstData];
    let cursors: string[] = [];
    hasMore = firstData.hasMore || false;
    cursor = firstData.cursor;
    // Sequential pagination (no parallel fetches)
    const paginationStartTime = Date.now();
    if (hasMore && typeof skip === 'number') {
      // Sequential fetch using skip parameter
      let pageCount = 0;
      const maxPages = CONCURRENCY_CONFIG.PAGINATION_MAX_PAGES; // Use configuration
      console.log(`[PERF] Starting pagination with skip method, max pages: ${maxPages}`);
      while (hasMore && pageCount < maxPages) {
        pageCount++;
        const params = { ...baseParams, skip: pageCount * 1000 };
        const url = buildUrl(params);
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'Partner-Authorization': apiKey,
          },
        });
        seatsAeroRequests++;
        if (!res.ok) break;
        const data = await res.json();
        allPages.push(data);
        hasMore = data.hasMore || false;
        cursor = data.cursor;
        lastResponse = res;
      }
    } else {
      // Sequential fetch using cursor
      console.log(`[PERF] Starting pagination with cursor method`);
      while (hasMore && cursor) {
        const params = { ...baseParams, cursor };
        const url = buildUrl(params);
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'Partner-Authorization': apiKey,
          },
        });
        seatsAeroRequests++;
        if (!res.ok) break;
        const data = await res.json();
        allPages.push(data);
        hasMore = data.hasMore || false;
        cursor = data.cursor;
        lastResponse = res;
      }
    }
    console.log(`[PERF] All pagination completed in ${Date.now() - paginationStartTime}ms. Total pages: ${allPages.length}, Total requests: ${seatsAeroRequests}`);
    
    // --- Optimized Processing with Early Filtering ---
    const processingStartTime = Date.now();
    let totalItems = 0;
    let totalTrips = 0;
    let filteredTrips = 0;
    
    for (const page of allPages) {
      if (!page?.data?.length) continue;
      totalItems += page.data.length;
      
      for (const item of page.data) {
        if (uniqueItems.has(item.ID)) continue;
        uniqueItems.set(item.ID, true);
        
        if (!item.AvailabilityTrips?.length) continue;
        
        const route = item.Route || {};
        const distance = route.Distance || 0;
        
        for (const trip of item.AvailabilityTrips) {
          totalTrips++;
          // Early filtering - skip non-direct flights and old trips
          if (trip.Stops !== 0) continue;
          if (trip.UpdatedAt && new Date(trip.UpdatedAt) < sevenDaysAgo) continue;
          
          // Fast cabin and seat filtering
          const tripCabin = trip.Cabin?.toLowerCase() || '';
          const remainingSeats = trip.RemainingSeats || 0;
          const seatThreshold = seats === 1 ? 0 : seats;
          
          // Single condition check
          if (cabin && tripCabin !== cabin.toLowerCase()) continue;
          if (remainingSeats < seatThreshold) continue;
          
          filteredTrips++;
          const mileageCost = trip.MileageCost || 0;
          const flightNumbers = trip.FlightNumbers || '';
          
          // Pre-compute common values
          const originAirport = route.OriginAirport;
          const destinationAirport = route.DestinationAirport;
          const itemDate = item.Date;
          const source = trip.Source || item.Source || '';
          const aircraft = Array.isArray(trip.Aircraft) && trip.Aircraft.length > 0 ? trip.Aircraft[0] : '';
          
          // Process flight numbers efficiently
          if (flightNumbers.includes(',')) {
            // Multiple flights
            const flightNumbersArr = flightNumbers.split(/,\s*/);
            for (const flightNumber of flightNumbersArr) {
              const normalizedFlightNumber = normalizeFlightNumber(flightNumber);
              const flightPrefix = normalizedFlightNumber.slice(0, 2);
              
              if (!meetsDistanceThresholds(flightPrefix, distance, mileageCost, tripCabin)) continue;
              
              results.push({
                originAirport,
                destinationAirport,
                date: itemDate,
                distance,
                FlightNumbers: normalizedFlightNumber,
                TotalDuration: trip.TotalDuration || 0,
                Aircraft: aircraft,
                DepartsAt: trip.DepartsAt || '',
                ArrivesAt: trip.ArrivesAt || '',
                YMile: tripCabin === 'economy' ? mileageCost : 0,
                WMile: tripCabin === 'premium' ? mileageCost : 0,
                JMile: tripCabin === 'business' ? mileageCost : 0,
                FMile: tripCabin === 'first' ? mileageCost : 0,
                Source: source,
                Cabin: tripCabin,
              });
            }
          } else {
            // Single flight
            const normalizedFlightNumber = normalizeFlightNumber(flightNumbers);
            const flightPrefix = normalizedFlightNumber.slice(0, 2);
            
            if (meetsDistanceThresholds(flightPrefix, distance, mileageCost, tripCabin)) {
              results.push({
                originAirport,
                destinationAirport,
                date: itemDate,
                distance,
                FlightNumbers: normalizedFlightNumber,
                TotalDuration: trip.TotalDuration || 0,
                Aircraft: aircraft,
                DepartsAt: trip.DepartsAt || '',
                ArrivesAt: trip.ArrivesAt || '',
                YMile: tripCabin === 'economy' ? mileageCost : 0,
                WMile: tripCabin === 'premium' ? mileageCost : 0,
                JMile: tripCabin === 'business' ? mileageCost : 0,
                FMile: tripCabin === 'first' ? mileageCost : 0,
                Source: source,
                Cabin: tripCabin,
              });
            }
          }
        }
      }
    }
    console.log(`[PERF] Initial processing completed in ${Date.now() - processingStartTime}ms`);
    console.log(`[PERF] Data volume - Items: ${totalItems}, Trips: ${totalTrips}, Filtered trips: ${filteredTrips}, Raw results: ${results.length}`);
    
    // Highly optimized merging with reduced object operations
    const mergingStartTime = Date.now();
    const mergedMap = new Map<string, any>();
    
    for (const entry of results) {
      const flightNumber = entry.FlightNumbers; // Already normalized
      const key = `${entry.originAirport}|${entry.destinationAirport}|${entry.date}|${flightNumber}|${entry.Source}`;
      const flightPrefix = flightNumber.slice(0, 2);
      const cabin = entry.Cabin;
      const cabinChar = cabin[0]?.toUpperCase();
      
      // Single cabin count calculation based on actual cabin
      let cabinCount = 0;
      if ((cabin === 'economy' && entry.YMile > 0) || 
          (cabin === 'premium' && entry.WMile > 0) || 
          (cabin === 'business' && entry.JMile > 0) || 
          (cabin === 'first' && entry.FMile > 0)) {
        cabinCount = getCountMultiplier({ code: flightPrefix, source: entry.Source, cabin: cabinChar, reliabilityTable });
      }
      
      const existing = mergedMap.get(key);
      if (!existing) {
        // Create optimized entry with pre-zeroed counts
        const newEntry = {
          originAirport: entry.originAirport,
          destinationAirport: entry.destinationAirport,
          date: entry.date,
          distance: entry.distance,
          FlightNumbers: flightNumber,
          TotalDuration: entry.TotalDuration,
          Aircraft: entry.Aircraft,
          DepartsAt: entry.DepartsAt,
          ArrivesAt: entry.ArrivesAt,
          Source: entry.Source,
          Cabin: cabin,
          YCount: cabin === 'economy' ? cabinCount : 0,
          WCount: cabin === 'premium' ? cabinCount : 0,
          JCount: cabin === 'business' ? cabinCount : 0,
          FCount: cabin === 'first' ? cabinCount : 0,
        };
        mergedMap.set(key, newEntry);
      } else {
        // Fast accumulation without conditionals
        if (cabin === 'economy') existing.YCount += cabinCount;
        else if (cabin === 'premium') existing.WCount += cabinCount;
        else if (cabin === 'business') existing.JCount += cabinCount;
        else if (cabin === 'first') existing.FCount += cabinCount;
        
        // Optimized string length comparison
        if (entry.Aircraft.length > existing.Aircraft.length) {
          existing.Aircraft = entry.Aircraft;
        }
        
        // Optimized time comparisons without redundant checks
        if (entry.DepartsAt && entry.DepartsAt < existing.DepartsAt) {
          existing.DepartsAt = entry.DepartsAt;
        }
        if (entry.ArrivesAt && entry.ArrivesAt > existing.ArrivesAt) {
          existing.ArrivesAt = entry.ArrivesAt;
        }
      }
    }
    console.log(`[PERF] Merging completed in ${Date.now() - mergingStartTime}ms. Merged results: ${mergedMap.size}`);
    
    // Consolidated grouping with alliance assignment in single pass
    const groupingStartTime = Date.now();
    const finalGroupedMap = new Map<string, any>();
    
    for (const entry of mergedMap.values()) {
      const flightPrefix = entry.FlightNumbers.slice(0, 2);
      const alliance = ALLIANCE_MAP.get(flightPrefix);
      
      // Skip entries without alliance (faster than filtering later)
      if (!alliance) continue;
      
      const groupKey = `${entry.originAirport}|${entry.destinationAirport}|${entry.date}|${alliance}`;
      const existing = finalGroupedMap.get(groupKey);
      
      if (!existing) {
        finalGroupedMap.set(groupKey, {
          originAirport: entry.originAirport,
          destinationAirport: entry.destinationAirport,
          date: entry.date,
          distance: entry.distance,
          alliance,
          earliestDeparture: entry.DepartsAt,
          latestDeparture: entry.DepartsAt,
          earliestArrival: entry.ArrivesAt,
          latestArrival: entry.ArrivesAt,
          flights: [{
            FlightNumbers: entry.FlightNumbers,
            TotalDuration: entry.TotalDuration,
            Aircraft: entry.Aircraft,
            DepartsAt: entry.DepartsAt,
            ArrivesAt: entry.ArrivesAt,
            YCount: entry.YCount,
            WCount: entry.WCount,
            JCount: entry.JCount,
            FCount: entry.FCount,
            distance: entry.distance,
          }]
        });
      } else {
        // Fast time comparisons
        if (entry.DepartsAt < existing.earliestDeparture) existing.earliestDeparture = entry.DepartsAt;
        if (entry.DepartsAt > existing.latestDeparture) existing.latestDeparture = entry.DepartsAt;
        if (entry.ArrivesAt < existing.earliestArrival) existing.earliestArrival = entry.ArrivesAt;
        if (entry.ArrivesAt > existing.latestArrival) existing.latestArrival = entry.ArrivesAt;
        
        existing.flights.push({
          FlightNumbers: entry.FlightNumbers,
          TotalDuration: entry.TotalDuration,
          Aircraft: entry.Aircraft,
          DepartsAt: entry.DepartsAt,
          ArrivesAt: entry.ArrivesAt,
          YCount: entry.YCount,
          WCount: entry.WCount,
          JCount: entry.JCount,
          FCount: entry.FCount,
          distance: entry.distance,
        });
      }
    }
    const groupedResults = Array.from(finalGroupedMap.values());
    console.log(`[PERF] Consolidated grouping and alliance assignment completed in ${Date.now() - groupingStartTime}ms. Final groups: ${groupedResults.length}`);
    // Forward rate limit headers from the last fetch response if present
    let rlRemaining: string | null = null;
    let rlReset: string | null = null;
    if (lastResponse && lastResponse.headers) {
      rlRemaining = lastResponse.headers.get('x-ratelimit-remaining');
      rlReset = lastResponse.headers.get('x-ratelimit-reset');
    }
    const responsePayload = { groups: groupedResults, seatsAeroRequests };
    
    // Save compressed response to Redis (async, non-blocking)
    const redisStartTime = Date.now();
    const hash = createHash('sha256').update(JSON.stringify({ routeId, startDate, endDate, cabin, carriers, seats })).digest('hex');
    const redisKey = `availability-v2-response:${hash}`;
    const redisPromise = saveCompressedResponseToRedis(redisKey, responsePayload);
    // Don't await Redis save to avoid blocking response
    redisPromise.then(() => {
      console.log(`[PERF] Redis save completed in ${Date.now() - redisStartTime}ms`);
    }).catch(err => {
      console.error('Redis save error:', err);
    });
    
    const totalTime = Date.now() - startTime;
    console.log(`[PERF] Total API request completed in ${totalTime}ms`);
    console.log(`[PERF] Cache stats - Flight numbers: ${flightNumberCache.size}, Alliance lookups: ${ALLIANCE_MAP.size}`);
    
    const nextRes = NextResponse.json(responsePayload);
    if (rlRemaining) nextRes.headers.set('x-ratelimit-remaining', rlRemaining);
    if (rlReset) nextRes.headers.set('x-ratelimit-reset', rlReset);
    return nextRes;
  } catch (error: any) {
    // Log with context, but avoid flooding logs
    console.error('Error in /api/availability-v2:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
} 