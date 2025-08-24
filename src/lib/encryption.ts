import { nanoid } from 'nanoid';

// Encryption configuration
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'your-super-secret-key-change-in-production';
const TOKEN_EXPIRY_MINUTES = 10; // Tokens expire after 10 minutes

/**
 * Simple XOR encryption for lightweight data protection
 * This is not cryptographically secure but provides basic obfuscation
 */
function xorEncrypt(data: string, key: string): string {
  let result = '';
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(result).toString('base64');
}

/**
 * Simple XOR decryption
 */
function xorDecrypt(encryptedData: string, key: string): string {
  const data = Buffer.from(encryptedData, 'base64').toString();
  let result = '';
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}

/**
 * Generate a unique encryption key for each request
 */
function generateEncryptionKey(): string {
  return nanoid(32);
}

/**
 * Create an encrypted response with embedded key
 */
export function encryptResponse(data: any): { encryptedData: string; key: string; timestamp: number } {
  const key = generateEncryptionKey();
  const timestamp = Date.now();
  
  // Create a payload with data, timestamp, and request ID
  const payload = {
    data,
    timestamp,
    requestId: nanoid(16),
    expiresAt: timestamp + (TOKEN_EXPIRY_MINUTES * 60 * 1000)
  };
  
  const jsonString = JSON.stringify(payload);
  const encryptedData = xorEncrypt(jsonString, key);
  
  return {
    encryptedData,
    key,
    timestamp
  };
}

/**
 * Decrypt response data (for frontend use)
 */
export function decryptResponse(encryptedData: string, key: string): any {
  try {
    const decryptedString = xorDecrypt(encryptedData, key);
    const payload = JSON.parse(decryptedString);
    
    // Check if token has expired
    if (Date.now() > payload.expiresAt) {
      throw new Error('Response token has expired');
    }
    
    return payload.data;
  } catch (error) {
    throw new Error('Failed to decrypt response data');
  }
}

/**
 * Validate encryption key format
 */
export function isValidEncryptionKey(key: string): boolean {
  return typeof key === 'string' && key.length === 32;
}

/**
 * Get encryption configuration for frontend
 */
export function getEncryptionConfig() {
  return {
    tokenExpiryMinutes: TOKEN_EXPIRY_MINUTES,
    keyLength: 32
  };
}
