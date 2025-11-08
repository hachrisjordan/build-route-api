import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ErrorHandlerService } from './error-handler';
import { getSupabaseConfig } from '@/lib/env-utils';

/**
 * Validation result interface
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: z.ZodError;
}

/**
 * Parsed and validated input data
 */
export interface ValidatedRouteInput {
  origin: string;
  destination: string;
  maxStop: number;
  originList: string[];
  destinationList: string[];
  pairsCount: number;
  binbin?: boolean;
}

/**
 * Airport code validation regex
 */
const AIRPORT_CODE_REGEX = /^[A-Z]{3}$/;

/**
 * City code validation regex (same as airport for now, but we'll validate against city groups)
 */
const CITY_CODE_REGEX = /^[A-Z]{3}$/;

/**
 * Multi-airport/city validation regex (slash-separated)
 */
const MULTI_AIRPORT_REGEX = /^([A-Z]{3})(\/[A-Z]{3})*$/;

/**
 * Enhanced schema for route path validation
 */
export const routePathValidationSchema = z.object({
  origin: z
    .string()
    .min(1, 'Origin is required')
    .regex(MULTI_AIRPORT_REGEX, 'Origin must be valid airport/city codes separated by slashes (e.g., LAX or TYO/NYC)'),
  destination: z
    .string()
    .min(1, 'Destination is required')
    .regex(MULTI_AIRPORT_REGEX, 'Destination must be valid airport/city codes separated by slashes (e.g., JFK or TYO/NYC)'),
  maxStop: z
    .number()
    .int('MaxStop must be an integer')
    .min(0, 'MaxStop must be at least 0')
    .max(4, 'MaxStop cannot exceed 4')
    .default(4),
  binbin: z.boolean().optional()
});

/**
 * Service for handling input validation for route path operations
 */
export class ValidationService {
  readonly serviceName = 'ValidationService';
  readonly version = '1.0.0';

  /**
   * Validate and parse the request body
   */
  static async validateRequest(request: NextRequest): Promise<ValidationResult<z.infer<typeof routePathValidationSchema>>> {
    try {
      const body = await request.json();
      const result = routePathValidationSchema.safeParse(body);
      
      return {
        success: result.success,
        data: result.success ? result.data : undefined,
        error: result.success ? undefined : result.error
      };
    } catch (error) {
      // Handle JSON parsing errors
      const zodError = new z.ZodError([
        {
          code: 'custom',
          message: 'Invalid JSON in request body',
          path: []
        }
      ]);
      
      return {
        success: false,
        error: zodError
      };
    }
  }

  /**
   * Process and validate the parsed input data
   */
  static processInputData(parsedData: z.infer<typeof routePathValidationSchema>): ValidationResult<ValidatedRouteInput> {
    try {
      // Extract and validate origin list
      const originListResult = this.parseAirportList(parsedData.origin, 'origin');
      if (!originListResult.success) {
        return {
          success: false,
          error: originListResult.error
        };
      }

      // Extract and validate destination list
      const destinationListResult = this.parseAirportList(parsedData.destination, 'destination');
      if (!destinationListResult.success) {
        return {
          success: false,
          error: destinationListResult.error
        };
      }

      // Validate maxStop
      const maxStop = Math.max(0, Math.min(4, parsedData.maxStop ?? 4));

      // Calculate pairs count
      const pairsCount = originListResult.data!.length * destinationListResult.data!.length;

      // Validate reasonable limits
      if (pairsCount > 100) {
        const zodError = new z.ZodError([
          {
            code: 'custom',
            message: 'Too many origin-destination combinations. Maximum 100 pairs allowed.',
            path: ['origin', 'destination']
          }
        ]);
        
        return {
          success: false,
          error: zodError
        };
      }

      return {
        success: true,
        data: {
          origin: parsedData.origin,
          destination: parsedData.destination,
          maxStop,
          originList: originListResult.data!,
          destinationList: destinationListResult.data!,
          pairsCount,
          binbin: parsedData.binbin
        }
      };
    } catch (error) {
      const zodError = new z.ZodError([
        {
          code: 'custom',
          message: 'Error processing input data',
          path: []
        }
      ]);
      
      return {
        success: false,
        error: zodError
      };
    }
  }

  /**
   * Parse and validate a slash-separated airport list
   */
  private static parseAirportList(
    input: string, 
    fieldName: 'origin' | 'destination'
  ): ValidationResult<string[]> {
    try {
      // Split by slash and clean up
      const airports = input
        .split('/')
        .map(code => code.trim().toUpperCase())
        .filter(code => code.length > 0);

      // Check if we have any airports
      if (airports.length === 0) {
        const zodError = new z.ZodError([
          {
            code: 'custom',
            message: `${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} cannot be empty`,
            path: [fieldName]
          }
        ]);
        
        return {
          success: false,
          error: zodError
        };
      }

      // Validate each airport/city code
      for (let i = 0; i < airports.length; i++) {
        const code = airports[i];
        if (!code || !AIRPORT_CODE_REGEX.test(code)) {
          const zodError = new z.ZodError([
            {
              code: 'custom',
              message: `Invalid airport/city code: ${code}. Must be 3 uppercase letters.`,
              path: [fieldName, i]
            }
          ]);
          
          return {
            success: false,
            error: zodError
          };
        }
      }

      // Check for duplicates
      const uniqueAirports = new Set(airports);
      if (uniqueAirports.size !== airports.length) {
        const zodError = new z.ZodError([
          {
            code: 'custom',
            message: `Duplicate airport codes found in ${fieldName}`,
            path: [fieldName]
          }
        ]);
        
        return {
          success: false,
          error: zodError
        };
      }

      return {
        success: true,
        data: airports
      };
    } catch (error) {
      const zodError = new z.ZodError([
        {
          code: 'custom',
          message: `Error parsing ${fieldName}`,
          path: [fieldName]
        }
      ]);
      
      return {
        success: false,
        error: zodError
      };
    }
  }

