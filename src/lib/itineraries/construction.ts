import type { AvailabilityFlight, AvailabilityGroup } from '@/types/availability';
import { getFlightUUID } from '@/lib/itineraries/ids';

export function composeItineraries(
  segments: [string, string][],
  segmentAvail: AvailabilityGroup[][],
  alliances: (string[] | null)[],
  flightMap: Map<string, AvailabilityFlight>,
  connectionMatrix: Map<string, Set<string>>,
  minConnectionMinutes = 45
): Record<string, string[][]> {
  const results: Record<string, string[][]> = {};
  if (segments.length === 0 || segmentAvail.some(arr => arr.length === 0)) return results;

  const segmentMap = new Map<string, { groups: AvailabilityGroup[]; allowedAlliances: string[] | null }>();
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const [from, to] = segment;
    const key = `${from}-${to}`;
    const groups = segmentAvail[i]?.filter(g => g.originAirport === from && g.destinationAirport === to) || [];
    const allowedAlliances = alliances[i] || null;
    segmentMap.set(key, { groups, allowedAlliances });
  }

  if (segmentMap.size !== segments.length || Array.from(segmentMap.values()).some(seg => seg.groups.length === 0)) {
    return results;
  }

  const firstSegment = segments[0];
  if (!firstSegment) return results;
  const firstSegmentKey = `${firstSegment[0]}-${firstSegment[1]}`;
  const firstSegmentData = segmentMap.get(firstSegmentKey);
  if (!firstSegmentData) return results;

  const flightsByDate = new Map<string, AvailabilityFlight[]>();
  for (const group of firstSegmentData.groups) {
    if (!flightsByDate.has(group.date)) {
      flightsByDate.set(group.date, []);
    }
    const validFlights = firstSegmentData.allowedAlliances && firstSegmentData.allowedAlliances.length > 0
      ? group.flights.filter(f => firstSegmentData.allowedAlliances!.includes(group.alliance))
      : group.flights;
    flightsByDate.get(group.date)!.push(...validFlights);
  }

  for (const [date, firstFlights] of flightsByDate) {
    const dateResults: string[][] = [];
    const stack: { segIdx: number; path: string[]; usedAirports: Set<string>; prevArrival: string | null; }[] = [];

    for (const flight of firstFlights) {
      const uuid = getFlightUUID(flight);
      if (!flightMap.has(uuid)) {
        flightMap.set(uuid, flight);
      }
      const [from, to] = firstSegment;
      stack.push({ segIdx: 1, path: [uuid], usedAirports: new Set([from, to]), prevArrival: uuid });
    }

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.segIdx === segments.length) {
        dateResults.push([...current.path]);
        continue;
      }

      const currentSegment = segments[current.segIdx];
      if (!currentSegment) continue;
      const [from, to] = currentSegment;
      const segmentKey = `${from}-${to}`;
      const segmentData = segmentMap.get(segmentKey);
      if (!segmentData) continue;
      if (current.usedAirports.has(to)) continue;

      for (const group of segmentData.groups) {
        if (segmentData.allowedAlliances && segmentData.allowedAlliances.length > 0 && !segmentData.allowedAlliances.includes(group.alliance)) {
          continue;
        }
        for (const flight of group.flights) {
          const uuid = getFlightUUID(flight);
          if (current.prevArrival) {
            const validConnections = connectionMatrix.get(current.prevArrival);
            if (!validConnections || !validConnections.has(uuid)) {
              continue;
            }
          }
          if (!flightMap.has(uuid)) {
            flightMap.set(uuid, flight);
          }
          const newUsedAirports = new Set(current.usedAirports);
          newUsedAirports.add(to);
          stack.push({ segIdx: current.segIdx + 1, path: [...current.path, uuid], usedAirports: newUsedAirports, prevArrival: uuid });
        }
      }
    }

    if (dateResults.length > 0) {
      const uniqueResults = Array.from(new Map(dateResults.map(itin => [itin.join('>'), itin])).values());
      results[date] = uniqueResults;
    }
  }

  return results;
}


