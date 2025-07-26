export interface FilterMetadata {
  stops: number[];
  airlines: string[];
  airports: {
    origins: string[];
    destinations: string[];
    connections: string[];
  };
  duration: {
    min: number;
    max: number;
  };
  departure: {
    min: number;
    max: number;
  };
  arrival: {
    min: number;
    max: number;
  };
  cabinClasses: {
    y: { min: number; max: number };
    w: { min: number; max: number };
    j: { min: number; max: number };
    f: { min: number; max: number };
  };
}

export interface FilterMetadataResponse {
  filterMetadata: FilterMetadata;
  cached: boolean;
}

export interface AirportMeta {
  code: string; // IATA
  name: string; // City or airport name
  role: 'origin' | 'destination' | 'connection';
}

export interface AirlineMeta {
  code: string;
  name: string;
}

export interface AirportFilterState {
  include: {
    origin: string[];
    destination: string[];
    connection: string[];
  };
  exclude: {
    origin: string[];
    destination: string[];
    connection: string[];
  };
} 