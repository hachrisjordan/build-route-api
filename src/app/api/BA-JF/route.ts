import { NextRequest, NextResponse } from 'next/server';
import { getAvailableProKey } from '@/lib/supabase-admin';
import { addDays, addMinutes, format, subDays } from 'date-fns';



/**
 * POST /api/BA-JF
 * Custom seats.aero API call with Alaska Airlines flights
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { date, seats } = body;

    if (!date || !seats) {
      return NextResponse.json(
        { error: 'Missing required parameters: date, seats' },
        { status: 400 }
      );
    }

    // Validate seats parameter
    const seatsNum = parseInt(seats);
    if (isNaN(seatsNum) || seatsNum < 0) {
      return NextResponse.json(
        { error: 'Seats parameter must be a non-negative integer' },
        { status: 400 }
      );
    }

    // Parse date parameter (format: 2025-09-10T17:00:00)
    const baseDate = new Date(date);

    if (isNaN(baseDate.getTime())) {
      return NextResponse.json(
        { error: 'Invalid date format. Expected: 2025-09-10T17:00:00' },
        { status: 400 }
      );
    }



    // Calculate dates: startDate is the input date, endDate is +1 day
    const startDate = format(baseDate, 'yyyy-MM-dd');
    const endDate = format(addDays(baseDate, 1), 'yyyy-MM-dd');

    // Get API key using admin client
    const proKeyData = await getAvailableProKey();
    if (!proKeyData || !proKeyData.pro_key) {
      return NextResponse.json({ 
        error: 'No available pro_key found' 
      }, { status: 500 });
    }

    // Clean the API key by removing any whitespace, newline, or carriage return characters
    const apiKey = proKeyData.pro_key.replace(/[\r\n]/g, '').trim();

    // Calculate 7 days ago for filtering
    const sevenDaysAgo = subDays(new Date(), 7);

    // Fixed route string for BA-JF - LHR to North American destinations
    const routeString = 'LHR-YUL/YYZ/YVR/ATL/AUS/BWI/BOS/ORD/CVG/DFW/DEN/IAH/LAS/LAX/MIA/BNA/MSY/EWR/JFK/PHL/PHX/PIT/PDX/SAN/SFO/SEA/IAD';

    // Parse route segments
    const segments = routeString.split('-');
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
      carriers: 'BA',
      sources: 'alaska',
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
            
            // Filter to only include BA flights
            if (trip.FlightNumbers && !trip.FlightNumbers.startsWith('BA')) {
              console.log('Skipping non-BA flight:', trip.FlightNumbers);
              continue;
            }
            
            console.log('Including BA flight:', trip.FlightNumbers);
            
            // Create a unique key for merging flights (without time to group all cabins)
            const flightKey = `${trip.FlightNumbers}-${trip.OriginAirport}-${trip.DestinationAirport}`;
            
            if (flightMap.has(flightKey)) {
              // Merge with existing flight
              const existingFlight = flightMap.get(flightKey) as any;
              const cabin = trip.Cabin?.toLowerCase() || 'economy';
              
              // Add cabin availability for premium classes only
              if (cabin === 'business') {
                existingFlight.businessSeats = trip.RemainingSeats;
                existingFlight.businessMiles = trip.MileageCost;
                existingFlight.businessTax = trip.TotalTaxes;
              } else if (cabin === 'first' || cabin === 'firstclass') {
                existingFlight.firstSeats = trip.RemainingSeats;
                existingFlight.firstMiles = trip.MileageCost;
                existingFlight.firstTax = trip.TotalTaxes;
              } else if (cabin === 'premium') {
                existingFlight.premiumSeats = trip.RemainingSeats;
                existingFlight.premiumMiles = trip.MileageCost;
                existingFlight.premiumTax = trip.TotalTaxes;
              }
            } else {
              // Create new flight entry
              const cabin = trip.Cabin?.toLowerCase() || 'economy';
              const newFlight: any = {
                OriginAirport: trip.OriginAirport,
                DestinationAirport: trip.DestinationAirport,
                Aircraft: trip.Aircraft,
                FlightNumbers: trip.FlightNumbers,
                DepartsAt: trip.DepartsAt?.replace('Z', ''),
                ArrivesAt: trip.ArrivesAt?.replace('Z', ''),
                UpdatedAt: trip.UpdatedAt
              };
              
              // Set cabin availability for premium classes only
              if (cabin === 'business') {
                newFlight.businessSeats = trip.RemainingSeats;
                newFlight.businessMiles = trip.MileageCost;
                newFlight.businessTax = trip.TotalTaxes;
              } else if (cabin === 'first' || cabin === 'firstclass') {
                newFlight.firstSeats = trip.RemainingSeats;
                newFlight.firstMiles = trip.MileageCost;
                newFlight.firstTax = trip.TotalTaxes;
              } else if (cabin === 'premium') {
                newFlight.premiumSeats = trip.RemainingSeats;
                newFlight.premiumMiles = trip.MileageCost;
                newFlight.premiumTax = trip.TotalTaxes;
              }
              
              flightMap.set(flightKey, newFlight);
            }
          }
        }
      }
    }

    // Convert map to array
    const allTrips = Array.from(flightMap.values());

    // Filter out flights that depart before input date + 75 minutes
    const inputDate = new Date(date);
    const cutoffTime = addMinutes(inputDate, 75);
    
    const filteredTrips = allTrips.filter((flight: any) => {
      const flightDeparture = new Date(flight.DepartsAt);
      return flightDeparture >= cutoffTime;
    });

    // Filter cabins based on seats parameter - only show cabins with seats under the specified number
    const filteredTripsWithSeats = filteredTrips.map((flight: any) => {
      const filteredFlight: any = {
        OriginAirport: flight.OriginAirport,
        DestinationAirport: flight.DestinationAirport,
        Aircraft: flight.Aircraft,
        FlightNumbers: flight.FlightNumbers,
        DepartsAt: flight.DepartsAt,
        ArrivesAt: flight.ArrivesAt,
        UpdatedAt: flight.UpdatedAt,
        Duration: flight.TotalDuration,
        Distance: flight.TotalSegmentDistance,
      };

      // Only include cabins where seats >= seatsNum
      if (flight.businessSeats && flight.businessSeats >= seatsNum) {
        filteredFlight.businessSeats = flight.businessSeats;
        filteredFlight.businessMiles = flight.businessMiles;
        filteredFlight.businessTax = flight.businessTax;
      }
      
      if (flight.firstSeats && flight.firstSeats >= seatsNum) {
        filteredFlight.firstSeats = flight.firstSeats;
        filteredFlight.firstMiles = flight.firstMiles;
        filteredFlight.firstTax = flight.firstTax;
      }
      
      if (flight.premiumSeats && flight.premiumSeats >= seatsNum) {
        filteredFlight.premiumSeats = flight.premiumSeats;
        filteredFlight.premiumMiles = flight.premiumMiles;
        filteredFlight.premiumTax = flight.premiumTax;
      }

      return filteredFlight;
    });

    // Return processed trips
    return NextResponse.json({
      trips: filteredTripsWithSeats,
              metadata: {
          date: date,
          startDate: startDate,
          endDate: endDate,
          seats: seatsNum,
          carriers: 'BA',
          totalTrips: filteredTripsWithSeats.length,
          filterDate: format(sevenDaysAgo, 'yyyy-MM-dd'),
          filterDescription: 'Results filtered to exclude data older than 7 days, flights departing before input date + 75 minutes, and only show cabins with seats greater than or equal to the specified number',
          route: routeString,
          url: url
        }
    });

  } catch (error: any) {
    console.error('Error in /api/BA-JF:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
} 