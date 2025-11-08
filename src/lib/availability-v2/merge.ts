import { getCountMultiplier } from '@/lib/reliability';
import { ProcessedTrip, MergedEntry } from '@/types/availability-v2';
import { calculatePartnerBooleans } from './partner-booking';

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
      const yCount = cabin === 'economy' ? cabinCount : 0;
      const wCount = cabin === 'premium' ? cabinCount : 0;
      const jCount = cabin === 'business' ? cabinCount : 0;
      const fCount = cabin === 'first' ? cabinCount : 0;
      
      const partnerBooleans = calculatePartnerBooleans(
        flightPrefix,
        entry.YFare,
        entry.WFare,
        entry.JFare,
        entry.FFare,
        yCount,
        wCount,
        jCount,
        fCount
      );

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
        YCount: yCount,
        WCount: wCount,
        JCount: jCount,
        FCount: fCount,
        YFare: [...entry.YFare], // Copy array since it will be mutated during merging
        WFare: [...entry.WFare],
        JFare: [...entry.JFare],
        FFare: [...entry.FFare],
        ...partnerBooleans,
      };
      mergedMap.set(key, newEntry);
    } else {
      // Update counts
      if (cabin === 'economy') {
        existing.YCount += cabinCount;
      } else if (cabin === 'premium') {
        existing.WCount += cabinCount;
      } else if (cabin === 'business') {
        existing.JCount += cabinCount;
      } else if (cabin === 'first') {
        existing.FCount += cabinCount;
      }

      // Merge fare classes efficiently - only push if entry has fare classes
      if (entry.YFare.length > 0) existing.YFare.push(...entry.YFare);
      if (entry.WFare.length > 0) existing.WFare.push(...entry.WFare);
      if (entry.JFare.length > 0) existing.JFare.push(...entry.JFare);
      if (entry.FFare.length > 0) existing.FFare.push(...entry.FFare);

      // Only recalculate partner booleans if counts actually changed (cabinCount > 0)
      // This avoids unnecessary recalculations when merging entries with same cabin
      if (cabinCount > 0) {
        const existingAirlineCode = existing.FlightNumbers.slice(0, 2);
        const partnerBooleans = calculatePartnerBooleans(
          existingAirlineCode,
          existing.YFare,
          existing.WFare,
          existing.JFare,
          existing.FFare,
          existing.YCount,
          existing.WCount,
          existing.JCount,
          existing.FCount
        );
        existing.YPartner = partnerBooleans.YPartner;
        existing.WPartner = partnerBooleans.WPartner;
        existing.JPartner = partnerBooleans.JPartner;
        existing.FPartner = partnerBooleans.FPartner;
      }

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


