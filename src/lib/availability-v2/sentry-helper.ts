import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { SentryErrorContext } from '@/types/availability-v2';

/**
 * Captures an error in Sentry with standardized context for availability-v2 API
 */
export function captureAvailabilityError(
  error: any,
  context: SentryErrorContext
): void {
  // Log with context, but avoid flooding logs
  console.error(`Error in /api/${context.route}:`, error);
  
  // Capture error in Sentry with additional context
  Sentry.captureException(error, {
    tags: {
      route: context.route,
      routeId: context.routeId || 'unknown',
      startDate: context.startDate || 'unknown',
      endDate: context.endDate || 'unknown',
      cabin: context.cabin || 'unknown',
    },
    extra: {
      requestUrl: context.requestUrl,
      userAgent: context.userAgent,
      requestId: context.requestId,
      processingTime: context.processingTime,
      seatsAeroRequests: context.seatsAeroRequests || 0,
    },
  });
}

/**
 * Creates a standardized error response for availability-v2 API
 */
export function createErrorResponse(error: any): NextResponse {
  return NextResponse.json(
    { error: error.message || 'Internal server error' },
    { status: 500 }
  );
}

/**
 * Handles errors for availability-v2 API with Sentry capture and error response
 */
export function handleAvailabilityError(
  error: any,
  req: NextRequest,
  context: Omit<SentryErrorContext, 'requestUrl' | 'userAgent' | 'requestId'>
): NextResponse {
  const fullContext: SentryErrorContext = {
    ...context,
    requestUrl: req.url,
    userAgent: req.headers.get('user-agent'),
    requestId: req.headers.get('x-request-id'),
  };
  
  captureAvailabilityError(error, fullContext);
  return createErrorResponse(error);
}
