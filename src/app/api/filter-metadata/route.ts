import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import zlib from 'zlib';
import Redis from 'ioredis';

// Input validation schema
const filterMetadataSchema = z.object({
  origin: z.string().min(2),
  destination: z.string().min(2),
  maxStop: z.number().min(0).max(4),
  startDate: z.string().min(8),
  endDate: z.string().min(8),
  apiKey: z.string().min(8).nullable(),
  cabin: z.string().optional(),
  carriers: z.string().optional(),
  minReliabilityPercent: z.number().min(0).max(100).optional(),
});

// --- Redis setup ---
const redis = new Redis({ host: '127.0.0.1', port: 6379 });
const CACHE_TTL_SECONDS = 1800; // 30 minutes

function getCacheKey(params: any) {
  const { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent } = params;
  const hash = createHash('sha256').update(JSON.stringify({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent })).digest('hex');
  return `build-itins:${origin}:${destination}:${hash}`;
}

async function getCachedItineraries(key: string) {
  const compressed = await redis.getBuffer(key);
  if (!compressed) return null;
  const json = zlib.gunzipSync(compressed).toString();
  return JSON.parse(json);
}

/**
 * POST /api/filter-metadata
 * Returns filter metadata for the client-side filter interface.
 */
export async function POST(req: NextRequest) {
  try {
    // 1. Validate input
    const body = await req.json();
    const parseResult = filterMetadataSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    const { origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers, minReliabilityPercent } = parseResult.data;

    // 2. Generate cache key and check for cached data
    const cacheKey = getCacheKey({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent });
    const cached = await getCachedItineraries(cacheKey);
    
    if (cached) {
      const { itineraries, flights } = cached;
      
      // Extract filter metadata from cached data
      const filterMetadata = extractFilterMetadata(itineraries, flights);
      
      return NextResponse.json({
        filterMetadata,
        cached: true,
      });
    }

    // 3. If no cached data, call the build-itineraries API to get the data
    let baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    if (!baseUrl) {
      const proto = req.headers.get('x-forwarded-proto') || 'http';
      const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000';
      baseUrl = `${proto}://${host}`;
    }

    const buildItinerariesRes = await fetch(`${baseUrl}/api/build-itineraries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers, minReliabilityPercent }),
    });

    if (!buildItinerariesRes.ok) {
      return NextResponse.json({ error: 'Failed to fetch itinerary data' }, { status: 500 });
    }

    const buildItinerariesData = await buildItinerariesRes.json();
    const { filterMetadata } = buildItinerariesData;

    return NextResponse.json({
      filterMetadata,
      cached: false,
    });

  } catch (err) {
    console.error('Error in /api/filter-metadata:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
}

// --- Helper: Extract filter metadata from full response ---
function extractFilterMetadata(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Record<string, any>
) {
  const metadata = {
    stops: new Set<number>(),
    airlines: new Set<string>(),
    airports: {
      origins: new Set<string>(),
      destinations: new Set<string>(),
      connections: new Set<string>(),
    },
    duration: {
      min: Infinity,
      max: -Infinity,
    },
    departure: {
      min: Infinity,
      max: -Infinity,
    },
    arrival: {
      min: Infinity,
      max: -Infinity,
    },
    cabinClasses: {
      y: { min: 0, max: 100 },
      w: { min: 0, max: 100 },
      j: { min: 0, max: 100 },
      f: { min: 0, max: 100 },
    },
  };

  // Process all itineraries to extract metadata
  for (const routeKey of Object.keys(itineraries)) {
    const routeSegments = routeKey.split('-');
    const stopCount = routeSegments.length - 2;
    metadata.stops.add(stopCount);

    // Extract airports
    metadata.airports.origins.add(routeSegments[0]);
    metadata.airports.destinations.add(routeSegments[routeSegments.length - 1]);
    for (let i = 1; i < routeSegments.length - 1; i++) {
      metadata.airports.connections.add(routeSegments[i]);
    }

    for (const date of Object.keys(itineraries[routeKey])) {
      for (const itinerary of itineraries[routeKey][date]) {
        const flightObjs = itinerary.map(uuid => flights[uuid]).filter(Boolean);
        if (flightObjs.length === 0) continue;

        // Extract airline codes
        flightObjs.forEach(flight => {
          const airlineCode = flight.FlightNumbers.slice(0, 2).toUpperCase();
          metadata.airlines.add(airlineCode);
        });

        // Calculate total duration (including layovers)
        let totalDuration = 0;
        for (let i = 0; i < flightObjs.length; i++) {
          totalDuration += flightObjs[i].TotalDuration;
          if (i > 0) {
            const prevArrive = new Date(flightObjs[i - 1].ArrivesAt).getTime();
            const currDepart = new Date(flightObjs[i].DepartsAt).getTime();
            const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
            totalDuration += layover;
          }
        }
        metadata.duration.min = Math.min(metadata.duration.min, totalDuration);
        metadata.duration.max = Math.max(metadata.duration.max, totalDuration);

        // Extract departure/arrival times
        const depTime = new Date(flightObjs[0].DepartsAt).getTime();
        const arrTime = new Date(flightObjs[flightObjs.length - 1].ArrivesAt).getTime();
        metadata.departure.min = Math.min(metadata.departure.min, depTime);
        metadata.departure.max = Math.max(metadata.departure.max, depTime);
        metadata.arrival.min = Math.min(metadata.arrival.min, arrTime);
        metadata.arrival.max = Math.max(metadata.arrival.max, arrTime);
      }
    }
  }

  // Convert sets to sorted arrays and handle edge cases
  return {
    stops: Array.from(metadata.stops).sort((a, b) => a - b),
    airlines: Array.from(metadata.airlines).sort(),
    airports: {
      origins: Array.from(metadata.airports.origins).sort(),
      destinations: Array.from(metadata.airports.destinations).sort(),
      connections: Array.from(metadata.airports.connections).sort(),
    },
    duration: {
      min: metadata.duration.min === Infinity ? 0 : metadata.duration.min,
      max: metadata.duration.max === -Infinity ? 0 : metadata.duration.max,
    },
    departure: {
      min: metadata.departure.min === Infinity ? Date.now() : metadata.departure.min,
      max: metadata.departure.max === -Infinity ? Date.now() : metadata.departure.max,
    },
    arrival: {
      min: metadata.arrival.min === Infinity ? Date.now() : metadata.arrival.min,
      max: metadata.arrival.max === -Infinity ? Date.now() : metadata.arrival.max,
    },
    cabinClasses: metadata.cabinClasses, // These will be calculated based on reliability rules
  };
} 