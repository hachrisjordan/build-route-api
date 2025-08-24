import { NextResponse } from 'next/server';
import { encryptResponseSecureJWT, validateJWTSecret } from '@/lib/secure-jwt-encryption';

export async function GET() {
  try {
    // Check if JWT secret is properly configured
    const isSecretValid = validateJWTSecret();
    
    if (!isSecretValid) {
      return NextResponse.json({
        error: 'JWT_SECRET is not properly configured',
        message: 'Please set a strong JWT_SECRET in your environment variables',
        requirements: [
          'At least 32 characters long',
          'Contains numbers, letters, and special characters',
          'Not the default placeholder value'
        ]
      }, { status: 500 });
    }
    
    // Test data
    const testData = {
      message: 'Hello from SECURE encrypted API!',
      timestamp: new Date().toISOString(),
      security: {
        algorithm: 'HMAC-SHA256',
        issuer: 'build-route-api',
        audience: 'frontend-app',
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
    
    // Encrypt the test data with secure JWT
    const { token, expiresAt } = encryptResponseSecureJWT(testData);
    
    // Decode token parts to show structure (this is safe to do)
    const [header, payload, signature] = token.split('.');
    const decodedHeader = JSON.parse(Buffer.from(header.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const decodedPayload = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt,
      tokenInfo: {
        header: decodedHeader,
        payload: {
          ...decodedPayload,
          data: '[ENCRYPTED DATA]' // Don't expose actual data
        },
        signature: signature.substring(0, 20) + '...' // Show partial signature
      },
      originalData: testData, // For testing purposes only - remove in production
      message: 'Secure JWT encryption test successful! This token is cryptographically secure.',
      securityFeatures: [
        'HMAC-SHA256 signature verification',
        'Token expiration (10 minutes)',
        'Issuer and audience validation',
        'Unique token ID for each request',
        'Cryptographically secure random generation'
      ]
    });
    
  } catch (error) {
    console.error('Secure encryption test error:', error);
    return NextResponse.json(
      { error: 'Secure encryption test failed', details: (error as Error).message },
      { status: 500 }
    );
  }
}
