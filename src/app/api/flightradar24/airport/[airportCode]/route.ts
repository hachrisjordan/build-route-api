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
 * API route to fetch flight data using the airport-based Python FlightRadar24 script
 * Matches the format: /api/flightradar24/airport/{airportCode}?origin={origin}&destination={destination}
 * 
 * @param request - The incoming request
 * @param params - Route parameters containing airport code
 * @returns Flight data in JSON format
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ airportCode: string }> }
) {
  try {
    const { searchParams } = new URL(request.url);
    const { airportCode } = await params;
    const originIata = searchParams.get('origin');
    const destinationIata = searchParams.get('destination');
    
    if (!airportCode) {
      return NextResponse.json({
        error: 'Airport code is required'
      }, { status: 400 });
    }
    
    // Build command arguments for the Python script
    const args = [airportCode];
    if (originIata) args.push(originIata);
    if (destinationIata) args.push(destinationIata);
    
    // Execute the Python script
    const result = await executePythonScript(args);
    
    // Parse the CSV output from Python script
    const flights = parseFlightData(result);
    
    // Auto-save flights to database if any data was retrieved
    if (flights.length > 0) {
      try {
        const { storeFlightData } = await import('@/lib/flightradar24-airport-client');
        
        // Store all flights (no filtering)
        const storageResult = await storeFlightData(airportCode, flights);
        
        if (storageResult.success) {
          console.log(`[FlightRadar24 Airport] Stored ${storageResult.stored} flights to database`);
        } else {
          console.error('[FlightRadar24 Airport] Database storage error:', storageResult.error);
        }
      } catch (saveError) {
        console.error('[FlightRadar24 Airport] Failed to auto-save flights:', saveError);
      }
    }
    
    // Return the scraped flights
    return NextResponse.json(flights);
    
  } catch (error) {
    console.error('FlightRadar Airport API error:', error);
    
    return NextResponse.json({
      error: 'Failed to fetch flight data',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

/**
 * Execute the Python FlightRadar24 airport script with given arguments
 * 
 * @param args - Command line arguments for the Python script
 * @returns Promise<string> - The stdout output from the script
 */
function executePythonScript(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use python3 as the primary command (consistent with Docker setup)
    // Fallback to python if python3 is not available
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
    
    console.log(`[FlightRadar24 Airport] Attempting to use Python command: ${pythonCommand}`);
    
    const pythonProcess = spawn(pythonCommand, [
      'scripts/flightradar_airport_api.py',
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
        console.log(`[FlightRadar24 Airport] ${output.trim()}`);
      }
    });
    
    pythonProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString();
      stderr += errorOutput;
      
      // Log error messages from Python script
      console.error(`[FlightRadar24 Airport Error] ${errorOutput.trim()}`);
    });
    
    pythonProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Python script failed with code ${code}: ${stderr}`));
      }
    });
    
    pythonProcess.on('error', (error) => {
      console.error(`[FlightRadar24 Airport] Primary Python command failed: ${error.message}`);
      
      // Try fallback command if primary fails
      if (pythonCommand === 'python3') {
        console.log(`[FlightRadar24 Airport] Trying fallback command: python`);
        
        const fallbackProcess = spawn('python', [
          'scripts/flightradar_airport_api.py',
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
            console.log(`[FlightRadar24 Airport] ${output.trim()}`);
          }
        });
        
        fallbackProcess.stderr.on('data', (data) => {
          fallbackStderr += data.toString();
          console.error(`[FlightRadar24 Airport Error] ${data.toString().trim()}`);
        });
        
        fallbackProcess.on('close', (code) => {
          if (code === 0) {
            console.log(`[FlightRadar24 Airport] Fallback command succeeded`);
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
        line.startsWith('Date range') || line.startsWith('📅') ||
        line.startsWith('⏰') || line.startsWith('🔍') || line.startsWith('📊') ||
        line.startsWith('---') || line.startsWith('📄') || line.startsWith('✅') ||
        line.startsWith('🔄') || line.startsWith('⚠️') || line.startsWith('❌') ||
        line.startsWith('🔍') || line.startsWith('Warning') || line.startsWith('Continuing') ||
        line.startsWith('🔄 Fetching') || line.startsWith('✅ Loaded') || line.startsWith('✅ Page') ||
        line.startsWith('✅ Completed') || line.startsWith('✅ Processed') || line.startsWith('[OK]') ||
        line.startsWith('[WARNING]') || line.startsWith('[INFO]') || line.startsWith('[DEBUG]')) {
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
