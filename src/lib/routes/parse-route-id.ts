export type ParsedRouteId = {
  segments: string[];
  originAirports: string[];
  destinationSegments: string[];
  middleSegments: string[][];
};

/**
 * Parses a routeId string of the form AAA/BBB-CCC/DDD-EEE into structured segments
 */
export function parseRouteId(routeId: string): ParsedRouteId {
  const segments = routeId.split('-');
  const originAirports = (segments[0] || '').split('/').filter(Boolean);
  const destinationSegments = (segments[segments.length - 1] || '').split('/').filter(Boolean);
  const middleSegments = segments.slice(1, -1).map((seg: string) => (seg || '').split('/').filter(Boolean));

  return {
    segments,
    originAirports,
    destinationSegments,
    middleSegments,
  };
}


