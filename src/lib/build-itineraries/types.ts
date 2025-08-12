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
}

export interface AvailabilityGroup {
  originAirport: string;
  destinationAirport: string;
  date: string;
  alliance: string;
  flights: AvailabilityFlight[];
}

export interface OptimizedItinerary {
  route: string;
  date: string;
  itinerary: string[];
  totalDuration: number;
  departureTime: number;
  arrivalTime: number;
  stopCount: number;
  airlineCodes: string[];
  origin: string;
  destination: string;
  connections: string[];
  classPercentages: { y: number; w: number; j: number; f: number };
}