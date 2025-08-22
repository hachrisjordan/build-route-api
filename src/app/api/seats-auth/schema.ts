import { z } from 'zod';

/**
 * Request schema for seats-auth POST endpoint - Authorization Code flow
 */
export const SeatsAuthRequestSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required')
});

export type SeatsAuthRequest = z.infer<typeof SeatsAuthRequestSchema>;

/**
 * Request schema for seats-auth POST endpoint - Refresh Token flow
 */
export const SeatsAuthRefreshRequestSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1, 'Refresh token is required')
});

export type SeatsAuthRefreshRequest = z.infer<typeof SeatsAuthRefreshRequestSchema>;

/**
 * Union type for all possible request schemas
 */
export const SeatsAuthRequestUnionSchema = z.union([
  SeatsAuthRequestSchema,
  SeatsAuthRefreshRequestSchema
]);

export type SeatsAuthRequestUnion = z.infer<typeof SeatsAuthRequestUnionSchema>;

/**
 * Response schema for successful OAuth2 token exchange
 */
export const SeatsAuthSuccessResponseSchema = z.object({
  success: z.literal(true),
  data: z.record(z.any()), // OAuth2 token response from seats.aero
  metadata: z.object({
    timestamp: z.string().datetime(),
    endpoint: z.literal('seats-auth'),
    grantType: z.enum(['authorization_code', 'refresh_token']),
    scope: z.string().optional(),
    redirectUri: z.string().url().optional()
  })
});

export type SeatsAuthSuccessResponse = z.infer<typeof SeatsAuthSuccessResponseSchema>;

/**
 * Error response schema
 */
export const SeatsAuthErrorResponseSchema = z.object({
  error: z.string(),
  status: z.number().optional(),
  details: z.string().optional(),
  missing: z.array(z.string()).optional(),
  message: z.string().optional(),
  required: z.array(z.string()).optional(),
  received: z.record(z.boolean()).optional(),
  type: z.string().optional(),
  validationErrors: z.array(z.object({
    field: z.string(),
    message: z.string()
  })).optional(),
  retryAfter: z.number().optional()
});

export type SeatsAuthErrorResponse = z.infer<typeof SeatsAuthErrorResponseSchema>;

/**
 * Union type for all possible responses
 */
export const SeatsAuthResponseSchema = z.union([
  SeatsAuthSuccessResponseSchema,
  SeatsAuthErrorResponseSchema
]);

export type SeatsAuthResponse = z.infer<typeof SeatsAuthResponseSchema>;

/**
 * Configuration status response schema for GET endpoint
 */
export const SeatsAuthConfigResponseSchema = z.object({
  endpoint: z.literal('seats-auth'),
  status: z.enum(['configured', 'misconfigured']),
  configuration: z.object({
    SEATS_AERO_CLIENT_ID: z.boolean(),
    SEATS_AERO_CLIENT_SECRET: z.boolean(),
    SEATS_AERO_REDIRECT_URI: z.boolean()
  }),
  message: z.string(),
  usage: z.object({
    method: z.literal('POST'),
    supportedGrantTypes: z.array(z.enum(['authorization_code', 'refresh_token'])),
    authorizationCode: z.object({
      requiredBody: z.array(z.string()),
      description: z.string()
    }),
    refreshToken: z.object({
      requiredBody: z.array(z.string()),
      description: z.string()
    })
  })
});

export type SeatsAuthConfigResponse = z.infer<typeof SeatsAuthConfigResponseSchema>;

/**
 * Environment variables required for seats-auth API
 */
export const REQUIRED_ENV_VARS = [
  'SEATS_AERO_CLIENT_ID',
  'SEATS_AERO_CLIENT_SECRET', 
  'SEATS_AERO_REDIRECT_URI'
] as const;

export type RequiredEnvVars = typeof REQUIRED_ENV_VARS[number];

/**
 * Grant types supported by the seats-auth API
 */
export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

export type SupportedGrantType = typeof SUPPORTED_GRANT_TYPES[number];
