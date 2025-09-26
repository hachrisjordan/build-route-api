import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from '@/lib/env-utils';
import { PzRecord } from '@/types/availability-v2';

const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getSupabaseConfig();

export async function fetchUaPzRecords(startDate: string, endDate: string): Promise<PzRecord[]> {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from('pz')
    .select('flight_number, origin_airport, destination_airport, departure_date, in, xn')
    .like('flight_number', 'UA%')
    .gte('departure_date', startDate)
    .lte('departure_date', endDate);

  if (error) {
    console.error('Error fetching pz data:', error);
    return [];
  }
  return data || [];
}


