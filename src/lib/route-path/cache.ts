import { SupabaseClient } from '@/lib/route-helpers';
import { Airport, Path, IntraRoute } from '@/types/route';
import { 
  fetchAirportByIata, 
  fetchIntraRoutes, 
  fetchPathsByMaxStop, 
  batchFetchAirportsByIata, 
  batchFetchIntraRoutes, 
  globalBatchFetchIntraRoutes,
  getHaversineDistance,
  fetchPathsBySubregions
} from '@/lib/route-helpers';

/**
 * In-memory per-request cache for route path data
 */
export interface RoutePathCache {
  airport: Map<string, Airport | null>;
  intraRoute: Map<string, IntraRoute[]>;
  path: Map<string, Path[]>;
  sharedPaths: Map<string, Path[]>; // For batch-fetched regional path data
  globalIntraRoutes: Map<string, IntraRoute[]>; // For globally batch-fetched intra routes
}

/**
 * Creates a new empty RoutePathCache instance
 */
export function createRoutePathCache(): RoutePathCache {
  return {
    airport: new Map(),
    intraRoute: new Map(),
    path: new Map(),
    sharedPaths: new Map(),
    globalIntraRoutes: new Map(),
  };
}

/**
 * Service for managing route path caching operations
 */
export class RoutePathCacheService {
  readonly serviceName = 'RoutePathCacheService';
  readonly version = '1.0.0';

  constructor(public cache: RoutePathCache) {}

  /**
   * Fetch airport with cache
   */
  async fetchAirportCached(supabase: SupabaseClient, iata: string): Promise<Airport | null> {
    if (this.cache.airport.has(iata)) {
      return this.cache.airport.get(iata)!;
    }
    
    const airport = await fetchAirportByIata(supabase, iata);
    this.cache.airport.set(iata, airport);
    return airport;
  }

  /**
   * Fetch intra routes with cache
   */
  async fetchIntraRoutesCached(
    supabase: SupabaseClient, 
    origin: string, 
    destination: string
  ): Promise<IntraRoute[]> {
    const key = `${origin}-${destination}`;
    if (this.cache.intraRoute.has(key)) {
      return this.cache.intraRoute.get(key)!;
    }
    
    const routes = await fetchIntraRoutes(supabase, origin, destination);
    this.cache.intraRoute.set(key, routes);
    return routes;
  }

  /**
   * Fetch paths with cache
   */
  async fetchPathsCached(
    supabase: SupabaseClient,
    originRegion: string,
    destinationRegion: string,
    maxDistance: number,
    origin: string,
    destination: string,
    maxStop: number
  ): Promise<Path[]> {
    const key = `${originRegion}-${destinationRegion}-${maxDistance}-${origin}-${destination}-${maxStop}`;
    if (this.cache.path.has(key)) {
      return this.cache.path.get(key)!;
    }
    
    // Use maxStop filtering for better performance with large datasets
    const paths = await fetchPathsByMaxStop(
      supabase, 
      origin, 
      destination, 
      maxStop, 
      originRegion, 
      destinationRegion, 
      maxDistance
    );
    
    this.cache.path.set(key, paths);
    return paths;
  }

  /**
   * Fetch paths by subregions with cache (for region mode)
   */
  async fetchPathsBySubregionsCached(
    supabase: SupabaseClient,
    originSubregions: string[],
    destinationSubregions: string[],
    maxStop: number
  ): Promise<Path[]> {
    const key = `${originSubregions.sort().join(',')}-${destinationSubregions.sort().join(',')}-${maxStop}`;
    if (this.cache.path.has(key)) {
      return this.cache.path.get(key)!;
    }
    
    const paths = await fetchPathsBySubregions(
      supabase,
      originSubregions,
      destinationSubregions,
      maxStop
    );
    
    this.cache.path.set(key, paths);
    return paths;
  }

  /**
   * Batch fetch all intra routes needed for a set of airport pairs
   */
  async batchFetchIntraRoutesCached(
    supabase: SupabaseClient,
    pairs: { origin: string; destination: string }[]
  ): Promise<Record<string, IntraRoute[]>> {
    const uniquePairs = Array.from(new Set(pairs.map(p => `${p.origin}-${p.destination}`)));
    const pairMap: Record<string, IntraRoute[]> = {};
    
    // First check global cache (pre-fetched data)
    let foundInGlobalCache = 0;
    let notInGlobalCache: string[] = [];
    
    uniquePairs.forEach(pair => {
      if (this.cache.globalIntraRoutes.has(pair)) {
        pairMap[pair] = this.cache.globalIntraRoutes.get(pair)!;
        foundInGlobalCache++;
      } else {
        notInGlobalCache.push(pair);
      }
    });
    
    if (foundInGlobalCache > 0) {
      console.log(`Using global intra routes cache: ${foundInGlobalCache}/${uniquePairs.length} pairs`);
    }
    
    // For any pairs not in global cache, check local cache
    const uncachedPairs = notInGlobalCache.filter(pair => !this.cache.intraRoute.has(pair));
    const cachedPairs = notInGlobalCache.filter(pair => this.cache.intraRoute.has(pair));
    
    // Get locally cached results
    cachedPairs.forEach(pair => {
      pairMap[pair] = this.cache.intraRoute.get(pair)!;
    });
    
    // Fetch any remaining uncached pairs
    if (uncachedPairs.length > 0) {
      console.log(`Fetching remaining ${uncachedPairs.length} intra route pairs individually`);
      const uncachedPairsArray = uncachedPairs.map(pair => {
        const [origin, destination] = pair.split('-');
        return { origin: origin!, destination: destination! };
      });
      
      const fetchedResults = await batchFetchIntraRoutes(supabase, uncachedPairsArray);
      
      // Store in cache and result map
      Object.entries(fetchedResults).forEach(([pair, routes]) => {
        this.cache.intraRoute.set(pair, routes);
        pairMap[pair] = routes;
      });
    }
    
    return pairMap;
  }

