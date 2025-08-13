import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getSupabaseConfig } from './env-utils';

const { url: supabaseUrl, anonKey: supabaseAnonKey } = getSupabaseConfig();

export const createSupabaseServerClient = () => {
  // Runtime validation
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables');
  }
  
  const cookieStore = cookies();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get: (key: string) => cookieStore.get(key)?.value,
      set: (key: string, value: string, options: any) => {},
      remove: (key: string, options: any) => {},
    },
  });
}; 