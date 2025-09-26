import { NextResponse } from 'next/server';
import { FullRoutePathResult } from '@/types/route';

/**
 * API response data structure
 */
export interface RoutePathResponse {
  routes: FullRoutePathResult[];
  queryParamsArr: string[];
  metadata?: ResponseMetadata;
}

/**
 * Response metadata for additional information
 */
export interface ResponseMetadata {
  totalRoutes: number;
  queryParamsCount: number;
  processingTime?: number;
  cacheStats?: CacheStats;
  performanceStats?: PerformanceStats;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  airportCacheSize: number;
  intraRouteCacheSize: number;
  pathCacheSize: number;
  sharedPathsCacheSize: number;
  globalIntraRoutesCacheSize: number;
}

/**
 * Performance statistics
 */
export interface PerformanceStats {
  totalTime: number;
  validationTime?: number;
  dataFetchTime?: number;
  processingTime?: number;
  groupingTime?: number;
}

/**
 * Error response structure
 */
export interface ErrorResponse {
  error: string;
  details?: any;
  code?: string;
  timestamp?: string;
}

/**
 * Service for formatting API responses
 */
export class ResponseFormatterService {
  readonly serviceName = 'ResponseFormatterService';
  readonly version = '1.0.0';

  /**
   * Format successful route path response
   */
  static formatSuccessResponse(
    routes: FullRoutePathResult[],
    queryParamsArr: string[],
    metadata?: ResponseMetadata
  ): NextResponse<RoutePathResponse> {
    const response: RoutePathResponse = {
      routes,
      queryParamsArr,
      ...(metadata && { metadata })
    };

    return NextResponse.json(response, { 
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
  }

  /**
   * Format error response
   */
  static formatErrorResponse(
    error: string,
    statusCode: number = 500,
    details?: any,
    code?: string
  ): NextResponse<ErrorResponse> {
    const response: ErrorResponse = {
      error,
      ...(details && { details }),
      ...(code && { code }),
      timestamp: new Date().toISOString()
    };

    return NextResponse.json(response, { 
      status: statusCode,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });
  }

  /**
   * Format validation error response
   */
  static formatValidationErrorResponse(
    message: string,
    validationErrors: any[]
  ): NextResponse<ErrorResponse> {
    return this.formatErrorResponse(
      message,
      400,
      { validationErrors },
      'VALIDATION_ERROR'
    );
  }

  /**
   * Format not found error response
   */
  static formatNotFoundErrorResponse(
    message: string,
    context?: Record<string, any>
  ): NextResponse<ErrorResponse> {
    return this.formatErrorResponse(
      message,
      404,
      context,
      'NOT_FOUND'
    );
  }

  /**
   * Format internal server error response
   */
  static formatInternalErrorResponse(
    message: string,
    context?: Record<string, any>
  ): NextResponse<ErrorResponse> {
    return this.formatErrorResponse(
      message,
      500,
      context,
      'INTERNAL_ERROR'
    );
  }

  /**
   * Format no routes found response
   */
  static formatNoRoutesFoundResponse(
    origin: string,
    destination: string,
    maxStop: number,
    context?: Record<string, any>
  ): NextResponse<ErrorResponse> {
    return this.formatNotFoundErrorResponse(
      `No valid route found for ${origin} to ${destination} with maxStop ${maxStop}`,
      {
        origin,
        destination,
        maxStop,
        ...context
      }
    );
  }

  /**
   * Format missing environment variables response
   */
  static formatMissingEnvVarsResponse(
    missingVars: string[]
  ): NextResponse<ErrorResponse> {
    return this.formatInternalErrorResponse(
      'Missing required environment variables',
      { missingVariables: missingVars }
    );
  }

  /**
   * Format empty input response
   */
  static formatEmptyInputResponse(
    field: string
  ): NextResponse<ErrorResponse> {
    return this.formatValidationErrorResponse(
      `${field} cannot be empty`,
      [{ field, message: `${field} cannot be empty` }]
    );
  }

  /**
   * Create response metadata from processing data
   */
  static createMetadata(data: {
    totalRoutes: number;
    queryParamsCount: number;
    processingTime?: number;
    cacheStats?: CacheStats;
    performanceStats?: PerformanceStats;
  }): ResponseMetadata {
    return {
      totalRoutes: data.totalRoutes,
      queryParamsCount: data.queryParamsCount,
      ...(data.processingTime && { processingTime: data.processingTime }),
      ...(data.cacheStats && { cacheStats: data.cacheStats }),
      ...(data.performanceStats && { performanceStats: data.performanceStats })
    };
  }

  /**
   * Create cache statistics from cache data
   */
  static createCacheStats(cache: {
    airport: Map<string, any>;
    intraRoute: Map<string, any>;
    path: Map<string, any>;
    sharedPaths: Map<string, any>;
    globalIntraRoutes: Map<string, any>;
  }): CacheStats {
    return {
      airportCacheSize: cache.airport.size,
      intraRouteCacheSize: cache.intraRoute.size,
      pathCacheSize: cache.path.size,
      sharedPathsCacheSize: cache.sharedPaths.size,
      globalIntraRoutesCacheSize: cache.globalIntraRoutes.size
    };
  }

  /**
   * Create performance statistics from timing data
   */
  static createPerformanceStats(timings: Record<string, { duration?: number }>): PerformanceStats {
    const totalTime = Object.values(timings).reduce((sum, timing) => sum + (timing.duration || 0), 0);
    
    return {
      totalTime,
      validationTime: timings['input-validation']?.duration,
      dataFetchTime: timings['pre-fetch-airports']?.duration,
      processingTime: timings['pair-processing']?.duration,
      groupingTime: timings['final-grouping']?.duration
    };
  }

  /**
   * Format query parameters array from groups
   */
  static formatQueryParams(groups: Array<{ keys: string[]; dests: string[] }>): string[] {
    return groups
      .sort((a, b) => 
        b.dests.length - a.dests.length || 
        a.keys.join('/').localeCompare(b.keys.join('/'))
      )
      .map(group => `${group.keys.join('/')}-${group.dests.join('/')}`);
  }

  /**
   * Add response headers for API versioning and debugging
   */
  static addResponseHeaders(response: NextResponse, additionalHeaders: Record<string, string> = {}): NextResponse {
    const headers = new Headers(response.headers);
    
    // Add standard headers
    headers.set('X-API-Version', '1.0');
    headers.set('X-Response-Time', new Date().toISOString());
    
    // Add custom headers
    Object.entries(additionalHeaders).forEach(([key, value]) => {
      headers.set(key, value);
    });
    
    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  /**
   * Format routes with additional processing
   */
  static processRoutes(routes: FullRoutePathResult[]): FullRoutePathResult[] {
    // Sort routes by cumulative distance (shortest first)
    return routes.sort((a, b) => a.cumulativeDistance - b.cumulativeDistance);
  }

  /**
   * Validate response data before formatting
   */
  static validateResponseData(data: {
    routes: FullRoutePathResult[];
    queryParamsArr: string[];
  }): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!Array.isArray(data.routes)) {
      errors.push('Routes must be an array');
    }
    
    if (!Array.isArray(data.queryParamsArr)) {
      errors.push('QueryParamsArr must be an array');
    }
    
    if (data.routes.length === 0) {
      errors.push('Routes array cannot be empty');
    }
    
    // Validate route structure
    data.routes.forEach((route, index) => {
      if (!route.A || typeof route.A !== 'string') {
        errors.push(`Route ${index}: A field is required and must be a string`);
      }
      
      if (typeof route.cumulativeDistance !== 'number' || route.cumulativeDistance < 0) {
        errors.push(`Route ${index}: cumulativeDistance must be a non-negative number`);
      }
      
      if (!route.caseType || !['case1', 'case2A', 'case2B', 'case3', 'case4'].includes(route.caseType)) {
        errors.push(`Route ${index}: caseType must be one of: case1, case2A, case2B, case3, case4`);
      }
    });
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

/**
 * Utility functions for response formatting
 */
export const ResponseFormatterUtils = {
  /**
   * Check if a response is successful
   */
  isSuccessResponse(response: NextResponse): boolean {
    return response.status >= 200 && response.status < 300;
  },

  /**
   * Check if a response is an error
   */
  isErrorResponse(response: NextResponse): boolean {
    return response.status >= 400;
  },

  /**
   * Extract error message from error response
   */
  async extractErrorMessage(response: NextResponse): Promise<string> {
    try {
      const data = await response.json();
      return data.error || 'Unknown error';
    } catch {
      return 'Failed to parse error response';
    }
  },

  /**
   * Create a standardized success response
   */
  createSuccessResponse(data: any, statusCode: number = 200): NextResponse {
    return NextResponse.json(data, { status: statusCode });
  },

  /**
   * Create a standardized error response
   */
  createErrorResponse(error: string, statusCode: number = 500, details?: any): NextResponse {
    return NextResponse.json(
      { error, ...(details && { details }) },
      { status: statusCode }
    );
  }
};