  /**
   * Validate environment variables
   */
  static validateEnvironment(): ValidationResult<{ supabaseUrl: string; supabaseKey: string }> {
    try {
      const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getSupabaseConfig();

      if (!supabaseUrl || !supabaseKey) {
        const missingVars = [];
        if (!supabaseUrl) missingVars.push('SUPABASE_URL');
        if (!supabaseKey) missingVars.push('SUPABASE_SERVICE_ROLE_KEY');

        const zodError = new z.ZodError([
          {
            code: 'custom',
            message: `Missing required environment variables: ${missingVars.join(', ')}`,
            path: []
          }
        ]);

        return {
          success: false,
          error: zodError
        };
      }

      return {
        success: true,
        data: { supabaseUrl, supabaseKey }
      };
    } catch (error) {
      const zodError = new z.ZodError([
        {
          code: 'custom',
          message: 'Error validating environment configuration',
          path: []
        }
      ]);

      return {
        success: false,
        error: zodError
      };
    }
  }

  /**
   * Validate route calculation parameters
   */
  static validateRouteCalculationParams(params: {
    origin: string;
    destination: string;
    maxStop: number;
  }): ValidationResult<boolean> {
    try {
      // Validate individual airport codes
      if (!AIRPORT_CODE_REGEX.test(params.origin)) {
        const zodError = new z.ZodError([
          {
            code: 'custom',
            message: `Invalid origin airport code: ${params.origin}`,
            path: ['origin']
          }
        ]);
        
        return {
          success: false,
          error: zodError
        };
      }

      if (!AIRPORT_CODE_REGEX.test(params.destination)) {
        const zodError = new z.ZodError([
          {
            code: 'custom',
            message: `Invalid destination airport code: ${params.destination}`,
            path: ['destination']
          }
        ]);
        
        return {
          success: false,
          error: zodError
        };
      }

      // Validate maxStop
      if (params.maxStop < 0 || params.maxStop > 4 || !Number.isInteger(params.maxStop)) {
        const zodError = new z.ZodError([
          {
            code: 'custom',
            message: `Invalid maxStop: ${params.maxStop}. Must be an integer between 0 and 4.`,
            path: ['maxStop']
          }
        ]);
        
        return {
          success: false,
          error: zodError
        };
      }

      return {
        success: true,
        data: true
      };
    } catch (error) {
      const zodError = new z.ZodError([
        {
          code: 'custom',
          message: 'Error validating route calculation parameters',
          path: []
        }
      ]);
      
      return {
        success: false,
        error: zodError
      };
    }
  }

  /**
   * Complete validation pipeline for route path requests
   */
  static async validateRoutePathRequest(request: NextRequest): Promise<{
    success: boolean;
    data?: ValidatedRouteInput;
    errorResponse?: Response;
  }> {
    try {
      // Step 1: Parse and validate request body
      const parseResult = await this.validateRequest(request);
      if (!parseResult.success) {
        return {
          success: false,
          errorResponse: ErrorHandlerService.handleValidationError(parseResult.error!, request)
        };
      }

      // Step 2: Process and validate input data
      const processResult = this.processInputData(parseResult.data!);
      if (!processResult.success) {
        return {
          success: false,
          errorResponse: ErrorHandlerService.handleValidationError(processResult.error!, request)
        };
      }

      // Step 3: Validate environment variables
      const envResult = this.validateEnvironment();
      if (!envResult.success) {
        const { url: supabaseUrl, serviceRoleKey: supabaseKey } = getSupabaseConfig();
        const missingVars = [];
        if (!supabaseUrl) missingVars.push('SUPABASE_URL');
        if (!supabaseKey) missingVars.push('SUPABASE_SERVICE_ROLE_KEY');
        
        return {
          success: false,
          errorResponse: ErrorHandlerService.handleMissingEnvVars(missingVars, request)
        };
      }

      return {
        success: true,
        data: processResult.data
      };
    } catch (error) {
      return {
        success: false,
        errorResponse: ErrorHandlerService.createErrorResponse(
          error as Error,
          request,
          { validationStep: 'complete_pipeline' }
        )
      };
    }
  }
}

/**
 * Utility functions for validation
 */
export const ValidationUtils = {
  /**
   * Check if a string is a valid airport code
   */
  isValidAirportCode(code: string): boolean {
    return AIRPORT_CODE_REGEX.test(code);
  },

  /**
   * Check if a string is a valid multi-airport format
   */
  isValidMultiAirportFormat(input: string): boolean {
    return MULTI_AIRPORT_REGEX.test(input);
  },

  /**
   * Sanitize airport code (uppercase, trim)
   */
  sanitizeAirportCode(code: string): string {
    return code.trim().toUpperCase();
  },

  /**
   * Extract airport codes from multi-airport string
   */
  extractAirportCodes(input: string): string[] {
    return input
      .split('/')
      .map(code => this.sanitizeAirportCode(code))
      .filter(code => code.length > 0);
  },

  /**
   * Validate maxStop value
   */
  isValidMaxStop(value: any): value is number {
    return typeof value === 'number' && 
           Number.isInteger(value) && 
           value >= 0 && 
           value <= 4;
  }
};
