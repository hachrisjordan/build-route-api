import { NextResponse } from 'next/server';
import { encryptResponseAES, validateEncryptionKey } from '@/lib/aes-encryption';

export async function GET() {
  try {
    // Check if encryption key is properly configured
    const isKeyValid = validateEncryptionKey();
    
    if (!isKeyValid) {
      return NextResponse.json({
        error: 'ENCRYPTION_SECRET is not properly configured',
        message: 'Please set a strong ENCRYPTION_SECRET in your environment variables',
        requirements: [
          'At least 32 characters long',
          'Not the default placeholder value'
        ]
      }, { status: 500 });
    }
    
    // Test data
    const testData = {
      message: 'Hello from AES ENCRYPTED API!',
      timestamp: new Date().toISOString(),
      security: {
        algorithm: 'AES-256-GCM',
        keyDerivation: 'PBKDF2-SHA256',
        encryptionMode: 'Galois/Counter Mode',
        tokenExpiry: '10 minutes'
      },
      testArray: [1, 2, 3, 4, 5],
      testObject: {
        key: 'value',
        nested: {
          deep: 'data'
        }
      }
    };
    
    // Encrypt the test data with AES
    const { token, expiresAt } = encryptResponseAES(testData);
    
    // Show token structure (this is safe - it's encrypted)
    const [encryptedData, iv, authTag] = token.split('.');
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt,
      tokenInfo: {
        encryptedData: encryptedData.substring(0, 20) + '...',
        iv: iv.substring(0, 20) + '...',
        authTag: authTag.substring(0, 20) + '...',
        totalLength: token.length
      },
      originalData: testData, // For testing purposes only - remove in production
      message: 'AES encryption test successful! This data is ACTUALLY encrypted and cannot be decoded without the secret key.',
      securityFeatures: [
        'AES-256-GCM encryption (industry standard)',
        'PBKDF2 key derivation (100,000 iterations)',
        'Random initialization vector (IV)',
        'Authentication tag for integrity',
        'Token expiration (10 minutes)',
        'Unique request ID for each token'
      ],
      whyThisIsSecure: [
        'Data is encrypted with AES-256, not just encoded',
        'Cannot be decoded without knowing the secret key',
        'Uses cryptographically secure random numbers',
        'Provides both confidentiality and authenticity',
        'Even if someone gets the token, they cannot read the data'
      ]
    });
    
  } catch (error) {
    console.error('AES encryption test error:', error);
    return NextResponse.json(
      { error: 'AES encryption test failed', details: (error as Error).message },
      { status: 500 }
    );
  }
}
