import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getRedisConfig } from '@/lib/env-utils';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import zlib from 'zlib';
import { addDays, parseISO, format, subDays, addMinutes } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import { CONCURRENCY_CONFIG } from '@/lib/concurrency-config';

// NH destinations from TYO route string
const NH_DESTINATIONS = [
  'PEK', 'DLC', 'CAN', 'HGH', 'TAO', 'PVG', 'SHA', 'SZX', 'HKG', 'DEL', 'BOM', 'CGK', 'AXT', 'AOJ', 'AKJ', 'FUK', 'HKD', 'HIJ', 'ISG', 'IWK', 'KOJ', 'UKB', 'KCZ', 'KMQ', 'KMJ', 'KUH', 'MYJ', 'MMB', 'MMY', 'KMI', 'NGS', 'NGO', 'SHB', 'KIJ', 'OBO', 'OIT', 'OKJ', 'OKA', 'ITM', 'KIX', 'CTS', 'SDJ', 'FSZ', 'TAK', 'TKS', 'HND', 'NRT', 'TOY', 'UBJ', 'WKJ', 'KUM', 'KUL', 'MNL', 'SIN', 'GMP', 'TSA', 'BKK', 'HAN', 'SGN', 'PER', 'SYD'
];

// Function to return NH destinations (excluding origin)
function getDestinationAirports(origin: string): string[] {
  const originUpper = origin.toUpperCase();
  
  // Return all NH destinations except the origin
  return NH_DESTINATIONS.filter(airport => airport !== originUpper);
}

