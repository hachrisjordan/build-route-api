import { SupabaseClient } from '@/lib/route-helpers';
import { Airport, Path, IntraRoute } from '@/types/route';
import { getHaversineDistance, batchFetchAirportsByIata, batchFetchPathsForRegionCombinations, globalBatchFetchIntraRoutes } from '@/lib/route-helpers';
import { RoutePathCacheService } from './cache';
import { APIPerformanceMonitor } from './performance';

/**
 * Region combination data structure
 */
export interface RegionCombination {
  originRegion: string;
  destinationRegion: string;
  maxDistance: number;
  pairs: Array<{ origin: string; destination: string; maxStop: number }>;
}

/**
 * Batch processing result
 */
export interface BatchProcessingResult {
  airportsFetched: number;
  regionCombinations: Map<string, RegionCombination>;
  sharedPathsData: Record<string, Path[]>;
  intraRoutePairs: Array<{ origin: string; destination: string }>;
  globalIntraRoutesData: Record<string, IntraRoute[]>;
  processingStats: {
    airportsTime: number;
    regionAnalysisTime: number;
    pathsFetchTime: number;
    intraRoutesAnalysisTime: number;
    intraRoutesFetchTime: number;
  };
}

/**
 * Service for handling batch processing operations
 */
export class BatchProcessorService {
  readonly serviceName = 'BatchProcessorService';
  readonly version = '1.0.0';

  /**
   * Pre-fetch all airports for the given origin and destination lists
   */
  static async preFetchAirports(
    supabase: SupabaseClient,
    cacheService: RoutePathCacheService,
    originList: string[],
    destinationList: string[],
    performanceMonitor: APIPerformanceMonitor
  ): Promise<number> {
    performanceMonitor.startAPI('pre-fetch-airports');
    
    const allAirportCodes = [...new Set([...originList, ...destinationList])];
    const airportsToFetch = allAirportCodes.filter(code => !cacheService.cache.airport.has(code));

    let airportsFetched = 0;
    if (airportsToFetch.length > 0) {
      const airportsMap = await batchFetchAirportsByIata(supabase, airportsToFetch);
      Object.entries(airportsMap).forEach(([code, airport]) => {
        if (airport) {
          cacheService.cache.airport.set(code, airport);
          airportsFetched++;
        }
      });
    }

    performanceMonitor.endAPI('pre-fetch-airports', { 
      cacheSize: cacheService.cache.airport.size,
      airportsFetched
    });

    return airportsFetched;
  }

  /**
   * Analyze and group pairs by region combinations for batch fetching
   */
  static analyzeRegionCombinations(
    originList: string[],
    destinationList: string[],
    maxStop: number,
    cacheService: RoutePathCacheService,
    performanceMonitor: APIPerformanceMonitor
  ): Map<string, RegionCombination> {
    performanceMonitor.startAPI('region-analysis');
    
    const regionCombinations = new Map<string, RegionCombination>();

    // Analyze all pairs to determine unique region combinations
    for (const origin of originList) {
      for (const destination of destinationList) {
        const originAirport = cacheService.cache.airport.get(origin);
        const destinationAirport = cacheService.cache.airport.get(destination);

        if (originAirport && destinationAirport) {
          const directDistance = getHaversineDistance(
            originAirport.latitude,
            originAirport.longitude,
            destinationAirport.latitude,
            destinationAirport.longitude
          );
          const maxDistance = 2 * directDistance;
          const key = `${originAirport.region}-${destinationAirport.region}-${Math.ceil(maxDistance)}`;

          if (!regionCombinations.has(key)) {
            regionCombinations.set(key, {
              originRegion: originAirport.region,
              destinationRegion: destinationAirport.region,
              maxDistance,
              pairs: [],
            });
          }
          
          regionCombinations.get(key)!.pairs.push({
            origin,
            destination,
            maxStop
          });
        }
      }
    }

    performanceMonitor.endAPI('region-analysis', { 
      combinationsCount: regionCombinations.size 
    });

    return regionCombinations;
  }

