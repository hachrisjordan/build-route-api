import { normalizeFlightNumber } from '@/lib/airlines/normalize-flight';
import { getDistanceThresholdCount } from '@/lib/airlines/award-thresholds';
import { getCountMultiplier } from '@/lib/reliability';
import { ProcessedTrip, ProcessingStats } from '@/types/availability-v2';

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
  
  // Cache lowercase cabin for comparison (avoid repeated toLowerCase calls)
  const cabinLower = cabin ? cabin.toLowerCase() : null;

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
        if (trip.Stops !== 0 || 
            (trip.UpdatedAt && new Date(trip.UpdatedAt) < sevenDaysAgo)) {
          continue;
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
            const normalizedFlightNumber = normalizeFlightNumber(flightNumber);
            const flightPrefix = normalizedFlightNumber.slice(0, 2);

            const thresholdCount = getDistanceThresholdCount(flightPrefix, distance, mileageCost, tripCabin);
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
          const normalizedFlightNumber = normalizeFlightNumber(flightNumbers);
          const flightPrefix = normalizedFlightNumber.slice(0, 2);

          const thresholdCount = getDistanceThresholdCount(flightPrefix, distance, mileageCost, tripCabin);
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
