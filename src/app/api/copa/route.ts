import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAvailableProKey } from '@/lib/supabase-admin';
import { parseISO, addMinutes, isAfter, isBefore, addDays, format, subDays } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import { CONCURRENCY_CONFIG } from '@/lib/concurrency-config';
import { getSupabaseConfig } from '@/lib/env-utils';

// Use environment variables for Supabase
const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getSupabaseConfig();

// Zod schema for request validation
const copaSchema = z.object({
  O: z.string().length(3), // Origin airport
  D: z.string().length(3), // Destination airport
  T: z.string().min(8), // Timestamp (inbound arrival time)
  cabin: z.string().optional(),
  seats: z.coerce.number().int().min(1).default(1).optional(),
});

interface AvailabilityFlight {
  FlightNumbers: string;
  TotalDuration: number;
  Aircraft: string;
  DepartsAt: string;
  ArrivesAt: string;
  YCount: number;
  WCount: number;
  JCount: number;
  FCount: number;
  distance: number;
  originAirport: string;
  destinationAirport: string;
}

interface AvailabilityGroup {
  originAirport: string;
  destinationAirport: string;
  date: string;
  alliance: string;
  earliestDeparture: string;
  latestDeparture: string;
  earliestArrival: string;
  latestArrival: string;
  flights: AvailabilityFlight[];
}

interface FlightMapEntry {
  id: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  duration: string;
  cabin: string;
  carrier: string;
  flightNumber: string;
}

// Copa destinations
const COPA_DESTINATIONS = [
  'EZE', 'AUA', 'NAS', 'BGI', 'BZE', 'CNF', 'BSB', 'FLN', 'MAO', 'GIG', 'SSA', 'GRU', 'SCL', 'BOG', 'MDE', 'SJO', 'HAV', 'SNU', 'CUR', 'POP', 'PUJ', 'STI', 'SDQ', 'UIO', 'SAL', 'GUA', 'GEO', 'XPL', 'SAP', 'KIN', 'MBJ', 'CUN', 'GDL', 'MEX', 'NLU', 'MTY', 'SJD', 'TQO', 'MGA', 'PTY', 'LIM', 'SJU', 'SXM', 'PBM', 'POS', 'MVD', 'CCS'
];

// Function to get Copa destinations - always return all Copa destinations
function getDestinationAirports(origin: string): string[] {
  return COPA_DESTINATIONS;
}







function getFlightUUID(flight: AvailabilityFlight): string {
  return `${flight.FlightNumbers}-${flight.DepartsAt}-${flight.ArrivesAt}`;
}

