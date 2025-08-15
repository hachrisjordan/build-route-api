import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { addDays, format, subDays } from 'date-fns';
import { getAvailableProKey } from '@/lib/supabase-admin';
import { getSupabaseConfig } from '@/lib/env-utils';

// Use environment variables for Supabase
const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getSupabaseConfig();

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
 * GET /api/seats-aero-united
 * Custom seats.aero API call with United Airlines business class flights
 */
export async function GET(req: NextRequest) {
  try {
    // Get API key using admin client
    let apiKey: string;
    try {
      const proKeyData = await getAvailableProKey();
      if (!proKeyData || !proKeyData.pro_key) {
        return NextResponse.json({ 
          error: 'No available pro_key found',
          details: 'All API keys may have reached their quota limits'
        }, { status: 500 });
      }
      apiKey = proKeyData.pro_key;
      console.log(`[seats-aero-united] Using pro_key with ${proKeyData.remaining} remaining quota`);
    } catch (error) {
      console.error('[seats-aero-united] Failed to get pro_key:', error);
      return NextResponse.json({ 
        error: 'Failed to retrieve API key',
        details: 'Database connection error'
      }, { status: 500 });
    }

    // Get parameters from URL
    const { searchParams } = new URL(req.url);
    const originParam = searchParams.get('origin');
    const startDateParam = searchParams.get('start_date');
    const endDateParam = searchParams.get('end_date');
    
    // Validate required parameters
    if (!originParam) {
      return NextResponse.json({ 
        error: 'Missing required parameter: origin',
        example: '/api/seats-aero-united?origin=GRU/GIG&start_date=2024-08-15&end_date=2024-12-31'
      }, { status: 400 });
    }
    
    if (!startDateParam) {
      return NextResponse.json({ 
        error: 'Missing required parameter: start_date',
        example: '/api/seats-aero-united?origin=GRU/GIG&start_date=2024-08-15&end_date=2024-12-31'
      }, { status: 400 });
    }
    
    if (!endDateParam) {
      return NextResponse.json({ 
        error: 'Missing required parameter: end_date',
        example: '/api/seats-aero-united?origin=GRU/GIG&start_date=2024-08-15&end_date=2024-12-31'
      }, { status: 400 });
    }
    
    // Use provided dates
    const startDate = startDateParam;
    const endDate = endDateParam;

    // Calculate 7 days ago for filtering
    const today = new Date();
    const sevenDaysAgo = subDays(today, 7);

    // Define United destinations
    const unitedDestinations = 'DEN/LAX/SFO/ORD/IAD/EWR/IAH';

    // Define routes: origin airports to United destinations
    const routes = [
      `${originParam}-${unitedDestinations}`
    ];

    const allTrips: any[] = [];
    const tripMap = new Map<string, any>(); // Key: FlightNumbers-DepartsAt, Value: trip data

    // Fetch reliability table (cached)
    const reliabilityTable = await getReliabilityTableCached();

    for (const route of routes) {
      // Parse route segments
      const segments = route.split('-');
      const originAirports = segments[0].split('/');
      const destinationAirports = segments[1].split('/');

      // Build seats.aero API parameters
      const params = {
        origin_airport: originAirports.join(','),
        destination_airport: destinationAirports.join(','),
        start_date: startDate,
        end_date: endDate,
        take: '1000',
        include_trips: 'true',
        only_direct_flights: 'true',
        include_filtered: 'true',
        sources: 'aeroplan,united,velocity,azul',
        cabin: 'business',
        carriers: 'UA',
        disable_live_filtering: 'true'
      };

      // Build URL
      const sp = new URLSearchParams(params as any);
      const url = `https://seats.aero/partnerapi/search?${sp.toString()}`;

      // Log the URL
      console.log('Seats.aero API URL:', url);

      // Make API call
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'Partner-Authorization': apiKey,
        },
      });

      if (response.status === 429) {
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
        return NextResponse.json(
          { error: `Seats.aero API Error: ${response.statusText}` },
          { status: response.status }
        );
      }

      const rawData = await response.json();
      
      // Extract only the AvailabilityTrips with the required fields
      if (rawData.data && Array.isArray(rawData.data)) {
        for (const item of rawData.data) {
          if (item.AvailabilityTrips && Array.isArray(item.AvailabilityTrips)) {
            for (const trip of item.AvailabilityTrips) {
              // Filter out trips older than 7 days
              if (trip.UpdatedAt) {
                const tripUpdatedAt = new Date(trip.UpdatedAt);
                if (tripUpdatedAt < sevenDaysAgo) continue;
              }
              
              // Filter to only include UA flights
              if (trip.FlightNumbers && !trip.FlightNumbers.startsWith('UA')) {
                console.log('Skipping non-UA flight:', trip.FlightNumbers);
                continue;
              }
              
              console.log('Including UA flight:', trip.FlightNumbers);
              
              // Create unique key for this flight
              const flightKey = `${trip.FlightNumbers}-${trip.DepartsAt}`;
              
              if (tripMap.has(flightKey)) {
                // Merge with existing flight - prioritize non-zero remaining seats
                const existingTrip = tripMap.get(flightKey);
                
                const flightPrefix = trip.FlightNumbers ? normalizeFlightNumber(trip.FlightNumbers).slice(0, 2).toUpperCase() : '';
                const cabinType = trip.Cabin ? trip.Cabin.toLowerCase() : '';
                const source = trip.Source || item.Source || '';
                
                // Calculate count for this trip
                let JCount = 0;
                if (cabinType === 'business' && trip.RemainingSeats > 0) {
                  JCount = getCountMultiplier({ code: flightPrefix, cabin: 'J', source, reliabilityTable });
                }

                if (existingTrip.RemainingSeats === 0 && trip.RemainingSeats > 0) {
                  // Replace with non-zero seats version
                  console.log(`Replacing ${flightKey} with non-zero seats version: ${trip.RemainingSeats} seats`);
                  tripMap.set(flightKey, {
                    TotalDuration: trip.TotalDuration,
                    RemainingSeats: trip.RemainingSeats,
                    Distance: trip.TotalSegmentDistance,
                    OriginAirport: trip.OriginAirport,
                    DestinationAirport: trip.DestinationAirport,
                    Aircraft: trip.Aircraft,
                    FlightNumbers: trip.FlightNumbers,
                    DepartsAt: trip.DepartsAt?.replace('Z', ''),
                    Cabin: trip.Cabin,
                    ArrivesAt: trip.ArrivesAt?.replace('Z', ''),
                    UpdatedAt: trip.UpdatedAt,
                    Source: source,
                    JCount: JCount,
                  });
                } else if (existingTrip.RemainingSeats > 0 && trip.RemainingSeats === 0) {
                  // Keep existing non-zero seats version but update JCount if higher
                  console.log(`Keeping existing non-zero seats version for ${flightKey}: ${existingTrip.RemainingSeats} seats`);
                  if (JCount > (existingTrip.JCount || 0)) {
                    existingTrip.JCount = JCount;
                  }
                } else if (existingTrip.RemainingSeats === 0 && trip.RemainingSeats === 0) {
                   // Both have zero seats, keep the one with higher Distance (longer flight = better availability)
                   if (trip.Distance > existingTrip.Distance) {
                     console.log(`Replacing ${flightKey} with higher Distance version: ${trip.Distance} vs ${existingTrip.Distance}`);
                    tripMap.set(flightKey, {
                      TotalDuration: trip.TotalDuration,
                      RemainingSeats: trip.RemainingSeats,
                      Distance: trip.TotalSegmentDistance,
                      OriginAirport: trip.OriginAirport,
                      DestinationAirport: trip.DestinationAirport,
                      Aircraft: trip.Aircraft,
                      FlightNumbers: trip.FlightNumbers,
                      DepartsAt: trip.DepartsAt?.replace('Z', ''),
                      Cabin: trip.Cabin,
                      ArrivesAt: trip.ArrivesAt?.replace('Z', ''),
                      UpdatedAt: trip.UpdatedAt,
                      Source: source,
                      JCount: JCount,
                    });
                  }
                } else {
                  // Both have non-zero seats, keep the one with more seats
                  if (trip.RemainingSeats > existingTrip.RemainingSeats) {
                    console.log(`Replacing ${flightKey} with more seats version: ${trip.RemainingSeats} vs ${existingTrip.RemainingSeats} seats`);
                    tripMap.set(flightKey, {
                      TotalDuration: trip.TotalDuration,
                      RemainingSeats: trip.RemainingSeats,
                      Distance: trip.TotalSegmentDistance,
                      OriginAirport: trip.OriginAirport,
                      DestinationAirport: trip.DestinationAirport,
                      Aircraft: trip.Aircraft,
                      FlightNumbers: trip.FlightNumbers,
                      DepartsAt: trip.DepartsAt?.replace('Z', ''),
                      Cabin: trip.Cabin,
                      ArrivesAt: trip.ArrivesAt?.replace('Z', ''),
                      UpdatedAt: trip.UpdatedAt,
                      Source: source,
                      JCount: JCount,
                    });
                  } else {
                    // Keep existing but update JCount if higher
                    if (JCount > (existingTrip.JCount || 0)) {
                      existingTrip.JCount = JCount;
                    }
                  }
                }
              } else {
                // First occurrence of this flight
                const flightPrefix = trip.FlightNumbers ? normalizeFlightNumber(trip.FlightNumbers).slice(0, 2).toUpperCase() : '';
                const cabinType = trip.Cabin ? trip.Cabin.toLowerCase() : '';
                const source = trip.Source || item.Source || '';
                
                // Calculate count based on cabin type and reliability
                let JCount = 0;
                if (cabinType === 'business' && trip.RemainingSeats > 0) {
                  JCount = getCountMultiplier({ code: flightPrefix, cabin: 'J', source, reliabilityTable });
                }
                
                tripMap.set(flightKey, {
                  TotalDuration: trip.TotalDuration,
                  RemainingSeats: trip.RemainingSeats,
                  Distance: trip.TotalSegmentDistance,
                  OriginAirport: trip.OriginAirport,
                  DestinationAirport: trip.DestinationAirport,
                  Aircraft: trip.Aircraft,
                  FlightNumbers: trip.FlightNumbers,
                  DepartsAt: trip.DepartsAt?.replace('Z', ''),
                  Cabin: trip.Cabin,
                  ArrivesAt: trip.ArrivesAt?.replace('Z', ''),
                  UpdatedAt: trip.UpdatedAt,
                  Source: source,
                  JCount: JCount,
                });
              }
            }
          }
        }
      }
    }

    // Convert tripMap back to array
    allTrips.length = 0; // Clear the array
    
    for (const trip of tripMap.values()) {
      allTrips.push(trip);
    }

    // Return only the trips array
    return NextResponse.json({
      trips: allTrips,
      metadata: {
        startDate,
        endDate,
        cabin: 'business',
        carriers: 'UA',
        origin: originParam,
        destinations: unitedDestinations,
        totalTrips: allTrips.length,
        filterDate: format(sevenDaysAgo, 'yyyy-MM-dd'),
        filterDescription: 'Results filtered to exclude data older than 7 days',
        note: 'JCount represents business class availability with reliability multipliers applied'
      }
    });

  } catch (error: any) {
    console.error('Error in /api/seats-aero-united:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
} 