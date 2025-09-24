/**
 * FlightRadar24 API Client
 * Utility functions for interacting with FlightRadar24 API and storing data
 */

import { getSupabaseAdminClient } from './supabase-admin';

export interface FlightRadar24Flight {
  flightNumber: string;
  date: string;
  registration: string;
  originIata: string;
  destinationIata: string;
  ontime: string;
}

export interface StoredFlightData {
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
export function filterFlightsWithOntimeData(flights: FlightRadar24Flight[]): FlightRadar24Flight[] {
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
export function formatFlightForDatabase(flight: FlightRadar24Flight): StoredFlightData {
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
 * Stores flight data to Supabase database
 * @param flights Array of flight data from FlightRadar24
 * @returns Promise with storage result
 */
export async function storeFlightData(flights: FlightRadar24Flight[]) {
  try {
    // Filter flights to only include those with actual ontime data
    const filteredFlights = filterFlightsWithOntimeData(flights);
    
    if (filteredFlights.length === 0) {
      return {
        success: true,
        message: 'No flights with ontime data found',
        totalReceived: flights.length,
        stored: 0
      };
    }

    // Format data for database
    const formattedFlights = filteredFlights.map(formatFlightForDatabase);

    // Deduplicate flights before database insertion
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
      throw new Error(`Database insertion failed: ${error.message}`);
    }

    return {
      success: true,
      message: 'Flight data stored successfully',
      totalReceived: flights.length,
      filtered: filteredFlights.length,
      deduplicated: deduplicatedFlights.length,
      stored: data?.length || 0,
      data: data
    };

  } catch (error) {
    console.error('Error storing flight data:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      totalReceived: flights.length,
      stored: 0
    };
  }
}

/**
 * Retrieves flight data from database with optional filtering
 * @param filters Optional filters for querying flight data
 * @returns Promise with flight data
 */
export async function getFlightData(filters?: {
  flightNumber?: string;
  date?: string;
  originIata?: string;
  destinationIata?: string;
  limit?: number;
}) {
  try {
    const supabase = getSupabaseAdminClient();
    let query = supabase
      .from('flight_data')
      .select('*')
      .order('date', { ascending: false })
      .limit(filters?.limit || 100);

    // Apply filters if provided
    if (filters?.flightNumber) {
      query = query.eq('flight_number', filters.flightNumber);
    }
    if (filters?.date) {
      query = query.eq('date', filters.date);
    }
    if (filters?.originIata) {
      query = query.eq('origin_iata', filters.originIata);
    }
    if (filters?.destinationIata) {
      query = query.eq('destination_iata', filters.destinationIata);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Database query failed: ${error.message}`);
    }

    return {
      success: true,
      data: data || [],
      count: data?.length || 0
    };

  } catch (error) {
    console.error('Error retrieving flight data:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      data: [],
      count: 0
    };
  }
}

/**
 * Example function to demonstrate usage with your sample data
 */
export async function storeSampleFlightData() {
  const sampleFlights: FlightRadar24Flight[] = [
    {
      "flightNumber": "UA28",
      "date": "2025-09-28",
      "registration": "N/A",
      "originIata": "SIN",
      "destinationIata": "SFO",
      "ontime": "N/A"
    },
    {
      "flightNumber": "UA28",
      "date": "2025-09-22",
      "registration": "N23983",
      "originIata": "SIN",
      "destinationIata": "SFO",
      "ontime": "N/A"
    },
    {
      "flightNumber": "UA28",
      "date": "2025-09-21",
      "registration": "N24980",
      "originIata": "SIN",
      "destinationIata": "SFO",
      "ontime": "N/A"
    },
    {
      "flightNumber": "UA28",
      "date": "2025-09-20",
      "registration": "N15969",
      "originIata": "SIN",
      "destinationIata": "SFO",
      "ontime": "N/A"
    },
    {
      "flightNumber": "UA28",
      "date": "2025-09-19",
      "registration": "N22995",
      "originIata": "SIN",
      "destinationIata": "SFO",
      "ontime": "-42"
    },
    {
      "flightNumber": "UA28",
      "date": "2025-09-18",
      "registration": "N26970",
      "originIata": "SIN",
      "destinationIata": "SFO",
      "ontime": "-4"
    },
    {
      "flightNumber": "UA28",
      "date": "2025-09-17",
      "registration": "N17963",
      "originIata": "SIN",
      "destinationIata": "SFO",
      "ontime": "14"
    }
  ];

  return await storeFlightData(sampleFlights);
}
