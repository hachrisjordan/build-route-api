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