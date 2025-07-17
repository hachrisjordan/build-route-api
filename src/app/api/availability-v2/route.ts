import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import Valkey from 'iovalkey';
import { createHash } from 'crypto';
import zlib from 'zlib';
import { addDays, parseISO, format } from 'date-fns';
import { createClient } from '@supabase/supabase-js';

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

// --- Valkey (iovalkey) setup ---
let valkey: any = null;
function getValkeyClient(): any {
  if (valkey) return valkey;
  const host = process.env.VALKEY_HOST;
  const port = process.env.VALKEY_PORT ? parseInt(process.env.VALKEY_PORT, 10) : 6379;
  const password = process.env.VALKEY_PASSWORD;
  if (!host) return null;
  valkey = new Valkey({ host, port, password });
  return valkey;
}
// Helper to compress and save response to Valkey
async function saveCompressedResponseToValkey(key: string, response: any) {
  const client = getValkeyClient();
  if (!client) return;
  try {
    const json = JSON.stringify(response);
    const compressed = zlib.gzipSync(json);
    await client.setBuffer(key, compressed);
    await client.expire(key, 86400); // 24h TTL
  } catch (err) {
    console.error('Valkey saveCompressedResponseToValkey error:', err);
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
    // Validate API key
    const apiKey = req.headers.get('partner-authorization');
    if (!apiKey) {
      return NextResponse.json({ error: 'API key is required' }, { status: 400 });
    }

    // Parse and validate body
    const body = await req.json();
    const parseResult = availabilityV2Schema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    const { routeId, startDate, endDate, cabin, carriers, seats: seatsRaw } = parseResult.data;
    const seats = typeof seatsRaw === 'number' && seatsRaw > 0 ? seatsRaw : 1;

    // Compute seatsAeroEndDate as +3 days after user input endDate
    let seatsAeroEndDate: string;
    try {
      // Accept both ISO and YYYY-MM-DD formats
      const parsedEndDate = endDate.length > 10 ? parseISO(endDate) : new Date(endDate);
      seatsAeroEndDate = format(addDays(parsedEndDate, 3), 'yyyy-MM-dd');
    } catch (e) {
      return NextResponse.json({ error: 'Invalid endDate format' }, { status: 400 });
    }

    // Parse route segments
    const segments = routeId.split('-');
    const originAirports = segments[0].split('/');
    const destinationSegments = segments[segments.length - 1].split('/');
    const middleSegments = segments.slice(1, -1).map(seg => seg.split('/'));

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
    const firstUrl = buildUrl({ ...baseParams });
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
    // If skip is supported, fire off parallel fetches
    if (hasMore && typeof skip === 'number') {
      // Try to estimate number of pages (if possible)
      // If total count is not available, fetch up to 5 more pages in parallel as a safe default
      const maxPages = 5;
      const fetches = [];
      for (let i = 1; i <= maxPages; i++) {
        const params = { ...baseParams, skip: i * 1000 };
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
      // Fallback: sequential fetch using cursor
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
              // Only include trips with enough RemainingSeats for the requested cabin
              let includeTrip = false;
              let cabinType = '';
              if (cabin) {
                if (
                  trip.Cabin &&
                  trip.Cabin.toLowerCase() === cabin.toLowerCase() &&
                  typeof trip.RemainingSeats === 'number' &&
                  trip.RemainingSeats >= seats
                ) {
                  includeTrip = true;
                  cabinType = trip.Cabin.toLowerCase();
                }
              } else {
                if (
                  typeof trip.RemainingSeats === 'number' &&
                  trip.RemainingSeats >= seats
                ) {
                  includeTrip = true;
                  cabinType = trip.Cabin ? trip.Cabin.toLowerCase() : '';
                }
              }
              if (!includeTrip) continue;
              const flightNumbersArr = (trip.FlightNumbers || '').split(/,\s*/);
              for (const flightNumber of flightNumbersArr) {
                const normalizedFlightNumber = normalizeFlightNumber(flightNumber);
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
    const mergedResults = Array.from(groupedMap.values()).map(({ YMile, WMile, JMile, FMile, ...rest }) => {
      // Alliance logic
      const flightPrefix = (rest.FlightNumbers || '').slice(0, 2).toUpperCase();
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
      return alliance ? { ...rest, alliance } : null;
    }).filter(Boolean);

    // Group by originAirport, destinationAirport, date, alliance
    const finalGroupedMap = new Map<string, any>();
    for (const entry of mergedResults) {
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
    // Save compressed response to Valkey
    const hash = createHash('sha256').update(JSON.stringify({ routeId, startDate, endDate, cabin, carriers, seats })).digest('hex');
    const valkeyKey = `availability-v2-response:${hash}`;
    saveCompressedResponseToValkey(valkeyKey, responsePayload);
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