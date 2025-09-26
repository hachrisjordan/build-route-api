import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SupabaseClient } from '@/lib/route-helpers';
import { getSupabaseConfig } from '@/lib/env-utils';
import { ValidationService, ValidatedRouteInput } from './validation';
import { ErrorHandlerService } from './error-handler';
import { APIPerformanceMonitor } from './performance';
import { RoutePathCacheService, createRoutePathCache } from './cache';
import { BatchProcessorService } from './batch-processor';
import { RouteCalculatorService } from './calculator';
import { RouteGroupingService } from './grouping';
import { ResponseFormatterService } from './response-formatter';
import { FullRoutePathResult } from '@/types/route';

/**
 * Route orchestration result
 */
export interface RouteOrchestrationResult {
  routes: FullRoutePathResult[];
  queryParamsArr: string[];
  metadata: any;
  processingTime: number;
}

/**
 * Route orchestration context
 */
export interface RouteOrchestrationContext {
  supabase: SupabaseClient;
  cacheService: RoutePathCacheService;
  performanceMonitor: APIPerformanceMonitor;
  validatedData: ValidatedRouteInput;
}

/**
 * Service for orchestrating the complete route path creation process
 */
export class RouteOrchestratorService {
  readonly serviceName = 'RouteOrchestratorService';
  readonly version = '1.0.0';

  /**
   * Main orchestration method for creating full route paths
   */
  static async createFullRoutePaths(req: NextRequest): Promise<NextResponse> {
    const performanceMonitor = new APIPerformanceMonitor();
    let context: RouteOrchestrationContext | null = null;

    try {
      // Step 1: Validate input
      context = await this.initializeContext(req, performanceMonitor);
      if (!context) {
        const error = new Error('Failed to initialize request context');
        return ErrorHandlerService.createErrorResponse(
          error,
          req,
          { step: 'initialization' }
        );
      }

      // Step 2: Process batch data
      const batchResult = await this.processBatchData(context, performanceMonitor);

      // Step 3: Calculate routes for all pairs
      const routeResults = await this.calculateRoutesForAllPairs(context, performanceMonitor);

      // Step 4: Process and format final response
      const result = await this.processFinalResponse(
        context,
        routeResults,
        batchResult,
        performanceMonitor
      );

      performanceMonitor.logAPISummary();
      return ResponseFormatterService.formatSuccessResponse(
        result.routes,
        result.queryParamsArr,
        result.metadata
      );

    } catch (error) {
      return ErrorHandlerService.createErrorResponse(
        error as Error,
        req,
        {
          processingTime: performanceMonitor.getTotalTime(),
          route: 'create-full-route-path',
          ...(context && {
            origin: context.validatedData.origin,
            destination: context.validatedData.destination,
            maxStop: context.validatedData.maxStop
          })
        }
      );
    }
  }

  /**
   * Initialize the orchestration context
   */
  private static async initializeContext(
    req: NextRequest,
    performanceMonitor: APIPerformanceMonitor
  ): Promise<RouteOrchestrationContext | null> {
    try {
      // Validate input
      performanceMonitor.startAPI('input-validation');
      const validationResult = await ValidationService.validateRoutePathRequest(req);
      if (!validationResult.success) {
        return null;
      }

      const validatedData = validationResult.data!;
      performanceMonitor.endAPI('input-validation');

      console.log(`Processing ${validatedData.originList.length} origins × ${validatedData.destinationList.length} destinations = ${validatedData.pairsCount} pairs`);

      // Create Supabase client
      performanceMonitor.startAPI('supabase-client-creation');
      const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getSupabaseConfig();
      const supabase: SupabaseClient = createClient(supabaseUrl!, supabaseKey!);
      performanceMonitor.endAPI('supabase-client-creation');

      // Create cache service
      const cache = createRoutePathCache();
      const cacheService = new RoutePathCacheService(cache);

      return {
        supabase,
        cacheService,
        performanceMonitor,
        validatedData
      };
    } catch (error) {
      console.error('Failed to initialize context:', error);
      return null;
    }
  }

