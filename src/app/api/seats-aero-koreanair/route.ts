import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { addDays, format, subDays } from 'date-fns';

// Use environment variables for Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * GET /api/seats-aero-koreanair
 * Custom seats.aero API call with Korean Air flights
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

    // Clean the API key by removing any whitespace, newline, or carriage return characters
    const apiKey = data.pro_key.replace(/[\r\n]/g, '').trim();

    // Get date parameter from query string
    const { searchParams } = new URL(req.url);
    const dateParam = searchParams.get('date');
    
    if (!dateParam) {
      return NextResponse.json({ 
        error: 'Date parameter is required. Use ?date=YYYY-MM-DD' 
      }, { status: 400 });
    }

    // Parse the date parameter
    const baseDate = new Date(dateParam);
    if (isNaN(baseDate.getTime())) {
      return NextResponse.json({ 
        error: 'Invalid date format. Use YYYY-MM-DD' 
      }, { status: 400 });
    }

    // Calculate dates: 7 days after base date to 60 days after base date
    const startDate = format(addDays(baseDate, 7), 'yyyy-MM-dd');
    const endDate = format(addDays(baseDate, 60), 'yyyy-MM-dd');

    // Calculate 7 days ago for filtering
    const sevenDaysAgo = subDays(new Date(), 7);

    // Define route: Korean domestic routes
    const route = 'CJU/RSU/KWJ/TAE/ICN/PUS/GMP/CJJ-CJU/RSU/KWJ/TAE/ICN/PUS/GMP/CJJ';

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
      include_filtered: 'false',
      carriers: 'KE',
      sources: 'virginatlantic',
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
    
    const flightMap = new Map();

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
            
            // Filter to only include KE flights
            if (trip.FlightNumbers && !trip.FlightNumbers.startsWith('KE')) {
              console.log('Skipping non-KE flight:', trip.FlightNumbers);
              continue;
            }
            
            console.log('Including KE flight:', trip.FlightNumbers);
            
            // Create a unique key for merging flights
            const flightKey = `${trip.FlightNumbers}-${trip.DepartsAt}-${trip.OriginAirport}-${trip.DestinationAirport}`;
            
            if (flightMap.has(flightKey)) {
              // Merge with existing flight
              const existingFlight = flightMap.get(flightKey) as any;
              const cabin = trip.Cabin?.toLowerCase() || 'economy';
              
              // Add cabin availability flag
              if (cabin === 'economy') {
                existingFlight.economy = true;
                existingFlight.economySeats = trip.RemainingSeats;
                existingFlight.economyMiles = trip.MileageCost;
              } else if (cabin === 'business') {
                existingFlight.business = true;
                existingFlight.businessSeats = trip.RemainingSeats;
                existingFlight.businessMiles = trip.MileageCost;
              }
            } else {
              // Create new flight entry
              const cabin = trip.Cabin?.toLowerCase() || 'economy';
              const newFlight: any = {
                TotalTaxes: trip.TotalTaxes,
                OriginAirport: trip.OriginAirport,
                DestinationAirport: trip.DestinationAirport,
                Aircraft: trip.Aircraft,
                FlightNumbers: trip.FlightNumbers,
                DepartsAt: trip.DepartsAt?.replace('Z', ''),
                ArrivesAt: trip.ArrivesAt?.replace('Z', ''),
                UpdatedAt: trip.UpdatedAt,
                economy: false,
                business: false
              };
              
              // Set cabin availability
              if (cabin === 'economy') {
                newFlight.economy = true;
                newFlight.economySeats = trip.RemainingSeats;
                newFlight.economyMiles = trip.MileageCost;
              } else if (cabin === 'business') {
                newFlight.business = true;
                newFlight.businessSeats = trip.RemainingSeats;
                newFlight.businessMiles = trip.MileageCost;
              }
              
              flightMap.set(flightKey, newFlight);
            }
          }
        }
      }
    }

    // Convert map to array
    const allTrips = Array.from(flightMap.values());

    // Filter to only keep flights with both economy and business class
    const filteredTrips = allTrips.filter((flight: any) => flight.economy && flight.business);

    // Return processed trips
    return NextResponse.json({
      trips: filteredTrips,
      metadata: {
        baseDate: dateParam,
        startDate,
        endDate,
        carriers: 'KE',
        totalTrips: filteredTrips.length,
        filterDate: format(sevenDaysAgo, 'yyyy-MM-dd'),
        filterDescription: 'Results filtered to exclude data older than 7 days and only flights with both economy and business class',
        route: route,
        url: url
      }
    });

  } catch (error: any) {
    console.error('Error in /api/seats-aero-koreanair:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
} 