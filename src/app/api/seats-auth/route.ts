import { NextRequest, NextResponse } from 'next/server';
import { getSanitizedEnv } from '@/lib/env-utils';
import { 
  SeatsAuthRequestSchema, 
  SeatsAuthErrorResponse,
  REQUIRED_ENV_VARS 
} from './schema';

/**
 * POST /api/seats-auth
 * OAuth2 token exchange endpoint for seats.aero
 * 
 * Required parameters:
 * - code: Authorization code from seats.aero
 * - state: State parameter for CSRF protection
 * 
 * Environment variables required:
 * - SEATS_AERO_CLIENT_ID: OAuth2 client ID
 * - SEATS_AERO_CLIENT_SECRET: OAuth2 client secret
 * - SEATS_AERO_REDIRECT_URI: OAuth2 redirect URI
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    // Validate request body using Zod schema
    const validationResult = SeatsAuthRequestSchema.safeParse(body);
    if (!validationResult.success) {
      const errors = validationResult.error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message
      }));
      
      return NextResponse.json(
        { 
          error: 'Invalid request parameters',
          details: 'Request validation failed',
          validationErrors: errors,
          required: ['code', 'state']
        } satisfies SeatsAuthErrorResponse,
        { status: 400 }
      );
    }

    const { code, state } = validationResult.data;

    // Get and validate environment variables
    const envVars = REQUIRED_ENV_VARS.reduce((acc, varName) => {
      acc[varName] = getSanitizedEnv(varName);
      return acc;
    }, {} as Record<string, string>);

    const missingVars = REQUIRED_ENV_VARS.filter(varName => !envVars[varName]);

    if (missingVars.length > 0) {
      return NextResponse.json(
        { 
          error: 'Missing required environment variables',
          missing: missingVars,
          message: 'Please configure the required environment variables for seats.aero OAuth2'
        } satisfies SeatsAuthErrorResponse,
        { status: 500 }
      );
    }

    const { SEATS_AERO_CLIENT_ID: clientId, SEATS_AERO_CLIENT_SECRET: clientSecret, SEATS_AERO_REDIRECT_URI: redirectUri } = envVars;

    // Prepare OAuth2 token request payload
    const tokenRequestPayload = {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      state,
      scope: 'openid' // Hardcoded as specified
    };

    // Make OAuth2 token request to seats.aero
    const response = await fetch('https://seats.aero/oauth2/token', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'Cookie': '__Host-source=aeroplan; __cf_bm=yDjnmmbCqGffgloPcsckMqie4iXpXvG8VDO4.ZgM3aU-1755837791-1.0.1.1-qUyOq1U6tP.A0F.j5DqdaelGR6tQUSOKx5M5gcxJte1LO_5ye8UAgN7QMjPH__oJb88lVs.qY3sMnHZ2pxjYqw06HVdtNwx1PfBlKcVFAg4; __ss_sid=4dff5014-46ca-43f7-97e1-b72b56f384c7; _abck=7XNoCGvITuIq83TEg6wFK9MdoQAdq-QAOuKyC3IbRI117g_G-TfF_Cx6QImOb09ZP9GBMpZAdixlTOodohd6dcFETRkkYQABoNpy8UO65mRG0MzNMfBKnxbF2eQWpov20opLigoP8QJxSK_H3IhX0-vB9ZshJ5NFset0KTmoo4Q4XnhQmpYNQpbpGo0okvUylGB-h5iDv3dox-N5P574irw9SBQfYHOb7XpQMB5CCnOJrWTRSIzvH1GAmPwvu3W0NOfBMlLKvfn65IJutFOYgJVKUeQiCx6in5NE25Ym7oIXFzZ_hSSOZU7uw1Kh8UeR8JoYxCQ4USBD89J1gs6C1Te6ipvKCZeUosOiOFAyZIIF1SnjiFdLjfZ6338ks_cG; bm_sz=30N5XVqWw8eybrEe7pqLRGZKYAN'
      },
      body: JSON.stringify(tokenRequestPayload)
    });

    // Handle rate limiting
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      return NextResponse.json(
        {
          error: 'Rate limit exceeded. Please try again later.',
          retryAfter: retryAfter ? Number(retryAfter) : undefined,
        } satisfies SeatsAuthErrorResponse,
        { status: 429 }
      );
    }

    // Handle other HTTP errors
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Seats.aero OAuth2 error:', {
        status: response.status,
        statusText: response.statusText,
        body: errorText
      });

      return NextResponse.json(
        { 
          error: `Seats.aero OAuth2 Error: ${response.statusText}`,
          status: response.status,
          details: errorText
        } satisfies SeatsAuthErrorResponse,
        { status: response.status }
      );
    }

    // Parse successful response
    const tokenData = await response.json();

    // Return the token data
    return NextResponse.json({
      success: true,
      data: tokenData,
      metadata: {
        timestamp: new Date().toISOString(),
        endpoint: 'seats-auth',
        scope: 'openid',
        redirectUri
      }
    });

  } catch (error: any) {
    console.error('Error in /api/seats-auth:', error);
    
    // Handle specific error types
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return NextResponse.json(
        { 
          error: 'Network error occurred while contacting seats.aero',
          details: error.message
        } satisfies SeatsAuthErrorResponse,
        { status: 500 }
      );
    }

    return NextResponse.json(
      { 
        error: error.message || 'Internal server error',
        type: error.name || 'UnknownError'
      } satisfies SeatsAuthErrorResponse,
      { status: 500 }
    );
  }
}

/**
 * GET /api/seats-auth
 * Health check and configuration info endpoint
 */
export async function GET() {
  try {
    const envVars = REQUIRED_ENV_VARS.reduce((acc, varName) => {
      acc[varName] = getSanitizedEnv(varName);
      return acc;
    }, {} as Record<string, string>);

    const configStatus = REQUIRED_ENV_VARS.reduce((acc, varName) => {
      acc[varName] = !!envVars[varName];
      return acc;
    }, {} as Record<string, boolean>);

    const allConfigured = Object.values(configStatus).every(Boolean);

    return NextResponse.json({
      endpoint: 'seats-auth',
      status: allConfigured ? 'configured' : 'misconfigured',
      configuration: configStatus,
      message: allConfigured 
        ? 'Seats.aero OAuth2 endpoint is properly configured'
        : 'Some required environment variables are missing',
      usage: {
        method: 'POST',
        requiredBody: ['code', 'state'],
        description: 'Exchange authorization code for OAuth2 access token from seats.aero'
      }
    });

  } catch (error: any) {
    console.error('Error in GET /api/seats-auth:', error);
    return NextResponse.json(
      { error: 'Failed to check configuration status' },
      { status: 500 }
    );
  }
}
