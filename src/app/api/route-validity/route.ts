import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from '@/lib/env-utils';

// Supabase configuration
const { url: SUPABASE_URL, serviceRoleKey: SUPABASE_KEY } = getSupabaseConfig();

// Input validation schema
const RouteValiditySchema = z.object({
  dep: z.string().min(3).max(3), // Departure airport IATA code
  des: z.string().min(3).max(3), // Destination airport IATA code
  airline: z.string().min(2).max(3), // Airline IATA code
});

// FlightConnections API configuration
const FLIGHTCONNECTIONS_URL = 'https://www.flightconnections.com/validity.php';
const FLIGHTCONNECTIONS_HEADERS = {
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9,vi-VN;q=0.8,vi;q=0.7',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'priority': 'u=1, i',
  'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest',
};

/**
 * Fetch airport ID by IATA code from Supabase
 */
async function fetchAirportId(supabase: any, iata: string): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from('airports')
      .select('id')
      .eq('iata', iata.toUpperCase())
      .single();

    if (error || !data) {
      console.error(`Airport not found for IATA code: ${iata}`, error);
      return null;
    }

    return data.id;
  } catch (error) {
    console.error(`Error fetching airport ID for ${iata}:`, error);
    return null;
  }
}

/**
 * Fetch airline ID by IATA code from Supabase
 */
async function fetchAirlineId(supabase: any, iata: string): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from('airlines')
      .select('id')
      .eq('code', iata.toUpperCase())
      .single();

    if (error || !data) {
      console.error(`Airline not found for IATA code: ${iata}`, error);
      return null;
    }

    return data.id;
  } catch (error) {
    console.error(`Error fetching airline ID for ${iata}:`, error);
    return null;
  }
}

/**
 * Make request to FlightConnections API
 */
async function fetchRouteValidity(depId: number, desId: number, airlineId: number): Promise<any> {
  try {
    const formData = new URLSearchParams({
      dep: depId.toString(),
      des: desId.toString(),
      id: airlineId.toString(),
      startDate: '2025',
      endDate: '2026',
      lang: 'en',
    });

    const response = await fetch(FLIGHTCONNECTIONS_URL, {
      method: 'POST',
      headers: FLIGHTCONNECTIONS_HEADERS,
      body: formData.toString(),
    });

    if (!response.ok) {
      throw new Error(`FlightConnections API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching route validity:', error);
    throw error;
  }
}

/**
 * Check if two date ranges overlap or are adjacent
 */
function rangesOverlapOrAdjacent(range1: any, range2: any): boolean {
  const start1 = new Date(range1.datefrom);
  const end1 = new Date(range1.dateto);
  const start2 = new Date(range2.datefrom);
  const end2 = new Date(range2.dateto);
  
  // Check if ranges overlap
  if (start1 <= end2 && start2 <= end1) {
    return true;
  }
  
  // Check if ranges are adjacent (within 1 day)
  const dayDiff1 = Math.abs((start2.getTime() - end1.getTime()) / (1000 * 60 * 60 * 24));
  const dayDiff2 = Math.abs((start1.getTime() - end2.getTime()) / (1000 * 60 * 60 * 24));
  
  return dayDiff1 <= 1 || dayDiff2 <= 1;
}

/**
 * Format flight data to return only essential information and merge overlapping date ranges
 */
function formatFlightData(flights: any[]): any[] {
  // First, format the basic flight data
  const formattedFlights = flights.map(flight => ({
    flightnumber: flight.flightnumber?.replace(/\s+/g, '') || '', // Remove all spaces
    deptime: flight.deptime || '',
    destime: flight.destime || '',
    datefrom: flight.datefrom || '',
    dateto: flight.dateto || '',
  }));

  // Group flights by flight number and times
  const flightGroups = new Map<string, any[]>();
  
  formattedFlights.forEach(flight => {
    const key = `${flight.flightnumber}-${flight.deptime}-${flight.destime}`;
    if (!flightGroups.has(key)) {
      flightGroups.set(key, []);
    }
    flightGroups.get(key)!.push(flight);
  });

  // Merge overlapping date ranges for each group
  const mergedFlights: any[] = [];
  
  flightGroups.forEach((groupFlights, key) => {
    if (groupFlights.length === 1) {
      mergedFlights.push(groupFlights[0]);
      return;
    }

    // Sort by datefrom
    groupFlights.sort((a, b) => new Date(a.datefrom).getTime() - new Date(b.datefrom).getTime());

    const merged = [];
    let current = { ...groupFlights[0] };

    for (let i = 1; i < groupFlights.length; i++) {
      const next = groupFlights[i];
      
      if (rangesOverlapOrAdjacent(current, next)) {
        // Merge the date ranges
        const currentEnd = new Date(current.dateto);
        const nextEnd = new Date(next.dateto);
        if (nextEnd > currentEnd) {
          current.dateto = next.dateto;
        }
      } else {
        // No overlap, add current to merged and start new
        merged.push(current);
        current = { ...next };
      }
    }
    
    // Add the last merged flight
    merged.push(current);
    
    // Add all merged flights to result
    mergedFlights.push(...merged);
  });

  return mergedFlights;
}

/**
 * POST /api/route-validity
 * Validates route availability between airports for a specific airline
 */
export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    // Parse and validate request body
    const body = await req.json();
    const parsed = RouteValiditySchema.safeParse(body);
    
    if (!parsed.success) {
      return NextResponse.json({ 
        error: 'Invalid input', 
        details: parsed.error.errors 
      }, { status: 400 });
    }

    const { dep, des, airline } = parsed.data;

    // Create Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Fetch IDs from Supabase
    const [depId, desId, airlineId] = await Promise.all([
      fetchAirportId(supabase, dep),
      fetchAirportId(supabase, des),
      fetchAirlineId(supabase, airline),
    ]);

    // Validate that all IDs were found
    if (!depId) {
      return NextResponse.json({ 
        error: 'Departure airport not found', 
        airport: dep 
      }, { status: 404 });
    }

    if (!desId) {
      return NextResponse.json({ 
        error: 'Destination airport not found', 
        airport: des 
      }, { status: 404 });
    }

    if (!airlineId) {
      return NextResponse.json({ 
        error: 'Airline not found', 
        airline: airline 
      }, { status: 404 });
    }

    // Fetch route validity from FlightConnections
    const validityData = await fetchRouteValidity(depId, desId, airlineId);

    // Format the response to include only essential flight information
    const formattedFlights = validityData.flights ? formatFlightData(validityData.flights) : [];

    return NextResponse.json({
      success: true,
      flights: formattedFlights,
      metadata: {
        departure: { iata: dep, id: depId },
        destination: { iata: des, id: desId },
        airline: { iata: airline, id: airlineId },
      },
    });

  } catch (error) {
    console.error('Error in route-validity POST:', error);
    return NextResponse.json({ 
      error: 'Internal server error', 
      details: (error as Error).message 
    }, { status: 500 });
  }
} 