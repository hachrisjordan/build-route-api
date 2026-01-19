/**
 * FlightRadar24 Airport API Client
 * Utility functions for interacting with FlightRadar24 Airport API and storing data
 * Stores all flights without filtering by ontime data
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

type Fr24Status = 'success' | 'failed';

async function upsertFr24Status(airport: string, status: Fr24Status) {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from('fr24_status')
    .upsert(
      {
        airport: airport.toUpperCase(),
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'airport', ignoreDuplicates: false }
    );

  if (error) {
    // Don’t fail the main flow for status tracking issues.
    console.error('[fr24_status] Upsert failed:', error);
  }
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
 * Filters out flights with ontime "N/A" before storing
 * Upserts `fr24_status` for the given airport after each run
 * @param flights Array of flight data from FlightRadar24
 * @returns Promise with storage result
 */
export async function storeFlightData(airport: string, flights: FlightRadar24Flight[]) {
  try {
    if (flights.length === 0) {
      await upsertFr24Status(airport, 'success');
      return {
        success: true,
        message: 'No flights to store',
        totalReceived: 0,
        stored: 0
      };
    }

    // Filter out flights with ontime "N/A"
    const flightsWithOntime = flights.filter(flight => flight.ontime !== "N/A");
    
    if (flightsWithOntime.length === 0) {
      await upsertFr24Status(airport, 'success');
      return {
        success: true,
        message: 'No flights with ontime data to store',
        totalReceived: flights.length,
        filtered: 0,
        stored: 0
      };
    }

    // Format data for database
    const formattedFlights = flightsWithOntime.map(formatFlightForDatabase);

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

    await upsertFr24Status(airport, 'success');
    return {
      success: true,
      message: 'Flight data stored successfully',
      totalReceived: flights.length,
      filtered: flightsWithOntime.length,
      deduplicated: deduplicatedFlights.length,
      stored: data?.length || 0,
      data: data
    };

  } catch (error) {
    console.error('Error storing flight data:', error);
    await upsertFr24Status(airport, 'failed');
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
