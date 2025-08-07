import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { addDays, format, parseISO, subDays } from 'date-fns';

// Use environment variables for Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

    // Calculate dates
    const startDate = format(new Date(), 'yyyy-MM-dd');
    const endDate = format(addDays(new Date(), 365), 'yyyy-MM-dd');

    // Define routes
    const routes = [
      // US to Europe
      'ATL/BOS/IAD/JFK/LAS/LAX/MCO/MIA/SEA/SFO/TPA-EDI/LHR/MAN',
      // Europe to US
      'EDI/LHR/MAN-ATL/BOS/IAD/JFK/LAS/LAX/MCO/MIA/SEA/SFO/TPA'
    ];

    const allTrips: any[] = [];
    const sevenDaysAgo = subDays(new Date(), 7);

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
        include_filtered: 'false',
        sources: 'delta',
        cabin: 'business',
        carriers: 'VS',
        disable_live_filtering: 'false'
      };

      // Build URL
      const sp = new URLSearchParams(params as any);
      const url = `https://seats.aero/partnerapi/search?${sp.toString()}`;
      console.log('Seats.aero API URL:', url);

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
        console.error(`Error fetching data for route ${route}:`, response.statusText);
        continue;
      }

      const rawData = await response.json();

      if (!rawData.data) {
        console.error(`No data found for route ${route}`);
        continue;
      }

      // Filter and process data
      for (const item of rawData.data) {
        if (!item.AvailabilityTrips) continue;

        for (const trip of item.AvailabilityTrips) {
          if (trip.Stops !== 0) continue;
          
          // Filter out trips older than 7 days
          if (trip.UpdatedAt) {
            const tripUpdatedAt = new Date(trip.UpdatedAt);
            if (tripUpdatedAt < sevenDaysAgo) continue;
          }

          // Only include VS flights
          if (trip.FlightNumbers && !trip.FlightNumbers.startsWith('VS')) {
            console.log('Skipping flight:', trip.FlightNumbers, '(not VS)');
            continue;
          }
          console.log('Including flight:', trip.FlightNumbers, '(VS)');

          const tripData = {
            TotalDuration: trip.TotalDuration,
            RemainingSeats: trip.RemainingSeats,
            MileageCost: trip.MileageCost,
            OriginAirport: trip.OriginAirport,
            DestinationAirport: trip.DestinationAirport,
            Aircraft: trip.Aircraft,
            FlightNumbers: trip.FlightNumbers,
            DepartsAt: trip.DepartsAt?.replace('Z', ''),
            Cabin: trip.Cabin,
            ArrivesAt: trip.ArrivesAt?.replace('Z', ''),
            UpdatedAt: trip.UpdatedAt
          };

          allTrips.push(tripData);
        }
      }
    }

    return NextResponse.json({
      trips: allTrips,
      metadata: {
        totalTrips: allTrips.length,
        routes: routes,
        startDate,
        endDate,
        carriers: 'VS',
        sources: 'delta',
        processedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error in seats-aero-virginatlantic-vs API:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 