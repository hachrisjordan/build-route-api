import { normalizeFlightNumber } from '@/lib/airlines/normalize-flight';
import { getDistanceThresholdCount } from '@/lib/airlines/award-thresholds';
import { getCountMultiplier } from '@/lib/reliability';
import { ProcessedTrip, ProcessingStats } from '@/types/availability-v2';

// Module-level caches for performance optimization
const flightNormCache = new Map<string, string>();
const thresholdCache = new Map<string, number>();
let callCount = 0;

/**
 * Memoized flight number normalization
 */
function getCachedNormalized(flightNumber: string): string {
  let normalized = flightNormCache.get(flightNumber);
  if (!normalized) {
    normalized = normalizeFlightNumber(flightNumber);
    flightNormCache.set(flightNumber, normalized);
  }
  return normalized;
}

/**
 * Memoized threshold calculation with rounded keys to reduce cache size
 */
function getCachedThreshold(
  prefix: string,
  distance: number,
  mileage: number,
  cabin: string
): number {
  // Round to reduce cache key space
  const key = `${prefix}_${Math.floor(distance/100)}_${Math.floor(mileage/1000)}_${cabin}`;
  let result = thresholdCache.get(key);
  if (result === undefined) {
    result = getDistanceThresholdCount(prefix, distance, mileage, cabin);
    thresholdCache.set(key, result);
  }
  return result;
}

/**
 * Clear processing caches to prevent memory bloat
 */
export function clearProcessingCaches(): void {
  flightNormCache.clear();
  thresholdCache.clear();
}

/**
 * Processes raw availability data with early filtering and mapping
 */
export function processAvailabilityData(
  pages: any[],
  cabin: string | undefined,
  seats: number,
  sevenDaysAgo: Date,
  reliabilityTable: any[]
): { results: ProcessedTrip[]; stats: ProcessingStats } {
  const results: ProcessedTrip[] = [];
  const uniqueItems = new Map<string, boolean>();
  
  let totalItems = 0;
  let totalTrips = 0;
  let filteredTrips = 0;
  
  // Periodic cache clearing to prevent memory bloat
  callCount++;
  if (callCount % 100 === 0) {
    clearProcessingCaches();
  }
  
  // Cache lowercase cabin for comparison (avoid repeated toLowerCase calls)
  const cabinLower = cabin ? cabin.toLowerCase() : null;
  
  // Convert Date to timestamp for faster comparisons
  const sevenDaysAgoTime = sevenDaysAgo.getTime();

  for (const page of pages) {
    if (!page?.data?.length) continue;
    totalItems += page.data.length;

    for (const item of page.data) {
      if (uniqueItems.has(item.ID)) continue;
      uniqueItems.set(item.ID, true);

      if (!item.AvailabilityTrips?.length) continue;

      const route = item.Route || {};
      const distance = route.Distance || 0;

      for (const trip of item.AvailabilityTrips) {
        totalTrips++;
        
        // Combined early exit conditions (fail fast) - optimize for common rejection cases
        if (trip.Stops !== 0) {
          continue;
        }
        
        // Use timestamp comparison instead of Date objects for better performance
        if (trip.UpdatedAt) {
          const updatedTime = Date.parse(trip.UpdatedAt);
          if (updatedTime < sevenDaysAgoTime) {
            continue;
          }
        }

        // Fast cabin and seat filtering - combine conditions for better branch prediction
        const tripCabin = trip.Cabin?.toLowerCase() || '';
        const remainingSeats = trip.RemainingSeats || 0;
        const seatThreshold = seats === 1 ? 0 : seats;

        // Combined condition check with short-circuit evaluation
        if ((cabinLower && tripCabin !== cabinLower) || 
            remainingSeats < seatThreshold) {
          continue;
        }

        filteredTrips++;
        const mileageCost = trip.MileageCost || 0;
        const flightNumbers = trip.FlightNumbers || '';
        
        // Extract fare classes from trip
        const fareClasses = Array.isArray(trip.FareClasses) ? trip.FareClasses : [];
        
        // Map fare classes to cabin-specific arrays
        const yFare = tripCabin === 'economy' ? fareClasses : [];
        const wFare = tripCabin === 'premium' ? fareClasses : [];
        const jFare = tripCabin === 'business' ? fareClasses : [];
        const fFare = tripCabin === 'first' ? fareClasses : [];

        // Pre-compute common values
        const originAirport = route.OriginAirport;
        const destinationAirport = route.DestinationAirport;
        const itemDate = item.Date;
        const source = trip.Source || item.Source || '';
        const aircraft = Array.isArray(trip.Aircraft) && trip.Aircraft.length > 0 ? trip.Aircraft[0] : '';

        // Process flight numbers efficiently
        if (flightNumbers.includes(',')) {
          // Multiple flights
          const flightNumbersArr = flightNumbers.split(/,\s*/);
          for (const flightNumber of flightNumbersArr) {
            const normalizedFlightNumber = getCachedNormalized(flightNumber);
            const flightPrefix = normalizedFlightNumber.slice(0, 2);

            const thresholdCount = getCachedThreshold(flightPrefix, distance, mileageCost, tripCabin);
            if (thresholdCount === 0) continue;

            results.push({
              originAirport,
              destinationAirport,
              date: itemDate,
              distance,
              FlightNumbers: normalizedFlightNumber,
              TotalDuration: trip.TotalDuration || 0,
              Aircraft: aircraft,
              DepartsAt: trip.DepartsAt || '',
              ArrivesAt: trip.ArrivesAt || '',
              YMile: tripCabin === 'economy' ? mileageCost : 0,
              WMile: tripCabin === 'premium' ? mileageCost : 0,
              JMile: tripCabin === 'business' ? mileageCost : 0,
              FMile: tripCabin === 'first' ? mileageCost : 0,
              Source: source,
              Cabin: tripCabin,
              ThresholdCount: thresholdCount,
              YFare: yFare,
              WFare: wFare,
              JFare: jFare,
              FFare: fFare,
            });
          }
        } else {
          // Single flight
          const normalizedFlightNumber = getCachedNormalized(flightNumbers);
          const flightPrefix = normalizedFlightNumber.slice(0, 2);

          const thresholdCount = getCachedThreshold(flightPrefix, distance, mileageCost, tripCabin);
          if (thresholdCount > 0) {
            results.push({
              originAirport,
              destinationAirport,
              date: itemDate,
              distance,
              FlightNumbers: normalizedFlightNumber,
              TotalDuration: trip.TotalDuration || 0,
              Aircraft: aircraft,
              DepartsAt: trip.DepartsAt || '',
              ArrivesAt: trip.ArrivesAt || '',
              YMile: tripCabin === 'economy' ? mileageCost : 0,
              WMile: tripCabin === 'premium' ? mileageCost : 0,
              JMile: tripCabin === 'business' ? mileageCost : 0,
              FMile: tripCabin === 'first' ? mileageCost : 0,
              Source: source,
              Cabin: tripCabin,
              ThresholdCount: thresholdCount,
              YFare: yFare,
              WFare: wFare,
              JFare: jFare,
              FFare: fFare,
            });
          }
        }
      }
    }
  }

  return {
    results,
    stats: {
      totalItems,
      totalTrips,
      filteredTrips,
      rawResults: results.length
    }
  };
}