async function buildOutboundItineraries(
  availabilityData: any,
  inboundArrivalTime: string,
  origin: string,
  destination: string,
  flightMap: Map<string, AvailabilityFlight>,
  minConnectionMinutes = 90,
  maxConnectionMinutes = 360 // 6 hours
): Promise<Array<{
  route: string;
  date: string;
  itinerary: string[];
  totalDuration: number;
  departureTime: string;
  arrivalTime: string;
  connections: string[];
  classPercentages: { y: number; w: number; j: number; f: number };
}>> {
  const results: Array<{
    route: string;
    date: string;
    itinerary: string[];
    totalDuration: number;
    departureTime: string;
    arrivalTime: string;
    connections: string[];
    classPercentages: { y: number; w: number; j: number; f: number };
  }> = [];
  const inboundArrival = parseISO(inboundArrivalTime);
  
  // Track processed flights to avoid duplicates
  const processedFlights = new Set<string>();

  // Build D-PTY-XXX routes: First find all flights from D to PTY, then from PTY to final destinations
  if (availabilityData.groups) {
    // First, collect all flights from D to PTY (first leg)
    const firstLegFlights: AvailabilityFlight[] = [];
    for (const group of availabilityData.groups) {
      const { originAirport, destinationAirport, flights } = group;
      if (originAirport === destination && destinationAirport === 'PTY') {
        firstLegFlights.push(...flights);
      }
    }

    // Then, collect all flights from PTY to final destinations (second leg)
    const secondLegFlights: AvailabilityFlight[] = [];
    for (const group of availabilityData.groups) {
      const { originAirport, destinationAirport, flights } = group;
      if (originAirport === 'PTY' && COPA_DESTINATIONS.includes(destinationAirport)) {
        secondLegFlights.push(...flights);
      }
    }

    // Now build D-PTY-XXX itineraries by combining first and second leg flights
    for (const firstLegFlight of firstLegFlights) {
      const firstLegDepartureTime = parseISO(firstLegFlight.DepartsAt);
      const firstLegArrivalTime = parseISO(firstLegFlight.ArrivesAt);
      
      // Check if first leg departs within the allowed window (after inbound arrival)
      if (isBefore(firstLegDepartureTime, inboundArrival) || isAfter(firstLegDepartureTime, addMinutes(inboundArrival, maxConnectionMinutes))) {
        continue;
      }

      for (const secondLegFlight of secondLegFlights) {
        const secondLegDepartureTime = parseISO(secondLegFlight.DepartsAt);
        
        // Check if second leg departs within connection window after first leg arrival
        const minSecondLegDepartureTime = addMinutes(firstLegArrivalTime, minConnectionMinutes);
        const maxSecondLegDepartureTime = addMinutes(firstLegArrivalTime, maxConnectionMinutes);
        
        if (isBefore(secondLegDepartureTime, minSecondLegDepartureTime) || isAfter(secondLegDepartureTime, maxSecondLegDepartureTime)) {
          continue;
        }

        // Create unique identifier for this D-PTY-XXX itinerary
        const connectingKey = `${firstLegFlight.FlightNumbers}-${firstLegFlight.DepartsAt}-${firstLegFlight.ArrivesAt}-${secondLegFlight.FlightNumbers}-${secondLegFlight.DepartsAt}-${secondLegFlight.ArrivesAt}`;
        
        // Skip if we've already processed this exact connecting itinerary
        if (processedFlights.has(connectingKey)) {
          continue;
        }
        
        // Create the D-PTY-XXX flight itinerary
        const firstLegUUID = getFlightUUID(firstLegFlight);
        const secondLegUUID = getFlightUUID(secondLegFlight);
        flightMap.set(firstLegUUID, firstLegFlight);
        flightMap.set(secondLegUUID, secondLegFlight);

        const route = `${destination}-PTY-${secondLegFlight.destinationAirport}`;
        const itinerary = [firstLegUUID, secondLegUUID];
        const connections = ['PTY'];

        // Calculate total duration and class percentages for connecting itinerary
        const totalDuration = firstLegFlight.TotalDuration + secondLegFlight.TotalDuration;
        
        // Calculate percentage of total flight duration where that cabin class has availability
        let connectingY = 0;
        let connectingW = 0;
        let connectingJ = 0;
        let connectingF = 0;
        
        if (firstLegFlight.YCount > 0) connectingY += Math.round((firstLegFlight.TotalDuration / totalDuration) * 100);
        if (secondLegFlight.YCount > 0) connectingY += Math.round((secondLegFlight.TotalDuration / totalDuration) * 100);
        
        if (firstLegFlight.WCount > 0) connectingW += Math.round((firstLegFlight.TotalDuration / totalDuration) * 100);
        if (secondLegFlight.WCount > 0) connectingW += Math.round((secondLegFlight.TotalDuration / totalDuration) * 100);
        
        if (firstLegFlight.JCount > 0) connectingJ += Math.round((firstLegFlight.TotalDuration / totalDuration) * 100);
        if (secondLegFlight.JCount > 0) connectingJ += Math.round((secondLegFlight.TotalDuration / totalDuration) * 100);
        
        if (firstLegFlight.FCount > 0) connectingF += Math.round((firstLegFlight.TotalDuration / totalDuration) * 100);
        if (secondLegFlight.FCount > 0) connectingF += Math.round((secondLegFlight.TotalDuration / totalDuration) * 100);



        results.push({
          route,
          date: format(parseISO(firstLegFlight.DepartsAt), 'yyyy-MM-dd'),
          itinerary,
          totalDuration,
          departureTime: firstLegFlight.DepartsAt,
          arrivalTime: secondLegFlight.ArrivesAt,
          connections,
          classPercentages: { 
            y: connectingY, 
            w: connectingW, 
            j: connectingJ, 
            f: connectingF 
          }
        });
        
        // Mark this connecting itinerary as processed to avoid duplicates
        processedFlights.add(connectingKey);
      }
    }
  }

  return results;
}

