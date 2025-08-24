import { NextResponse } from 'next/server';
import { encryptResponseJWT } from '@/lib/jwt-encryption';

export async function GET() {
  try {
    // Test data
    const testData = {
      message: 'Hello from encrypted API!',
      timestamp: new Date().toISOString(),
      testArray: [1, 2, 3, 4, 5],
      testObject: {
        key: 'value',
        nested: {
          deep: 'data'
        }
      }
    };
    
    // Encrypt the test data
    const { token, expiresAt } = encryptResponseJWT(testData);
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt,
      originalData: testData, // For testing purposes only - remove in production
      message: 'Test data encrypted successfully. Copy the token to test decryption.'
    });
    
  } catch (error) {
    console.error('Encryption test error:', error);
    return NextResponse.json(
      { error: 'Encryption test failed', details: (error as Error).message },
      { status: 500 }
    );
  }
}
