import * as Sentry from '@sentry/nextjs';

export function setInitialSentryContext() {
  Sentry.setContext('performance', {
    route: 'build-itineraries',
    origin: 'pending',
    destination: 'pending',
    maxStop: 'pending',
  });
}

export function setRequestSentryContext(origin: string, destination: string, maxStop: number | string) {
  Sentry.setContext('performance', {
    route: 'build-itineraries',
    origin,
    destination,
    maxStop,
  });
}

export function reportPerformance(performanceMetrics: any, extras: any) {
  Sentry.setContext('performance', {
    route: 'build-itineraries',
    origin: extras.origin,
    destination: extras.destination,
    maxStop: extras.maxStop,
    availabilityFetchMs: performanceMetrics.availabilityFetch,
    reliabilityCacheMs: performanceMetrics.reliabilityCache,
    segmentFilteringMs: performanceMetrics.segmentFiltering,
    groupConnectionMatrixMs: performanceMetrics.groupConnectionMatrix,
    flightMetadataMs: performanceMetrics.flightMetadata,
    flightConnectionMatrixMs: performanceMetrics.flightConnectionMatrix,
    routePreFilteringMs: performanceMetrics.routePreFiltering,
    itineraryBuildMs: performanceMetrics.itineraryBuild,
    totalTimeMs: performanceMetrics.totalTime,
    totalSeatsAeroRequests: extras.totalSeatsAeroRequests,
    totalItineraries: extras.totalItineraries,
    totalUniqueFlights: extras.totalUniqueFlights,
  });
}

export function reportItineraryBreakdown(itineraryMetrics: any, processingMode: 'parallel' | 'sequential') {
  Sentry.setContext('itineraryBreakdown', {
    phases: {
      routeProcessing: {
        totalMs: itineraryMetrics.phases.routeProcessing.totalMs,
        routesProcessed: itineraryMetrics.phases.routeProcessing.count,
        avgMsPerRoute: Math.round(itineraryMetrics.phases.routeProcessing.avgMs * 100) / 100,
        percentageOfTotal: Math.round((itineraryMetrics.phases.routeProcessing.totalMs / itineraryMetrics.totals.totalTimeMs) * 100)
      },
      segmentProcessing: {
        totalMs: itineraryMetrics.phases.segmentProcessing.totalMs,
        segmentsProcessed: itineraryMetrics.totals.segmentsProcessed,
        avgMsPerSegment: itineraryMetrics.totals.segmentsProcessed > 0 ? Math.round((itineraryMetrics.phases.segmentProcessing.totalMs / itineraryMetrics.totals.segmentsProcessed) * 100) / 100 : 0
      },
      itineraryComposition: {
        totalMs: itineraryMetrics.phases.itineraryComposition.totalMs,
        itinerariesCreated: itineraryMetrics.totals.itinerariesCreated,
        avgMsPerItinerary: itineraryMetrics.totals.itinerariesCreated > 0 ? Math.round((itineraryMetrics.phases.itineraryComposition.totalMs / itineraryMetrics.totals.itinerariesCreated) * 100) / 100 : 0
      },
      postProcessing: {
        totalMs: itineraryMetrics.phases.postProcessing.totalMs,
        percentageOfTotal: Math.round((itineraryMetrics.phases.postProcessing.totalMs / itineraryMetrics.totals.totalTimeMs) * 100)
      }
    },
    totals: {
      totalItineraryBuildTimeMs: itineraryMetrics.totals.totalTimeMs,
      routesProcessed: itineraryMetrics.totals.routesProcessed,
      segmentsProcessed: itineraryMetrics.totals.segmentsProcessed,
      itinerariesCreated: itineraryMetrics.totals.itinerariesCreated,
      processingMode
    }
  });
}

export function addPerformanceBreadcrumb(performanceMetrics: any) {
  Sentry.addBreadcrumb({
    category: 'performance',
    message: 'Build itineraries performance metrics',
    level: 'info',
    data: performanceMetrics,
  });
}

export function captureBuildError(err: any, ctx: { reqUrl: string; userAgent: string | null; requestId: string | null; processingTime: number; origin?: string; destination?: string; maxStop?: number; startDate?: string; endDate?: string; }) {
  Sentry.captureException(err, {
    tags: {
      route: 'build-itineraries',
      origin: ctx.origin || 'unknown',
      destination: ctx.destination || 'unknown',
      maxStop: ctx.maxStop || 'unknown',
      startDate: ctx.startDate || 'unknown',
      endDate: ctx.endDate || 'unknown',
    },
    extra: {
      requestUrl: ctx.reqUrl,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      processingTime: ctx.processingTime,
    },
  });
}


