import { nanoid } from 'nanoid';

// JWT-like encryption configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret-key-change-in-production';
const TOKEN_EXPIRY_MINUTES = 10; // Tokens expire after 10 minutes

/**
 * Create a JWT-like token with header, payload, and signature
 */
function createJWTPayload(data: any): string {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
    kid: nanoid(16)
  };
  
  const payload = {
    data,
    iat: Math.floor(Date.now() / 1000), // Issued at
    exp: Math.floor(Date.now() / 1000) + (TOKEN_EXPIRY_MINUTES * 60), // Expiration
    jti: nanoid(16) // JWT ID
  };
  
  // Encode header and payload
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  
  // Create signature (simplified HMAC-like)
  const signature = createSignature(encodedHeader + '.' + encodedPayload);
  
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verify and decode JWT-like token
 */
function verifyJWTPayload(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }
    
    const [encodedHeader, encodedPayload, signature] = parts;
    
    // Verify signature
    const expectedSignature = createSignature(encodedHeader + '.' + encodedPayload);
    if (signature !== expectedSignature) {
      throw new Error('Invalid signature');
    }
    
    // Decode payload
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
    
    // Check expiration
    if (Date.now() / 1000 > payload.exp) {
      throw new Error('Token has expired');
    }
    
    return payload.data;
  } catch (error) {
    throw new Error('Failed to verify token');
  }
}

/**
 * Create a simple signature (in production, use proper HMAC)
 */
function createSignature(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  // Add JWT_SECRET to the hash
  for (let i = 0; i < JWT_SECRET.length; i++) {
    const char = JWT_SECRET.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  
  return Buffer.from(hash.toString()).toString('base64url');
}

/**
 * Encrypt response data using JWT-like encryption
 */
export function encryptResponseJWT(data: any): { token: string; expiresAt: number } {
  const token = createJWTPayload(data);
  const expiresAt = Date.now() + (TOKEN_EXPIRY_MINUTES * 60 * 1000);
  
  return {
    token,
    expiresAt
  };
}

/**
 * Decrypt response data using JWT-like decryption
 */
export function decryptResponseJWT(token: string): any {
  return verifyJWTPayload(token);
}

/**
 * Get JWT encryption configuration
 */
export function getJWTConfig() {
  return {
    tokenExpiryMinutes: TOKEN_EXPIRY_MINUTES,
    algorithm: 'HS256'
  };
}
