import { z } from 'zod';

/**
 * Request schema for seats-auth POST endpoint
 */
export const SeatsAuthRequestSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required')
});

export type SeatsAuthRequest = z.infer<typeof SeatsAuthRequestSchema>;

/**
 * Response schema for successful OAuth2 token exchange
 */
export const SeatsAuthSuccessResponseSchema = z.object({
  success: z.literal(true),
  data: z.record(z.any()), // OAuth2 token response from seats.aero
  metadata: z.object({
    timestamp: z.string().datetime(),
    endpoint: z.literal('seats-auth'),
    scope: z.literal('openid'),
    redirectUri: z.string().url()
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
    requiredBody: z.array(z.string()),
    description: z.string()
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
