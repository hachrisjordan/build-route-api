import type { AvailabilityFlight } from '@/types/availability';
import { precomputeItineraryMetadata, optimizedFilterSortSearchPaginate } from '@/lib/itineraries/processing';
import { extractFilterMetadata } from '@/lib/itineraries/filter-metadata';
import { buildFlightsPage, buildPricingPage } from '@/lib/itineraries/postprocess';
import { getClassPercentages } from '@/lib/itineraries/class-percentages';

export function buildOptimizedFromCached(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Record<string, AvailabilityFlight>,
  reliabilityMap: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number,
  filterParams: any,
  pricingPool?: Map<string, any>
) {
  const optimizedItineraries = precomputeItineraryMetadata(
    itineraries,
    flights,
    reliabilityMap,
    minReliabilityPercent,
    getClassPercentages,
    undefined, // routeStructureMap not available from cache
    pricingPool
  );
  const { total, data } = optimizedFilterSortSearchPaginate(optimizedItineraries, filterParams);
  const filterMetadata = extractFilterMetadata(itineraries, flights);
  const flightsPage = buildFlightsPage(data as any, flights);
  const pricingPage = pricingPool ? buildPricingPage(data as any, pricingPool) : {};
  return { total, data, filterMetadata, flightsPage, pricingPage };
}


