export interface ItineraryCard {
  itinerary: string[];
  metadata?: Record<string, unknown>;
}

export interface ItineraryResponsePage {
  itineraries: ItineraryCard[];
  flights: Record<string, any>;
  total: number;
  page: number;
  pageSize: number;
  minRateLimitRemaining: number | null;
  minRateLimitReset: number | null;
  totalSeatsAeroHttpRequests: number;
  filterMetadata?: Record<string, unknown>;
}


