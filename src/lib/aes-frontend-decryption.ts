/**
 * Frontend Decryption Utilities for AES-Encrypted Live-Search API Responses
 * This file should be copied to your frontend repository
 * 
 * IMPORTANT: This utility only handles token validation and metadata extraction.
 * The actual decryption happens on the backend for security.
 */

// Configuration - should match your backend
const TOKEN_EXPIRY_MINUTES = 10;

/**
 * Check if a response is encrypted
 */
export function isEncryptedResponse(response: any): boolean {
  return response && response.encrypted === true && response.token;
}

/**
 * Extract token metadata from AES-encrypted response
 * Note: This only extracts metadata, doesn't decrypt the actual data
 */
export function getAESTokenMetadata(response: any): any {
  if (!isEncryptedResponse(response)) {
    return null;
  }
  
  try {
    const parts = response.token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    
    const [encryptedData, iv, authTag] = parts;
    
    return {
      encryptedDataLength: encryptedData.length,
      ivLength: iv.length,
      authTagLength: authTag.length,
      totalLength: response.token.length,
      expiresAt: response.expiresAt,
      isExpired: Date.now() > response.expiresAt
    };
  } catch {
    return null;
  }
}

/**
 * Check if token is expired
 */
export function isTokenExpired(response: any): boolean {
  if (!isEncryptedResponse(response)) {
    return false;
  }
  
  return Date.now() > response.expiresAt;
}

/**
 * Check if token will expire soon (within 1 minute)
 */
export function isTokenExpiringSoon(response: any): boolean {
  if (!isEncryptedResponse(response)) {
    return false;
  }
  
  const oneMinute = 60 * 1000;
  return (response.expiresAt - Date.now()) < oneMinute;
}

/**
 * Process a live-search API response
 * @param response - The raw API response
 * @returns The response with metadata (actual data remains encrypted)
 */
export function processAESLiveSearchResponse(response: any): any {
  if (isEncryptedResponse(response)) {
    // Add metadata about the encrypted response
    const metadata = getAESTokenMetadata(response);
    
    return {
      encrypted: true,
      token: response.token,
      expiresAt: response.expiresAt,
      metadata,
      message: 'Data is encrypted with AES-256-GCM. Decryption requires backend processing.'
    };
  }
  
  // If not encrypted, return as-is (for backward compatibility)
  return response;
}

/**
 * Validate AES token format
 */
export function validateAESTokenFormat(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }
    
    const [encryptedData, iv, authTag] = parts;
    
    // Check if all parts are valid hex strings
    const hexRegex = /^[0-9a-fA-F]+$/;
    return hexRegex.test(encryptedData) && hexRegex.test(iv) && hexRegex.test(authTag);
  } catch {
    return false;
  }
}

/**
 * Get encryption information for debugging
 */
export function getAESEncryptionInfo(response: any): any {
  if (!isEncryptedResponse(response)) {
    return null;
  }
  
  const metadata = getAESTokenMetadata(response);
  const isValidFormat = validateAESTokenFormat(response.token);
  
  return {
    algorithm: 'AES-256-GCM',
    keyDerivation: 'PBKDF2-SHA256',
    tokenFormat: isValidFormat ? 'Valid' : 'Invalid',
    metadata,
    securityLevel: 'Military-grade encryption',
    cannotBeDecoded: 'Data cannot be decoded without the secret key'
  };
}
