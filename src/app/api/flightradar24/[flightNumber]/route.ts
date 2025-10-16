import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

// Type for the response to match the existing API format
interface FlightRadarResponse {
  flightNumber: string;
  date: string;
  registration: string;
  originIata: string;
  destinationIata: string;
  ontime: string;
}

/**
 * API route to fetch flight data using the existing Python FlightRadar24 script
 * Matches the format: /api/flightradar24/{flightNumber}?origin={origin}&destination={destination}
 * 
 * @param request - The incoming request
 * @param params - Route parameters containing flight number
 * @returns Flight data in JSON format
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ flightNumber: string }> }
) {
  try {
    const { searchParams } = new URL(request.url);
    const { flightNumber } = await params;
    const originIata = searchParams.get('origin');
    const destinationIata = searchParams.get('destination');
    
    if (!flightNumber) {
      return NextResponse.json({
        error: 'Flight number is required'
      }, { status: 400 });
    }
    
    // Check database for existing data first
    const latestDate = await getLatestDateFromDatabase(flightNumber, originIata, destinationIata);
    
    // Build command arguments for the Python script
    const args = [flightNumber];
    if (originIata) args.push(originIata);
    if (destinationIata) args.push(destinationIata);
    
    // Add stop_date parameter if we found existing data (for stopping condition only)
    if (latestDate) {
      args.push('--stop-date', latestDate);
    }
    
    // Execute the Python script
    const result = await executePythonScript(args);
    
    // Parse the CSV output from Python script
    const flights = parseFlightData(result);
    
    // Auto-save flights to database if any data was retrieved
    if (flights.length > 0) {
      try {
        const { filterFlightsWithOntimeData, formatFlightForDatabase } = await import('@/lib/flightradar24-client');
        const { getSupabaseAdminClient } = await import('@/lib/supabase-admin');
        
        // Filter flights using the correct logic
        const filteredFlights = filterFlightsWithOntimeData(flights);
        
        if (filteredFlights.length > 0) {
          // Format and store in database
          const formattedFlights = filteredFlights.map(formatFlightForDatabase);
          
          // Deduplicate flights before database insertion
          const uniqueFlightsMap = new Map<string, any>();
          
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
          
          const supabase = getSupabaseAdminClient();
          
          const { data: storedData, error } = await supabase
            .from('flight_data')
            .upsert(deduplicatedFlights, { 
              onConflict: 'flight_number,date,origin_iata,destination_iata',
              ignoreDuplicates: false 
            })
            .select();
          
          if (error) {
            console.error('[FlightRadar24] Database storage error:', error);
          } else {
            // Auto-saved flights to database
            
            // Check and log the new latest date in the database
            const newLatestDate = await getLatestDateFromDatabase(flightNumber, originIata, destinationIata);
            }
          }
        } else {
          console.log('[FlightRadar24] No flights with actual ontime data found - nothing saved to database');
        }
      } catch (saveError) {
        console.error('[FlightRadar24] Failed to auto-save flights:', saveError);
      }
    }
    
    // After scraping and saving, return ALL flights from database for this flight/route
    const allFlights = await getAllFlightsFromDatabase(flightNumber, originIata, destinationIata);
    
    // Return the complete data from database
    return NextResponse.json(allFlights);
    
  } catch (error) {
    console.error('FlightRadar API error:', error);
    
    return NextResponse.json({
      error: 'Failed to fetch flight data',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

/**
 * Execute the Python FlightRadar24 script with given arguments
 * 
 * @param args - Command line arguments for the Python script
 * @returns Promise<string> - The stdout output from the script
 */
