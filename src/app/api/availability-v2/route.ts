import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import Valkey from 'iovalkey';
import { addDays, parseISO, format } from 'date-fns';

// Zod schema for request validation
const availabilityV2Schema = z.object({
  routeId: z.string().min(3),
  startDate: z.string().min(8),
  endDate: z.string().min(8),
  cabin: z.string().optional(),
  carriers: z.string().optional(),
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

async function saveSeatsAeroLink(url: string) {
  const client = getValkeyClient();
  if (!client) return;
  try {
    // Use a Redis set to deduplicate, and set TTL 24h (86400s)
    await client.sadd('seats_aero_links', url);
    await client.expire('seats_aero_links', 86400);
  } catch (err) {
    // Non-blocking, log only
    console.error('Valkey saveSeatsAeroLink error:', err);
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
    const { routeId, startDate, endDate, cabin, carriers } = parseResult.data;

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

    // Continue fetching until all data is retrieved
    while (hasMore) {
      // Combine all origins and connections
      const allOrigins = [...originAirports];
      const allDestinations = [...destinationSegments];
      middleSegments.forEach(segment => {
        allOrigins.push(...segment);
        allDestinations.unshift(...segment);
      });

      // Construct search params (only include known working params)
      const searchParams = new URLSearchParams({
        origin_airport: allOrigins.join(','),
        destination_airport: allDestinations.join(','),
        start_date: startDate,
        end_date: seatsAeroEndDate,
        take: '1000',
        include_trips: 'true',
        only_direct_flights: 'true',
        carriers: 'A3%2CEY%2CAC%2CCA%2CAI%2CNZ%2CNH%2COZ%2COS%2CAV%2CSN%2CCM%2COU%2CMS%2CET%2CBR%2CLO%2CLH%2CCL%2CZH%2CSQ%2CSA%2CLX%2CTP%2CTG%2CTK%2CUA%2CAR%2CAM%2CUX%2CAF%2CCI%2CMU%2CDL%2CGA%2CKQ%2CME%2CKL%2CKE%2CSV%2CSK%2CRO%2CMH%2CVN%2CVS%2CMF%2CAS%2CAA%2CBA%2CCX%2CFJ%2CAY%2CIB%2CJL%2CMS%2CQF%2CQR%2CRJ%2CAT%2CUL'
      });
      if (cabin) searchParams.append('cabin', cabin);
      if (carriers) searchParams.append('carriers', carriers);
      if (skip > 0) searchParams.append('skip', skip.toString());
      if (cursor) searchParams.append('cursor', cursor);

      // Save the full seats.aero link to Redis/Valkey (non-blocking)
      const seatsAeroUrl = `https://seats.aero/partnerapi/search?${searchParams.toString()}`;
      saveSeatsAeroLink(seatsAeroUrl).catch(() => {});

      // Fetch from external API (use /partnerapi/search)
      const response = await fetch(seatsAeroUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'Partner-Authorization': apiKey,
        },
      });
      seatsAeroRequests++;

      if (response.status === 429) {
        // Rate limit hit
        const retryAfter = response.headers.get('Retry-After');
        return NextResponse.json(
          {
            error: 'Rate limit exceeded. Please try again later.',
            retryAfter: retryAfter ? Number(retryAfter) : undefined,
          },
          { status: 429 }
        );
      }

      if (!response.ok) {
        // Other errors
        return NextResponse.json(
          { error: `Seats.aero API Error: ${response.statusText}` },
          { status: response.status }
        );
      }

      const data = await response.json();

      // Process and buffer each item
      if (data.data && Array.isArray(data.data) && data.data.length > 0) {
        for (const item of data.data) {
          if (uniqueItems.has(item.ID)) continue;
          // Only process direct flights (Stops === 0) and flatten
          if (item.AvailabilityTrips && Array.isArray(item.AvailabilityTrips) && item.AvailabilityTrips.length > 0) {
            for (const trip of item.AvailabilityTrips) {
              if (trip.Stops !== 0) continue;
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
                  YMile: (trip.Cabin && trip.Cabin.toLowerCase() === 'economy') ? (trip.MileageCost || 0) : 0,
                  WMile: (trip.Cabin && trip.Cabin.toLowerCase() === 'premium') ? (trip.MileageCost || 0) : 0,
                  JMile: (trip.Cabin && trip.Cabin.toLowerCase() === 'business') ? (trip.MileageCost || 0) : 0,
                  FMile: (trip.Cabin && trip.Cabin.toLowerCase() === 'first') ? (trip.MileageCost || 0) : 0,
                });
              }
            }
          }
          uniqueItems.set(item.ID, true);
          processedCount++;
        }
      }
      hasMore = data.hasMore || false;
      if (hasMore) {
        skip += 1000;
        cursor = data.cursor;
      }
      lastResponse = response;
    }
    // Merge duplicates based on originAirport, destinationAirport, date, FlightNumbers
    const mergedMap = new Map<string, any>();
    for (const entry of results) {
      const key = [
        entry.originAirport,
        entry.destinationAirport,
        entry.date,
        normalizeFlightNumber(entry.FlightNumbers)
      ].join('|');
      if (!mergedMap.has(key)) {
        mergedMap.set(key, {
          ...entry,
          YCount: entry.YMile > 0 ? 1 : 0,
          WCount: entry.WMile > 0 ? 1 : 0,
          JCount: entry.JMile > 0 ? 1 : 0,
          FCount: entry.FMile > 0 ? 1 : 0,
          YMile: undefined,
          WMile: undefined,
          JMile: undefined,
          FMile: undefined,
        });
      } else {
        const merged = mergedMap.get(key);
        merged.YCount += entry.YMile > 0 ? 1 : 0;
        merged.WCount += entry.WMile > 0 ? 1 : 0;
        merged.JCount += entry.JMile > 0 ? 1 : 0;
        merged.FCount += entry.FMile > 0 ? 1 : 0;
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
    const mergedResults = Array.from(mergedMap.values()).map(({ YMile, WMile, JMile, FMile, ...rest }) => {
      // Alliance logic
      const flightPrefix = (rest.FlightNumbers || '').slice(0, 2).toUpperCase();
      const starAlliance = [
        'A3','AC','CA','AI','NZ','NH','OZ','OS','AV','SN','CM','OU','MS','ET','BR','LO','LH','CL','ZH','SQ','SA','LX','TP','TG','TK','UA'
      ];
      const skyTeam = [
        'AR','AM','UX','AF','CI','MU','DL','GA','KQ','ME','KL','KE','SV','SK','RO','VN','VS','MF'
      ];
      const oneWorld = [
        'AS','AA','BA','CX','FJ','AY','IB','JL','MS','QF','QR','RJ','AT','UL','MH'
      ];
      const etihad = ['EY'];
      let alliance: 'SA' | 'ST' | 'OW' | 'EY' | undefined;
      if (starAlliance.includes(flightPrefix)) alliance = 'SA';
      else if (skyTeam.includes(flightPrefix)) alliance = 'ST';
      else if (oneWorld.includes(flightPrefix)) alliance = 'OW';
      else if (etihad.includes(flightPrefix)) alliance = 'EY';
      else alliance = undefined;
      return alliance ? { ...rest, alliance } : null;
    }).filter(Boolean);

    // Group by originAirport, destinationAirport, date, alliance
    const groupedMap = new Map<string, any>();
    for (const entry of mergedResults) {
      const groupKey = [
        entry.originAirport,
        entry.destinationAirport,
        entry.date,
        entry.alliance
      ].join('|');
      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, {
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
        const group = groupedMap.get(groupKey);
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
    const groupedResults = Array.from(groupedMap.values());
    // Forward rate limit headers from the last fetch response if present
    let rlRemaining: string | null = null;
    let rlReset: string | null = null;
    if (lastResponse && lastResponse.headers) {
      rlRemaining = lastResponse.headers.get('x-ratelimit-remaining');
      rlReset = lastResponse.headers.get('x-ratelimit-reset');
    }
    const nextRes = NextResponse.json({ groups: groupedResults, seatsAeroRequests });
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