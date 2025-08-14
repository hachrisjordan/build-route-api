import { createClient } from '@supabase/supabase-js';
import { getSanitizedEnv } from './env-utils';

interface ReliabilityEntry {
  code: string;
  min_count: number;
  exemption?: string;
  ffp_program?: string[];
}

interface ReliabilityCache {
  data: ReliabilityEntry[];
  timestamp: number;
}

// Shared cache instance
let reliabilityCache: ReliabilityCache | null = null;
let ongoingFetch: Promise<ReliabilityEntry[]> | null = null;

const RELIABILITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Shared reliability table cache with concurrency control.
 * Ensures only one fetch happens at a time across all endpoints.
 */
export async function getReliabilityTableCached(): Promise<ReliabilityEntry[]> {
  const now = Date.now();
  
  // Return cached data if still valid
  if (reliabilityCache && (now - reliabilityCache.timestamp) < RELIABILITY_CACHE_TTL_MS) {
    return reliabilityCache.data;
  }
  
  // If a fetch is already in progress, wait for it
  if (ongoingFetch) {
    return await ongoingFetch;
  }
  
  // Start new fetch and store the promise
  ongoingFetch = fetchReliabilityTable();
  
  try {
    const data = await ongoingFetch;
    
    // Update cache with fresh data
    reliabilityCache = {
      data,
      timestamp: now
    };
    
    return data;
  } catch (error) {
    console.error('[reliability-cache] Failed to fetch reliability table:', error);
    
    // Return cached data if available, even if expired
    if (reliabilityCache) {
      console.warn('[reliability-cache] Returning stale cache due to fetch error');
      return reliabilityCache.data;
    }
    
    // Return empty array as fallback
    return [];
  } finally {
    // Clear the ongoing fetch promise
    ongoingFetch = null;
  }
}

/**
 * Internal function to fetch reliability table from Supabase
 */
async function fetchReliabilityTable(): Promise<ReliabilityEntry[]> {
  const supabaseUrl = getSanitizedEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = getSanitizedEnv('SUPABASE_SERVICE_ROLE_KEY');
  
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase environment variables');
  }
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from('reliability')
    .select('code, min_count, exemption, ffp_program');
  
  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }
  
  return data || [];
}

/**
 * Convert reliability table to map for fast lookups
 */
export function getReliabilityMap(table: ReliabilityEntry[]): Record<string, { min_count: number; exemption?: string }> {
  const map: Record<string, { min_count: number; exemption?: string }> = {};
  for (const row of table) {
    map[row.code] = { min_count: row.min_count, exemption: row.exemption };
  }
  return map;
}

/**
 * Clear the cache (useful for testing or forced refresh)
 */
export function clearReliabilityCache(): void {
  reliabilityCache = null;
  ongoingFetch = null;
}
