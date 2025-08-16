import { NextRequest, NextResponse } from 'next/server';
import { getAvailableProKey } from '@/lib/supabase-admin';
import { addDays, format, subDays } from 'date-fns';



/**
 * POST /api/seats-aero-alaska
 * Custom seats.aero API call with Alaska Airlines flights
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { startDate, endDate, seats } = body;

    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: 'Missing required parameters: startDate, endDate' },
        { status: 400 }
      );
    }

    // Validate seats parameter if provided
    let seatsNum: number | null = null;
    if (seats !== null && seats !== undefined) {
      const parsedSeats = parseInt(seats);
      if (isNaN(parsedSeats) || parsedSeats <= 0) {
        return NextResponse.json(
          { error: 'Seats parameter must be a positive integer if provided' },
          { status: 400 }
        );
      }
      seatsNum = parsedSeats;
    }

    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return NextResponse.json(
        { error: 'Invalid date format' },
        { status: 400 }
      );
    }



    // Generate dates for the range
    const dates = [];
    const current = new Date(start);
    while (current <= end) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

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

    // Fixed route string for Alaska Airlines - European origins to LHR
    const routeString = 'TIA/INN/SZG/VIE/BRU/SOF/DBV/ZAG/LCA/PRG/BLL/CPH/BSL/LYS/MRS/NCE/CDG/TLS/BER/CGN/DUS/FRA/HAM/HAJ/MUC/NUE/STR/ATH/CHQ/HER/KLX/EFL/JMK/RHO/SKG/JTR/BUD/KEF/DUB/BLQ/BDS/FLR/LIN/MXP/NAP/PMO/FCO/VCE/RIX/LUX/AMS/OSL/TOS/KRK/WAW/FAO/LIS/PDL/OTP/LJU/BCN/MAD/AGP/PMI/TFS/VLC/GOT/ARN/GVA/ZRH/IST/ADB-LHR';

    // Parse route segments
    const segments = routeString.split('-');
    const originAirports = segments[0].split('/');
    const destinationAirports = segments[1].split('/');

    // Build seats.aero API parameters
    const params = {
      origin_airport: originAirports.join(','),
      destination_airport: destinationAirports.join(','),
      start_date: format(start, 'yyyy-MM-dd'),
      end_date: format(end, 'yyyy-MM-dd'),
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
                Duration: trip.TotalDuration,
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

    // Filter flights based on seats requirement
    const filteredTrips = allTrips.filter((flight: any) => {
      if (seatsNum === 0) {
        // Special case: seats = 0
        // Keep results where economySeats is not null, and businessSeats is < 9
        if (flight.economy && flight.economySeats !== null) {
          if (flight.business && flight.businessSeats !== null) {
            return flight.businessSeats < 9;
          } else {
            return true; // No business class, but economy available
          }
        }
        return false; // No economy available
      } else if (seatsNum !== null) {
        // Seats parameter provided: businessSeats < seats <= economySeats OR seats <= economySeats if no business
        if (flight.business && flight.economy) {
          // Both cabins available: businessSeats < seats <= economySeats
          return flight.businessSeats < seatsNum && seatsNum <= flight.economySeats;
        } else if (flight.economy) {
          // Only economy available: seats <= economySeats
          return seatsNum <= flight.economySeats;
        }
        return false; // No valid cabin available
      } else {
        // No seats parameter: only accept results where economySeats > businessSeats
        if (flight.business && flight.economy) {
          return flight.economySeats > flight.businessSeats;
        }
        return false; // Must have both cabins for this filter
      }
    });

    // Return processed trips
    return NextResponse.json({
      trips: filteredTrips,
      metadata: {
        startDate: format(start, 'yyyy-MM-dd'),
        endDate: format(end, 'yyyy-MM-dd'),
        seats: seatsNum,
        carriers: 'BA',
        totalTrips: filteredTrips.length,
        filterDate: format(sevenDaysAgo, 'yyyy-MM-dd'),
        filterDescription: seatsNum === 0 
          ? 'Results filtered to exclude data older than 7 days and flights with economySeats not null and businessSeats < 9'
          : seatsNum !== null 
            ? `Results filtered to exclude data older than 7 days and flights with businessSeats < ${seatsNum} <= economySeats (or ${seatsNum} <= economySeats if no business class)`
            : 'Results filtered to exclude data older than 7 days and only flights where economySeats > businessSeats',
        route: routeString,
        url: url
      }
    });

  } catch (error: any) {
    console.error('Error in /api/seats-aero-alaska:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
} 