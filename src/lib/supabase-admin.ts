import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSanitizedEnv } from './env-utils';

/**
 * Supabase Admin Client
 * Uses service role key for administrative operations
 * This client bypasses Row Level Security (RLS) policies
 */

let adminClient: SupabaseClient | null = null;

/**
 * Get or create the Supabase admin client
 * Uses service role key for full database access
 */
export function getSupabaseAdminClient(): SupabaseClient {
  if (adminClient) {
    console.log('[admin-client] Returning existing client');
    return adminClient;
  }

  const supabaseUrl = getSanitizedEnv('NEXT_PUBLIC_SUPABASE_URL') || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = getSanitizedEnv('SUPABASE_SERVICE_ROLE_KEY') || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[admin-client] Missing environment variables:');
    console.error('[admin-client] NEXT_PUBLIC_SUPABASE_URL:', supabaseUrl ? 'SET' : 'MISSING');
    console.error('[admin-client] SUPABASE_SERVICE_ROLE_KEY:', supabaseServiceKey ? 'SET' : 'MISSING');
    throw new Error('Missing Supabase environment variables for admin client');
  }

  try {
    adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  } catch (error) {
    console.error('[admin-client] Failed to create Supabase client:', error);
    throw error;
  }

  return adminClient;
}

/**
 * Pro Key Management Functions
 * These functions handle pro_key table operations with admin privileges
 */

export interface ProKey {
  pro_key: string;
  remaining: number;
  last_updated: string;
  created_at?: string;
}

/**
 * Get the pro_key with the highest remaining quota
 * @returns ProKey with highest remaining quota or null if none available
 */
export async function getAvailableProKey(): Promise<ProKey | null> {
  const admin = getSupabaseAdminClient();
  
  try {
    const { data, error } = await admin
      .from('pro_key')
      .select('pro_key, remaining, last_updated')
      .order('remaining', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Failed to fetch available pro_key:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    if (!data || !data.pro_key) {
      console.warn('No available pro_key found in database');
      return null;
    }

    console.log(`[admin-client] Retrieved pro_key with ${data.remaining} remaining quota`);
    return data;
  } catch (error) {
    console.error('Error in getAvailableProKey:', error);
    throw error;
  }
}

/**
 * Update the remaining quota for a specific pro_key
 * @param proKey The pro_key to update
 * @param remaining New remaining quota value
 * @returns Success boolean
 */
export async function updateProKeyRemaining(proKey: string, remaining: number): Promise<boolean> {
  const admin = getSupabaseAdminClient();
  
  try {
    const { error } = await admin
      .from('pro_key')
      .update({ 
        remaining, 
        last_updated: new Date().toISOString() 
      })
      .eq('pro_key', proKey);

    if (error) {
      console.error('Failed to update pro_key remaining:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    console.log(`[admin-client] Updated pro_key ${proKey} remaining to ${remaining}`);
    return true;
  } catch (error) {
    console.error('Error in updateProKeyRemaining:', error);
    return false;
  }
}

/**
 * Get all pro_keys with their current status
 * Useful for monitoring and admin dashboard
 * @returns Array of all pro_keys
 */
export async function getAllProKeys(): Promise<ProKey[]> {
  const admin = getSupabaseAdminClient();
  
  try {
    const { data, error } = await admin
      .from('pro_key')
      .select('*')
      .order('remaining', { ascending: false });

    if (error) {
      console.error('Failed to fetch all pro_keys:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    console.log(`[admin-client] Retrieved ${data?.length || 0} pro_keys`);
    return data || [];
  } catch (error) {
    console.error('Error in getAllProKeys:', error);
    throw error;
  }
}

/**
 * Add a new pro_key to the database
 * @param proKey The new pro_key to add
 * @param initialQuota Initial quota for the pro_key (default: 1000)
 * @returns Success boolean
 */
export async function addProKey(proKey: string, initialQuota: number = 1000): Promise<boolean> {
  const admin = getSupabaseAdminClient();
  
  try {
    const { error } = await admin
      .from('pro_key')
      .insert({
        pro_key: proKey,
        remaining: initialQuota,
        last_updated: new Date().toISOString()
      });

    if (error) {
      console.error('Failed to add new pro_key:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    console.log(`[admin-client] Added new pro_key with ${initialQuota} quota`);
    return true;
  } catch (error) {
    console.error('Error in addProKey:', error);
    return false;
  }
}

/**
 * Remove a pro_key from the database
 * @param proKey The pro_key to remove
 * @returns Success boolean
 */
export async function removeProKey(proKey: string): Promise<boolean> {
  const admin = getSupabaseAdminClient();
  
  try {
    const { error } = await admin
      .from('pro_key')
      .delete()
      .eq('pro_key', proKey);

    if (error) {
      console.error('Failed to remove pro_key:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    console.log(`[admin-client] Removed pro_key ${proKey}`);
    return true;
  } catch (error) {
    console.error('Error in removeProKey:', error);
    return false;
  }
}

/**
 * Health check for admin client
 * @returns Boolean indicating if admin client can connect to database
 */
export async function testAdminConnection(): Promise<boolean> {
  try {
    console.log('[admin-client] Initializing admin client...');
    const admin = getSupabaseAdminClient();
    
    console.log('[admin-client] Admin client initialized, testing basic query...');
    console.log('[admin-client] Attempting to query pro_key table...');
    
    const result = await admin
      .from('pro_key')
      .select('*')
      .limit(1);
    
    console.log('[admin-client] Raw query result:', JSON.stringify(result, null, 2));
    
    const { data, error } = result;
    
    if (error) {
      console.error('Admin connection test failed with Supabase error:', {
        message: error.message || 'NO MESSAGE',
        details: error.details || 'NO DETAILS',
        hint: error.hint || 'NO HINT',
        code: error.code || 'NO CODE',
        fullError: JSON.stringify(error, null, 2)
      });
      return false;
    }
    
    console.log('[admin-client] Connection test successful!');
    console.log('[admin-client] Query data:', data);
    return true;
  } catch (error) {
    console.error('Admin connection test threw exception:', {
      message: error instanceof Error ? error.message : 'NO MESSAGE',
      stack: error instanceof Error ? error.stack : 'NO STACK',
      name: error instanceof Error ? error.name : 'NO NAME',
      fullError: JSON.stringify(error, null, 2)
    });
    return false;
  }
}