  /**
   * Batch fetch paths for all region combinations
   */
  static async batchFetchPaths(
    supabase: SupabaseClient,
    regionCombinations: Map<string, RegionCombination>,
    cacheService: RoutePathCacheService,
    performanceMonitor: APIPerformanceMonitor
  ): Promise<Record<string, Path[]>> {
    performanceMonitor.startAPI('batch-path-fetch');
    
    const regionCombinationArray = Array.from(regionCombinations.values());
    let sharedPathsData: Record<string, Path[]> = {};

    if (regionCombinationArray.length > 0) {
      sharedPathsData = await batchFetchPathsForRegionCombinations(supabase, regionCombinationArray);
      
      // Store in shared cache
      Object.entries(sharedPathsData).forEach(([key, paths]) => {
        cacheService.setSharedPaths(key, paths);
      });
    }

    performanceMonitor.endAPI('batch-path-fetch');
    
    return sharedPathsData;
  }

  /**
   * Pre-analyze and batch fetch all intra routes globally
   */
  static async batchFetchIntraRoutes(
    supabase: SupabaseClient,
    originList: string[],
    destinationList: string[],
    maxStop: number,
    cacheService: RoutePathCacheService,
    performanceMonitor: APIPerformanceMonitor
  ): Promise<{
    intraRoutePairs: Array<{ origin: string; destination: string }>;
    globalIntraRoutesData: Record<string, IntraRoute[]>;
  }> {
    performanceMonitor.startAPI('intra-routes-pre-analysis');
    
    const allIntraRoutePairs = await cacheService.preAnalyzeIntraRoutePairs(
      supabase, 
      originList, 
      destinationList, 
      maxStop
    );
    
    performanceMonitor.endAPI('intra-routes-pre-analysis', { 
      pairsCount: allIntraRoutePairs.length 
    });

    let globalIntraRoutesData: Record<string, IntraRoute[]> = {};

    if (allIntraRoutePairs.length > 0) {
      performanceMonitor.startAPI('global-intra-routes-fetch');
      
      globalIntraRoutesData = await globalBatchFetchIntraRoutes(supabase, allIntraRoutePairs);
      
      // Store in global cache
      Object.entries(globalIntraRoutesData).forEach(([pair, routes]) => {
        cacheService.setGlobalIntraRoutes(pair, routes);
      });

      performanceMonitor.endAPI('global-intra-routes-fetch', {
        routesCount: Object.keys(globalIntraRoutesData).length,
        cacheSize: cacheService.cache.globalIntraRoutes.size
      });
    }

    return {
      intraRoutePairs: allIntraRoutePairs,
      globalIntraRoutesData
    };
  }

  /**
   * Complete batch processing pipeline
   */
  static async processBatchData(
    supabase: SupabaseClient,
    originList: string[],
    destinationList: string[],
    maxStop: number,
    cacheService: RoutePathCacheService,
    performanceMonitor: APIPerformanceMonitor
  ): Promise<BatchProcessingResult> {
    const startTime = performance.now();
    
    // Step 1: Pre-fetch all airports
    const airportsFetched = await this.preFetchAirports(
      supabase,
      cacheService,
      originList,
      destinationList,
      performanceMonitor
    );

    // Step 2: Analyze region combinations
    const regionCombinations = this.analyzeRegionCombinations(
      originList,
      destinationList,
      maxStop,
      cacheService,
      performanceMonitor
    );

    // Step 3: Batch fetch paths for region combinations
    const sharedPathsData = await this.batchFetchPaths(
      supabase,
      regionCombinations,
      cacheService,
      performanceMonitor
    );

    // Step 4: Pre-analyze and batch fetch intra routes
    const { intraRoutePairs, globalIntraRoutesData } = await this.batchFetchIntraRoutes(
      supabase,
      originList,
      destinationList,
      maxStop,
      cacheService,
      performanceMonitor
    );

    const processingStats = {
      airportsTime: performanceMonitor.getDuration('pre-fetch-airports') || 0,
      regionAnalysisTime: performanceMonitor.getDuration('region-analysis') || 0,
      pathsFetchTime: performanceMonitor.getDuration('batch-path-fetch') || 0,
      intraRoutesAnalysisTime: performanceMonitor.getDuration('intra-routes-pre-analysis') || 0,
      intraRoutesFetchTime: performanceMonitor.getDuration('global-intra-routes-fetch') || 0,
    };

    return {
      airportsFetched,
      regionCombinations,
      sharedPathsData,
      intraRoutePairs,
      globalIntraRoutesData,
      processingStats
    };
  }

