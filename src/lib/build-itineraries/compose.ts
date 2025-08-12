import { createHash } from 'crypto';
import { AvailabilityFlight, AvailabilityGroup } from './types';

export function getFlightUUID(flight: AvailabilityFlight): string {
  const key = `${flight.FlightNumbers}|${flight.DepartsAt}|${flight.ArrivesAt}`;
  return createHash('md5').update(key).digest('hex');
}

export function composeItineraries(
  segments: [string, string][],
  segmentAvail: AvailabilityGroup[][],
  alliances: (string[] | null)[],
  flightMap: Map<string, AvailabilityFlight>,
  minConnectionMinutes = 45
): Record<string, string[][]> {
  const results: Record<string, string[][]> = {};
  if (segments.length === 0 || segmentAvail.some(arr => arr.length === 0)) return results;

  function dfs(
    segIdx: number,
    path: string[],
    usedAirports: Set<string>,
    prevArrival: string | null,
    date: string
  ) {
    if (segIdx === segments.length) {
      if (!results[date]) results[date] = [];
      results[date].push([...path]);
      return;
    }
    const segment = segments[segIdx];
    if (!segment) return;
    const [from, to] = segment;
    const allowedAlliances = alliances[segIdx];
    const segmentGroups = segmentAvail[segIdx];
    if (!segmentGroups) return;
    for (const group of segmentGroups) {
      if (group.originAirport !== from || group.destinationAirport !== to) continue;
      if (segIdx === 0 && group.date !== date) continue;
      for (const flight of group.flights) {
        if ((segIdx > 0 && usedAirports.has(to)) || (segIdx === 0 && usedAirports.has(from))) continue;
        if (allowedAlliances && allowedAlliances.length > 0 && !allowedAlliances.includes(group.alliance)) continue;
        if (prevArrival) {
          const prev = new Date(prevArrival);
          const dep = new Date(flight.DepartsAt);
          const diffMinutes = (dep.getTime() - prev.getTime()) / 60000;
          if (diffMinutes < minConnectionMinutes || diffMinutes > 24 * 60) continue;
        }
        const uuid = getFlightUUID(flight);
        if (!flightMap.has(uuid)) {
          flightMap.set(uuid, flight);
        }
        usedAirports.add(from);
        usedAirports.add(to);
        path.push(uuid);
        dfs(segIdx + 1, path, usedAirports, flight.ArrivesAt, date);
        path.pop();
        usedAirports.delete(from);
        usedAirports.delete(to);
      }
    }
  }

  const firstSegmentGroups = segmentAvail[0];
  if (!firstSegmentGroups) return results;
  const firstSegmentDates = new Set(firstSegmentGroups.map(g => g.date));
  for (const date of firstSegmentDates) {
    dfs(0, [], new Set(), null, date);
    if (results[date]) {
      const seen = new Set<string>();
      results[date] = results[date].filter(itinerary => {
        const key = itinerary.join('>');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  return results;
}