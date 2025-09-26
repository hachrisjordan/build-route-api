// Request/Response types for availability-v2 API

export interface AvailabilityV2Request {
  routeId: string;
  startDate: string;
  endDate: string;
  cabin?: string;
  carriers?: string;
  seats?: number;
  united?: boolean;
}

export interface ProcessedTrip {
  originAirport: string;
  destinationAirport: string;
  date: string;
  distance: number;
  FlightNumbers: string;
  TotalDuration: number;
  Aircraft: string;
  DepartsAt: string;
  ArrivesAt: string;
  YMile: number;
  WMile: number;
  JMile: number;
  FMile: number;
  Source: string;
  Cabin: string;
  ThresholdCount: number;
}

export interface MergedEntry {
  originAirport: string;
  destinationAirport: string;
  date: string;
  distance: number;
  FlightNumbers: string;
  TotalDuration: number;
  Aircraft: string;
  DepartsAt: string;
  ArrivesAt: string;
  Source: string;
  Cabin: string;
  YCount: number;
  WCount: number;
  JCount: number;
  FCount: number;
}

export interface FlightEntry {
  FlightNumbers: string;
  TotalDuration: number;
  Aircraft: string;
  DepartsAt: string;
  ArrivesAt: string;
  YCount: number;
  WCount: number;
  JCount: number;
  FCount: number;
  distance: number;
}

export interface GroupedResult {
  originAirport: string;
  destinationAirport: string;
  date: string;
  distance: number;
  alliance: string;
  earliestDeparture: string;
  latestDeparture: string;
  earliestArrival: string;
  latestArrival: string;
  flights: FlightEntry[];
}

export interface AvailabilityV2Response {
  groups: GroupedResult[];
  seatsAeroRequests: number;
}

export interface ProcessingStats {
  totalItems: number;
  totalTrips: number;
  filteredTrips: number;
  rawResults: number;
}

export interface RateLimitInfo {
  remaining: string | null;
  reset: string | null;
}

export interface ResponseBuilderOptions {
  groupedResults: GroupedResult[];
  seatsAeroRequests: number;
  rateLimit: RateLimitInfo | null;
  routeId: string;
  startDate: string;
  endDate: string;
  cabin?: string;
  carriers?: string;
  seats: number;
  united: boolean;
  startTime: number;
}

export interface SentryErrorContext {
  route: string;
  routeId?: string;
  startDate?: string;
  endDate?: string;
  cabin?: string;
  requestUrl?: string;
  userAgent?: string | null;
  requestId?: string | null;
  processingTime?: number;
  seatsAeroRequests?: number;
}

// Route parsing types
export interface RouteSegments {
  segments: string[];
  originAirports: string[];
  destinationSegments: string[];
  middleSegments: string[][];
}

// Date parsing types
export interface ParsedDateRange {
  seatsAeroEndDate: string;
  sevenDaysAgo: Date;
}

// Seats.aero client types
export interface SeatsAeroClient {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface PaginateSearchResult {
  pages: any[];
  requestCount: number;
  lastResponse: Response | null;
  rateLimit: RateLimitInfo | null;
}

// Supabase PZ data types
export interface PzRecord {
  flight_number: string;
  origin_airport: string;
  destination_airport: string;
  departure_date: string;
  in: number;
  xn: number;
}

// UA seat adjustment types
export interface UaSeatAdjustment {
  yCount: number;
  jCount: number;
}

// Alliance types
export type AllianceCode = 'SA' | 'ST' | 'OW' | 'EY' | 'EK' | 'JX' | 'B6' | 'GF' | 'DE' | 'LY' | 'LA' | 'HA' | 'VA' | 'G3' | 'AD';

// Cabin types
export type CabinType = 'economy' | 'premium' | 'business' | 'first' | 'y' | 'w' | 'j' | 'f';

// Error types
export interface ApiError {
  error: string;
  details?: any;
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}
