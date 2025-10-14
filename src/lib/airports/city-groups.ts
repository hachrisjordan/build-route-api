import { createClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from '@/lib/env-utils';

// Cache for city groups data
let cityToAirports: Map<string, string[]> | null = null;
let airportToCity: Map<string, string> | null = null;
let loadPromise: Promise<void> | null = null;

/**
 * Fetch and cache city_groups data from Supabase
 * Uses singleton pattern to load once per process
 */
async function loadCityGroups(): Promise<void> {
  if (cityToAirports && airportToCity) {
    return; // Already loaded
  }

  if (loadPromise) {
    return loadPromise; // Loading in progress
  }

  loadPromise = (async () => {
    try {
      const { url, anonKey } = getSupabaseConfig();
      const supabase = createClient(url, anonKey);

      const { data, error } = await supabase
        .from('city_groups')
        .select('city_code, city_name, airports');

      if (error) {
        throw new Error(`Failed to fetch city_groups: ${error.message}`);
      }

      if (!data || data.length === 0) {
        console.warn('[city-groups] No city_groups data found in database');
        cityToAirports = new Map();
        airportToCity = new Map();
        return;
      }

      // Initialize maps
      cityToAirports = new Map();
      airportToCity = new Map();

      // Process each city group
      for (const row of data) {
        const cityCode = row.city_code;
        const airports = row.airports || [];

        if (cityCode && airports.length > 0) {
          cityToAirports.set(cityCode, airports);
          
          // Map each airport to its city
          for (const airport of airports) {
            airportToCity.set(airport, cityCode);
          }
        }
      }

      console.log(`[city-groups] Loaded ${cityToAirports.size} city groups with ${airportToCity.size} airports`);
    } catch (error) {
      console.error('[city-groups] Failed to load city groups:', error);
      // Initialize empty maps on error
      cityToAirports = new Map();
      airportToCity = new Map();
    }
  })();

  return loadPromise;
}

/**
 * Get city code for an airport
 * Returns the airport code itself if not in any city group
 */
export function getAirportCityCode(airportCode: string): string {
  if (!airportToCity) {
    throw new Error('City groups not loaded. Call loadCityGroups() first.');
  }
  return airportToCity.get(airportCode) || airportCode;
}

/**
 * Get all airports for a city code
 * Returns [cityCode] if not a multi-airport city
 */
export function getCityAirports(cityCode: string): string[] {
  if (!cityToAirports) {
    throw new Error('City groups not loaded. Call loadCityGroups() first.');
  }
  return cityToAirports.get(cityCode) || [cityCode];
}

/**
 * Check if two airports are in the same city
 */
export function isSameCity(airport1: string, airport2: string): boolean {
  if (airport1 === airport2) {
    return true; // Same airport
  }
  
  const city1 = getAirportCityCode(airport1);
  const city2 = getAirportCityCode(airport2);
  
  // If both are city codes, compare directly
  if (city1 === airport1 && city2 === airport2) {
    return airport1 === airport2;
  }
  
  // If one is a city code and the other is an airport, check if airport belongs to city
  if (city1 === airport1) {
    return city2 === airport1; // airport2 belongs to city airport1
  }
  if (city2 === airport2) {
    return city1 === airport2; // airport1 belongs to city airport2
  }
  
  // Both are airports, check if they belong to the same city
  return city1 === city2;
}

/**
 * Check if a code is a city code (vs airport code)
 */
export function isCityCode(code: string): boolean {
  if (!cityToAirports) {
    throw new Error('City groups not loaded. Call loadCityGroups() first.');
  }
  return cityToAirports.has(code);
}

/**
 * Normalize airport to city code if it belongs to a city group
 * Returns the airport code itself if not in any city group
 */
export function normalizeToCityCode(airportCode: string): string {
  return getAirportCityCode(airportCode);
}

/**
 * Initialize city groups (call this early in the application lifecycle)
 */
export async function initializeCityGroups(): Promise<void> {
  await loadCityGroups();
}

/**
 * Get cache statistics for debugging
 */
export function getCityGroupsStats(): {
  cityGroupsCount: number;
  airportsCount: number;
  isLoaded: boolean;
} {
  return {
    cityGroupsCount: cityToAirports?.size || 0,
    airportsCount: airportToCity?.size || 0,
    isLoaded: !!(cityToAirports && airportToCity)
  };
}

// Auto-initialize on module load
if (typeof window === 'undefined') {
  // Only auto-initialize on server side
  initializeCityGroups().catch(error => {
    console.error('[city-groups] Auto-initialization failed:', error);
  });
}
