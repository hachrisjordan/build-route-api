import { createBrowserClient } from '@supabase/ssr';
import { getSupabaseConfig } from './env-utils';

const { url: supabaseUrl, anonKey: supabaseAnonKey } = getSupabaseConfig();

export const createSupabaseBrowserClient = () => {
  // Runtime validation
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables');
  }
  
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}; 