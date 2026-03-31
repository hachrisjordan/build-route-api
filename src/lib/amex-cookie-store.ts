import { getSupabaseAdminClient } from './supabase-admin';

type AmexCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
};

/**
 * Build a Cookie header string from AmEx cookies stored in Supabase.
 * Returns null if no cookies are available.
 */
export async function buildAmexCookieHeaderFromStore(): Promise<string | null> {
  const admin = getSupabaseAdminClient();

  const { data, error } = await admin
    .from('program')
    .select('cookies')
    .eq('code', 'AMEX')
    .maybeSingle();

  if (error) {
    console.error('[AmEx] Failed to load cookies from Supabase:', error);
    return null;
  }

  const cookies = (data?.cookies ?? []) as AmexCookie[];
  if (!Array.isArray(cookies) || cookies.length === 0) {
    console.warn('[AmEx] No cookies stored for AMEX in program table');
    return null;
  }

  const parts: string[] = [];
  for (const cookie of cookies) {
    if (!cookie?.name || !cookie?.value) continue;

    const domain = (cookie.domain || '').toLowerCase();
    if (!domain.includes('americanexpress.com')) continue;

    parts.push(`${cookie.name}=${cookie.value}`);
  }

  if (parts.length === 0) {
    console.warn('[AmEx] Stored cookies did not include any americanexpress.com entries');
    return null;
  }

  return parts.join('; ');
}

/**
 * Ensure process.env.AMEX_COOKIE is populated from Supabase if not already set.
 * Returns the effective cookie header string or null if none is available.
 */
export async function ensureAmexCookieEnvFromStore(): Promise<string | null> {
  if (process.env.AMEX_COOKIE) {
    return process.env.AMEX_COOKIE;
  }

  try {
    const header = await buildAmexCookieHeaderFromStore();
    if (header) {
      process.env.AMEX_COOKIE = header;
      console.log('[AmEx] Loaded AMEX_COOKIE from Supabase store');
      return header;
    }
    return null;
  } catch (error) {
    console.error('[AmEx] Failed to ensure AMEX_COOKIE from store:', error);
    return null;
  }
}

