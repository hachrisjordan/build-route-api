import { NextRequest, NextResponse } from 'next/server';
import { addDays, format, subDays } from 'date-fns';
import { getAvailableProKey } from '@/lib/supabase-admin';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from '@/lib/env-utils';

// Regular Supabase client for data queries (not pro_key)
const { url: supabaseUrl, anonKey: supabaseAnonKey } = getSupabaseConfig();

/**
 * Calculate mileage cost based on origin and destination airports
 */
async function calculateMileageCost(supabase: any, originAirport: string, destinationAirport: string): Promise<number | null> {
  try {
    // Get ISO codes for both airports
    const { data: airports, error: airportError } = await supabase
      .from('airports')
      .select('iata, iso')
      .in('iata', [originAirport, destinationAirport]);

    if (airportError || !airports || airports.length !== 2) {
      return null;
    }

    const originAirportData = airports.find((a: any) => a.iata === originAirport);
    const destinationAirportData = airports.find((a: any) => a.iata === destinationAirport);

    if (!originAirportData?.iso || !destinationAirportData?.iso) {
      return null;
    }

    // Get zones for both ISO codes
    const { data: zones, error: zoneError } = await supabase
      .from('av')
      .select('code, zone')
      .in('code', [originAirportData.iso, destinationAirportData.iso]);

    if (zoneError || !zones || zones.length !== 2) {
      return null;
    }

    const originZone = zones.find((z: any) => z.code === originAirportData.iso)?.zone;
    const destinationZone = zones.find((z: any) => z.code === destinationAirportData.iso)?.zone;

    if (!originZone || !destinationZone) {
      return null;
    }

    // Get pricing for the route
    const { data: pricing, error: pricingError } = await supabase
      .from('av_pricing')
      .select('first')
      .eq('from_region', originZone)
      .eq('to_region', destinationZone)
      .single();

    if (pricingError || !pricing) {
      return null;
    }

    return pricing.first;
  } catch (error) {
    return null;
  }
}

/**
 * GET /api/seats-aero-ana
 * Custom seats.aero API call with ANA first class flights
 */
export async function GET(req: NextRequest) {
  try {
    // Get API key using admin client
    const proKeyData = await getAvailableProKey();
    if (!proKeyData || !proKeyData.pro_key) {
      return NextResponse.json({ 
        error: 'No available pro_key found' 
      }, { status: 500 });
    }

    const apiKey = proKeyData.pro_key;

    // Create regular supabase client for data queries
    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    // Calculate dates: today to 365 days from today
    const today = new Date();
    const startDate = format(today, 'yyyy-MM-dd');
    const endDate = format(addDays(today, 365), 'yyyy-MM-dd');

    // Calculate 7 days ago for filtering
    const sevenDaysAgo = subDays(today, 7);

    // Define routes: ANA key destinations to Tokyo and vice versa
    const routes = [
      // Key destinations to Tokyo (HND/NRT)
      'ORD/JFK/SFO/LHR/HNL-HND/NRT',
      // Tokyo (HND/NRT) to key destinations
      'HND/NRT-ORD/JFK/SFO/LHR/HNL'
    ];

    const allTrips: any[] = [];
    const tripsToSave: any[] = [];
    const tripMap = new Map<string, any>(); // Key: FlightNumbers-DepartsAt, Value: trip data

    for (const route of routes) {
      // Parse route segments
      const segments = route.split('-');
      const originAirports = segments[0]?.split('/') || [];
      const destinationAirports = segments[1]?.split('/') || [];

      // Build seats.aero API parameters
      const params = {
        origin_airport: originAirports.join(','),
        destination_airport: destinationAirports.join(','),
        start_date: startDate,
        end_date: endDate,
        take: '1000',
        include_trips: 'true',
        only_direct_flights: 'true',
        include_filtered: 'false',
        cabin: 'first',
        carriers: 'NH',
        disable_live_filtering: 'true'
      };

      // Build URL
      const sp = new URLSearchParams(params as any);
      const url = `https://seats.aero/partnerapi/search?${sp.toString()}`;


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
              
              // Filter to only include NH flights
              if (trip.FlightNumbers && !trip.FlightNumbers.startsWith('NH')) {
                continue;
              }
              
              // Create unique key for this flight
              const flightKey = `${trip.FlightNumbers}-${trip.DepartsAt}`;
              
              if (tripMap.has(flightKey)) {
                // Merge with existing flight - prioritize non-zero remaining seats
                const existingTrip = tripMap.get(flightKey);
                
                if (existingTrip.RemainingSeats === 0 && trip.RemainingSeats > 0) {
                  // Replace with non-zero seats version
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
                  });
                } else if (existingTrip.RemainingSeats > 0 && trip.RemainingSeats === 0) {
                  // Keep existing non-zero seats version
                                 } else if (existingTrip.RemainingSeats === 0 && trip.RemainingSeats === 0) {
                   // Both have zero seats, keep the one with higher Distance (longer flight = better availability)
                   if (trip.Distance > existingTrip.Distance) {
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
                    });
                  }
                } else {
                  // Both have non-zero seats, keep the one with more seats
                  if (trip.RemainingSeats > existingTrip.RemainingSeats) {
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
                    });
                  }
                }
              } else {
                // First occurrence of this flight
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
                });
              }
            }
          }
        }
      }
    }

    // Convert tripMap back to arrays
    allTrips.length = 0; // Clear the array
    tripsToSave.length = 0; // Clear the array
    
    for (const trip of tripMap.values()) {
      allTrips.push(trip);
      
      // Calculate mileage cost for this trip
      const mileageCost = await calculateMileageCost(supabase, trip.OriginAirport, trip.DestinationAirport);
      
      // Prepare trip data for database
      tripsToSave.push({
        total_duration: trip.TotalDuration,
        remaining_seats: trip.RemainingSeats,
        distance: trip.TotalSegmentDistance,
        origin_airport: trip.OriginAirport,
        destination_airport: trip.DestinationAirport,
        aircraft: trip.Aircraft,
        flight_numbers: trip.FlightNumbers,
        departs_at: trip.DepartsAt || null,
        cabin: trip.Cabin,
        arrives_at: trip.ArrivesAt || null,
        updated_at: trip.UpdatedAt || null,
        search_date: today,
        mileage_cost: mileageCost
      });
    }

    // Save trips to database if we have any
    let saveResult = null;
    if (tripsToSave.length > 0) {
      // First truncate the table to clear old data
      const { error: truncateError } = await supabase
        .from('ana_flights')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all rows

      if (truncateError) {
        saveResult = { error: `Truncate failed: ${truncateError.message}` };
      } else {
        
        // Now insert the new data
        const { data: savedData, error: saveError } = await supabase
          .from('ana_flights')
          .insert(tripsToSave)
          .select();

        if (saveError) {
          saveResult = { error: saveError.message };
        } else {
          saveResult = { 
            success: true, 
            savedCount: savedData?.length || 0 
          };
        }
      }
    }

    // Return only the trips array
    return NextResponse.json({
      trips: allTrips,
      metadata: {
        startDate,
        endDate,
        cabin: 'first',
        carriers: 'NH',
        totalTrips: allTrips.length,
        filterDate: format(sevenDaysAgo, 'yyyy-MM-dd'),
        filterDescription: 'Results filtered to exclude data older than 7 days',
        databaseSave: saveResult
      }
    });

  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
} 