import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/[^\x00-\x7F]/g, '') || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.replace(/[^\x00-\x7F]/g, '') || '';

export const createSupabaseServerClient = () => {
  const cookieStore = cookies();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get: (key: string) => cookieStore.get(key)?.value,
      set: (key: string, value: string, options: any) => {},
      remove: (key: string, options: any) => {},
    },
  });
}; 