  /**
   * Calculate shared path key for a given origin-destination pair
   */
  static calculateSharedPathKey(
    origin: string,
    destination: string,
    cacheService: RoutePathCacheService
  ): string | undefined {
    const originAirport = cacheService.cache.airport.get(origin);
    const destinationAirport = cacheService.cache.airport.get(destination);

    if (!originAirport || !destinationAirport) {
      return undefined;
    }

    const directDistance = getHaversineDistance(
      originAirport.latitude,
      originAirport.longitude,
      destinationAirport.latitude,
      destinationAirport.longitude
    );
    const maxDistance = 2 * directDistance;
    
    return `${originAirport.region}-${destinationAirport.region}-${Math.ceil(maxDistance)}`;
  }

  /**
   * Get batch processing statistics
   */
  static getBatchProcessingStats(result: BatchProcessingResult): {
    totalAirports: number;
    regionCombinationsCount: number;
    sharedPathsCount: number;
    intraRoutePairsCount: number;
    globalIntraRoutesCount: number;
    totalProcessingTime: number;
    efficiency: {
      airportsPerMs: number;
      pathsPerMs: number;
      intraRoutesPerMs: number;
    };
  } {
    const totalProcessingTime = Object.values(result.processingStats).reduce((sum, time) => sum + time, 0);
    const sharedPathsCount = Object.values(result.sharedPathsData).reduce((sum, paths) => sum + paths.length, 0);
    const globalIntraRoutesCount = Object.values(result.globalIntraRoutesData).reduce((sum, routes) => sum + routes.length, 0);

    return {
      totalAirports: result.airportsFetched,
      regionCombinationsCount: result.regionCombinations.size,
      sharedPathsCount,
      intraRoutePairsCount: result.intraRoutePairs.length,
      globalIntraRoutesCount,
      totalProcessingTime,
      efficiency: {
        airportsPerMs: result.airportsFetched / (result.processingStats.airportsTime || 1),
        pathsPerMs: sharedPathsCount / (result.processingStats.pathsFetchTime || 1),
        intraRoutesPerMs: globalIntraRoutesCount / (result.processingStats.intraRoutesFetchTime || 1),
      }
    };
  }

  /**
   * Validate batch processing results
   */
  static validateBatchProcessingResult(result: BatchProcessingResult): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate airports were fetched
    if (result.airportsFetched === 0) {
      errors.push('No airports were fetched during batch processing');
    }

    // Validate region combinations
    if (result.regionCombinations.size === 0) {
      warnings.push('No region combinations found - this may indicate missing airport data');
    }

    // Validate shared paths data
    const totalSharedPaths = Object.values(result.sharedPathsData).reduce((sum, paths) => sum + paths.length, 0);
    if (totalSharedPaths === 0) {
      warnings.push('No shared paths were fetched - this may indicate no valid routes exist');
    }

    // Validate intra routes data
    const totalIntraRoutes = Object.values(result.globalIntraRoutesData).reduce((sum, routes) => sum + routes.length, 0);
    if (totalIntraRoutes === 0) {
      warnings.push('No intra routes were fetched - this may limit route calculation options');
    }

    // Validate processing times
    const totalTime = Object.values(result.processingStats).reduce((sum, time) => sum + time, 0);
    if (totalTime === 0) {
      errors.push('Processing times are not available - performance monitoring may be disabled');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}

/**
 * Utility functions for batch processing
 */
export const BatchProcessorUtils = {
  /**
   * Check if batch processing is needed
   */
  shouldUseBatchProcessing(originList: string[], destinationList: string[]): boolean {
    const totalPairs = originList.length * destinationList.length;
    return totalPairs > 1; // Use batch processing for multiple pairs
  },

  /**
   * Estimate batch processing time based on input size
   */
  estimateProcessingTime(originList: string[], destinationList: string[]): number {
    const totalPairs = originList.length * destinationList.length;
    const baseTime = 100; // Base time in ms
    const timePerPair = 50; // Additional time per pair
    return baseTime + (totalPairs * timePerPair);
  },

  /**
   * Get optimal batch size for processing
   */
  getOptimalBatchSize(totalItems: number): number {
    if (totalItems <= 10) return totalItems;
    if (totalItems <= 50) return 10;
    if (totalItems <= 100) return 20;
    return 25; // Max batch size
  },

  /**
   * Create batch processing progress callback
   */
  createProgressCallback(totalSteps: number): (step: number, message: string) => void {
    let currentStep = 0;
    return (step: number, message: string) => {
      currentStep = step;
      const progress = Math.round((step / totalSteps) * 100);
      console.log(`Batch Processing Progress: ${progress}% - ${message}`);
    };
  }
};
