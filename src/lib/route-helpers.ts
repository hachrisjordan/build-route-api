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

/**
 * Fetch paths with maxStop filtering applied at the database level
 * @param supabase - Supabase client
 * @param originRegion - Origin region
 * @param destinationRegion - Destination region
 * @param maxDistance - Maximum distance
 * @param maxStop - Maximum number of stops
 * @param userOrigin - User input origin
 * @param userDestination - User input destination
 * @param options - Additional options
 * @returns Filtered paths
 */
export async function fetchPathsWithMaxStopFilter(
  supabase: SupabaseClient,
  originRegion: string,
  destinationRegion: string,
  maxDistance: number,
  maxStop: number,
  userOrigin: string,
  userDestination: string,
  options: {
    maxMemoryUsage?: number;
    enableStreaming?: boolean;
    customBatchSize?: number;
    customConcurrency?: number;
  } = {}
): Promise<Path[]> {
  // Build the base query
  let query = supabase
    .from('path')
    .select('*')
    .eq('originRegion', originRegion)
    .eq('destinationRegion', destinationRegion)
    .lte('totalDistance', maxDistance);

  // Apply maxStop-specific filtering at the database level
  switch (maxStop) {
    case 0:
      // Only A-B and A-A with origin = user input origin and destination = user input destination
      query = query
        .or(`and(origin.eq.${userOrigin},destination.eq.${userDestination})`)
        .is('h1', null)
        .is('h2', null);
      break;
      
    case 1:
      // Don't include A-H-H-B, and specific conditions for other types
      // This is complex to do at DB level, so we'll fetch and filter in memory
      // but with a more targeted query
      query = query
        .or(`and(origin.eq.${userOrigin},destination.eq.${userDestination}),and(origin.eq.${userOrigin},destination.neq.${userDestination}),and(origin.neq.${userOrigin},destination.eq.${userDestination})`)
        .or(`and(is.h1.null,is.h2.null),and(not.is.h1.null,is.h2.null)`);
      break;
      
    case 2:
      // For A-H-H-B: origin = user input origin and destination = user input destination
      // For A-H-B: origin = user input origin OR destination = user input destination
      // For A-B and A-A: include all
      query = query
        .or(`and(origin.eq.${userOrigin},destination.eq.${userDestination}),and(origin.eq.${userOrigin},destination.neq.${userDestination}),and(origin.neq.${userOrigin},destination.eq.${userDestination})`);
      break;
      
    default:
      // For maxStop >= 3, include all path types (no additional filtering)
      break;
  }

  const { data, error } = await query;
  
  if (error) {
    console.error('Error fetching paths with maxStop filter:', error);
    return [];
  }
  
  if (!data) return [];
  
  // Apply additional filtering in memory for complex cases
  const paths = data as unknown as Path[];
  return filterPathsByMaxStopInMemory(paths, maxStop, userOrigin, userDestination);
}

/**
 * Filter paths in memory for complex maxStop conditions
 * @param paths - Array of paths to filter
 * @param maxStop - Maximum number of stops
 * @param userOrigin - User input origin
 * @param userDestination - User input destination
 * @returns Filtered paths
 */
function filterPathsByMaxStopInMemory(
  paths: Path[],
  maxStop: number,
  userOrigin: string,
  userDestination: string
): Path[] {
  return paths.filter(path => {
    // Determine path type based on h1 and h2 values
    const hasH1 = path.h1 && path.h1.trim() !== '';
    const hasH2 = path.h2 && path.h2.trim() !== '';
    
    let pathType: 'A-B' | 'A-H-B' | 'A-H-H-B' | 'A-A';
    if (!hasH1 && !hasH2) {
      pathType = 'A-B';
    } else if (hasH1 && !hasH2) {
      pathType = 'A-H-B';
    } else if (hasH1 && hasH2) {
      pathType = 'A-H-H-B';
    } else {
      pathType = 'A-B';
    }
    
    // Apply filtering based on maxStop
    switch (maxStop) {
      case 0:
        // Only A-B and A-A with origin = user input origin and destination = user input destination
        if (pathType === 'A-H-B' || pathType === 'A-H-H-B') {
          return false;
        }
        return path.origin === userOrigin && path.destination === userDestination;
        
      case 1:
        // Don't include A-H-H-B
        if (pathType === 'A-H-H-B') {
          return false;
        }
        
        // For A-H-B: origin = user input origin and destination = user input destination
        if (pathType === 'A-H-B') {
          return path.origin === userOrigin && path.destination === userDestination;
        }
        
        // For A-B and A-A: origin = user input origin OR destination = user input destination
        if (pathType === 'A-B' || pathType === 'A-A') {
          return path.origin === userOrigin || path.destination === userDestination;
        }
        
        return false;
        
      case 2:
        // For A-H-H-B: origin = user input origin and destination = user input destination
        if (pathType === 'A-H-H-B') {
          return path.origin === userOrigin && path.destination === userDestination;
        }
        
        // For A-H-B: origin = user input origin OR destination = user input destination
        if (pathType === 'A-H-B') {
          return path.origin === userOrigin || path.destination === userDestination;
        }
        
        // For A-B and A-A: include all
        if (pathType === 'A-B' || pathType === 'A-A') {
          return true;
        }
        
        return false;
        
      default:
        // For maxStop >= 3, include all path types
        return true;
    }
  });
} 