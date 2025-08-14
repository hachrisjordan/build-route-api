import { NextRequest, NextResponse } from 'next/server';
import { getAvailableProKey } from '@/lib/supabase-admin';
import { addDays, format, parseISO, subDays } from 'date-fns';



export async function GET(req: NextRequest) {
  try {
    // Get query parameters
    const { searchParams } = new URL(req.url);
    const direction = searchParams.get('direction'); // 'to_europe' or 'from_europe'
    const startDateParam = searchParams.get('start_date');
    const endDateParam = searchParams.get('end_date');

    // Validate direction parameter
    if (!direction || !['to_europe', 'from_europe'].includes(direction)) {
      return NextResponse.json({ 
        error: 'Invalid direction parameter. Must be "to_europe" or "from_europe"' 
      }, { status: 400 });
    }

    // Parse and validate dates
    let startDate: string;
    let endDate: string;

    if (startDateParam && endDateParam) {
      try {
        const parsedStartDate = parseISO(startDateParam);
        const parsedEndDate = parseISO(endDateParam);
        
        if (parsedStartDate > parsedEndDate) {
          return NextResponse.json({ 
            error: 'Start date must be before end date' 
          }, { status: 400 });
        }
        
        startDate = format(parsedStartDate, 'yyyy-MM-dd');
        endDate = format(parsedEndDate, 'yyyy-MM-dd');
      } catch (error) {
        return NextResponse.json({ 
          error: 'Invalid date format. Use YYYY-MM-DD format' 
        }, { status: 400 });
      }
    } else {
      // Default dates if not provided
      startDate = format(new Date(), 'yyyy-MM-dd');
      endDate = format(addDays(new Date(), 365), 'yyyy-MM-dd');
    }

    // Get API key using admin client
    const proKeyData = await getAvailableProKey();
    if (!proKeyData || !proKeyData.pro_key) {
      return NextResponse.json({ 
        error: 'No available pro_key found' 
      }, { status: 500 });
    }

    const apiKey = proKeyData.pro_key;

    // Define route based on direction
    let route: string;
    if (direction === 'to_europe') {
      route = 'ATL/BOS/IAD/JFK/LAS/LAX/MCO/MIA/SEA/SFO/TPA-EDI/LHR/MAN';
    } else {
      route = 'EDI/LHR/MAN-ATL/BOS/IAD/JFK/LAS/LAX/MCO/MIA/SEA/SFO/TPA';
    }

    let allTrips: any[] = [];
    const sevenDaysAgo = subDays(new Date(), 7);

    // Parse route segments
    const segments = route.split('-');
    if (segments.length !== 2) {
      return NextResponse.json({ 
        error: 'Invalid route format' 
      }, { status: 400 });
    }
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
      include_filtered: 'true',
      sources: 'delta,virginatlantic',
      cabin: 'business',
      carriers: 'VS',
      disable_live_filtering: 'false'
    };

    // Build URL
    const sp = new URLSearchParams(params as any);
    const url = `https://seats.aero/partnerapi/search?${sp.toString()}`;
    console.log('Seats.aero API URL:', url);
    console.log('Direction:', direction);
    console.log('Route:', route);

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
      return NextResponse.json(
        { error: `Failed to fetch data: ${response.statusText}` },
        { status: response.status }
      );
    }

    const rawData = await response.json();

    if (!rawData.data) {
      console.error(`No data found for route ${route}`);
      return NextResponse.json(
        { trips: [], metadata: { message: 'No data found for the specified route and dates' } }
      );
    }

    // Filter and process data
    const tripMap = new Map<string, any>(); // Key: FlightNumbers-DepartsAt, Value: trip data

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

        // Create unique key for this flight
        const flightKey = `${trip.FlightNumbers}-${trip.DepartsAt}`;
        
        if (tripMap.has(flightKey)) {
          // Merge with existing flight
          const existingTrip = tripMap.get(flightKey);
          
          // Keep delta source as primary, add virginatlantic flag
          if (trip.Source === 'delta') {
            existingTrip.virginatlantic = existingTrip.Source === 'virginatlantic';
            existingTrip.Source = 'delta';
            // Keep lowest RemainingSeats
            existingTrip.RemainingSeats = Math.min(existingTrip.RemainingSeats, trip.RemainingSeats);
          } else if (trip.Source === 'virginatlantic' && existingTrip.Source === 'delta') {
            // Delta already exists, just add virginatlantic flag and update seats
            existingTrip.virginatlantic = true;
            existingTrip.RemainingSeats = Math.min(existingTrip.RemainingSeats, trip.RemainingSeats);
                      // Add virgin atlantic specific fields and MileageCost from virginatlantic
          existingTrip.MileageCost = trip.MileageCost;
          if (trip.TotalTaxes !== undefined) {
            // Convert GBP to USD if currency is GBP
            if (trip.TaxesCurrency === 'GBP') {
              existingTrip.TotalTaxes = Math.round(trip.TotalTaxes * 1.34);
              existingTrip.TaxesCurrency = 'USD';
            } else {
              existingTrip.TotalTaxes = trip.TotalTaxes;
              existingTrip.TaxesCurrency = trip.TaxesCurrency;
            }
          }
          }
        } else {
          // First occurrence of this flight
          const tripData: any = {
            TotalDuration: trip.TotalDuration,
            RemainingSeats: trip.RemainingSeats,
            MileageCost: trip.MileageCost,
            OriginAirport: trip.OriginAirport,
            DestinationAirport: trip.DestinationAirport,
            Aircraft: trip.Aircraft,
            FlightNumbers: trip.FlightNumbers,
            DepartsAt: trip.DepartsAt?.replace('Z', ''),
            Cabin: trip.Cabin,
            Source: trip.Source,
            ArrivesAt: trip.ArrivesAt?.replace('Z', ''),
            UpdatedAt: trip.UpdatedAt,
            virginatlantic: trip.Source === 'virginatlantic'
          };

          // Add virgin atlantic specific fields if available
          if (trip.TotalTaxes !== undefined) {
            // Convert GBP to USD if currency is GBP
            if (trip.TaxesCurrency === 'GBP') {
              tripData.TotalTaxes = Math.round(trip.TotalTaxes * 1.34);
              tripData.TaxesCurrency = 'USD';
            } else {
              tripData.TotalTaxes = trip.TotalTaxes;
              tripData.TaxesCurrency = trip.TaxesCurrency;
            }
          }

          tripMap.set(flightKey, tripData);
        }
      }
    }

    // Convert map to array and filter out flights without virginatlantic data and exclude specific MileageCost
    allTrips = Array.from(tripMap.values()).filter(trip => 
      trip.Source === 'delta' && 
      trip.virginatlantic === true && 
      trip.MileageCost !== 350000
    );

    return NextResponse.json({
      trips: allTrips,
      metadata: {
        totalTrips: allTrips.length,
        direction,
        route,
        startDate,
        endDate,
        carriers: 'VS',
        sources: 'delta,virginatlantic',
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