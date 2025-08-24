import { nanoid } from 'nanoid';
import crypto from 'crypto';

// AES encryption configuration
const ENCRYPTION_KEY = process.env.ENCRYPTION_SECRET || 'your-super-secure-encryption-secret-key-change-in-production';
const TOKEN_EXPIRY_MINUTES = 10; // Tokens expire after 10 minutes

// Derive a 32-byte key from the environment variable
function deriveKey(): Buffer {
  return crypto.pbkdf2Sync(ENCRYPTION_KEY, 'salt', 100000, 32, 'sha256');
}

/**
 * Encrypt data using AES-256-GCM (Galois/Counter Mode)
 * This provides both encryption and authentication
 */
function encryptData(data: any): { encryptedData: string; iv: string; authTag: string } {
  const key = deriveKey();
  const iv = crypto.randomBytes(16); // Initialization vector
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    encryptedData: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

/**
 * Decrypt data using AES-256-GCM
 */
function decryptData(encryptedData: string, iv: string, authTag: string): any {
  try {
    const key = deriveKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  } catch (error) {
    throw new Error('Failed to decrypt data - invalid or corrupted token');
  }
}

/**
 * Create an encrypted response with embedded metadata
 */
export function encryptResponseAES(data: any): { token: string; expiresAt: number } {
  const payload = {
    data,
    timestamp: Date.now(),
    requestId: nanoid(16),
    expiresAt: Date.now() + (TOKEN_EXPIRY_MINUTES * 60 * 1000)
  };
  
  const { encryptedData, iv, authTag } = encryptData(payload);
  
  // Create a token that combines all encrypted components
  const token = `${encryptedData}.${iv}.${authTag}`;
  const expiresAt = payload.expiresAt;
  
  return {
    token,
    expiresAt
  };
}

/**
 * Decrypt response data
 */
export function decryptResponseAES(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }
    
    const [encryptedData, iv, authTag] = parts;
    
    // Validate that all parts exist
    if (!encryptedData || !iv || !authTag) {
      throw new Error('Invalid token format - missing components');
    }
    
    // Decrypt the data
    const payload = decryptData(encryptedData, iv, authTag);
    
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
 * Validate encryption key strength
 */
export function validateEncryptionKey(): boolean {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY === 'your-super-secure-encryption-secret-key-change-in-production') {
    return false;
  }
  
  // Check if key is at least 32 characters long
  if (ENCRYPTION_KEY.length < 32) {
    return false;
  }
  
  return true;
}

/**
 * Get encryption configuration
 */
export function getAESConfig() {
  return {
    algorithm: 'AES-256-GCM',
    keyDerivation: 'PBKDF2-SHA256',
    tokenExpiryMinutes: TOKEN_EXPIRY_MINUTES,
    keyLength: 32
  };
}
