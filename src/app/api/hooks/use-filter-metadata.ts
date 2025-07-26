import { useState, useEffect, useCallback } from 'react';
import type { FilterMetadata, AirportFilterState } from '@/types/filter-metadata';
import { fetchFilterMetadata, getDefaultFilterMetadata } from '@/lib/filter-utils';

interface UseFilterMetadataProps {
  origin: string;
  destination: string;
  maxStop: number;
  startDate: string;
  endDate: string;
  apiKey?: string | null;
  cabin?: string;
  carriers?: string;
  minReliabilityPercent?: number;
}

interface UseFilterMetadataReturn {
  // Metadata
  filterMetadata: FilterMetadata;
  isLoadingMetadata: boolean;
  metadataError: string | null;
  
  // Filter states
  selectedStops: number[];
  selectedIncludeAirlines: string[];
  selectedExcludeAirlines: string[];
  yPercent: number;
  wPercent: number;
  jPercent: number;
  fPercent: number;
  duration: number;
  depTime: [number, number];
  arrTime: [number, number];
  selectedAirportFilter: AirportFilterState;
  searchQuery: string;
  
  // Change handlers
  setSelectedStops: (stops: number[]) => void;
  setSelectedIncludeAirlines: (codes: string[]) => void;
  setSelectedExcludeAirlines: (codes: string[]) => void;
  setYPercent: (value: number) => void;
  setWPercent: (value: number) => void;
  setJPercent: (value: number) => void;
  setFPercent: (value: number) => void;
  setDuration: (value: number) => void;
  setDepTime: (value: [number, number]) => void;
  setArrTime: (value: [number, number]) => void;
  setSelectedAirportFilter: (state: AirportFilterState) => void;
  setSearchQuery: (query: string) => void;
  
  // Reset handlers
  resetStops: () => void;
  resetAirlines: () => void;
  resetY: () => void;
  resetW: () => void;
  resetJ: () => void;
  resetF: () => void;
  resetDuration: () => void;
  resetDepTime: () => void;
  resetArrTime: () => void;
  resetAirportFilter: () => void;
  resetSearch: () => void;
  resetAll: () => void;
  
  // Refresh metadata
  refreshMetadata: () => Promise<void>;
  
  // Update search parameters
  updateSearchParams: (params: Partial<UseFilterMetadataProps>) => void;
}