  /**
   * Pre-fetch all airports for all origin-destination pairs
   */
  async preFetchAirports(
    supabase: SupabaseClient,
    originList: string[],
    destinationList: string[]
  ): Promise<void> {
    const allAirportCodes = [...new Set([...originList, ...destinationList])];
    const airportsToFetch = allAirportCodes.filter(code => !this.cache.airport.has(code));
    
    if (airportsToFetch.length > 0) {
      const airportsMap = await batchFetchAirportsByIata(supabase, airportsToFetch);
      Object.entries(airportsMap).forEach(([code, airport]) => {
        if (airport) {
          this.cache.airport.set(code, airport);
        }
      });
    }
  }

  /**
   * Pre-analyze all intra route pairs needed across all airport combinations
   */
  async preAnalyzeIntraRoutePairs(
    supabase: SupabaseClient,
    originList: string[],
    destinationList: string[],
    maxStop: number
  ): Promise<Array<{ origin: string; destination: string }>> {
    const allIntraRoutePairs: Array<{ origin: string; destination: string }> = [];
    
    // For each origin-destination pair, simulate the path analysis to determine needed intra routes
    for (const o of originList) {
      for (const d of destinationList) {
        const originAirport = this.cache.airport.get(o);
        const destinationAirport = this.cache.airport.get(d);
        
        if (!originAirport || !destinationAirport || 
            !originAirport.latitude || !originAirport.longitude ||
            !destinationAirport.latitude || !destinationAirport.longitude ||
            !originAirport.region || !destinationAirport.region) {
          continue;
        }
        
        // Get the shared path data for this pair
        const directDistance = getHaversineDistance(
          originAirport.latitude,
          originAirport.longitude,
          destinationAirport.latitude,
          destinationAirport.longitude
        );
        const maxDistance = 2 * directDistance;
        const sharedPathsKey = `${originAirport.region}-${destinationAirport.region}-${Math.ceil(maxDistance)}`;
        
        if (this.cache.sharedPaths.has(sharedPathsKey)) {
          const paths = this.cache.sharedPaths.get(sharedPathsKey)!;
          
          // Apply the same filtering logic as in getFullRoutePath
          const filteredPaths = paths.filter(p => {
            if (maxStop === 0) {
              return p.origin === o && p.destination === d;
            } else if (maxStop === 1) {
              return (p.origin === o || p.destination === d) && p.type !== 'A-H-H-B';
            } else if (maxStop === 2) {
              return (p.type === 'A-H-H-B' && p.origin === o && p.destination === d) ||
                     (p.type === 'A-H-B' && (p.origin === o || p.destination === d)) ||
                     p.type === 'A-B' || p.type === 'A-A';
            }
            return true;
          });
          
          // Collect intra route pairs needed
          // Case 2A: path.destination === destination, path.origin != origin
          const case2APaths = filteredPaths.filter(p => p.destination === d && p.origin !== o);
          case2APaths.forEach(p => {
            if (p.origin) allIntraRoutePairs.push({ origin: o, destination: p.origin });
          });
          
          // Case 2B: path.origin === origin, path.destination != destination
          const case2BPaths = filteredPaths.filter(p => p.origin === o && p.destination !== d);
          case2BPaths.forEach(p => {
            if (p.destination) allIntraRoutePairs.push({ origin: p.destination, destination: d });
          });
          
          // Case 3: path.origin != origin && path.destination != destination
          const case3Paths = filteredPaths.filter(p => p.origin !== o && p.destination !== d);
          case3Paths.forEach(p => {
            if (p.origin) allIntraRoutePairs.push({ origin: o, destination: p.origin });
            if (p.destination) allIntraRoutePairs.push({ origin: p.destination, destination: d });
          });
        }
      }
    }
    
    return allIntraRoutePairs;
  }

  /**
   * Store shared paths data in cache
   */
  setSharedPaths(key: string, paths: Path[]): void {
    this.cache.sharedPaths.set(key, paths);
  }

  /**
   * Get shared paths data from cache
   */
  getSharedPaths(key: string): Path[] | undefined {
    return this.cache.sharedPaths.get(key);
  }

  /**
   * Check if shared paths exist in cache
   */
  hasSharedPaths(key: string): boolean {
    return this.cache.sharedPaths.has(key);
  }

  /**
   * Store global intra routes data in cache
   */
  setGlobalIntraRoutes(key: string, routes: IntraRoute[]): void {
    this.cache.globalIntraRoutes.set(key, routes);
  }

  /**
   * Get cache statistics for debugging
   */
  getCacheStats(): {
    airportCount: number;
    intraRouteCount: number;
    pathCount: number;
    sharedPathsCount: number;
    globalIntraRoutesCount: number;
  } {
    return {
      airportCount: this.cache.airport.size,
      intraRouteCount: this.cache.intraRoute.size,
      pathCount: this.cache.path.size,
      sharedPathsCount: this.cache.sharedPaths.size,
      globalIntraRoutesCount: this.cache.globalIntraRoutes.size,
    };
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.cache.airport.clear();
    this.cache.intraRoute.clear();
    this.cache.path.clear();
    this.cache.sharedPaths.clear();
    this.cache.globalIntraRoutes.clear();
  }
}
