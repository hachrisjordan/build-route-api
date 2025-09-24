import { Airport, Path, IntraRoute } from '../types/route';
import { createClient, SupabaseClient as SupabaseClientType } from '@supabase/supabase-js';
import { CONCURRENCY_CONFIG } from './concurrency-config';

// Use 'any' for generics to avoid linter errors
export type SupabaseClient = SupabaseClientType<any, any, any>;

// Haversine formula (returns distance in miles)
export function getHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// Fetch airport by IATA code
export async function fetchAirportByIata(
  supabase: SupabaseClient,
  iata: string
): Promise<Airport | null> {
  const { data, error } = await supabase
    .from('airports')
    .select('*')
    .ilike('iata', iata)
    .single();
  if (error || !data) return null;
  return data as unknown as Airport;
}

// Batch fetch airports by IATA codes
export async function batchFetchAirportsByIata(
  supabase: SupabaseClient,
  iataCodes: string[]
): Promise<Record<string, Airport | null>> {
  if (iataCodes.length === 0) return {};
  
  const uniqueCodes = [...new Set(iataCodes)];
  const { data, error } = await supabase
    .from('airports')
    .select('*')
    .in('iata', uniqueCodes);
  
  if (error || !data) return {};
  
  const result: Record<string, Airport | null> = {};
  uniqueCodes.forEach(code => {
    result[code] = null;
  });
  
  data.forEach(airport => {
    result[airport.iata] = airport as unknown as Airport;
  });
  
  return result;
}

export async function buildAirportMapAndDirectDistance(
  origin: string,
  destination: string,
  segmentPool: Record<string, any[]>,
  supabaseUrl: string,
  supabaseAnonKey: string
): Promise<{ airportMap: Record<string, Airport | null>; directDistanceMiles: number }> {
  const codes = new Set<string>();
  Object.keys(segmentPool).forEach(key => {
    const [so, sd] = key.split('-');
    if (so) codes.add(so);
    if (sd) codes.add(sd);
  });
  if (origin) codes.add(origin);
  if (destination) codes.add(destination);
  const supabase = createClient(supabaseUrl, supabaseAnonKey) as unknown as SupabaseClient;
  const airportMap = await batchFetchAirportsByIata(supabase, Array.from(codes));
  let directDistanceMiles = 0;
  const oAp = airportMap[origin];
  const dAp = airportMap[destination];
  if (oAp && dAp && typeof oAp.latitude === 'number' && typeof oAp.longitude === 'number' && typeof dAp.latitude === 'number' && typeof dAp.longitude === 'number') {
    directDistanceMiles = getHaversineDistance(oAp.latitude, oAp.longitude, dAp.latitude, dAp.longitude);
  }
  return { airportMap, directDistanceMiles };
}

// Helper function to fetch paths in batches
async function fetchPathsBatch(
  supabase: SupabaseClient,
  originRegion: string,
  destinationRegion: string,
  maxDistance: number,
  offset: number,
  limit: number
): Promise<Path[]> {
  const { data, error } = await supabase
    .from('path')
    .select('*')
    .eq('originRegion', originRegion)
    .eq('destinationRegion', destinationRegion)
    .lte('totalDistance', maxDistance)
    .range(offset, offset + limit - 1);
  
  if (error || !data) return [];
  return data as unknown as Path[];
}