function executePythonScript(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use python3 as the primary command (consistent with Docker setup)
    // Fallback to python if python3 is not available
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
    
    console.log(`[FlightRadar24] Attempting to use Python command: ${pythonCommand}`);
    
    const pythonProcess = spawn(pythonCommand, [
      'scripts/flightradar_api.py',
      ...args
    ], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        REDIS_HOST: process.env.REDIS_HOST || 'localhost',
        REDIS_PORT: process.env.REDIS_PORT || '6380',
        REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined
      }
    });
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      
      // Log cache-related messages from Python script
      if (output.includes('[OK]') || output.includes('[WARNING]') || output.includes('[INFO]')) {
        console.log(`[FlightRadar24] ${output.trim()}`);
      }
    });
    
    pythonProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString();
      stderr += errorOutput;
      
      // Log error messages from Python script
      console.error(`[FlightRadar24 Error] ${errorOutput.trim()}`);
    });
    
    pythonProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Python script failed with code ${code}: ${stderr}`));
      }
    });
    
    pythonProcess.on('error', (error) => {
      console.error(`[FlightRadar24] Primary Python command failed: ${error.message}`);
      
      // Try fallback command if primary fails
      if (pythonCommand === 'python3') {
        console.log(`[FlightRadar24] Trying fallback command: python`);
        
        const fallbackProcess = spawn('python', [
          'scripts/flightradar_api.py',
          ...args
        ], {
          cwd: process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            REDIS_HOST: process.env.REDIS_HOST || 'localhost',
            REDIS_PORT: process.env.REDIS_PORT || '6380',
            REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined
          }
        });
        
        let fallbackStdout = '';
        let fallbackStderr = '';
        
        fallbackProcess.stdout.on('data', (data) => {
          const output = data.toString();
          fallbackStdout += output;
          
          if (output.includes('[OK]') || output.includes('[WARNING]') || output.includes('[INFO]')) {
            console.log(`[FlightRadar24] ${output.trim()}`);
          }
        });
        
        fallbackProcess.stderr.on('data', (data) => {
          fallbackStderr += data.toString();
          console.error(`[FlightRadar24 Error] ${data.toString().trim()}`);
        });
        
        fallbackProcess.on('close', (code) => {
          if (code === 0) {
            console.log(`[FlightRadar24] Fallback command succeeded`);
            resolve(fallbackStdout);
          } else {
            reject(new Error(`Both Python commands failed. Primary: ${error.message}, Fallback: ${fallbackStderr}`));
          }
        });
        
        fallbackProcess.on('error', (fallbackError) => {
          reject(new Error(`Both Python commands failed. Primary: ${error.message}, Fallback: ${fallbackError.message}`));
        });
      } else {
        reject(new Error(`Failed to execute Python script: ${error.message}`));
      }
    });
    
    // Set a timeout to prevent hanging
    setTimeout(() => {
      pythonProcess.kill();
      reject(new Error('Python script execution timed out'));
    }, 300000); // 5 minutes timeout
  });
}

/**
 * Parse the CSV output from the Python script into structured data
 * 
 * @param csvOutput - Raw CSV output from the Python script
 * @returns Array of FlightRadarResponse objects
 */
function parseFlightData(csvOutput: string): FlightRadarResponse[] {
  const lines = csvOutput.trim().split('\n');
  const flights: FlightRadarResponse[] = [];
  
  for (const line of lines) {
    // Skip empty lines and debug output
    if (!line.trim() || line.startsWith('====') || line.startsWith('Today') || 
        line.startsWith('Target') || line.startsWith('Current') || 
        line.startsWith('Request') || line.startsWith('Found') || 
        line.startsWith('Date range') || line.startsWith('Added') || 
        line.startsWith('Next') || line.startsWith('All flights') || 
        line.startsWith('Currently') || line.startsWith('Reached') || 
        line.startsWith('Error') || line.startsWith('402') || 
        line.startsWith('Going back') || line.startsWith('Searching') || 
        line.startsWith('Filtering') || line.startsWith('Summary') || 
        line.startsWith('Total') || line.startsWith('Unique') || 
        line.startsWith('Date range')) {
      continue;
    }
    
    // Parse CSV line: flight_number,date,registration,origin_iata,destination_iata,ontime
    const parts = line.split(',');
    if (parts.length === 6 && parts.every(part => part !== undefined)) {
      flights.push({
        flightNumber: parts[0]!.trim(),
        date: parts[1]!.trim(),
        registration: parts[2]!.trim(),
        originIata: parts[3]!.trim(),
        destinationIata: parts[4]!.trim(),
        ontime: parts[5]!.trim(),
      });
    }
  }
  
  return flights;
}

/**
 * Get the latest date from database for the given flight/route
 * @param flightNumber - Flight number to search for
 * @param originIata - Optional origin airport filter
 * @param destinationIata - Optional destination airport filter
 * @returns Latest date string or null if no data found
 */
async function getLatestDateFromDatabase(
  flightNumber: string, 
  originIata?: string | null, 
  destinationIata?: string | null
): Promise<string | null> {
  try {
    const supabase = getSupabaseAdminClient();
    let query = supabase
      .from('flight_data')
      .select('date')
      .eq('flight_number', flightNumber)
      .order('date', { ascending: false })
      .limit(1);

    // Apply route filters if provided
    if (originIata) {
      query = query.eq('origin_iata', originIata);
    }
    if (destinationIata) {
      query = query.eq('destination_iata', destinationIata);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[FlightRadar24] Database query error:', error);
      return null;
    }

    if (data && data.length > 0 && data[0]) {
      return data[0].date;
    }

    return null;
  } catch (error) {
    console.error('[FlightRadar24] Error getting latest date:', error);
    return null;
  }
}

/**
 * Get all flights from database for the given flight/route
 * @param flightNumber - Flight number to search for
 * @param originIata - Optional origin airport filter
 * @param destinationIata - Optional destination airport filter
 * @returns All matching flights formatted as FlightRadarResponse
 */
async function getAllFlightsFromDatabase(
  flightNumber: string, 
  originIata?: string | null, 
  destinationIata?: string | null
): Promise<FlightRadarResponse[]> {
  try {
    const supabase = getSupabaseAdminClient();
    let query = supabase
      .from('flight_data')
      .select('*')
      .eq('flight_number', flightNumber)
      .order('date', { ascending: false });

    // Apply route filters if provided
    if (originIata) {
      query = query.eq('origin_iata', originIata);
    }
    if (destinationIata) {
      query = query.eq('destination_iata', destinationIata);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[FlightRadar24] Database query error:', error);
      return [];
    }

    if (!data) {
      return [];
    }

    // Convert database format to FlightRadarResponse format
    return data.map(flight => ({
      flightNumber: flight.flight_number,
      date: flight.date,
      registration: flight.registration || 'N/A',
      originIata: flight.origin_iata,
      destinationIata: flight.destination_iata,
      ontime: flight.ontime || 'N/A'
    }));

  } catch (error) {
    console.error('[FlightRadar24] Error getting all flights:', error);
    return [];
  }
}