import { getCountMultiplier } from '@/lib/reliability';
import { ProcessedTrip, MergedEntry } from '@/types/availability-v2';

/**
 * Merge processed trips into unique flight entries with accumulated seat counts.
 */
export function mergeProcessedTrips(
  results: ProcessedTrip[],
  reliabilityTable: any[]
): Map<string, MergedEntry> {
  const mergedMap = new Map<string, MergedEntry>();

  for (const entry of results) {
    const flightNumber = entry.FlightNumbers;
    const key = `${entry.originAirport}|${entry.destinationAirport}|${entry.date}|${flightNumber}|${entry.Source}`;
    const flightPrefix = flightNumber.slice(0, 2);
    const cabin = entry.Cabin;
    const cabinChar = cabin[0]?.toUpperCase() || '';

    let cabinCount = 0;
    if ((cabin === 'economy' && entry.YMile > 0) ||
        (cabin === 'premium' && entry.WMile > 0) ||
        (cabin === 'business' && entry.JMile > 0) ||
        (cabin === 'first' && entry.FMile > 0)) {
      const baseMultiplier = getCountMultiplier({ code: flightPrefix, source: entry.Source, cabin: cabinChar, reliabilityTable });
      const thresholdCount = entry.ThresholdCount || 2;
      cabinCount = baseMultiplier * thresholdCount;
    }

    const existing = mergedMap.get(key);
    if (!existing) {
      const newEntry: MergedEntry = {
        originAirport: entry.originAirport,
        destinationAirport: entry.destinationAirport,
        date: entry.date,
        distance: entry.distance,
        FlightNumbers: flightNumber,
        TotalDuration: entry.TotalDuration,
        Aircraft: entry.Aircraft,
        DepartsAt: entry.DepartsAt,
        ArrivesAt: entry.ArrivesAt,
        Source: entry.Source,
        Cabin: cabin,
        YCount: cabin === 'economy' ? cabinCount : 0,
        WCount: cabin === 'premium' ? cabinCount : 0,
        JCount: cabin === 'business' ? cabinCount : 0,
        FCount: cabin === 'first' ? cabinCount : 0,
      };
      mergedMap.set(key, newEntry);
    } else {
      if (cabin === 'economy') existing.YCount += cabinCount;
      else if (cabin === 'premium') existing.WCount += cabinCount;
      else if (cabin === 'business') existing.JCount += cabinCount;
      else if (cabin === 'first') existing.FCount += cabinCount;

      if (entry.Aircraft.length > existing.Aircraft.length) {
        existing.Aircraft = entry.Aircraft;
      }

      if (entry.DepartsAt && entry.DepartsAt < existing.DepartsAt) {
        existing.DepartsAt = entry.DepartsAt;
      }
      if (entry.ArrivesAt && entry.ArrivesAt > existing.ArrivesAt) {
        existing.ArrivesAt = entry.ArrivesAt;
      }
    }
  }

  return mergedMap;
}


