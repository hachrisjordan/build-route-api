export function createPerformanceMetrics() {
  return {
    availabilityFetch: 0,
    reliabilityCache: 0,
    segmentFiltering: 0,
    groupConnectionMatrix: 0,
    flightMetadata: 0,
    flightConnectionMatrix: 0,
    routePreFiltering: 0,
    itineraryBuild: 0,
    totalTime: 0,
  };
}

export function createItineraryMetrics() {
  return {
    phases: {
      routeProcessing: { totalMs: 0, count: 0, avgMs: 0 },
      segmentProcessing: { totalMs: 0, count: 0, avgMs: 0 },
      itineraryComposition: { totalMs: 0, count: 0, avgMs: 0 },
      postProcessing: { totalMs: 0, count: 0, avgMs: 0 },
    },
    totals: {
      routesProcessed: 0,
      segmentsProcessed: 0,
      itinerariesCreated: 0,
      totalTimeMs: 0,
    },
  } as any;
}

export function finalizePostProcessingMetrics(itineraryMetrics: any, postProcessingMs: number, itineraryBuildStart: number) {
  itineraryMetrics.phases.postProcessing.totalMs = postProcessingMs;
  itineraryMetrics.phases.postProcessing.count = 1;
  itineraryMetrics.phases.postProcessing.avgMs = postProcessingMs;
  itineraryMetrics.totals.totalTimeMs = Date.now() - itineraryBuildStart;
}


