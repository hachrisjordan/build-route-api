import { ZodError } from 'zod';
import { ValidationError } from '@/types/availability-v2';

/**
 * Maps Zod validation errors to client-friendly error messages
 */
export function mapZodErrors(zodError: ZodError): ValidationError[] {
  return zodError.errors.map((error) => {
    const field = error.path.join('.');
    let message = error.message;
    
    // Customize messages for better user experience
    switch (error.code) {
      case 'too_small':
        if (field === 'routeId') {
          message = 'Route ID must be at least 3 characters long';
        } else if (field === 'startDate' || field === 'endDate') {
          message = 'Date must be at least 8 characters long (YYYY-MM-DD format)';
        } else if (field === 'seats') {
          message = 'Seats must be at least 1';
        }
        break;
      case 'invalid_string':
        if (field === 'startDate' || field === 'endDate') {
          message = 'Date must be in YYYY-MM-DD format';
        }
        break;
      case 'invalid_type':
        if (field === 'seats') {
          message = 'Seats must be a number';
        } else if (field === 'united') {
          message = 'United parameter must be true or false';
        }
        break;
      case 'invalid_enum_value':
        if (field === 'cabin') {
          message = 'Cabin must be one of: economy, premium, business, first';
        }
        break;
      default:
        // Keep the original message for unknown error types
        break;
    }
    
    return {
      field,
      message,
      code: error.code
    };
  });
}

/**
 * Creates a user-friendly error response from Zod validation errors
 */
export function createValidationErrorResponse(zodError: ZodError) {
  const validationErrors = mapZodErrors(zodError);
  
  return {
    error: 'Validation failed',
    message: 'Please check your input and try again',
    details: validationErrors,
    // Add helpful hints for common issues
    hints: generateValidationHints(validationErrors)
  };
}

/**
 * Generates helpful hints based on validation errors
 */
function generateValidationHints(errors: ValidationError[]): string[] {
  const hints: string[] = [];
  
  const hasDateError = errors.some(e => e.field.includes('Date'));
  const hasRouteError = errors.some(e => e.field === 'routeId');
  const hasSeatsError = errors.some(e => e.field === 'seats');
  
  if (hasDateError) {
    hints.push('Dates should be in YYYY-MM-DD format (e.g., 2024-01-15)');
  }
  
  if (hasRouteError) {
    hints.push('Route ID should be in format: ORIGIN-DESTINATION (e.g., LAX-JFK)');
  }
  
  if (hasSeatsError) {
    hints.push('Seats should be a positive number (e.g., 1, 2, 4)');
  }
  
  if (errors.some(e => e.field === 'cabin')) {
    hints.push('Valid cabin options: economy, premium, business, first');
  }
  
  return hints;
}
