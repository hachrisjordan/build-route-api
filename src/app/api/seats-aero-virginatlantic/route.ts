import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { addDays, format, subDays } from 'date-fns';

// Use environment variables for Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * GET /api/seats-aero-virginatlantic
 * Custom seats.aero API call with Virgin Atlantic business class Delta flights
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

    // Define routes: US to Europe and Europe to US
    const routes = [
      // US to Europe
      'ATL/BOS/CVG/DTW/JFK/LAX/MCO/MSP/SEA/SLC/TPA-AMS/ARN/ATH/BCN/BER/BRU/CDG/CPH/CTA/DUB/EDI/FCO/FRA/GVA/KEF/LGW/LHR/LIS/MAD/MUC/MXP/NAP/NCE/PRG/VCE/ZRH',
      // Europe to US
      'AMS/ARN/ATH/BCN/BER/BRU/CDG/CPH/CTA/DUB/EDI/FCO/FRA/GVA/KEF/LGW/LHR/LIS/MAD/MUC/MXP/NAP/NCE/PRG/VCE/ZRH-ATL/BOS/CVG/DTW/JFK/LAX/MCO/MSP/SEA/SLC/TPA'
    ];

    const allTrips = [];
    const tripsToSave = [];

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
        sources: 'virginatlantic',
        cabin: 'business',
        carriers: 'DL',
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
              
              // Filter to only include DL flights
              if (trip.FlightNumbers && !trip.FlightNumbers.startsWith('DL')) {
                console.log('Skipping non-DL flight:', trip.FlightNumbers);
                continue;
              }
              
              console.log('Including DL flight:', trip.FlightNumbers);
              
              // Prepare trip data for response
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
                UpdatedAt: trip.UpdatedAt,
              };

              allTrips.push(tripData);

              // Prepare trip data for database
              tripsToSave.push({
                total_duration: trip.TotalDuration,
                remaining_seats: trip.RemainingSeats,
                mileage_cost: trip.MileageCost,
                origin_airport: trip.OriginAirport,
                destination_airport: trip.DestinationAirport,
                aircraft: trip.Aircraft,
                flight_numbers: trip.FlightNumbers,
                departs_at: trip.DepartsAt ? new Date(trip.DepartsAt) : null,
                cabin: trip.Cabin,
                arrives_at: trip.ArrivesAt ? new Date(trip.ArrivesAt) : null,
                updated_at: trip.UpdatedAt ? new Date(trip.UpdatedAt) : null,
                search_date: today
              });
            }
          }
        }
      }
    }

    // Save trips to database if we have any
    let saveResult = null;
    if (tripsToSave.length > 0) {
      // First truncate the table to clear old data
      const { error: truncateError } = await supabase
        .from('virgin_atlantic_flights')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all rows

      if (truncateError) {
        console.error('Error truncating table:', truncateError);
        saveResult = { error: `Truncate failed: ${truncateError.message}` };
      } else {
        console.log('Table truncated successfully');
        
        // Now insert the new data
        const { data: savedData, error: saveError } = await supabase
          .from('virgin_atlantic_flights')
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
        sources: 'virginatlantic',
        cabin: 'business',
        carriers: 'DL',
        totalTrips: allTrips.length,
        filterDate: format(sevenDaysAgo, 'yyyy-MM-dd'),
        filterDescription: 'Results filtered to exclude data older than 7 days',
        databaseSave: saveResult
      }
    });

  } catch (error: any) {
    console.error('Error in /api/seats-aero-virginatlantic:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
} 