export async function POST(req: NextRequest) {
  try {
    // Parse and validate body
    const body = await req.json();
    const parseResult = copaSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    const { O: origin, D: destination, T: timestamp, cabin, seats } = parseResult.data;

    // Get API key from Supabase
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Get country code for origin airport to filter out same-country destinations
    const { data: originAirportData, error: originError } = await supabase
      .from('airports')
      .select('country_code')
      .eq('iata', origin)
      .single();

    if (originError || !originAirportData) {
      return NextResponse.json({ 
        error: 'Origin airport not found', 
        details: originError?.message 
      }, { status: 400 });
    }

    const originCountryCode = originAirportData.country_code;

    // Get API key using admin client
    const proKeyData = await getAvailableProKey();
    if (!proKeyData || !proKeyData.pro_key) {
      return NextResponse.json({ 
        error: 'No available pro_key found' 
      }, { status: 500 });
    }

    const apiKey = proKeyData.pro_key;

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

    // Calculate 7 days ago for filtering
    const sevenDaysAgo = subDays(new Date(), 7);

    // Get destination airports based on origin
    const destinationAirports = getDestinationAirports(origin);
    const originAirports = [destination, 'PTY']; // From D and PTY

      // Build seats.aero API parameters
      const baseParams: Record<string, string> = {
        origin_airport: originAirports.join(','),
        destination_airport: destinationAirports.join(','),
        start_date: startDate,
        end_date: endDate,
        take: '1000',
        include_trips: 'true',
        only_direct_flights: 'true',
        include_filtered: 'true',
        cabin: 'business',
        carriers: 'UA%2CCM',
        sources: 'aeroplan,azul,velocity,united',
        disable_live_filtering: 'true'
      };
    if (cabin) baseParams.cabin = cabin;

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
    let allPages = [firstData];
    let hasMore = firstData.hasMore || false;
    let cursor = firstData.cursor;

    // Sequential pagination
    if (hasMore && typeof cursor === 'string') {
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
        if (!res.ok) break;
        const data = await res.json();
        allPages.push(data);
        hasMore = data.hasMore || false;
        cursor = data.cursor;
      }
    }

    // Process all pages and build availability data
    const uniqueItems = new Map<string, boolean>();
    const results: any[] = [];

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
              const seatsCount = seats || 1;
              if (cabin) {
                if (
                  trip.Cabin &&
                  trip.Cabin.toLowerCase() === cabin.toLowerCase() &&
                  typeof trip.RemainingSeats === 'number' &&
                  (seatsCount === 1 ? trip.RemainingSeats >= 0 : trip.RemainingSeats >= seatsCount)
                ) {
                  includeTrip = true;
                  cabinType = trip.Cabin.toLowerCase();
                }
              } else {
                if (
                  typeof trip.RemainingSeats === 'number' &&
                  (seatsCount === 1 ? trip.RemainingSeats >= 0 : trip.RemainingSeats >= seatsCount)
                ) {
                  includeTrip = true;
                  cabinType = trip.Cabin ? trip.Cabin.toLowerCase() : '';
                }
              }
              if (!includeTrip) continue;
              
              // Filter out flights that depart too early (before T + 60 minutes)
              if (trip.DepartsAt) {
                const departureTime = new Date(trip.DepartsAt);
                const minDepartureTime = addDays(parseISO(timestamp), 0); // Same day as timestamp
                const minDepartureTimeWithBuffer = addDays(minDepartureTime, 0); // Add 60 minutes buffer
                minDepartureTimeWithBuffer.setMinutes(minDepartureTimeWithBuffer.getMinutes() + 60);
                
                if (departureTime < minDepartureTimeWithBuffer) {
                  continue; // Skip flights that depart too early
                }
              }
              
              const flightNumbersArr = (trip.FlightNumbers || '').split(/,\s*/);
              for (const flightNumber of flightNumbersArr) {
                const normalizedFlightNumber = flightNumber.replace(/^([A-Z]{2,3})(0*)(\d+)$/i, (_: string, prefix: string, zeros: string, number: string) => `${prefix.toUpperCase()}${parseInt(number, 10)}`);
                const flightPrefix = normalizedFlightNumber.slice(0, 2).toUpperCase();
                
                // Only include UA and CM flights
                if (flightPrefix !== 'UA' && flightPrefix !== 'CM') {
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
                  YCount: (cabinType === 'economy') ? 1 : 0,
                  WCount: (cabinType === 'premium') ? 1 : 0,
                  JCount: (cabinType === 'business') ? 1 : 0,
                  FCount: (cabinType === 'first') ? 1 : 0,
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

    // Group by originAirport, destinationAirport, date, alliance
    const finalGroupedMap = new Map<string, any>();
    const aggregatedFlightMap = new Map<string, any>(); // Track individual flights by flight number + time
    
    for (const entry of results) {
      const groupKey = [
        entry.originAirport,
        entry.destinationAirport,
        entry.date,
        'SA' // UA is Star Alliance, CM is Copa
      ].join('|');
      
      // Create unique flight key for cabin aggregation
      const flightKey = `${entry.FlightNumbers}-${entry.DepartsAt}-${entry.ArrivesAt}`;
      
      if (!finalGroupedMap.has(groupKey)) {
        finalGroupedMap.set(groupKey, {
          originAirport: entry.originAirport,
          destinationAirport: entry.destinationAirport,
          date: entry.date,
          distance: entry.distance,
          alliance: 'SA',
          earliestDeparture: entry.DepartsAt,
          latestDeparture: entry.DepartsAt,
          earliestArrival: entry.ArrivesAt,
          latestArrival: entry.ArrivesAt,
          flights: []
        });
      }
      
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
      
      // Aggregate cabin availability for the same flight
      if (!aggregatedFlightMap.has(flightKey)) {
        aggregatedFlightMap.set(flightKey, {
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
          originAirport: entry.originAirport,
          destinationAirport: entry.destinationAirport,
        });
      } else {
        // Merge cabin availability
        const existingFlight = aggregatedFlightMap.get(flightKey);
        if (existingFlight) {
          existingFlight.YCount = Math.max(existingFlight.YCount, entry.YCount);
          existingFlight.WCount = Math.max(existingFlight.WCount, entry.WCount);
          existingFlight.JCount = Math.max(existingFlight.JCount, entry.JCount);
          existingFlight.FCount = Math.max(existingFlight.FCount, entry.FCount);
        }
      }
    }
    
    // Add aggregated flights to groups
    for (const [groupKey, group] of finalGroupedMap) {
      for (const [flightKey, flight] of aggregatedFlightMap) {
        const flightGroupKey = [
          flight.originAirport,
          flight.destinationAirport,
          flight.date || group.date,
          'SA'
        ].join('|');
        
        if (flightGroupKey === groupKey) {
          group.flights.push(flight);
        }
      }
    }

    const availabilityData = { groups: Array.from(finalGroupedMap.values()) };

    // Build outbound itineraries
    const flightMap = new Map<string, AvailabilityFlight>();
    const itineraries = await buildOutboundItineraries(availabilityData, timestamp, origin, destination, flightMap);

    // Filter out routes where final destination has same country code as origin
    const filteredItineraries = [];
    for (const itinerary of itineraries) {
      // Extract final destination from route (D-PTY-XXX format)
      const routeParts = itinerary.route.split('-');
      const finalDestination = routeParts[routeParts.length - 1];
      
      // Get country code for final destination
      const { data: destAirportData } = await supabase
        .from('airports')
        .select('country_code')
        .eq('iata', finalDestination)
        .single();
      
      // Only include if destination country code is different from origin
      if (destAirportData && destAirportData.country_code !== originCountryCode) {
        filteredItineraries.push(itinerary);
      }
    }

    // Sort by departure time
    filteredItineraries.sort((a: any, b: any) => new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime());

    return NextResponse.json({
      itineraries: filteredItineraries,
      flights: Object.fromEntries(flightMap),
      totalCount: filteredItineraries.length,
      inboundArrivalTime: timestamp,
      origin,
      destination
    });

  } catch (error: any) {
    console.error('Error in /api/copa:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
