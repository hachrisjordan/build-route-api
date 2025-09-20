import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

/**
 * FlightRadar24 Data Storage API
 * Stores flight tracking data from FlightRadar24 API to Supabase
 * Only stores flights where ontime is not "N/A" (actual flight data)
 */

interface FlightData {
  flightNumber: string;
  date: string;
  registration: string;
  originIata: string;
  destinationIata: string;
  ontime: string;
}

interface StoredFlightData {
  flight_number: string;
  date: string;
  registration: string | null;
  origin_iata: string;
  destination_iata: string;
  ontime: string | null;
}

/**
 * Filters flight data to store flights from the first date with actual ontime data backwards
 * @param flights Array of flight data from FlightRadar24 (newest to oldest dates)
 * @returns Filtered array with flights from first actual ontime date backwards
 */
function filterFlightsWithOntimeData(flights: FlightData[]): FlightData[] {
  // Sort flights by date (newest first) to ensure proper order
  const sortedFlights = [...flights].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  
  // Find the first date (most recent) that has actual ontime data
  const firstActualDateIndex = sortedFlights.findIndex(flight => flight.ontime !== "N/A");
  
  // If no actual ontime data found, return empty array
  if (firstActualDateIndex === -1) {
    return [];
  }
  
  // Return all flights from the first actual date backwards (including those with N/A)
  return sortedFlights.slice(firstActualDateIndex);
}

/**
 * Converts FlightRadar24 data format to database format
 * @param flight Flight data from FlightRadar24 API
 * @returns Formatted data for database storage
 */
function formatFlightForDatabase(flight: FlightData): StoredFlightData {
  return {
    flight_number: flight.flightNumber,
    date: flight.date,
    registration: flight.registration === "N/A" ? null : flight.registration,
    origin_iata: flight.originIata,
    destination_iata: flight.destinationIata,
    ontime: flight.ontime === "N/A" ? null : flight.ontime
  };
}

/**
 * POST /api/flightradar24/store
 * Stores flight tracking data from FlightRadar24 API
 */
export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const flights: FlightData[] = await request.json();
    
    // Validate input
    if (!Array.isArray(flights) || flights.length === 0) {
      return NextResponse.json(
        { error: 'Invalid request: Expected non-empty array of flight data' },
        { status: 400 }
      );
    }

    // Filter flights to include those from first actual ontime date backwards
    const filteredFlights = filterFlightsWithOntimeData(flights);
    
    if (filteredFlights.length === 0) {
      return NextResponse.json(
        { 
          message: 'No flights found with actual ontime data to establish baseline',
          totalReceived: flights.length,
          stored: 0
        },
        { status: 200 }
      );
    }

    // Format data for database
    const formattedFlights = filteredFlights.map(formatFlightForDatabase);

    // Deduplicate flights before database insertion
    // Use a Map to ensure uniqueness based on the database constraint fields
    const uniqueFlightsMap = new Map<string, StoredFlightData>();
    
    formattedFlights.forEach(flight => {
      // Create a unique key based on the database constraint fields
      const uniqueKey = `${flight.flight_number}|${flight.date}|${flight.origin_iata}|${flight.destination_iata}`;
      
      // Keep the most recent entry if there are duplicates
      if (!uniqueFlightsMap.has(uniqueKey)) {
        uniqueFlightsMap.set(uniqueKey, flight);
      }
    });
    
    // Convert back to array
    const deduplicatedFlights = Array.from(uniqueFlightsMap.values());
    
    console.log(`[FlightRadar24] Deduplicated ${formattedFlights.length} flights to ${deduplicatedFlights.length} unique entries`);

    // Get Supabase admin client
    const supabase = getSupabaseAdminClient();

    // Insert or update flights in database (upsert to handle duplicates)
    const { data, error } = await supabase
      .from('flight_data')
      .upsert(deduplicatedFlights, { 
        onConflict: 'flight_number,date,origin_iata,destination_iata',
        ignoreDuplicates: false 
      })
      .select();

    if (error) {
      console.error('Database insertion error:', error);
      return NextResponse.json(
        { error: 'Failed to store flight data', details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: 'Flight data stored successfully',
      totalReceived: flights.length,
      filtered: filteredFlights.length,
      deduplicated: deduplicatedFlights.length,
      stored: data?.length || 0,
      data: data
    });

  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/flightradar24/store
 * Retrieves stored flight data with optional filtering
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const flightNumber = searchParams.get('flight_number');
    const date = searchParams.get('date');
    const originIata = searchParams.get('origin_iata');
    const destinationIata = searchParams.get('destination_iata');
    const supabase = getSupabaseAdminClient();
    let query = supabase
      .from('flight_data')
      .select('*')
      .order('date', { ascending: false });

    // Apply filters if provided
    if (flightNumber) {
      query = query.eq('flight_number', flightNumber);
    }
    if (date) {
      query = query.eq('date', date);
    }
    if (originIata) {
      query = query.eq('origin_iata', originIata);
    }
    if (destinationIata) {
      query = query.eq('destination_iata', destinationIata);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Database query error:', error);
      return NextResponse.json(
        { error: 'Failed to retrieve flight data', details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      data: data || [],
      count: data?.length || 0
    });

  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
