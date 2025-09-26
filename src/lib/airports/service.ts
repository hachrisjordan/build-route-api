import { buildAirportMapAndDirectDistance } from '@/lib/route-helpers';

export async function getAirportData(
  origin: string,
  destination: string,
  segmentPool: Record<string, any>,
  supabaseUrl: string,
  supabaseAnonKey: string
) {
  return buildAirportMapAndDirectDistance(origin, destination, segmentPool, supabaseUrl, supabaseAnonKey);
}


