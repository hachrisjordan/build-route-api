import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Error types for route path operations
 */
export enum RouteErrorType {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AIRPORT_NOT_FOUND = 'AIRPORT_NOT_FOUND',
  NO_ROUTES_FOUND = 'NO_ROUTES_FOUND',
  DATABASE_ERROR = 'DATABASE_ERROR',
  CACHE_ERROR = 'CACHE_ERROR',
  CALCULATION_ERROR = 'CALCULATION_ERROR',
  GROUPING_ERROR = 'GROUPING_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  EXTERNAL_API_ERROR = 'EXTERNAL_API_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR'
}

/**
 * Custom error class for route path operations
 */
export class RouteError extends Error {
  public readonly type: RouteErrorType;
  public readonly statusCode: number;
  public readonly context?: Record<string, any>;
  public readonly isOperational: boolean;

  constructor(
    type: RouteErrorType,
    message: string,
    statusCode: number = 500,
    context?: Record<string, any>,
    isOperational: boolean = true
  ) {
    super(message);
    this.name = 'RouteError';
    this.type = type;
    this.statusCode = statusCode;
    this.context = context;
    this.isOperational = isOperational;
    
    // Ensure proper prototype chain
    Object.setPrototypeOf(this, RouteError.prototype);
  }
}

/**
 * Error context for Sentry reporting
 */
export interface ErrorContext {
  requestUrl?: string;
  userAgent?: string;
  requestId?: string;
  processingTime?: number;
  routeId?: string;
  origin?: string;
  destination?: string;
  maxStop?: number;
  cacheSize?: number;
  routesCount?: number;
  [key: string]: any;
}

/**
 * Service for handling errors in route path operations
 */
export class ErrorHandlerService {
  readonly serviceName = 'ErrorHandlerService';
  readonly version = '1.0.0';

  /**
   * Create a validation error
   */
  static createValidationError(message: string, details?: any): RouteError {
    return new RouteError(
      RouteErrorType.VALIDATION_ERROR,
      message,
      400,
      { details }
    );
  }

  /**
   * Create an airport not found error
   */
  static createAirportNotFoundError(airportCode: string): RouteError {
    return new RouteError(
      RouteErrorType.AIRPORT_NOT_FOUND,
      `Airport not found: ${airportCode}`,
      404,
      { airportCode }
    );
  }

  /**
   * Create a no routes found error
   */
  static createNoRoutesFoundError(origin: string, destination: string, maxStop: number): RouteError {
    return new RouteError(
      RouteErrorType.NO_ROUTES_FOUND,
      `No valid route found for ${origin} to ${destination} with maxStop ${maxStop}`,
      404,
      { origin, destination, maxStop }
    );
  }

  /**
   * Create a database error
   */
  static createDatabaseError(message: string, context?: Record<string, any>): RouteError {
    return new RouteError(
      RouteErrorType.DATABASE_ERROR,
      message,
      500,
      context
    );
  }

  /**
   * Create a cache error
   */
  static createCacheError(message: string, context?: Record<string, any>): RouteError {
    return new RouteError(
      RouteErrorType.CACHE_ERROR,
      message,
      500,
      context
    );
  }

  /**
   * Create a calculation error
   */
  static createCalculationError(message: string, context?: Record<string, any>): RouteError {
    return new RouteError(
      RouteErrorType.CALCULATION_ERROR,
      message,
      500,
      context
    );
  }

  /**
   * Create a grouping error
   */
  static createGroupingError(message: string, context?: Record<string, any>): RouteError {
    return new RouteError(
      RouteErrorType.GROUPING_ERROR,
      message,
      500,
      context
    );
  }

  /**
   * Create an internal error
   */
  static createInternalError(message: string, context?: Record<string, any>): RouteError {
    return new RouteError(
      RouteErrorType.INTERNAL_ERROR,
      message,
      500,
      context,
      false
    );
  }

  /**
   * Handle and log an error with Sentry integration
   */
  static handleError(
    error: Error | RouteError,
    context: ErrorContext = {},
    request?: NextRequest
  ): void {
    // Check if it's an operational error (expected/normal behavior)
    const isOperational = error instanceof RouteError && error.isOperational;
    
    if (isOperational) {
      // Log operational errors (like airport not found, no routes) as info, not error
      console.log(`[error-handler] ${error.message}`, {
        type: error.type,
        context
      });
      // Don't send operational errors to Sentry - they're expected scenarios
      return;
    }
    
    // Log unexpected errors to console
    console.error('Route Error:', {
      message: error.message,
      type: error instanceof RouteError ? error.type : 'UNKNOWN',
      context,
      stack: error.stack
    });

    // Capture in Sentry with enhanced context (only for non-operational errors)
    const sentryContext = {
      tags: {
        route: 'create-full-route-path',
        errorType: error instanceof RouteError ? error.type : 'UNKNOWN',
        ...(context.routeId && { routeId: context.routeId }),
        ...(context.origin && { origin: context.origin }),
        ...(context.destination && { destination: context.destination })
      },
      extra: {
        ...context,
        ...(request && {
          requestUrl: request.url,
          userAgent: request.headers.get('user-agent'),
          requestId: request.headers.get('x-request-id')
        }),
        ...(error instanceof RouteError && {
          errorContext: error.context,
          isOperational: error.isOperational
        })
      }
    };

    Sentry.captureException(error, sentryContext);
  }