  /**
   * Process batch data for all origin-destination pairs
   */
  private static async processBatchData(
    context: RouteOrchestrationContext,
    performanceMonitor: APIPerformanceMonitor
  ): Promise<any> {
    const batchResult = await BatchProcessorService.processBatchData(
      context.supabase,
      context.validatedData.originList,
      context.validatedData.destinationList,
      context.validatedData.maxStop,
      context.cacheService,
      performanceMonitor
    );

    console.log(`Batch processing completed: ${batchResult.airportsFetched} airports, ${batchResult.regionCombinations.size} region combinations, ${Object.keys(batchResult.sharedPathsData).length} shared path groups`);

    return batchResult;
  }

  /**
   * Calculate routes for all origin-destination pairs
   */
  private static async calculateRoutesForAllPairs(
    context: RouteOrchestrationContext,
    performanceMonitor: APIPerformanceMonitor
  ): Promise<{
    allRoutes: FullRoutePathResult[];
    anyError: Error | null;
  }> {
    performanceMonitor.startAPI('pair-processing');

    const { originList, destinationList, maxStop } = context.validatedData;
    const pairPromises = [];

    // Create route calculation promises for all pairs
    for (const origin of originList) {
      for (const destination of destinationList) {
        const sharedPathsKey = BatchProcessorService.calculateSharedPathKey(
          origin,
          destination,
          context.cacheService
        );

        const calculator = new RouteCalculatorService();
        pairPromises.push(
          calculator.calculateFullRoutePath({
            origin,
            destination,
            maxStop,
            supabase: context.supabase,
            cacheService: context.cacheService,
            sharedPathsKey
          })
        );
      }
    }

    // Execute all route calculations in parallel
    const pairResults = await Promise.allSettled(pairPromises);
    performanceMonitor.endAPI('pair-processing', { 
      pairsCount: originList.length * destinationList.length 
    });

    // Process results
    const allRoutes: FullRoutePathResult[] = [];
    let anyError: Error | null = null;

    for (const result of pairResults) {
      if (result.status === 'fulfilled') {
        allRoutes.push(...result.value.routes);
      } else {
        console.error('Error processing pair:', result.reason);
        if (!anyError) {
          anyError = result.reason;
        }
      }
    }

    console.log(`Total routes found: ${allRoutes.length}`);
    console.log(`Intra route cache size: ${context.cacheService.cache.intraRoute.size}`);
    console.log(`Path cache size: ${context.cacheService.cache.path.size}`);

      // Check if no routes were found
      if (allRoutes.length === 0) {
        const error = ErrorHandlerService.createNoRoutesFoundError(
          'any',
          'any',
          0
        );
        throw error;
      }

    return { allRoutes, anyError };
  }

  /**
   * Process final response with grouping and formatting
   */
  private static async processFinalResponse(
    context: RouteOrchestrationContext,
    routeResults: { allRoutes: FullRoutePathResult[]; anyError: Error | null },
    batchResult: any,
    performanceMonitor: APIPerformanceMonitor
  ): Promise<RouteOrchestrationResult> {
    performanceMonitor.startAPI('final-grouping');

    const { allRoutes } = routeResults;
    const { destinationList } = context.validatedData;

    // Group routes using the grouping service
    const groupingResult = this.groupRoutes(allRoutes, destinationList);
    
    // Generate query parameters
    const queryParamsArr = ResponseFormatterService.formatQueryParams(groupingResult.finalGroups);

    performanceMonitor.endAPI('final-grouping', {
      groupsCount: groupingResult.finalGroups.length,
      queryParamsCount: queryParamsArr.length
    });

    // Create response metadata
    const metadata = ResponseFormatterService.createMetadata({
      totalRoutes: allRoutes.length,
      queryParamsCount: queryParamsArr.length,
      processingTime: performanceMonitor.getTotalTime(),
      cacheStats: ResponseFormatterService.createCacheStats(context.cacheService.cache),
      performanceStats: ResponseFormatterService.createPerformanceStats(performanceMonitor.getTimings())
    });

    // Process and format routes
    const processedRoutes = ResponseFormatterService.processRoutes(allRoutes);

    return {
      routes: processedRoutes,
      queryParamsArr,
      metadata,
      processingTime: performanceMonitor.getTotalTime()
    };
  }

