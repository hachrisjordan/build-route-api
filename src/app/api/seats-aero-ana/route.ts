import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { addDays, format, subDays } from 'date-fns';

// Use environment variables for Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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
      console.error('Error fetching airport data:', airportError);
      return null;
    }

    const originAirportData = airports.find((a: any) => a.iata === originAirport);
    const destinationAirportData = airports.find((a: any) => a.iata === destinationAirport);

    if (!originAirportData?.iso || !destinationAirportData?.iso) {
      console.error('Missing ISO codes for airports:', { originAirport, destinationAirport });
      return null;
    }

    // Get zones for both ISO codes
    const { data: zones, error: zoneError } = await supabase
      .from('av')
      .select('code, zone')
      .in('code', [originAirportData.iso, destinationAirportData.iso]);

    if (zoneError || !zones || zones.length !== 2) {
      console.error('Error fetching zone data:', zoneError);
      return null;
    }

    const originZone = zones.find((z: any) => z.code === originAirportData.iso)?.zone;
    const destinationZone = zones.find((z: any) => z.code === destinationAirportData.iso)?.zone;

    if (!originZone || !destinationZone) {
      console.error('Missing zones for airports:', { originZone, destinationZone });
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
      console.error('Error fetching pricing data:', pricingError);
      return null;
    }

    return pricing.first;
  } catch (error) {
    console.error('Error calculating mileage cost:', error);
    return null;
  }
}

/**
 * GET /api/seats-aero-ana
 * Custom seats.aero API call with ANA first class flights
 */
export async function GET(req: NextRequest) {
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
              
              // Filter to only include NH flights
              if (trip.FlightNumbers && !trip.FlightNumbers.startsWith('NH')) {
                console.log('Skipping non-NH flight:', trip.FlightNumbers);
                continue;
              }
              
              console.log('Including NH flight:', trip.FlightNumbers);
              
              // Create unique key for this flight
              const flightKey = `${trip.FlightNumbers}-${trip.DepartsAt}`;
              
              if (tripMap.has(flightKey)) {
                // Merge with existing flight - prioritize non-zero remaining seats
                const existingTrip = tripMap.get(flightKey);
                
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
                  });
                } else if (existingTrip.RemainingSeats > 0 && trip.RemainingSeats === 0) {
                  // Keep existing non-zero seats version
                  console.log(`Keeping existing non-zero seats version for ${flightKey}: ${existingTrip.RemainingSeats} seats`);
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
        departs_at: trip.DepartsAt ? new Date(trip.DepartsAt) : null,
        cabin: trip.Cabin,
        arrives_at: trip.ArrivesAt ? new Date(trip.ArrivesAt) : null,
        updated_at: trip.UpdatedAt ? new Date(trip.UpdatedAt) : null,
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
        console.error('Error truncating table:', truncateError);
        saveResult = { error: `Truncate failed: ${truncateError.message}` };
      } else {
        console.log('Table truncated successfully');
        
        // Now insert the new data
        const { data: savedData, error: saveError } = await supabase
          .from('ana_flights')
          .insert(tripsToSave)
          .select();

        if (saveError) {
          console.error('Error saving to database:', saveError);
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
    console.error('Error in /api/seats-aero-ana:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
} 