  /**
   * Create an error response for the API
   */
  static createErrorResponse(
    error: Error | RouteError,
    request?: NextRequest,
    context: ErrorContext = {}
  ): NextResponse {
    // Handle the error (log and capture in Sentry)
    this.handleError(error, context, request);

    // Determine response details
    let statusCode = 500;
    let errorMessage = 'Internal server error';
    let details: any = undefined;

    if (error instanceof RouteError) {
      statusCode = error.statusCode;
      errorMessage = error.message;
      details = error.context;
    } else {
      errorMessage = error.message;
    }

    // Add processing time if available
    if (context.processingTime) {
      details = {
        ...details,
        processingTime: context.processingTime
      };
    }

    return NextResponse.json(
      {
        error: errorMessage,
        ...(details && { details })
      },
      { status: statusCode }
    );
  }

  /**
   * Wrap a function with error handling
   */
  static async wrapWithErrorHandling<T>(
    fn: () => Promise<T>,
    context: ErrorContext = {},
    request?: NextRequest
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.handleError(error as Error, context, request);
      throw error;
    }
  }

  /**
   * Wrap a synchronous function with error handling
   */
  static wrapWithErrorHandlingSync<T>(
    fn: () => T,
    context: ErrorContext = {},
    request?: NextRequest
  ): T {
    try {
      return fn();
    } catch (error) {
      this.handleError(error as Error, context, request);
      throw error;
    }
  }

  /**
   * Handle validation errors specifically
   */
  static handleValidationError(
    validationError: any,
    request?: NextRequest
  ): NextResponse {
    const error = this.createValidationError(
      'Invalid input',
      validationError.errors
    );
    
    return this.createErrorResponse(error, request, {
      validationErrors: validationError.errors
    });
  }

  /**
   * Handle missing environment variables
   */
  static handleMissingEnvVars(
    missingVars: string[],
    request?: NextRequest
  ): NextResponse {
    const error = this.createInternalError(
      'Missing required environment variables',
      { missingVariables: missingVars }
    );
    
    return this.createErrorResponse(error, request, {
      missingVariables: missingVars
    });
  }

  /**
   * Handle empty input errors
   */
  static handleEmptyInputError(
    field: string,
    request?: NextRequest
  ): NextResponse {
    const error = this.createValidationError(
      `${field} cannot be empty`
    );
    
    return this.createErrorResponse(error, request, {
      field,
      message: `${field} cannot be empty`
    });
  }

  /**
   * Handle no routes found for multiple pairs
   */
  static handleNoRoutesFoundForPairs(
    anyError: Error | null,
    request?: NextRequest,
    context: ErrorContext = {}
  ): NextResponse {
    const error = this.createNoRoutesFoundError(
      'any',
      'any',
      0
    );
    
    return this.createErrorResponse(error, request, {
      ...context,
      details: anyError ? anyError.message : undefined,
      message: 'No valid route found for any origin-destination pair'
    });
  }
}

/**
 * Utility functions for common error scenarios
 */
export const RouteErrorUtils = {
  /**
   * Check if an error is a RouteError
   */
  isRouteError(error: any): error is RouteError {
    return error instanceof RouteError;
  },

  /**
   * Check if an error is operational (expected/recoverable)
   */
  isOperationalError(error: any): boolean {
    return this.isRouteError(error) && error.isOperational;
  },

  /**
   * Extract error context from an error
   */
  extractErrorContext(error: any): Record<string, any> {
    if (this.isRouteError(error)) {
      return {
        type: error.type,
        statusCode: error.statusCode,
        context: error.context,
        isOperational: error.isOperational
      };
    }
    
    return {
      type: 'UNKNOWN',
      message: error.message,
      stack: error.stack
    };
  },

  /**
   * Create a safe error message for client responses
   */
  getSafeErrorMessage(error: any): string {
    if (this.isRouteError(error) && error.isOperational) {
      return error.message;
    }
    
    return 'An unexpected error occurred';
  }
};
