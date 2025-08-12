import { createClient } from '@supabase/supabase-js';
import { AvailabilityFlight } from './types';

let reliabilityCache: any[] | null = null;
let reliabilityCacheTimestamp = 0;
const RELIABILITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getReliabilityTableCached() {
  const now = Date.now();
  if (reliabilityCache && now - reliabilityCacheTimestamp < RELIABILITY_CACHE_TTL_MS) {
    return reliabilityCache;
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return [];
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase.from('reliability').select('code, min_count, exemption');
  if (error) {
    console.error('Failed to fetch reliability table:', error);
    reliabilityCache = [];
  } else {
    reliabilityCache = data || [];
  }
  reliabilityCacheTimestamp = now;
  return reliabilityCache;
}

export function getReliabilityMap(table: any[]): Record<string, { min_count: number; exemption?: string }> {
  const map: Record<string, { min_count: number; exemption?: string }> = {};
  for (const row of table) {
    map[row.code] = { min_count: row.min_count, exemption: row.exemption };
  }
  return map;
}

export function isUnreliableFlight(
  flight: AvailabilityFlight,
  reliability: Record<string, { min_count: number; exemption?: string }>
) {
  const code = flight.FlightNumbers.slice(0, 2).toUpperCase();
  const rel = reliability[code];
  const min = rel?.min_count ?? 1;
  const exemption = rel?.exemption || '';
  const minY = exemption.includes('Y') ? 1 : min;
  const minW = exemption.includes('W') ? 1 : min;
  const minJ = exemption.includes('J') ? 1 : min;
  const minF = exemption.includes('F') ? 1 : min;
  return (
    flight.YCount < minY &&
    flight.WCount < minW &&
    flight.JCount < minJ &&
    flight.FCount < minF
  );
}

export function filterReliableItineraries(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Map<string, AvailabilityFlight>,
  reliability: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number
) {
  const filtered: Record<string, Record<string, string[][]>> = {};
  const usedFlightUUIDs = new Set<string>();
  for (const routeKey of Object.keys(itineraries)) {
    const routeItineraries = itineraries[routeKey];
    if (!routeItineraries) continue;
    for (const date of Object.keys(routeItineraries)) {
      const dateItineraries = routeItineraries[date];
      if (!dateItineraries) continue;
      const keptItins: string[][] = [];
      for (const itin of dateItineraries) {
        const flightsArr = itin.map(uuid => flights.get(uuid)).filter(Boolean) as AvailabilityFlight[];
        if (!flightsArr.length) continue;
        const totalDuration = flightsArr.reduce((sum, f) => sum + f.TotalDuration, 0);
        const unreliableDuration = flightsArr.filter(f => isUnreliableFlight(f, reliability)).reduce((sum, f) => sum + f.TotalDuration, 0);
        if (unreliableDuration === 0) {
          keptItins.push(itin);
          itin.forEach(uuid => usedFlightUUIDs.add(uuid));
          continue;
        }
        if (totalDuration === 0) continue;
        const unreliablePct = (unreliableDuration / totalDuration) * 100;
        if (unreliablePct <= 100 - minReliabilityPercent) {
          keptItins.push(itin);
          itin.forEach(uuid => usedFlightUUIDs.add(uuid));
        }
      }
      if (keptItins.length) {
        if (!filtered[routeKey]) filtered[routeKey] = {};
        filtered[routeKey][date] = keptItins;
      }
    }
  }
  for (const uuid of Array.from(flights.keys())) {
    if (!usedFlightUUIDs.has(uuid)) {
      flights.delete(uuid);
    }
  }
  return filtered;
}