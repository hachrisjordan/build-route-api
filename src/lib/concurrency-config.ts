/**
 * Concurrency Configuration
 * 
 * This file centralizes all concurrency settings for the application.
 * Adjust these values based on your server capacity and API rate limits.
 */

export const CONCURRENCY_CONFIG = {
  // Availability requests concurrency - optimized for 6 vCPUs
  AVAILABILITY_CONCURRENT_REQUESTS: 50, // Increased for faster parallel processing
  
  // Pagination settings - optimized for speed
  PAGINATION_MAX_PAGES: 20, // Increased for better data coverage
  PAGINATION_SEQUENTIAL: false, // Changed back to parallel for speed
  PAGINATION_CONCURRENT_REQUESTS: 8, // New setting for pagination concurrency
  
  // Database batching settings - optimized for 12GB RAM
  DATABASE_BATCH_SIZE: 20000, // Increased batch size for better throughput
  DATABASE_CONCURRENT_BATCHES: 12, // Increased for 6 vCPUs with hyperthreading
  
  // Memory limits - optimized for 12GB RAM
  MAX_MEMORY_USAGE_MB: 8192, // 8GB limit (leaving 4GB for system)
  
  // Rate limiting considerations
  SEATS_AERO_RATE_LIMIT: {
    REQUESTS_PER_MINUTE: 300, // Increased for higher capacity
    BURST_LIMIT: 150, // Increased burst limit
  },
  
  // Performance monitoring
  ENABLE_PERFORMANCE_MONITORING: true,
  LOG_CONCURRENCY_METRICS: true,
  
  // New optimization settings
  OPTIMIZE_ITINERARY_COMPOSITION: true,
  ENABLE_EARLY_FILTERING: true,
  CACHE_INTERMEDIATE_RESULTS: true,
  PARALLEL_ROUTE_PROCESSING: true,
} as const;

/**
 * Get optimal concurrency based on dataset size - optimized for 6 vCPUs
 */
export function getOptimalConcurrency(datasetSize: number): number {
  if (datasetSize <= 1000) return 10; // 2 per vCPU
  if (datasetSize <= 5000) return 18; // 3 per vCPU
  if (datasetSize <= 10000) return 24; // 4 per vCPU
  if (datasetSize <= 50000) return 30; // 5 per vCPU
  return 36; // 6 per vCPU for very large datasets
}

/**
 * Get optimal batch size based on dataset size - optimized for 12GB RAM
 */
export function getOptimalBatchSize(datasetSize: number): number {
  if (datasetSize <= 10000) return 15000; // Increased for more RAM
  if (datasetSize <= 50000) return 10000; // Increased for more RAM
  if (datasetSize <= 100000) return 5000; // Increased for more RAM
  if (datasetSize <= 500000) return 2500; // Increased for more RAM
  return 1000; // Increased for very large datasets
}

/**
 * Calculate safe concurrency based on rate limits
 */
export function getSafeConcurrency(
  baseConcurrency: number = CONCURRENCY_CONFIG.AVAILABILITY_CONCURRENT_REQUESTS,
  rateLimitRemaining?: number
): number {
  if (rateLimitRemaining === undefined) {
    return baseConcurrency;
  }
  
  // Use 80% of remaining rate limit to be safe
  const safeLimit = Math.floor(rateLimitRemaining * 0.8);
  return Math.min(baseConcurrency, safeLimit);
}

/**
 * Performance monitoring utilities
 */
export const PERFORMANCE_MONITORING = {
  startTime: 0,
  requestCount: 0,
  errorCount: 0,
  
  start() {
    this.startTime = Date.now();
    this.requestCount = 0;
    this.errorCount = 0;
  },
  
  incrementRequest() {
    this.requestCount++;
  },
  
  incrementError() {
    this.errorCount++;
  },
  
  getMetrics() {
    const duration = Date.now() - this.startTime;
    return {
      duration,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      requestsPerSecond: this.requestCount / (duration / 1000),
      errorRate: this.errorCount / this.requestCount,
    };
  },
  
  logMetrics() {
    if (!CONCURRENCY_CONFIG.LOG_CONCURRENCY_METRICS) return;
    
    const metrics = this.getMetrics();
    console.log('=== Concurrency Performance Metrics ===');
    console.log(`Duration: ${metrics.duration}ms`);
    console.log(`Requests: ${metrics.requestCount}`);
    console.log(`Errors: ${metrics.errorCount}`);
    console.log(`Requests/sec: ${metrics.requestsPerSecond.toFixed(2)}`);
    console.log(`Error rate: ${(metrics.errorRate * 100).toFixed(2)}%`);
    console.log('=====================================');
  },
}; 