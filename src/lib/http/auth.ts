import { NextRequest, NextResponse } from 'next/server';

/**
 * Validates API key from request headers
 * @param req NextRequest object
 * @returns API key if valid, null if missing
 */
export function validateApiKey(req: NextRequest): string | null {
  return req.headers.get('partner-authorization');
}

/**
 * Creates a 400 response for missing API key
 * @returns NextResponse with error message
 */
export function createMissingApiKeyResponse(): NextResponse {
  return NextResponse.json({ error: 'API key is required' }, { status: 400 });
}

/**
 * Validates API key and returns error response if missing
 * @param req NextRequest object
 * @returns Object with apiKey and errorResponse (if any)
 */
export function validateApiKeyWithResponse(req: NextRequest): {
  apiKey: string | null;
  errorResponse?: NextResponse;
} {
  const apiKey = validateApiKey(req);
  
  if (!apiKey) {
    return {
      apiKey: null,
      errorResponse: createMissingApiKeyResponse()
    };
  }
  
  return { apiKey };
}
