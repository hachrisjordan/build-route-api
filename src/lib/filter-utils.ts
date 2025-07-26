import type { FilterMetadata, FilterMetadataResponse, AirportMeta, AirlineMeta } from '@/types/filter-metadata';

/**
 * Fetches filter metadata for the given search parameters
 */
export async function fetchFilterMetadata(params: {
  origin: string;
  destination: string;
  maxStop: number;
  startDate: string;
  endDate: string;
  apiKey?: string | null;
  cabin?: string;
  carriers?: string;
  minReliabilityPercent?: number;
}): Promise<FilterMetadata> {
  try {
    const response = await fetch('/api/filter-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch filter metadata: ${response.statusText}`);
    }

    const data: FilterMetadataResponse = await response.json();
    return data.filterMetadata;
  } catch (error) {
    console.error('Error fetching filter metadata:', error);
    // Return default metadata if fetch fails
    return getDefaultFilterMetadata();
  }
}

/**
 * Returns default filter metadata when no data is available
 */
export function getDefaultFilterMetadata(): FilterMetadata {
  return {
    stops: [0, 1, 2, 3, 4],
    airlines: [],
    airports: {
      origins: [],
      destinations: [],
      connections: [],
    },
    duration: {
      min: 0,
      max: 1440, // 24 hours in minutes
    },
    departure: {
      min: Date.now(),
      max: Date.now() + 24 * 60 * 60 * 1000, // 24 hours from now
    },
    arrival: {
      min: Date.now(),
      max: Date.now() + 24 * 60 * 60 * 1000, // 24 hours from now
    },
    cabinClasses: {
      y: { min: 0, max: 100 },
      w: { min: 0, max: 100 },
      j: { min: 0, max: 100 },
      f: { min: 0, max: 100 },
    },
  };
}

/**
 * Converts filter metadata to airport meta objects for the filter interface
 */
export function convertToAirportMeta(metadata: FilterMetadata): AirportMeta[] {
  const airportMeta: AirportMeta[] = [];
  
  // Add origins
  metadata.airports.origins.forEach(code => {
    airportMeta.push({
      code,
      name: code, // You might want to fetch airport names from a separate API
      role: 'origin',
    });
  });
  
  // Add destinations
  metadata.airports.destinations.forEach(code => {
    airportMeta.push({
      code,
      name: code, // You might want to fetch airport names from a separate API
      role: 'destination',
    });
  });
  
  // Add connections
  metadata.airports.connections.forEach(code => {
    airportMeta.push({
      code,
      name: code, // You might want to fetch airport names from a separate API
      role: 'connection',
    });
  });
  
  return airportMeta;
}

/**
 * Converts filter metadata to airline meta objects for the filter interface
 */
export function convertToAirlineMeta(metadata: FilterMetadata): AirlineMeta[] {
  return metadata.airlines.map(code => ({
    code,
    name: code, // You might want to fetch airline names from a separate API
  }));
}

/**
 * Formats duration in minutes to a human-readable string
 */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins.toString().padStart(2, '0')}m`;
}

/**
 * Formats a timestamp to a readable time string
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Formats a timestamp to a readable date string
 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
} 