export function useFilterMetadata({
  origin,
  destination,
  maxStop,
  startDate,
  endDate,
  apiKey,
  cabin,
  carriers,
  minReliabilityPercent,
}: UseFilterMetadataProps): UseFilterMetadataReturn {
  // Metadata state
  const [filterMetadata, setFilterMetadata] = useState<FilterMetadata>(getDefaultFilterMetadata());
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);

  // Filter states
  const [selectedStops, setSelectedStops] = useState<number[]>([]);
  const [selectedIncludeAirlines, setSelectedIncludeAirlines] = useState<string[]>([]);
  const [selectedExcludeAirlines, setSelectedExcludeAirlines] = useState<string[]>([]);
  const [yPercent, setYPercent] = useState(0);
  const [wPercent, setWPercent] = useState(0);
  const [jPercent, setJPercent] = useState(0);
  const [fPercent, setFPercent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [depTime, setDepTime] = useState<[number, number]>([0, 0]);
  const [arrTime, setArrTime] = useState<[number, number]>([0, 0]);
  const [selectedAirportFilter, setSelectedAirportFilter] = useState<AirportFilterState>({
    include: { origin: [], destination: [], connection: [] },
    exclude: { origin: [], destination: [], connection: [] },
  });
  const [searchQuery, setSearchQuery] = useState('');

  // Current search parameters state
  const [currentSearchParams, setCurrentSearchParams] = useState<UseFilterMetadataProps>({
    origin,
    destination,
    maxStop,
    startDate,
    endDate,
    apiKey,
    cabin,
    carriers,
    minReliabilityPercent,
  });

  // Fetch metadata function
  const fetchMetadata = useCallback(async (params?: Partial<UseFilterMetadataProps>) => {
    const searchParams = params ? { ...currentSearchParams, ...params } : currentSearchParams;
    
    if (!searchParams.origin || !searchParams.destination) return;
    
    setIsLoadingMetadata(true);
    setMetadataError(null);
    
    try {
      const metadata = await fetchFilterMetadata(searchParams);
      
      setFilterMetadata(metadata);
      
      // Initialize filter states with metadata
      setSelectedStops(metadata.stops);
      setDuration(metadata.duration.max);
      setDepTime([metadata.departure.min, metadata.departure.max]);
      setArrTime([metadata.arrival.min, metadata.arrival.max]);
      
    } catch (error) {
      console.error('Error fetching filter metadata:', error);
      setMetadataError(error instanceof Error ? error.message : 'Failed to fetch filter metadata');
    } finally {
      setIsLoadingMetadata(false);
    }
  }, [currentSearchParams]);

  // Update search parameters function
  const updateSearchParams = useCallback((params: Partial<UseFilterMetadataProps>) => {
    setCurrentSearchParams(prev => ({ ...prev, ...params }));
  }, []);

  // Fetch metadata on mount and when dependencies change
  useEffect(() => {
    fetchMetadata();
  }, [fetchMetadata]);

  // Update current search params when props change
  useEffect(() => {
    setCurrentSearchParams({
      origin,
      destination,
      maxStop,
      startDate,
      endDate,
      apiKey,
      cabin,
      carriers,
      minReliabilityPercent,
    });
  }, [origin, destination, maxStop, startDate, endDate, apiKey, cabin, carriers, minReliabilityPercent]);

  // Reset handlers
  const resetStops = useCallback(() => {
    setSelectedStops(filterMetadata.stops);
  }, [filterMetadata.stops]);

  const resetAirlines = useCallback(() => {
    setSelectedIncludeAirlines([]);
    setSelectedExcludeAirlines([]);
  }, []);

  const resetY = useCallback(() => {
    setYPercent(0);
  }, []);

  const resetW = useCallback(() => {
    setWPercent(0);
  }, []);

  const resetJ = useCallback(() => {
    setJPercent(0);
  }, []);

  const resetF = useCallback(() => {
    setFPercent(0);
  }, []);

  const resetDuration = useCallback(() => {
    setDuration(filterMetadata.duration.max);
  }, [filterMetadata.duration.max]);

  const resetDepTime = useCallback(() => {
    setDepTime([filterMetadata.departure.min, filterMetadata.departure.max]);
  }, [filterMetadata.departure.min, filterMetadata.departure.max]);

  const resetArrTime = useCallback(() => {
    setArrTime([filterMetadata.arrival.min, filterMetadata.arrival.max]);
  }, [filterMetadata.arrival.min, filterMetadata.arrival.max]);

  const resetAirportFilter = useCallback(() => {
    setSelectedAirportFilter({
      include: { origin: [], destination: [], connection: [] },
      exclude: { origin: [], destination: [] , connection: [] },
    });
  }, []);

  const resetSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  const resetAll = useCallback(() => {
    resetStops();
    resetAirlines();
    resetY();
    resetW();
    resetJ();
    resetF();
    resetDuration();
    resetDepTime();
    resetArrTime();
    resetAirportFilter();
    resetSearch();
  }, [
    resetStops,
    resetAirlines,
    resetY,
    resetW,
    resetJ,
    resetF,
    resetDuration,
    resetDepTime,
    resetArrTime,
    resetAirportFilter,
    resetSearch,
  ]);

  // Refresh metadata function
  const refreshMetadata = useCallback(async () => {
    await fetchMetadata();
  }, [fetchMetadata]);

  return {
    // Metadata
    filterMetadata,
    isLoadingMetadata,
    metadataError,
    
    // Filter states
    selectedStops,
    selectedIncludeAirlines,
    selectedExcludeAirlines,
    yPercent,
    wPercent,
    jPercent,
    fPercent,
    duration,
    depTime,
    arrTime,
    selectedAirportFilter,
    searchQuery,
    
    // Change handlers
    setSelectedStops,
    setSelectedIncludeAirlines,
    setSelectedExcludeAirlines,
    setYPercent,
    setWPercent,
    setJPercent,
    setFPercent,
    setDuration,
    setDepTime,
    setArrTime,
    setSelectedAirportFilter,
    setSearchQuery,
    
    // Reset handlers
    resetStops,
    resetAirlines,
    resetY,
    resetW,
    resetJ,
    resetF,
    resetDuration,
    resetDepTime,
    resetArrTime,
    resetAirportFilter,
    resetSearch,
    resetAll,
    
    // Refresh metadata
    refreshMetadata,
    
    // Update search parameters
    updateSearchParams,
  };
} 