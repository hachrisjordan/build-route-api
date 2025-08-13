/**
 * Sanitizes environment variables by removing invisible Unicode characters
 * that can cause URL parsing errors
 */
export function sanitizeEnvVar(value: string | undefined): string {
  if (!value) return '';
  
  // Remove all non-ASCII characters including invisible Unicode characters
  // like left-to-right isolate (⁦) and pop directional isolate (⁩)
  return value.replace(/[^\x00-\x7F]/g, '');
}

/**
 * Gets a sanitized environment variable
 */
export function getSanitizedEnv(key: string): string {
  return sanitizeEnvVar(process.env[key]);
}

/**
 * Gets Supabase configuration with sanitized environment variables
 * Returns empty strings if variables are missing (for build-time compatibility)
 */
export function getSupabaseConfig() {
  const url = getSanitizedEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = getSanitizedEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceRoleKey = getSanitizedEnv('SUPABASE_SERVICE_ROLE_KEY');
  
  return {
    url,
    anonKey,
    serviceRoleKey,
  };
}

/**
 * Gets Supabase configuration and validates that required variables are present
 * Throws an error if required variables are missing (for runtime validation)
 */
export function getValidatedSupabaseConfig() {
  const config = getSupabaseConfig();
  
  if (!config.url || !config.serviceRoleKey) {
    throw new Error('Missing required Supabase environment variables');
  }
  
  return config;
}

/**
 * Validates that required environment variables are set and sanitized
 */
export function validateRequiredEnvVars(requiredVars: string[]): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  
  for (const varName of requiredVars) {
    const value = getSanitizedEnv(varName);
    if (!value) {
      missing.push(varName);
    }
  }
  
  return {
    valid: missing.length === 0,
    missing,
  };
}