// Fetch paths by region and distance with batching and parallel processing
export async function fetchPaths(
  supabase: SupabaseClient,
  originRegion: string,
  destinationRegion: string,
  maxDistance: number,
  batchSize: number = CONCURRENCY_CONFIG.DATABASE_BATCH_SIZE,
  maxConcurrentBatches: number = CONCURRENCY_CONFIG.DATABASE_CONCURRENT_BATCHES
): Promise<Path[]> {
  // First, get the total count to determine how many batches we need
  const { count, error: countError } = await supabase
    .from('path')
    .select('*', { count: 'exact', head: true })
    .eq('originRegion', originRegion)
    .eq('destinationRegion', destinationRegion)
    .lte('totalDistance', maxDistance);
  
  if (countError || count === null) {
    console.warn('Failed to get count, falling back to single batch');
    return fetchPathsBatch(supabase, originRegion, destinationRegion, maxDistance, 0, batchSize);
  }
  
  if (count === 0) return [];
  
  // Calculate number of batches needed
  const totalBatches = Math.ceil(count / batchSize);
  const allPaths: Path[] = [];
  
  // Process batches in parallel with concurrency limit
  for (let i = 0; i < totalBatches; i += maxConcurrentBatches) {
    const batchPromises = [];
    
    // Create batch promises for current chunk
    for (let j = 0; j < maxConcurrentBatches && i + j < totalBatches; j++) {
      const batchIndex = i + j;
      const offset = batchIndex * batchSize;
      batchPromises.push(
        fetchPathsBatch(supabase, originRegion, destinationRegion, maxDistance, offset, batchSize)
      );
    }
    
    // Wait for current chunk of batches to complete
    const batchResults = await Promise.all(batchPromises);
    
    // Add results to allPaths
    batchResults.forEach(paths => {
      allPaths.push(...paths);
    });
    
    // Optional: Add a small delay between chunks to prevent overwhelming the database
    if (i + maxConcurrentBatches < totalBatches) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  
  return allPaths;
}

// Fetch intra_routes by origin or destination
export async function fetchIntraRoutes(
  supabase: SupabaseClient,
  origin?: string,
  destination?: string
): Promise<IntraRoute[]> {
  let query = supabase.from('intra_routes').select('*');
  if (origin) query = query.eq('Origin', origin);
  if (destination) query = query.eq('Destination', destination);
  const { data, error } = await query;
  if (error || !data) return [];
  return data as unknown as IntraRoute[];
}

// Batch fetch intra routes for multiple origin-destination pairs
export async function batchFetchIntraRoutes(
  supabase: SupabaseClient,
  pairs: { origin: string; destination: string }[]
): Promise<Record<string, IntraRoute[]>> {
  if (pairs.length === 0) return {};
  
  const uniquePairs = [...new Set(pairs.map(p => `${p.origin}-${p.destination}`))];
  const result: Record<string, IntraRoute[]> = {};
  
  // Fetch all unique pairs in parallel
  await Promise.all(uniquePairs.map(async (pair) => {
    const [origin, destination] = pair.split('-');
    const routes = await fetchIntraRoutes(supabase, origin, destination);
    result[pair] = routes;
  }));
  
  return result;
}

// Fetch paths by maxStop with specific filtering logic
// Optimized batch fetch function for paths with maxStop filtering
async function fetchPathsByMaxStopBatch(
  supabase: SupabaseClient,
  origin: string,
  destination: string,
  maxStop: number,
  originRegion: string,
  destinationRegion: string,
  maxDistance: number,
  offset: number,
  limit: number
): Promise<Path[]> {
  let query = supabase
    .from('path')
    .select('*')
    .lte('totalDistance', maxDistance)
    .eq('originRegion', originRegion)
    .eq('destinationRegion', destinationRegion)
    .range(offset, offset + limit - 1);

  if (maxStop === 0) {
    // Only A-B and A-A with origin = user input origin and destination = user input destination
    query = query
      .eq('origin', origin)
      .eq('destination', destination);
  } else if (maxStop === 1) {
    // Don't need A-H-H-B, and for A-H-B: origin = user input origin and destination = user input destination
    // For A-B and A-A: origin = user input origin OR destination = user input destination
    query = query.or(`origin.eq.${origin},destination.eq.${destination}`)
      .not('type', 'eq', 'A-H-H-B'); // Exclude A-H-H-B type
  } else if (maxStop === 2) {
    // For A-H-H-B: origin = user input origin and destination = user input destination
    // For A-H-B: origin = user input origin OR destination = user input destination
    // For A-B and A-A: no filtering (include all)
    query = query.or(`and(type.eq.A-H-H-B,origin.eq.${origin},destination.eq.${destination}),and(type.eq.A-H-B,or(origin.eq.${origin},destination.eq.${destination})),type.eq.A-B,type.eq.A-A`);
  } else if (maxStop === 3) {
    // For A-H-H-B: origin = user input origin OR destination = user input destination
    // For A-B, A-H-B, A-A: no filtering (include all)
    query = query.or(`and(type.eq.A-H-H-B,or(origin.eq.${origin},destination.eq.${destination})),type.eq.A-B,type.eq.A-H-B,type.eq.A-A`);
  }

  const { data, error } = await query;
  if (error || !data) return [];
  return data as unknown as Path[];
}

export async function fetchPathsByMaxStop(
  supabase: SupabaseClient,
  origin: string,
  destination: string,
  maxStop: number,
  originRegion: string,
  destinationRegion: string,
  maxDistance: number
): Promise<Path[]> {
  // First, get the total count with the same filtering logic
  let countQuery = supabase
    .from('path')
    .select('*', { count: 'exact', head: true })
    .lte('totalDistance', maxDistance)
    .eq('originRegion', originRegion)
    .eq('destinationRegion', destinationRegion);

  if (maxStop === 0) {
    countQuery = countQuery
      .eq('origin', origin)
      .eq('destination', destination);
  } else if (maxStop === 1) {
    countQuery = countQuery.or(`origin.eq.${origin},destination.eq.${destination}`)
      .not('type', 'eq', 'A-H-H-B');
  } else if (maxStop === 2) {
    // For A-H-H-B: origin = user input origin and destination = user input destination
    // For A-H-B: origin = user input origin OR destination = user input destination
    // For A-B and A-A: no filtering (include all)
    countQuery = countQuery.or(`and(type.eq.A-H-H-B,origin.eq.${origin},destination.eq.${destination}),and(type.eq.A-H-B,or(origin.eq.${origin},destination.eq.${destination})),type.eq.A-B,type.eq.A-A`);
  } else if (maxStop === 3) {
    // For A-H-H-B: origin = user input origin OR destination = user input destination
    // For A-B, A-H-B, A-A: no filtering (include all)
    countQuery = countQuery.or(`and(type.eq.A-H-H-B,or(origin.eq.${origin},destination.eq.${destination})),type.eq.A-B,type.eq.A-H-B,type.eq.A-A`);
  }

  const { count, error: countError } = await countQuery;
  
  if (countError || count === null) {
    console.warn('Failed to get count, falling back to single batch');
    return fetchPathsByMaxStopBatch(supabase, origin, destination, maxStop, originRegion, destinationRegion, maxDistance, 0, 10000);
  }
  
  if (count === 0) return [];
  
  console.log(`Fetching ${count} paths with maxStop=${maxStop} filtering in batches of 10000 with 5 concurrent batches`);
  
  // Calculate number of batches needed
  const batchSize = 10000;
  const maxConcurrentBatches = 5;
  const totalBatches = Math.ceil(count / batchSize);
  const allPaths: Path[] = [];
  
  // Process batches in parallel with concurrency limit
  for (let i = 0; i < totalBatches; i += maxConcurrentBatches) {
    const batchPromises = [];
    
    // Create batch promises for current chunk
    for (let j = 0; j < maxConcurrentBatches && i + j < totalBatches; j++) {
      const batchIndex = i + j;
      const offset = batchIndex * batchSize;
      batchPromises.push(
        fetchPathsByMaxStopBatch(supabase, origin, destination, maxStop, originRegion, destinationRegion, maxDistance, offset, batchSize)
      );
    }
    
    // Wait for current chunk of batches to complete
    const batchResults = await Promise.all(batchPromises);
    
    // Add results to allPaths
    batchResults.forEach(paths => {
      allPaths.push(...paths);
    });
    
    // Optional: Add a small delay between chunks to prevent overwhelming the database
    if (i + maxConcurrentBatches < totalBatches) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  
  return allPaths;
}

// Utility function to calculate optimal batch size based on dataset size
function calculateOptimalBatchSize(totalCount: number): number {
  if (totalCount <= 10000) return 10000;
  if (totalCount <= 50000) return 5000;
  if (totalCount <= 100000) return 2500;
  if (totalCount <= 500000) return 1000;
  return 500; // For very large datasets
}

// Utility function to calculate optimal concurrency based on dataset size
function calculateOptimalConcurrency(totalCount: number): number {
  if (totalCount <= 50000) return 5;
  if (totalCount <= 200000) return 3;
  return 2; // For very large datasets, reduce concurrency
}

// Advanced fetch paths with automatic optimization for large datasets
export async function fetchPathsOptimized(
  supabase: SupabaseClient,
  originRegion: string,
  destinationRegion: string,
  maxDistance: number,
  options: {
    maxMemoryUsage?: number; // in MB
    enableStreaming?: boolean;
    customBatchSize?: number;
    customConcurrency?: number;
  } = {}
): Promise<Path[]> {
  const {
    maxMemoryUsage = CONCURRENCY_CONFIG.MAX_MEMORY_USAGE_MB, // Use configured memory limit
    enableStreaming = false,
    customBatchSize,
    customConcurrency
  } = options;

  // First, get the total count
  const { count, error: countError } = await supabase
    .from('path')
    .select('*', { count: 'exact', head: true })
    .eq('originRegion', originRegion)
    .eq('destinationRegion', destinationRegion)
    .lte('totalDistance', maxDistance);
  
  if (countError || count === null) {
    console.warn('Failed to get count, falling back to single batch');
    return fetchPathsBatch(supabase, originRegion, destinationRegion, maxDistance, 0, 10000);
  }
  
  if (count === 0) return [];
  
  // Calculate optimal batch size and concurrency
  const batchSize = customBatchSize || calculateOptimalBatchSize(count);
  const maxConcurrentBatches = customConcurrency || calculateOptimalConcurrency(count);
  
  console.log(`Fetching ${count} paths in batches of ${batchSize} with ${maxConcurrentBatches} concurrent batches`);
  
  // For very large datasets, use streaming approach
  if (enableStreaming && count > 100000) {
    return fetchPathsStreaming(supabase, originRegion, destinationRegion, maxDistance, batchSize, maxMemoryUsage);
  }
  
  // Use the regular batching approach
  return fetchPaths(supabase, originRegion, destinationRegion, maxDistance, batchSize, maxConcurrentBatches);
}

// Streaming approach for very large datasets
async function fetchPathsStreaming(
  supabase: SupabaseClient,
  originRegion: string,
  destinationRegion: string,
  maxDistance: number,
  batchSize: number,
  maxMemoryUsage: number
): Promise<Path[]> {
  const allPaths: Path[] = [];
  let currentBatch = 0;
  let estimatedMemoryUsage = 0;
  const estimatedPathSize = 1024; // Rough estimate: 1KB per path object
  
  while (true) {
    const offset = currentBatch * batchSize;
    const paths = await fetchPathsBatch(supabase, originRegion, destinationRegion, maxDistance, offset, batchSize);
    
    if (paths.length === 0) break; // No more data
    
    // Check memory usage
    estimatedMemoryUsage += paths.length * estimatedPathSize;
    if (estimatedMemoryUsage > maxMemoryUsage * 1024 * 1024) {
      console.warn(`Memory usage limit reached (${maxMemoryUsage}MB). Processing ${allPaths.length} paths.`);
      break;
    }
    
    allPaths.push(...paths);
    currentBatch++;
    
    // Add a small delay to prevent overwhelming the database
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  return allPaths;
}

// Batch fetch paths for multiple region combinations
export async function batchFetchPathsForRegionCombinations(
  supabase: SupabaseClient,
  regionCombinations: Array<{
    originRegion: string;
    destinationRegion: string;
    maxDistance: number;
    pairs: Array<{ origin: string; destination: string; maxStop: number }>;
  }>
): Promise<Record<string, Path[]>> {
  console.log(`Batch fetching paths for ${regionCombinations.length} region combinations`);
  
  const results: Record<string, Path[]> = {};
  
  // Fetch all region combinations in parallel
  const fetchPromises = regionCombinations
    .filter(combo => combo.pairs.length > 0) // Filter out empty combinations
    .map(async (combo) => {
      const key = `${combo.originRegion}-${combo.destinationRegion}-${combo.maxDistance}`;
      
      // For each region combination, we need to consider all maxStop values from its pairs
      const maxStops = [...new Set(combo.pairs.map(p => p.maxStop))];
      const maxStopValue = Math.max(...maxStops);
      
      // Use the most permissive maxStop filtering for this region combination
      // We'll filter more specifically during processing
      const firstPair = combo.pairs[0]!; // Safe to use ! after filtering above
      
      const paths = await fetchPathsByMaxStop(
        supabase,
        firstPair.origin, // Use first pair's origin as reference
        firstPair.destination, // Use first pair's destination as reference  
        maxStopValue,
        combo.originRegion,
        combo.destinationRegion,
        combo.maxDistance
      );
      
      return { key, paths };
    });
  
  const fetchResults = await Promise.all(fetchPromises);
  
  fetchResults.forEach(({ key, paths }) => {
    results[key] = paths;
  });
  
  console.log(`Batch fetch completed: ${Object.keys(results).length} region combinations loaded`);
  return results;
}

// Global batch fetch intra routes for all pairs across multiple airport combinations
export async function globalBatchFetchIntraRoutes(
  supabase: SupabaseClient,
  allIntraRoutePairs: Array<{ origin: string; destination: string }>
): Promise<Record<string, IntraRoute[]>> {
  if (allIntraRoutePairs.length === 0) return {};
  
  // Deduplicate pairs globally
  const uniquePairs = [...new Set(allIntraRoutePairs.map(p => `${p.origin}-${p.destination}`))];
  console.log(`Global intra routes fetch: ${allIntraRoutePairs.length} total pairs → ${uniquePairs.length} unique pairs`);
  
  const result: Record<string, IntraRoute[]> = {};
  
  // Group pairs for more efficient querying - batch by origin airport
  const originGroups = new Map<string, string[]>();
  uniquePairs.forEach(pair => {
    const [origin] = pair.split('-');
    if (origin) {
      if (!originGroups.has(origin)) {
        originGroups.set(origin, []);
      }
      originGroups.get(origin)!.push(pair);
    }
  });
  
  console.log(`Batching ${uniquePairs.length} pairs into ${originGroups.size} origin groups for efficient querying`);
  
  // Fetch all routes for each origin in parallel
  const fetchPromises = Array.from(originGroups.entries()).map(async ([origin, pairs]) => {
    // Get all routes FROM this origin
    const { data: routesFromOrigin, error } = await supabase
      .from('intra_routes')
      .select('*')
      .eq('Origin', origin);
    
    if (error) {
      console.warn(`Error fetching routes from ${origin}:`, error);
      return { origin, routes: [] };
    }
    
    return { origin, routes: routesFromOrigin as IntraRoute[] };
  });
  
  const fetchResults = await Promise.all(fetchPromises);
  
  // Process results and match to requested pairs
  fetchResults.forEach(({ origin, routes }) => {
    // For each pair that starts with this origin, filter the routes
    const originPairs = originGroups.get(origin) || [];
    
    originPairs.forEach(pair => {
      const [pairOrigin, pairDestination] = pair.split('-');
      if (pairOrigin && pairDestination) {
        const matchingRoutes = routes.filter(route => 
          route.Origin === pairOrigin && route.Destination === pairDestination
        );
        result[pair] = matchingRoutes;
      }
    });
  });
  
  // Handle any missing pairs (set empty array)
  uniquePairs.forEach(pair => {
    if (!result[pair]) {
      result[pair] = [];
    }
  });
  
  console.log(`Global intra routes fetch completed: ${Object.keys(result).length} pairs processed`);
  return result;
} 