  /**
   * Group routes using the grouping service
   */
  private static groupRoutes(
    allRoutes: FullRoutePathResult[],
    destinationList: string[]
  ): {
    finalGroups: Array<{ keys: string[]; dests: string[] }>;
  } {
    // Group segments by departure airport (except those ending at any input destination)
    const segmentMap: Record<string, Set<string>> = {};
    // Group segments by destination (for those ending at input destination)
    const destMap: Record<string, Set<string>> = {};

    for (const route of allRoutes) {
      const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D]
        .filter((c): c is string => !!c);

      for (let i = 0; i < codes.length - 1; i++) {
        const from = codes[i]!;
        const to = codes[i + 1]!;

        if (destinationList.includes(to)) {
          if (!destMap[to]) destMap[to] = new Set();
          destMap[to].add(from);
        } else {
          if (!segmentMap[from]) segmentMap[from] = new Set();
          segmentMap[from].add(to);
        }
      }
    }

    // Use the grouping service for advanced merging
    const groupingService = new RouteGroupingService();
    const { groups, queryParams } = groupingService.processRouteGrouping(segmentMap, destMap);

    return {
      finalGroups: groups
    };
  }

  /**
   * Get orchestration statistics
   */
  static getOrchestrationStats(context: RouteOrchestrationContext): {
    totalPairs: number;
    cacheStats: any;
    performanceStats: any;
  } {
    const { validatedData, cacheService, performanceMonitor } = context;
    
    return {
      totalPairs: validatedData.pairsCount,
      cacheStats: {
        airportCacheSize: cacheService.cache.airport.size,
        intraRouteCacheSize: cacheService.cache.intraRoute.size,
        pathCacheSize: cacheService.cache.path.size,
        sharedPathsCacheSize: cacheService.cache.sharedPaths.size,
        globalIntraRoutesCacheSize: cacheService.cache.globalIntraRoutes.size
      },
      performanceStats: performanceMonitor.getTimings()
    };
  }

  /**
   * Validate orchestration context
   */
  static validateContext(context: RouteOrchestrationContext): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!context.supabase) {
      errors.push('Supabase client is not initialized');
    }

    if (!context.cacheService) {
      errors.push('Cache service is not initialized');
    }

    if (!context.performanceMonitor) {
      errors.push('Performance monitor is not initialized');
    }

    if (!context.validatedData) {
      errors.push('Validated data is not available');
    }

    if (context.validatedData && context.validatedData.pairsCount === 0) {
      errors.push('No origin-destination pairs to process');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

/**
 * Utility functions for route orchestration
 */
export const RouteOrchestratorUtils = {
  /**
   * Check if orchestration should use batch processing
   */
  shouldUseBatchProcessing(pairsCount: number): boolean {
    return pairsCount > 1;
  },

  /**
   * Estimate total processing time
   */
  estimateProcessingTime(pairsCount: number): number {
    const baseTime = 200; // Base time in ms
    const timePerPair = 100; // Additional time per pair
    return baseTime + (pairsCount * timePerPair);
  },

  /**
   * Create progress callback for long-running operations
   */
  createProgressCallback(totalSteps: number): (step: number, message: string) => void {
    let currentStep = 0;
    return (step: number, message: string) => {
      currentStep = step;
      const progress = Math.round((step / totalSteps) * 100);
      console.log(`Route Orchestration Progress: ${progress}% - ${message}`);
    };
  }
};
