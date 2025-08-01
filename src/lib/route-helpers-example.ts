import { createClient } from '@supabase/supabase-js';
import { fetchPaths, fetchPathsOptimized, SupabaseClient } from './route-helpers';

// Example usage of the new batching functionality
export async function exampleUsage() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Example 1: Basic batching with default settings
  console.log('=== Example 1: Basic Batching ===');
  const paths1 = await fetchPaths(
    supabase,
    'US', // originRegion
    'EU', // destinationRegion
    5000, // maxDistance
    10000, // batchSize
    5 // maxConcurrentBatches
  );
  console.log(`Fetched ${paths1.length} paths with basic batching`);

  // Example 2: Optimized fetching for large datasets
  console.log('=== Example 2: Optimized Fetching ===');
  const paths2 = await fetchPathsOptimized(
    supabase,
    'US', // originRegion
    'EU', // destinationRegion
    5000, // maxDistance
    {
      maxMemoryUsage: 512, // 512MB memory limit
      enableStreaming: true, // Enable streaming for large datasets
      customBatchSize: 10000, // Custom batch size
      customConcurrency: 5 // Custom concurrency
    }
  );
  console.log(`Fetched ${paths2.length} paths with optimized fetching`);

  // Example 3: Handling very large datasets (72,000+ records)
  console.log('=== Example 3: Large Dataset Handling ===');
  const paths3 = await fetchPathsOptimized(
    supabase,
    'US', // originRegion
    'AS', // destinationRegion
    10000, // maxDistance
    {
      maxMemoryUsage: 1024, // 1GB memory limit for large datasets
      enableStreaming: true, // Enable streaming
      customBatchSize: 5000, // Smaller batches for very large datasets
      customConcurrency: 3 // Lower concurrency to prevent overwhelming DB
    }
  );
  console.log(`Fetched ${paths3.length} paths from large dataset`);

  // Example 4: Memory-efficient processing
  console.log('=== Example 4: Memory-Efficient Processing ===');
  const paths4 = await fetchPathsOptimized(
    supabase,
    'US', // originRegion
    'AF', // destinationRegion
    8000, // maxDistance
    {
      maxMemoryUsage: 256, // 256MB memory limit
      enableStreaming: true, // Enable streaming
      customBatchSize: 2500, // Smaller batches
      customConcurrency: 2 // Lower concurrency
    }
  );
  console.log(`Fetched ${paths4.length} paths with memory-efficient processing`);

  return {
    basicBatching: paths1.length,
    optimizedFetching: paths2.length,
    largeDataset: paths3.length,
    memoryEfficient: paths4.length
  };
}

// Example of how to handle different dataset sizes
export async function handleDatasetBySize(supabase: SupabaseClient, originRegion: string, destinationRegion: string, maxDistance: number) {
  // First, get the count to determine the best approach
  const { count } = await supabase
    .from('path')
    .select('*', { count: 'exact', head: true })
    .eq('originRegion', originRegion)
    .eq('destinationRegion', destinationRegion)
    .lte('totalDistance', maxDistance);

  if (!count) return [];

  console.log(`Dataset size: ${count} records`);

  // Choose strategy based on dataset size
  if (count <= 10000) {
    // Small dataset - use basic batching
    return await fetchPaths(supabase, originRegion, destinationRegion, maxDistance, 10000, 5);
  } else if (count <= 50000) {
    // Medium dataset - use optimized fetching
    return await fetchPathsOptimized(supabase, originRegion, destinationRegion, maxDistance, {
      maxMemoryUsage: 512,
      enableStreaming: false,
      customBatchSize: 5000,
      customConcurrency: 5
    });
  } else if (count <= 100000) {
    // Large dataset - use streaming
    return await fetchPathsOptimized(supabase, originRegion, destinationRegion, maxDistance, {
      maxMemoryUsage: 1024,
      enableStreaming: true,
      customBatchSize: 2500,
      customConcurrency: 3
    });
  } else {
    // Very large dataset - conservative approach
    return await fetchPathsOptimized(supabase, originRegion, destinationRegion, maxDistance, {
      maxMemoryUsage: 2048,
      enableStreaming: true,
      customBatchSize: 1000,
      customConcurrency: 2
    });
  }
}

// Performance monitoring wrapper
export async function fetchPathsWithMonitoring(
  supabase: SupabaseClient,
  originRegion: string,
  destinationRegion: string,
  maxDistance: number,
  options: {
    maxMemoryUsage?: number;
    enableStreaming?: boolean;
    customBatchSize?: number;
    customConcurrency?: number;
  } = {}
) {
  const startTime = Date.now();
  const startMemory = process.memoryUsage();

  try {
    const paths = await fetchPathsOptimized(supabase, originRegion, destinationRegion, maxDistance, options);
    
    const endTime = Date.now();
    const endMemory = process.memoryUsage();
    
    console.log(`Performance Metrics:`);
    console.log(`- Total time: ${endTime - startTime}ms`);
    console.log(`- Records fetched: ${paths.length}`);
    console.log(`- Memory used: ${(endMemory.heapUsed - startMemory.heapUsed) / 1024 / 1024}MB`);
    console.log(`- Records per second: ${Math.round(paths.length / ((endTime - startTime) / 1000))}`);
    
    return paths;
  } catch (error) {
    console.error('Error fetching paths:', error);
    throw error;
  }
} 