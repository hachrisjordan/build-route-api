/**
 * Secure Frontend Decryption Utilities for Live-Search API Responses
 * This file should be copied to your frontend repository
 * 
 * IMPORTANT: This is a simplified frontend-only implementation.
 * The actual JWT verification happens on the backend for security.
 * This utility provides basic token validation and data extraction.
 */

// Configuration - should match your backend
const TOKEN_EXPIRY_MINUTES = 10;

/**
 * Basic JWT token validation (frontend-safe)
 * Note: Full verification happens on backend - this is just for UX
 */
export function validateJWTToken(token: string): { isValid: boolean; error?: string } {
  try {
    // Split the token into parts
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { isValid: false, error: 'Invalid token format' };
    }
    
    const [, encodedPayload] = parts;
    
    // Decode the payload (this is safe to do on frontend)
    const payload = JSON.parse(atob(encodedPayload));
    
    // Check if token has expired
    const currentTime = Math.floor(Date.now() / 1000);
    if (currentTime > payload.exp) {
      return { isValid: false, error: 'Response token has expired' };
    }
    
    // Verify issuer and audience
    if (payload.iss !== 'build-route-api') {
      return { isValid: false, error: 'Invalid token issuer' };
    }
    
    if (payload.aud !== 'frontend-app') {
      return { isValid: false, error: 'Invalid token audience' };
    }
    
    return { isValid: true };
  } catch (error) {
    return { isValid: false, error: 'Failed to validate token' };
  }
}

/**
 * Extract data from JWT token (frontend-safe)
 * Note: This only extracts data, doesn't verify signature
 */
export function extractDataFromJWT(token: string): any {
  try {
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
    
    return payload.data;
  } catch (error) {
    throw new Error('Failed to extract data from token');
  }
}

/**
 * Check if a response is encrypted
 */
export function isEncryptedResponse(response: any): boolean {
  return response && response.encrypted === true && response.token;
}

/**
 * Process a live-search API response securely
 * @param response - The raw API response
 * @returns The extracted data or the original response if not encrypted
 */
export function processLiveSearchResponseSecure(response: any): any {
  if (isEncryptedResponse(response)) {
    // Validate the token first
    const validation = validateJWTToken(response.token);
    if (!validation.isValid) {
      throw new Error(validation.error || 'Token validation failed');
    }
    
    // Extract the data
    return extractDataFromJWT(response.token);
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
  
  try {
    const parts = response.token.split('.');
    const payload = JSON.parse(atob(parts[1]));
    const expiresAt = payload.exp * 1000; // Convert to milliseconds
    const isExpired = Date.now() > expiresAt;
    
    return { expiresAt, isExpired };
  } catch {
    return null;
  }
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

/**
 * Get token metadata (issuer, audience, issued at, etc.)
 */
export function getTokenMetadata(response: any): any {
  if (!isEncryptedResponse(response)) {
    return null;
  }
  
  try {
    const parts = response.token.split('.');
    const payload = JSON.parse(atob(parts[1]));
    
    return {
      issuer: payload.iss,
      audience: payload.aud,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
      tokenId: payload.jti
    };
  } catch {
    return null;
  }
}
