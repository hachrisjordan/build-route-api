import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createHash } from 'crypto';
import zlib from 'zlib';
import Redis from 'ioredis';
import { getRedisConfig } from '@/lib/env-utils';

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
let redis: Redis | null = null;

function getRedisClient(): Redis | null {
  if (redis) return redis;
  
  // Use sanitized Redis configuration
  const config = getRedisConfig();
  
  try {
    redis = new Redis({
      ...config,
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: true
    });
    
    redis.on('error', (err) => {
      console.warn('Redis connection error:', err.message);
    });
    
    return redis;
  } catch (error) {
    console.warn('Failed to create Redis client:', error);
    return null;
  }
}

const CACHE_TTL_SECONDS = 1800; // 30 minutes

function getCacheKey(params: any) {
  const { origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent } = params;
  const hash = createHash('sha256').update(JSON.stringify({ origin, destination, maxStop, startDate, endDate, cabin, carriers, minReliabilityPercent })).digest('hex');
  return `filter-metadata:${origin}:${destination}:${hash}`;
}

async function cacheItineraries(key: string, data: any, ttlSeconds = CACHE_TTL_SECONDS) {
  const redisClient = getRedisClient();
  if (!redisClient) return;
  
  try {
    const compressed = zlib.gzipSync(JSON.stringify(data));
    await redisClient.set(key, compressed, 'EX', ttlSeconds);
  } catch (error) {
    console.warn('Failed to cache data:', error);
  }
}

async function getCachedItineraries(key: string) {
  const redisClient = getRedisClient();
  if (!redisClient) return null;
  
  try {
    const compressed = await redisClient.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (error) {
    console.warn('Failed to get cached data:', error);
    return null;
  }
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
    
    // Check if the response has the expected structure
    if (!buildItinerariesData || !buildItinerariesData.itineraries || !buildItinerariesData.flights) {
      return NextResponse.json({ error: 'Invalid response from build-itineraries API' }, { status: 500 });
    }
    
    const { itineraries, flights } = buildItinerariesData;
    
    // Extract filter metadata from the response
    const filterMetadata = extractFilterMetadata(itineraries, flights);

    // 4. Cache the fetched data
    await cacheItineraries(cacheKey, { itineraries, flights });

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
    if (routeSegments.length < 2) continue; // Skip invalid routes
    
    const stopCount = routeSegments.length - 2;
    metadata.stops.add(stopCount);

    // Extract airports
    const origin = routeSegments[0];
    const destination = routeSegments[routeSegments.length - 1];
    
    if (origin) metadata.airports.origins.add(origin);
    if (destination) metadata.airports.destinations.add(destination);
    
    for (let i = 1; i < routeSegments.length - 1; i++) {
      const connection = routeSegments[i];
      if (connection) metadata.airports.connections.add(connection);
    }

    for (const date of Object.keys(itineraries[routeKey] || {})) {
      const routeItineraries = itineraries[routeKey];
      if (!routeItineraries || !routeItineraries[date]) continue;
      
      for (const itinerary of routeItineraries[date]) {
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