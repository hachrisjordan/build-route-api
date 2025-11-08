export interface AvailabilityFlight {
  FlightNumbers: string;
  TotalDuration: number;
  Aircraft: string;
  DepartsAt: string;
  ArrivesAt: string;
  YCount: number;
  WCount: number;
  JCount: number;
  FCount: number;
  YPartner: boolean;
  WPartner: boolean;
  JPartner: boolean;
  FPartner: boolean;
  originAirport?: string;
  destinationAirport?: string;
  originCity?: string;
  destinationCity?: string;
}

export interface AvailabilityGroup {
  originAirport: string;
  destinationAirport: string;
  originCity: string; // Added: City code (same as airport if no city group)
  destinationCity: string; // Added: City code (same as airport if no city group)
  date: string;
  alliance: string;
  flights: AvailabilityFlight[];
  earliestDeparture?: string;
  latestDeparture?: string;
  earliestArrival?: string;
  latestArrival?: string;
}

