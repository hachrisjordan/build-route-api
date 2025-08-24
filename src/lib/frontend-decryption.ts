/**
 * Frontend decryption utilities for live-search API responses
 * This file should be copied to your frontend repository
 */

// Configuration - should match your backend
const TOKEN_EXPIRY_MINUTES = 10;

/**
 * Decrypt a JWT-like token from the backend
 * @param token - The encrypted token from the API response
 * @returns The decrypted data
 */
export function decryptLiveSearchResponse(token: string): any {
  try {
    // Split the token into parts
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }
    
    const [, encodedPayload] = parts;
    
    // Decode the payload
    if (!encodedPayload) {
      throw new Error('Invalid token payload');
    }
    const payload = JSON.parse(atob(encodedPayload));
    
    // Check if token has expired
    const currentTime = Math.floor(Date.now() / 1000);
    if (currentTime > payload.exp) {
      throw new Error('Response token has expired');
    }
    
    return payload.data;
  } catch (error) {
    console.error('Failed to decrypt response:', error);
    throw new Error('Failed to decrypt response data');
  }
}

/**
 * Check if a response is encrypted
 */
export function isEncryptedResponse(response: any): boolean {
  return response && response.encrypted === true && response.token;
}

/**
 * Process a live-search API response
 * @param response - The raw API response
 * @returns The decrypted data or the original response if not encrypted
 */
export function processLiveSearchResponse(response: any): any {
  if (isEncryptedResponse(response)) {
    return decryptLiveSearchResponse(response.token);
  }
  
  // If not encrypted, return as-is (for backward compatibility)
  return response;
}

/**
 * Get token expiration info
 */
export function getTokenExpiration(response: any): { expiresAt: number; isExpired: boolean } | null {
  if (!isEncryptedResponse(response)) {
    return null;
  }
  
  const expiresAt = response.expiresAt;
  const isExpired = Date.now() > expiresAt;
  
  return { expiresAt, isExpired };
}

/**
 * Utility to check if a token will expire soon (within 1 minute)
 */
export function isTokenExpiringSoon(response: any): boolean {
  const expiration = getTokenExpiration(response);
  if (!expiration) return false;
  
  const oneMinute = 60 * 1000;
  return (expiration.expiresAt - Date.now()) < oneMinute;
}
