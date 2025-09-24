import type { AvailabilityFlight } from '@/types/availability';
import { precomputeItineraryMetadata, optimizedFilterSortSearchPaginate } from '@/lib/itineraries/processing';
import { extractFilterMetadata } from '@/lib/itineraries/filter-metadata';
import { buildFlightsPage } from '@/lib/itineraries/postprocess';
import { getClassPercentages } from '@/lib/itineraries/class-percentages';

export function buildOptimizedFromCached(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Record<string, AvailabilityFlight>,
  reliabilityMap: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number,
  filterParams: any
) {
  const optimizedItineraries = precomputeItineraryMetadata(
    itineraries,
    flights,
    reliabilityMap,
    minReliabilityPercent,
    getClassPercentages
  );
  const { total, data } = optimizedFilterSortSearchPaginate(optimizedItineraries, filterParams);
  const filterMetadata = extractFilterMetadata(itineraries, flights);
  const flightsPage = buildFlightsPage(data as any, flights);
  return { total, data, filterMetadata, flightsPage };
}


