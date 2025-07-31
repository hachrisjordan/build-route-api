import { Airport, Path, IntraRoute } from '../types/route';
import { createClient, SupabaseClient as SupabaseClientType } from '@supabase/supabase-js';

// Use 'any' for generics to avoid linter errors
export type SupabaseClient = SupabaseClientType<any, any, any>;

// Haversine formula (returns distance in miles)
export function getHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// Fetch airport by IATA code
export async function fetchAirportByIata(
  supabase: SupabaseClient,
  iata: string
): Promise<Airport | null> {
  const { data, error } = await supabase
    .from('airports')
    .select('*')
    .ilike('iata', iata)
    .single();
  if (error || !data) return null;
  return data as unknown as Airport;
}

// Batch fetch airports by IATA codes
export async function batchFetchAirportsByIata(
  supabase: SupabaseClient,
  iataCodes: string[]
): Promise<Record<string, Airport | null>> {
  if (iataCodes.length === 0) return {};
  
  const uniqueCodes = [...new Set(iataCodes)];
  const { data, error } = await supabase
    .from('airports')
    .select('*')
    .in('iata', uniqueCodes);
  
  if (error || !data) return {};
  
  const result: Record<string, Airport | null> = {};
  uniqueCodes.forEach(code => {
    result[code] = null;
  });
  
  data.forEach(airport => {
    result[airport.iata] = airport as unknown as Airport;
  });
  
  return result;
}

// Fetch paths by region and distance
export async function fetchPaths(
  supabase: SupabaseClient,
  originRegion: string,
  destinationRegion: string,
  maxDistance: number
): Promise<Path[]> {
  const { data, error } = await supabase
    .from('path')
    .select('*')
    .eq('originRegion', originRegion)
    .eq('destinationRegion', destinationRegion)
    .lte('totalDistance', maxDistance)
    .limit(10000);
  if (error || !data) return [];
  return data as unknown as Path[];
}

// Fetch intra_routes by origin or destination
export async function fetchIntraRoutes(
  supabase: SupabaseClient,
  origin?: string,
  destination?: string
): Promise<IntraRoute[]> {
  let query = supabase.from('intra_routes').select('*');
  if (origin) query = query.eq('Origin', origin);
  if (destination) query = query.eq('Destination', destination);
  const { data, error } = await query;
  if (error || !data) return [];
  return data as unknown as IntraRoute[];
}

// Batch fetch intra routes for multiple origin-destination pairs
export async function batchFetchIntraRoutes(
  supabase: SupabaseClient,
  pairs: { origin: string; destination: string }[]
): Promise<Record<string, IntraRoute[]>> {
  if (pairs.length === 0) return {};
  
  const uniquePairs = [...new Set(pairs.map(p => `${p.origin}-${p.destination}`))];
  const result: Record<string, IntraRoute[]> = {};
  
  // Fetch all unique pairs in parallel
  await Promise.all(uniquePairs.map(async (pair) => {
    const [origin, destination] = pair.split('-');
    const routes = await fetchIntraRoutes(supabase, origin, destination);
    result[pair] = routes;
  }));
  
  return result;
} 