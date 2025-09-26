/**
 * Configuration constants for availability-v2 API
 */

// API Configuration
export const API_CONFIG = {
  SEATS_AERO_BASE_URL: 'https://seats.aero/partnerapi/search?',
  DEFAULT_PAGE_SIZE: 1000,
  MAX_PAGINATION_PAGES: 10,
  REDIS_TTL_SECONDS: 1800, // 30 minutes
} as const;

// Request Configuration
export const REQUEST_CONFIG = {
  DEFAULT_SEATS: 1,
  MIN_ROUTE_ID_LENGTH: 3,
  MIN_DATE_LENGTH: 8,
  SUPPORTED_CABINS: ['economy', 'premium', 'business', 'first'] as const,
  SUPPORTED_CARRIERS: [
    'A3', 'EY', 'AC', 'CA', 'AI', 'NZ', 'NH', 'OZ', 'OS', 'AV', 'SN', 'CM', 'OU', 'MS', 'ET', 'BR', 'LO', 'LH', 'CL', 'ZH', 'SQ', 'SA', 'LX', 'TP', 'TG', 'TK', 'UA',
    'AR', 'AM', 'UX', 'AF', 'CI', 'MU', 'DL', 'GA', 'KQ', 'ME', 'KL', 'KE', 'SV', 'SK', 'RO', 'MH', 'VN', 'VS', 'MF',
    'AS', 'AA', 'BA', 'CX', 'FJ', 'AY', 'IB', 'JL', 'QF', 'QR', 'RJ', 'AT', 'UL', 'WY',
    'EK', 'JX', 'B6', 'GF', 'DE', 'LY', 'LA', 'HA', 'VA', 'G3', 'AD'
  ] as const,
} as const;

// Performance Configuration
export const PERFORMANCE_CONFIG = {
  FILTER_OLD_TRIPS_DAYS: 7,
  SEATS_AERO_EXTEND_DAYS: 3,
  CACHE_ALLIANCE_LOOKUPS: true,
  ENABLE_REDIS_CACHING: true,
  ENABLE_PZ_ADJUSTMENTS: true,
} as const;

// Error Configuration
export const ERROR_CONFIG = {
  MAX_ERROR_MESSAGE_LENGTH: 500,
  INCLUDE_STACK_TRACE: process.env.NODE_ENV === 'development',
  LOG_ERROR_DETAILS: true,
} as const;

// Validation Configuration
export const VALIDATION_CONFIG = {
  DATE_FORMAT: 'YYYY-MM-DD',
  ROUTE_ID_PATTERN: /^[A-Z]{3}-[A-Z]{3}(-[A-Z]{3})*$/,
  FLIGHT_NUMBER_PATTERN: /^[A-Z]{2,3}\d{1,4}$/,
  MAX_STRING_LENGTH: 100,
} as const;

// UA Seat Adjustment Configuration
export const UA_CONFIG = {
  SEAT_ADJUSTMENT_MULTIPLIER: 2.5,
  PZ_TABLE_NAME: 'pz',
  SUPPORTED_FIELDS: ['in', 'xn'] as const,
} as const;

// Alliance Configuration
export const ALLIANCE_CONFIG = {
  STAR_ALLIANCE: 'SA',
  SKYTEAM: 'ST',
  ONEWORLD: 'OW',
  INDIVIDUAL_CARRIERS: ['EY', 'EK', 'JX', 'B6', 'GF', 'DE', 'LY', 'LA', 'HA', 'VA', 'G3', 'AD'] as const,
} as const;

// Redis Configuration
export const REDIS_CONFIG = {
  KEY_PREFIX: 'availability-v2-response:',
  COMPRESSION_LEVEL: 6,
  MEMORY_LEVEL: 8,
  CONNECTION_TIMEOUT: 5000,
  RETRY_ATTEMPTS: 3,
} as const;

// Logging Configuration
export const LOGGING_CONFIG = {
  PERFORMANCE_PREFIX: '[PERF]',
  UNITED_PREFIX: '[UNITED]',
  ERROR_PREFIX: '[ERROR]',
  ENABLE_PERFORMANCE_LOGS: true,
  ENABLE_DEBUG_LOGS: process.env.NODE_ENV === 'development',
} as const;
