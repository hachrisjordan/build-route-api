// Airport type
export interface Airport {
  id: string;
  iata: string;
  name: string;
  city_name: string;
  country: string;
  country_code: string;
  latitude: number;
  longitude: number;
  region: string;
  tc: string;
  copazone: string;
}

// Path table type
export interface Path {
  id: string;
  type: string;
  origin: string;
  destination: string;
  h1?: string | null;
  h2?: string | null;
  originRegion: string;
  destinationRegion: string;
  h1Region?: string | null;
  h2Region?: string | null;
  alliance: string;
  totalDistance: number;
  directDistance: number;
}

// IntraRoute table type
export interface IntraRoute {
  id: string;
  Origin: string;
  Destination: string;
  Distance: number;
  Alliance: string;
}

// Output type for the API
export interface FullRoutePathResult {
  O: string | null;
  A: string;
  h1: string | null;
  h2: string | null;
  B: string;
  D: string | null;
  all1: string | null;
  all2: string | null;
  all3: string | null;
  cumulativeDistance: number;
  caseType: 'case1' | 'case2A' | 'case2B' | 'case3';
} 