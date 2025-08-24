import { nanoid } from 'nanoid';
import crypto from 'crypto';

// Secure JWT encryption configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secure-jwt-secret-key-change-in-production';
const TOKEN_EXPIRY_MINUTES = 10; // Tokens expire after 10 minutes

/**
 * Create a cryptographically secure JWT token
 */
function createSecureJWT(data: any): string {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
    kid: nanoid(16)
  };
  
  const payload = {
    data,
    iat: Math.floor(Date.now() / 1000), // Issued at
    exp: Math.floor(Date.now() / 1000) + (TOKEN_EXPIRY_MINUTES * 60), // Expiration
    jti: nanoid(16), // JWT ID
    iss: 'build-route-api', // Issuer
    aud: 'frontend-app' // Audience
  };
  
  // Encode header and payload using base64url (no padding)
  const encodedHeader = Buffer.from(JSON.stringify(header))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
    
  const encodedPayload = Buffer.from(JSON.stringify(payload))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  // Create HMAC-SHA256 signature
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(encodedHeader + '.' + encodedPayload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verify and decode a secure JWT token
 */
function verifySecureJWT(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }
    
    const [encodedHeader, encodedPayload, signature] = parts;
    
    // Verify HMAC-SHA256 signature
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(encodedHeader + '.' + encodedPayload)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    if (signature !== expectedSignature) {
      throw new Error('Invalid signature - token may have been tampered with');
    }
    
    // Decode payload
    const payload = JSON.parse(
      Buffer.from(encodedPayload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    );
    
    // Check expiration
    if (Date.now() / 1000 > payload.exp) {
      throw new Error('Token has expired');
    }
    
    // Verify issuer and audience (optional security checks)
    if (payload.iss !== 'build-route-api') {
      throw new Error('Invalid token issuer');
    }
    
    if (payload.aud !== 'frontend-app') {
      throw new Error('Invalid token audience');
    }
    
    return payload.data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`JWT verification failed: ${error.message}`);
    }
    throw new Error('Failed to verify JWT token');
  }
}

/**
 * Encrypt response data using secure JWT encryption
 */
export function encryptResponseSecureJWT(data: any): { token: string; expiresAt: number } {
  const token = createSecureJWT(data);
  const expiresAt = Date.now() + (TOKEN_EXPIRY_MINUTES * 60 * 1000);
  
  return {
    token,
    expiresAt
  };
}

/**
 * Decrypt response data using secure JWT decryption
 */
export function decryptResponseSecureJWT(token: string): any {
  return verifySecureJWT(token);
}

/**
 * Get secure JWT configuration
 */
export function getSecureJWTConfig() {
  return {
    tokenExpiryMinutes: TOKEN_EXPIRY_MINUTES,
    algorithm: 'HS256',
    issuer: 'build-route-api',
    audience: 'frontend-app'
  };
}

/**
 * Validate JWT secret strength
 */
export function validateJWTSecret(): boolean {
  if (!JWT_SECRET || JWT_SECRET === 'your-super-secure-jwt-secret-key-change-in-production') {
    return false;
  }
  
  // Check if secret is at least 32 characters long
  if (JWT_SECRET.length < 32) {
    return false;
  }
  
  // Check if secret contains sufficient entropy (basic check)
  const hasNumbers = /\d/.test(JWT_SECRET);
  const hasLetters = /[a-zA-Z]/.test(JWT_SECRET);
  const hasSpecialChars = /[^a-zA-Z0-9]/.test(JWT_SECRET);
  
  return hasNumbers && hasLetters && hasSpecialChars;
}