// Zod schema for request validation
const nhFSchema = z.object({
  O: z.string().length(3), // Origin airport
  D: z.string().length(3), // Destination airport
  T: z.string().min(8), // Timestamp
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

// Helper to compress and save response to Redis
async function saveCompressedResponseToRedis(key: string, response: any) {
  const client = getRedisClient();
  if (!client) return;
  try {
    const json = JSON.stringify(response);
    const compressed = zlib.gzipSync(json);
    await client.set(key, compressed);
    await client.expire(key, 86400); // 24h TTL
  } catch (err) {
    console.error('Redis saveCompressedResponseToRedis error:', err);
  }
}

/**
 * Normalizes a flight number by removing leading zeros after the airline prefix.
 * E.g., BA015 → BA15, JL001 → JL1
 */
function normalizeFlightNumber(flightNumber: string): string {
  const match = flightNumber.match(/^([A-Z]{2,3})(0*)(\d+)$/i);
  if (!match) return flightNumber;
  const [, prefix, , number] = match;
  if (!prefix || !number) return flightNumber;
  return `${prefix.toUpperCase()}${parseInt(number, 10)}`;
}

// Use environment variables for Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// --- Reliability Table In-Memory Cache ---
let reliabilityCache: any[] | null = null;
let reliabilityCacheTimestamp = 0;
const RELIABILITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getReliabilityTableCached() {
  const now = Date.now();
  if (reliabilityCache && now - reliabilityCacheTimestamp < RELIABILITY_CACHE_TTL_MS) {
    return reliabilityCache;
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase.from('reliability').select('code, min_count, exemption, ffp_program');
  if (error) {
    console.error('Failed to fetch reliability table:', error);
    reliabilityCache = [];
  } else {
    reliabilityCache = data || [];
  }
  reliabilityCacheTimestamp = now;
  return reliabilityCache;
}

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
 * POST /api/availability-v2
 * @param req NextRequest
 */
export async function POST(req: NextRequest) {
  try {
    // Get API key from Supabase
    const supabase = createClient(supabaseUrl, supabaseKey);
    const { data, error } = await supabase
      .from('pro_key')
      .select('pro_key, remaining, last_updated')
      .order('remaining', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data || !data.pro_key) {
      return NextResponse.json({ 
        error: 'No available pro_key found', 
        details: error?.message 
      }, { status: 500 });
    }

    const apiKey = data.pro_key;

    // Parse and validate body
    const body = await req.json();
    const parseResult = nhFSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    const { O: origin, D: destination, T: timestamp, cabin, carriers, seats: seatsRaw } = parseResult.data;
    const seats = typeof seatsRaw === 'number' && seatsRaw > 0 ? seatsRaw : 1;

    // Parse timestamp and extract date
    let startDate: string;
    let endDate: string;
    try {
      const parsedTimestamp = parseISO(timestamp);
      startDate = format(parsedTimestamp, 'yyyy-MM-dd');
      endDate = format(addDays(parsedTimestamp, 1), 'yyyy-MM-dd');
    } catch (e) {
      return NextResponse.json({ error: 'Invalid timestamp format' }, { status: 400 });
    }

    // Use the calculated endDate for seats.aero (no need to extend beyond requested range)
    let seatsAeroEndDate: string = endDate;

    // Calculate 7 days ago for filtering
    const sevenDaysAgo = subDays(new Date(), 7);

    // Get destination airports based on origin
    const destinationAirports = getDestinationAirports(origin);
    const originAirports = ['HND', 'NRT']; // NH hubs (Tokyo)

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
    const reliabilityTable = await getReliabilityTableCached();

    // --- Parallelized Paginated Fetches ---
    // Fetch first page to get hasMore and cursor
    const allOrigins = [...originAirports];
    const allDestinations = [...destinationAirports];
    const baseParams: Record<string, string> = {
      origin_airport: allOrigins.join(','),
      destination_airport: allDestinations.join(','),
      start_date: startDate,
      end_date: seatsAeroEndDate,
      take: '1000',
      include_trips: 'true',
      only_direct_flights: 'true',
      include_filtered: 'false',
      carriers: 'NH',
      sources: 'aeroplan,united',
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
    const firstUrl = buildUrl({ ...baseParams });
    
    // Log the seats.aero curl command
    console.log('Seats.aero API URL:', firstUrl);
    console.log('Seats.aero curl command:');
    console.log(`curl -X GET "${firstUrl}" \\`);
    console.log(`  -H "accept: application/json" \\`);
    console.log(`  -H "Partner-Authorization: ${apiKey}"`);
    const firstRes = await fetch(firstUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'Partner-Authorization': apiKey,
      },
    });
    seatsAeroRequests++;
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
    if (hasMore && typeof skip === 'number') {
      // Sequential fetch using skip parameter
      let pageCount = 0;
      const maxPages = CONCURRENCY_CONFIG.PAGINATION_MAX_PAGES; // Use configuration
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
    // --- Optimized Deduplication and Merging ---
    for (const page of allPages) {
      if (page && page.data && Array.isArray(page.data) && page.data.length > 0) {
        for (const item of page.data) {
          if (uniqueItems.has(item.ID)) continue;
          if (item.AvailabilityTrips && Array.isArray(item.AvailabilityTrips) && item.AvailabilityTrips.length > 0) {
            for (const trip of item.AvailabilityTrips) {
              if (trip.Stops !== 0) continue;
              
              // Filter out trips older than 7 days
              if (trip.UpdatedAt) {
                const tripUpdatedAt = new Date(trip.UpdatedAt);
                if (tripUpdatedAt < sevenDaysAgo) continue;
              }
              // Only include trips with enough RemainingSeats for the requested cabin
              let includeTrip = false;
              let cabinType = '';
              if (cabin) {
                if (
                  trip.Cabin &&
                  trip.Cabin.toLowerCase() === cabin.toLowerCase() &&
                  typeof trip.RemainingSeats === 'number' &&
                  (seats === 1 ? trip.RemainingSeats >= 0 : trip.RemainingSeats >= seats)
                ) {
                  includeTrip = true;
                  cabinType = trip.Cabin.toLowerCase();
                }
              } else {
                if (
                  typeof trip.RemainingSeats === 'number' &&
                  (seats === 1 ? trip.RemainingSeats >= 0 : trip.RemainingSeats >= seats)
                ) {
                  includeTrip = true;
                  cabinType = trip.Cabin ? trip.Cabin.toLowerCase() : '';
                }
              }
              if (!includeTrip) continue;
              
              // Apply hub-specific time windows based on destination
              if (trip.DepartsAt) {
                const departureTime = new Date(trip.DepartsAt);
                const timestampDate = parseISO(timestamp);
                const originAirport = item.Route.OriginAirport;
                
                let minHours: number;
                let maxHours: number;
                
                if (destination === 'NRT') {
                  // If inbound arrives at NRT
                  if (originAirport === 'NRT') {
                    minHours = 1; // NRT flights: 1-8 hours after T
                    maxHours = 8;
                  } else if (originAirport === 'HND') {
                    minHours = 3; // HND flights: 3-8 hours after T
                    maxHours = 8;
                  } else {
                    continue; // Skip non-Tokyo hubs
                  }
                } else if (destination === 'HND') {
                  // If inbound arrives at HND
                  if (originAirport === 'HND') {
                    minHours = 1; // HND flights: 1-8 hours after T
                    maxHours = 8;
                  } else if (originAirport === 'NRT') {
                    minHours = 3; // NRT flights: 3-8 hours after T
                    maxHours = 8;
                  } else {
                    continue; // Skip non-Tokyo hubs
                  }
                } else {
                  continue; // Skip if destination is neither HND nor NRT
                }
                
                const minDepartureTime = addMinutes(timestampDate, minHours * 60);
                const maxDepartureTime = addMinutes(timestampDate, maxHours * 60);
                
                if (departureTime < minDepartureTime || departureTime > maxDepartureTime) {
                  continue; // Skip flights outside the time window
                }
              }
              
              const flightNumbersArr = (trip.FlightNumbers || '').split(/,\s*/);
              for (const flightNumber of flightNumbersArr) {
                const normalizedFlightNumber = normalizeFlightNumber(flightNumber);
                const flightPrefix = normalizedFlightNumber.slice(0, 2).toUpperCase();
                const distance = item.Route.Distance || 0;
                const mileageCost = trip.MileageCost || 0;
                
                // Only include NH flights
                if (flightPrefix !== 'NH') {
                  continue;
                }
                
                // Apply distance-based filtering for DE and JX flights
                if (!meetsDistanceThresholds(flightPrefix, distance, mileageCost, cabinType)) {
                  continue;
                }
                
                results.push({
                  originAirport: item.Route.OriginAirport,
                  destinationAirport: item.Route.DestinationAirport,
                  date: item.Date,
                  distance: item.Route.Distance,
                  FlightNumbers: normalizedFlightNumber,
                  TotalDuration: trip.TotalDuration || 0,
                  Aircraft: Array.isArray(trip.Aircraft) && trip.Aircraft.length > 0 ? trip.Aircraft[0] : '',
                  DepartsAt: trip.DepartsAt || '',
                  ArrivesAt: trip.ArrivesAt || '',
                  YMile: (cabinType === 'economy') ? (trip.MileageCost || 0) : 0,
                  WMile: (cabinType === 'premium') ? (trip.MileageCost || 0) : 0,
                  JMile: (cabinType === 'business') ? (trip.MileageCost || 0) : 0,
                  FMile: (cabinType === 'first') ? (trip.MileageCost || 0) : 0,
                  Source: trip.Source || item.Source || '',
                  Cabin: trip.Cabin || '',
                });
              }
            }
          }
          uniqueItems.set(item.ID, true);
        }
      }
    }
    // Merge duplicates based on originAirport, destinationAirport, date, FlightNumbers, and Source
    // When merging, only sum counts for entries that have a positive count (i.e., only those that passed the seat filter)
    const mergedMap = new Map<string, any>();
    for (const entry of results) {
      const key = [
        entry.originAirport,
        entry.destinationAirport,
        entry.date,
        normalizeFlightNumber(entry.FlightNumbers),
        entry.Source
      ].join('|');
      const flightPrefix = (entry.FlightNumbers || '').slice(0, 2).toUpperCase();
      if (!mergedMap.has(key)) {
        mergedMap.set(key, {
          ...entry,
          YCount: (entry.YMile > 0 && entry.Cabin.toLowerCase() === 'economy') ? getCountMultiplier({ code: flightPrefix, cabin: 'Y', source: entry.Source, reliabilityTable }) : 0,
          WCount: (entry.WMile > 0 && entry.Cabin.toLowerCase() === 'premium') ? getCountMultiplier({ code: flightPrefix, cabin: 'W', source: entry.Source, reliabilityTable }) : 0,
          JCount: (entry.JMile > 0 && entry.Cabin.toLowerCase() === 'business') ? getCountMultiplier({ code: flightPrefix, cabin: 'J', source: entry.Source, reliabilityTable }) : 0,
          FCount: (entry.FMile > 0 && entry.Cabin.toLowerCase() === 'first') ? getCountMultiplier({ code: flightPrefix, cabin: 'F', source: entry.Source, reliabilityTable }) : 0,
          YMile: undefined,
          WMile: undefined,
          JMile: undefined,
          FMile: undefined,
        });
      } else {
        const merged = mergedMap.get(key);
        merged.YCount += (entry.YMile > 0 && entry.Cabin.toLowerCase() === 'economy') ? getCountMultiplier({ code: flightPrefix, cabin: 'Y', source: entry.Source, reliabilityTable }) : 0;
        merged.WCount += (entry.WMile > 0 && entry.Cabin.toLowerCase() === 'premium') ? getCountMultiplier({ code: flightPrefix, cabin: 'W', source: entry.Source, reliabilityTable }) : 0;
        merged.JCount += (entry.JMile > 0 && entry.Cabin.toLowerCase() === 'business') ? getCountMultiplier({ code: flightPrefix, cabin: 'J', source: entry.Source, reliabilityTable }) : 0;
        merged.FCount += (entry.FMile > 0 && entry.Cabin.toLowerCase() === 'first') ? getCountMultiplier({ code: flightPrefix, cabin: 'F', source: entry.Source, reliabilityTable }) : 0;
        // Accept the longer Aircraft string
        if ((entry.Aircraft || '').length > (merged.Aircraft || '').length) {
          merged.Aircraft = entry.Aircraft;
        }
        // Accept the earliest DepartsAt and latest ArrivesAt
        if (entry.DepartsAt && (!merged.DepartsAt || entry.DepartsAt < merged.DepartsAt)) {
          merged.DepartsAt = entry.DepartsAt;
        }
        if (entry.ArrivesAt && (!merged.ArrivesAt || entry.ArrivesAt > merged.ArrivesAt)) {
          merged.ArrivesAt = entry.ArrivesAt;
        }
      }
    }
    // Prepare final output, removing YMile/WMile/JMile/FMIle
    // Now, group by originAirport, destinationAirport, date, FlightNumbers (not Source) for the response
    const groupedMap = new Map<string, any>();
    for (const entry of mergedMap.values()) {
      const groupKey = [
        entry.originAirport,
        entry.destinationAirport,
        entry.date,
        normalizeFlightNumber(entry.FlightNumbers)
      ].join('|');
      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, {
          ...entry,
          YCount: entry.YCount,
          WCount: entry.WCount,
          JCount: entry.JCount,
          FCount: entry.FCount,
        });
      } else {
        const group = groupedMap.get(groupKey);
        group.YCount += entry.YCount;
        group.WCount += entry.WCount;
        group.JCount += entry.JCount;
        group.FCount += entry.FCount;
        // Accept the longer Aircraft string
        if ((entry.Aircraft || '').length > (group.Aircraft || '').length) {
          group.Aircraft = entry.Aircraft;
        }
        // Accept the earliest DepartsAt and latest ArrivesAt
        if (entry.DepartsAt && (!group.DepartsAt || entry.DepartsAt < group.DepartsAt)) {
          group.DepartsAt = entry.DepartsAt;
        }
        if (entry.ArrivesAt && (!group.ArrivesAt || entry.ArrivesAt > group.ArrivesAt)) {
          group.ArrivesAt = entry.ArrivesAt;
        }
      }
    }
    // Now, continue with alliance logic and grouping as before, but use groupedMap.values() instead of mergedMap.values()
    const mergedResults = Array.from(groupedMap.values()).map((entry) => {
      const { YMile, WMile, JMile, FMile, ...rest } = entry;
      // Alliance logic
      const flightPrefix = (rest.FlightNumbers || '').slice(0, 2).toUpperCase();
      const distance = rest.distance || 0;
      
      // Apply distance-based filtering for DE and JX flights in the merged results
      // Check each cabin type that has availability
      let hasValidCabin = false;
      if (rest.YCount > 0 && meetsDistanceThresholds(flightPrefix, distance, YMile || 0, 'economy')) {
        hasValidCabin = true;
      }
      if (rest.WCount > 0 && meetsDistanceThresholds(flightPrefix, distance, WMile || 0, 'premium')) {
        hasValidCabin = true;
      }
      if (rest.JCount > 0 && meetsDistanceThresholds(flightPrefix, distance, JMile || 0, 'business')) {
        hasValidCabin = true;
      }
      if (rest.FCount > 0 && meetsDistanceThresholds(flightPrefix, distance, FMile || 0, 'first')) {
        hasValidCabin = true;
      }
      
      // If no valid cabins for DE/JX flights, skip this result
      if ((flightPrefix === 'DE' || flightPrefix === 'JX') && !hasValidCabin) {
        return null;
      }
      
      // Preserve mileage values for later filtering
      const resultWithMileage = {
        ...rest,
        YMile,
        WMile,
        JMile,
        FMile
      };
      
      const starAlliance = [
        'A3','AC','CA','AI','NZ','NH','OZ','OS','AV','SN','CM','OU','MS','ET','BR','LO','LH','CL','ZH','SQ','SA','LX','TP','TG','TK','UA'
      ];
      const skyTeam = [
        'AR','AM','UX','AF','CI','MU','DL','GA','KQ','ME','KL','KE','SV','SK','RO','VN','VS','MF'
      ];
      const oneWorld = [
        'AS','AA','BA','CX','FJ','AY','IB','JL','MS','QF','QR','RJ','AT','UL','MH','WY'
      ];
      const etihad = ['EY'];
      const emirates = ['EK'];
      const starlux = ['JX'];
      const b6 = ['B6'];
      const gf = ['GF'];
      const de = ['DE'];
      let alliance: 'SA' | 'ST' | 'OW' | 'EY' | 'EK' | 'JX' | 'B6' | 'GF' | 'DE' | undefined;
      if (starAlliance.includes(flightPrefix)) alliance = 'SA';
      else if (skyTeam.includes(flightPrefix)) alliance = 'ST';
      else if (oneWorld.includes(flightPrefix)) alliance = 'OW';
      else if (etihad.includes(flightPrefix)) alliance = 'EY';
      else if (emirates.includes(flightPrefix)) alliance = 'EK';
      else if (starlux.includes(flightPrefix)) alliance = 'JX';
      else if (b6.includes(flightPrefix)) alliance = 'B6';
      else if (gf.includes(flightPrefix)) alliance = 'GF';
      else if (de.includes(flightPrefix)) alliance = 'DE';
      else alliance = undefined;
      return alliance ? { ...resultWithMileage, alliance } : null;
    }).filter(Boolean);

    // Group by originAirport, destinationAirport, date, alliance
    const finalGroupedMap = new Map<string, any>();
    for (const entry of mergedResults) {
      // Additional filtering for DE and JX flights in final grouping
      const flightPrefix = (entry.FlightNumbers || '').slice(0, 2).toUpperCase();
      const distance = entry.distance || 0;
      
      // For NH flights, ensure at least Y or J availability
      if (flightPrefix === 'NH') {
        if (entry.YCount === 0 && entry.JCount === 0) {
          continue; // Skip this entry if no Y AND no J availability
        }
      }
      
      // For DE and JX flights, ensure at least one cabin meets the distance thresholds
      if (flightPrefix === 'DE' || flightPrefix === 'JX') {
        let hasValidCabin = false;
        if (entry.YCount > 0 && meetsDistanceThresholds(flightPrefix, distance, entry.YMile || 0, 'economy')) {
          hasValidCabin = true;
        }
        if (entry.WCount > 0 && meetsDistanceThresholds(flightPrefix, distance, entry.WMile || 0, 'premium')) {
          hasValidCabin = true;
        }
        if (entry.JCount > 0 && meetsDistanceThresholds(flightPrefix, distance, entry.JMile || 0, 'business')) {
          hasValidCabin = true;
        }
        if (entry.FCount > 0 && meetsDistanceThresholds(flightPrefix, distance, entry.FMile || 0, 'first')) {
          hasValidCabin = true;
        }
        
        if (!hasValidCabin) {
          continue; // Skip this entry if no valid cabins
        }
      }
      
      const groupKey = [
        entry.originAirport,
        entry.destinationAirport,
        entry.date,
        entry.alliance
      ].join('|');
      if (!finalGroupedMap.has(groupKey)) {
        finalGroupedMap.set(groupKey, {
          originAirport: entry.originAirport,
          destinationAirport: entry.destinationAirport,
          date: entry.date,
          distance: entry.distance,
          alliance: entry.alliance,
          earliestDeparture: entry.DepartsAt,
          latestDeparture: entry.DepartsAt,
          earliestArrival: entry.ArrivesAt,
          latestArrival: entry.ArrivesAt,
          flights: [
            {
              FlightNumbers: normalizeFlightNumber(entry.FlightNumbers),
              TotalDuration: entry.TotalDuration,
              Aircraft: entry.Aircraft,
              DepartsAt: entry.DepartsAt,
              ArrivesAt: entry.ArrivesAt,
              YCount: entry.YCount,
              WCount: entry.WCount,
              JCount: entry.JCount,
              FCount: entry.FCount,
              distance: entry.distance,
            }
          ]
        });
      } else {
        const group = finalGroupedMap.get(groupKey);
        // Update earliest/latest departure/arrival
        if (entry.DepartsAt && (!group.earliestDeparture || entry.DepartsAt < group.earliestDeparture)) {
          group.earliestDeparture = entry.DepartsAt;
        }
        if (entry.DepartsAt && (!group.latestDeparture || entry.DepartsAt > group.latestDeparture)) {
          group.latestDeparture = entry.DepartsAt;
        }
        if (entry.ArrivesAt && (!group.earliestArrival || entry.ArrivesAt < group.earliestArrival)) {
          group.earliestArrival = entry.ArrivesAt;
        }
        if (entry.ArrivesAt && (!group.latestArrival || entry.ArrivesAt > group.latestArrival)) {
          group.latestArrival = entry.ArrivesAt;
        }
        group.flights.push({
          FlightNumbers: normalizeFlightNumber(entry.FlightNumbers),
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
    // Forward rate limit headers from the last fetch response if present
    let rlRemaining: string | null = null;
    let rlReset: string | null = null;
    if (lastResponse && lastResponse.headers) {
      rlRemaining = lastResponse.headers.get('x-ratelimit-remaining');
      rlReset = lastResponse.headers.get('x-ratelimit-reset');
    }
    const responsePayload = { groups: groupedResults, seatsAeroRequests };
    // Save compressed response to Redis
    const hash = createHash('sha256').update(JSON.stringify({ origin, destination, timestamp, cabin, carriers, seats })).digest('hex');
    const redisKey = `nh-f-response:${hash}`;
    saveCompressedResponseToRedis(redisKey, responsePayload);
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