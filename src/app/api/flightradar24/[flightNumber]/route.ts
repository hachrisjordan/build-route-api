import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';

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
    
    // Build command arguments for the Python script
    const args = [flightNumber];
    if (originIata) args.push(originIata);
    if (destinationIata) args.push(destinationIata);
    
    // Execute the Python script
    const result = await executePythonScript(args);
    
    // Parse the CSV output from Python script
    const flights = parseFlightData(result);
    
    // Return the data directly without the success wrapper to match existing API
    return NextResponse.json(flights);
    
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
    const pythonProcess = spawn('python', [
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
    });
    
    pythonProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString();
      stderr += errorOutput;
    });
    
    pythonProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Python script failed with code ${code}: ${stderr}`));
      }
    });
    
    pythonProcess.on('error', (error) => {
      reject(new Error(`Failed to execute Python script: ${error.message}`));
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