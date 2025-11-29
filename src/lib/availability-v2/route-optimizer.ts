import { getOptimalDateRangeForRoute, calculateEnvelopeDateRange } from './date-range-optimizer';
import { generateDateRange } from './date-utils';
import { loadRouteMetrics } from '@/lib/route-metrics/service';
import { getAirportCityCode } from '@/lib/airports/city-groups';
import { initializeCityGroups } from '@/lib/airports/city-groups';

export interface OptimizedGroup {
  origins: string[];
  destinations: string[];
  routes: string[]; // Original routes included
  estimatedResults: number;
  dateRange: { start: string; end: string }; // Per-group optimized range
}

interface Star {
  center: string;
  isOriginCenter: boolean;
  edges: string[];
  origins: string[];
  destinations: string[];
}

interface Bin {
  origins: string[];
  destinations: string[];
  routes: string[];
  estimatedResults: number;
}

// Lazy-loaded route count data
let routeCountCache: Map<string, number> | null = null;
let loadPromise: Promise<Map<string, number>> | null = null;

/**
 * Load route count data from Supabase route_metrics table
 * Applies city group aggregation on read (normalizes airport codes to city codes)
 * Uses avg field (rounded to nearest int) instead of count
 */
async function loadRouteCountData(): Promise<Map<string, number>> {
  if (routeCountCache) {
    return routeCountCache;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    try {
      // Ensure city groups are loaded
      await initializeCityGroups();

      // Load all route metrics from Supabase
      const allRouteKeys: string[] = []; // We'll load all metrics
      const routeMetrics = await loadRouteMetrics(allRouteKeys);

      // Apply city group aggregation on read
      // When querying, we need to normalize airport codes to city codes
      // Since route_metrics already stores city-aggregated data, we just need to
      // normalize the keys we're looking up
      const routeCountData = new Map<string, number>();

      // Copy all metrics to cache (they're already city-aggregated)
      for (const [key, avg] of routeMetrics) {
        routeCountData.set(key, avg);
      }

      console.log(`[route-optimizer] Loaded ${routeCountData.size} route count entries from Supabase`);
      routeCountCache = routeCountData;
      return routeCountData;
    } catch (error) {
      console.warn('[route-optimizer] Failed to load route metrics from Supabase, using defaults:', error);
      routeCountCache = new Map<string, number>();
      return routeCountCache;
    }
  })();

  return loadPromise;
}

/**
 * Calculate estimated results for a set of origin-destination combinations
 * Applies city group aggregation on read (normalizes airport codes to city codes when looking up)
 */
function calculateResults(
  origins: string[],
  destinations: string[],
  days: number,
  routeCountData: Map<string, number>
): number {
  let total = 0;
  
  for (const origin of origins) {
    for (const destination of destinations) {
      // Normalize to city codes for lookup (city group aggregation on read)
      const originCity = getAirportCityCode(origin);
      const destCity = getAirportCityCode(destination);
      const key = `${originCity},${destCity}`;
      // Default to 5 if not found, but if avg < 1 it should be at least 1 (handled in loadRouteMetrics)
      const perDay = routeCountData.get(key) || 5;
      total += perDay * days;
    }
  }
  
  return total;
}

/**
 * Build bipartite graph from routes
 */
function buildGraph(routes: string[]): {
  originMap: Map<string, string[]>;
  destinationMap: Map<string, string[]>;
} {
  const originMap = new Map<string, string[]>();
  const destinationMap = new Map<string, string[]>();
  
  for (const route of routes) {
    const [origin, destination] = route.split('-');
    
    if (!origin || !destination) {
      continue; // Skip invalid routes
    }
    
    if (!originMap.has(origin)) {
      originMap.set(origin, []);
    }
    originMap.get(origin)!.push(destination);
    
    if (!destinationMap.has(destination)) {
      destinationMap.set(destination, []);
    }
    destinationMap.get(destination)!.push(origin);
  }
  
  return { originMap, destinationMap };
}

/**
 * Star decomposition algorithm
 * Groups routes by finding highest-degree vertices (hubs)
 */
function decomposeIntoStars(routes: string[]): Star[] {
  const { originMap, destinationMap } = buildGraph(routes);
  const remaining = new Set(routes);
  const stars: Star[] = [];
  
  while (remaining.size > 0) {
    let maxVertex: string | null = null;
    let maxDegree = 0;
    let isOriginCenter = true;
    
    // Check origins for highest degree
    for (const [origin, destinations] of originMap.entries()) {
      const degree = destinations.filter(d => remaining.has(`${origin}-${d}`)).length;
      
      if (degree > maxDegree) {
        maxDegree = degree;
        maxVertex = origin;
        isOriginCenter = true;
      }
    }
    
    // Check destinations for highest degree
    for (const [destination, origins] of destinationMap.entries()) {
      const degree = origins.filter(o => remaining.has(`${o}-${destination}`)).length;
      
      if (degree > maxDegree) {
        maxDegree = degree;
        maxVertex = destination;
        isOriginCenter = false;
      }
    }
    
    if (!maxVertex) break;
    
    // Extract star
    const edges: string[] = [];
    const origins: string[] = [];
    const destinations: string[] = [];
    
    if (isOriginCenter) {
      origins.push(maxVertex);
      const dests = originMap.get(maxVertex) || [];
      
      for (const dest of dests) {
        const route = `${maxVertex}-${dest}`;
        if (remaining.has(route)) {
          edges.push(route);
          destinations.push(dest);
          remaining.delete(route);
        }
      }
    } else {
      destinations.push(maxVertex);
      const origs = destinationMap.get(maxVertex) || [];
      
      for (const orig of origs) {
        const route = `${orig}-${maxVertex}`;
        if (remaining.has(route)) {
          edges.push(route);
          origins.push(orig);
          remaining.delete(route);
        }
      }
    }
    
    if (edges.length > 0) {
      stars.push({
        center: maxVertex,
        isOriginCenter,
        edges,
        origins,
        destinations
      });
    }
  }
  
  return stars;
}

/**
 * Split oversized star into multiple bins
 */
function splitStar(
  star: Star,
  days: number,
  maxResults: number,
  routeCountData: Map<string, number>
): Bin[] {
  const bins: Bin[] = [];
  
  if (star.isOriginCenter) {
    // Split destinations
    let currentDestinations: string[] = [];
    let currentRoutes: string[] = [];
    let currentEstimate = 0;
    
    for (const dest of star.destinations) {
      // Normalize to city codes for lookup (city group aggregation on read)
      const centerCity = getAirportCityCode(star.center);
      const destCity = getAirportCityCode(dest);
      const perDay = routeCountData.get(`${centerCity},${destCity}`) || 5;
      const routeTotal = perDay * days;
      
      if (currentEstimate + routeTotal <= maxResults) {
        currentDestinations.push(dest);
        currentRoutes.push(`${star.center}-${dest}`);
        currentEstimate += routeTotal;
      } else {
        if (currentDestinations.length > 0) {
          bins.push({
            origins: [star.center],
            destinations: currentDestinations,
            routes: currentRoutes,
            estimatedResults: currentEstimate
          });
        }
        currentDestinations = [dest];
        currentRoutes = [`${star.center}-${dest}`];
        currentEstimate = routeTotal;
      }
    }
    
    if (currentDestinations.length > 0) {
      bins.push({
        origins: [star.center],
        destinations: currentDestinations,
        routes: currentRoutes,
        estimatedResults: currentEstimate
      });
    }
  } else {
    // Split origins
    let currentOrigins: string[] = [];
    let currentRoutes: string[] = [];
    let currentEstimate = 0;
    
    for (const orig of star.origins) {
      // Normalize to city codes for lookup (city group aggregation on read)
      const origCity = getAirportCityCode(orig);
      const centerCity = getAirportCityCode(star.center);
      const perDay = routeCountData.get(`${origCity},${centerCity}`) || 5;
      const routeTotal = perDay * days;
      
      if (currentEstimate + routeTotal <= maxResults) {
        currentOrigins.push(orig);
        currentRoutes.push(`${orig}-${star.center}`);
        currentEstimate += routeTotal;
      } else {
        if (currentOrigins.length > 0) {
          bins.push({
            origins: currentOrigins,
            destinations: [star.center],
            routes: currentRoutes,
            estimatedResults: currentEstimate
          });
        }
        currentOrigins = [orig];
        currentRoutes = [`${orig}-${star.center}`];
        currentEstimate = routeTotal;
      }
    }
    
    if (currentOrigins.length > 0) {
      bins.push({
        origins: currentOrigins,
        destinations: [star.center],
        routes: currentRoutes,
        estimatedResults: currentEstimate
      });
    }
  }
  
  return bins;
}

/**
 * Calculate estimate for origin/destination combinations using actual date ranges
 */
function calculateResultsWithDateRanges(
  origins: string[],
  destinations: string[],
  routes: string[],
  routeRanges: Array<{ route: string; start: string; end: string; needsFetch: boolean }>,
  routeCountData: Map<string, number>
): number {
  let total = 0;
  
  // Calculate envelope date range for all routes
  const relevantRanges = routes
    .map(route => routeRanges.find(r => r.route === route))
    .filter((r): r is NonNullable<typeof r> => r !== undefined && r.needsFetch);
  
  if (relevantRanges.length === 0) return 0;
  
  const envelopeRange = calculateEnvelopeDateRange(relevantRanges);
  const days = generateDateRange(envelopeRange.start, envelopeRange.end).length;
  
  // Calculate for all origin-destination combinations
  for (const origin of origins) {
    for (const destination of destinations) {
      // Normalize to city codes for lookup (city group aggregation on read)
      const originCity = getAirportCityCode(origin);
      const destCity = getAirportCityCode(destination);
      const key = `${originCity},${destCity}`;
      const perDay = routeCountData.get(key) || 5;
      total += perDay * days;
    }
  }
  
  return total;
}

/**
 * Pack stars into bins, splitting if necessary (using actual date ranges)
 */
function packStarsIntoBinsWithDateRanges(
  stars: Star[],
  routeRanges: Array<{ route: string; start: string; end: string; needsFetch: boolean }>,
  maxResults: number,
  routeCountData: Map<string, number>
): Bin[] {
  const bins: Bin[] = [];
  
  for (const star of stars) {
    // Calculate estimate using actual date ranges for routes in this star
    const totalEstimate = calculateResultsWithDateRanges(star.origins, star.destinations, star.edges, routeRanges, routeCountData);
    
    if (totalEstimate <= maxResults) {
      // Fits in one bin
      bins.push({
        origins: star.origins,
        destinations: star.destinations,
        routes: star.edges,
        estimatedResults: totalEstimate
      });
    } else {
      // Need to split - use average days for splitting logic
      const avgDays = Math.ceil(
        star.edges
          .map(route => {
            const range = routeRanges.find(r => r.route === route);
            return range && range.needsFetch ? generateDateRange(range.start, range.end).length : 0;
          })
          .reduce((sum, d) => sum + d, 0) / star.edges.length
      ) || 14;
      const splitBins = splitStar(star, avgDays, maxResults, routeCountData);
      bins.push(...splitBins);
    }
  }
  
  return bins;
}

/**
 * Ultra-aggressive consolidation - pack bins until hitting 2000 limit (using actual date ranges)
 */
function consolidateAggressivelyWithDateRanges(
  bins: Bin[],
  routeRanges: Array<{ route: string; start: string; end: string; needsFetch: boolean }>,
  maxResults: number,
  routeCountData: Map<string, number>
): Bin[] {
  // Sort bins by size (descending) for better packing
  const sortedBins = [...bins].sort((a, b) => b.estimatedResults - a.estimatedResults);
  
  const consolidatedBins: Bin[] = [];
  const used = new Set<number>();
  
  for (let i = 0; i < sortedBins.length; i++) {
    if (used.has(i)) continue;
    
    const currentBin = sortedBins[i];
    if (!currentBin) continue;
    
    let currentOrigins = [...currentBin.origins];
    let currentDestinations = [...currentBin.destinations];
    let currentRoutes = [...currentBin.routes];
    let currentEstimate = currentBin.estimatedResults;
    const packed = [i];
    
    // Try to pack more bins
    for (let j = i + 1; j < sortedBins.length; j++) {
      if (used.has(j)) continue;
      
      const nextBin = sortedBins[j];
      if (!nextBin) continue;
      
      const newOrigins = new Set([...currentOrigins, ...nextBin.origins]);
      const newDestinations = new Set([...currentDestinations, ...nextBin.destinations]);
      const combinedRoutes = [...currentRoutes, ...nextBin.routes];
      
      // Calculate estimate using actual date ranges for all routes
      const estimate = calculateResultsWithDateRanges(
        Array.from(newOrigins),
        Array.from(newDestinations),
        combinedRoutes,
        routeRanges,
        routeCountData
      );
      
      // Pack if under limit (no waste threshold)
      if (estimate <= maxResults) {
        currentOrigins = Array.from(newOrigins);
        currentDestinations = Array.from(newDestinations);
        currentRoutes = combinedRoutes;
        currentEstimate = estimate;
        packed.push(j);
      }
    }
    
    // Mark as used
    packed.forEach(idx => used.add(idx));
    
    // Add consolidated bin
    consolidatedBins.push({
      origins: currentOrigins,
      destinations: currentDestinations,
      routes: currentRoutes,
      estimatedResults: currentEstimate
    });
  }
  
  return consolidatedBins;
}

/**
 * Split a date range into chunks when estimated results exceed MAX_RESULTS
 * Returns array of date range chunks
 */
function splitDateRange(
  startDate: string,
  endDate: string,
  origins: string[],
  destinations: string[],
  maxResults: number,
  routeCountData: Map<string, number>
): Array<{ start: string; end: string }> {
  const allDates = generateDateRange(startDate, endDate);
  const totalDays = allDates.length;
  
  if (totalDays === 0) {
    return [{ start: startDate, end: endDate }];
  }
  
  // Calculate average results per day for all origin-destination combinations
  let totalPerDay = 0;
  for (const origin of origins) {
    for (const destination of destinations) {
      const originCity = getAirportCityCode(origin);
      const destCity = getAirportCityCode(destination);
      const key = `${originCity},${destCity}`;
      const perDay = routeCountData.get(key) || 5;
      totalPerDay += perDay;
    }
  }
  
  // Calculate how many days fit in MAX_RESULTS
  // Leave some buffer (90% of MAX_RESULTS) to account for variability
  const maxDaysPerChunk = Math.floor((maxResults * 0.9) / totalPerDay) || 1;
  
  // If the date range fits in one chunk, return as-is
  if (totalDays <= maxDaysPerChunk) {
    return [{ start: startDate, end: endDate }];
  }
  
  // Split into chunks
  const chunks: Array<{ start: string; end: string }> = [];
  
  for (let i = 0; i < allDates.length; i += maxDaysPerChunk) {
    const chunkStart = allDates[i]!;
    const chunkEnd = allDates[Math.min(i + maxDaysPerChunk - 1, allDates.length - 1)]!;
    chunks.push({ start: chunkStart, end: chunkEnd });
  }
  
  return chunks;
}

/**
 * Result type for route optimization
 */
export interface RouteOptimizationResult {
  optimizedGroups: OptimizedGroup[];
  cachedRoutes: string[];
}

/**
 * Main optimization function
 * Applies star decomposition + ultra-aggressive consolidation with cache awareness
 */
export async function optimizeRouteGroups(
  queryParamsArr: string[],
  startDate: string,
  endDate: string
): Promise<RouteOptimizationResult> {
  // Ensure city groups are initialized before using getAirportCityCode
  await initializeCityGroups();
  const routeCountData = await loadRouteCountData();
  const MAX_RESULTS = 1000;
  
  console.log(`[route-optimizer] Starting optimization for ${queryParamsArr.length} routes`);
  
  // Step 1: Check cache and get optimal date ranges for each route
  const routeRanges = await Promise.all(
    queryParamsArr.map(async (route) => {
      const [origin, destination] = route.split('-');
      if (!origin || !destination) {
        // Invalid route format, treat as needing fetch
        return { route, start: startDate, end: endDate, needsFetch: true };
      }
      const range = await getOptimalDateRangeForRoute(origin, destination, startDate, endDate);
      return { route, ...range };
    })
  );
  
  // Step 2: Separate fully cached routes from routes that need fetching
  const uncachedRoutes = routeRanges.filter(r => r.needsFetch);
  const cachedRoutes = routeRanges.filter(r => !r.needsFetch).map(r => r.route);
  
  if (uncachedRoutes.length === 0) {
    console.log(`[route-optimizer] All routes fully cached, no API calls needed (${cachedRoutes.length} cached routes)`);
    return { optimizedGroups: [], cachedRoutes };
  }
  
  console.log(`[route-optimizer] ${uncachedRoutes.length}/${queryParamsArr.length} routes need fetching, ${cachedRoutes.length} fully cached`);
  
  // Step 3: Extract just the route strings for decomposition
  const routesToOptimize = uncachedRoutes.map(r => r.route);
  
  // Step 4: Star decomposition
  const stars = decomposeIntoStars(routesToOptimize);
  console.log(`[route-optimizer] Phase 1: Decomposed into ${stars.length} star groups`);
  
  // Step 5: Pack into bins using actual date ranges per route
  const packedBins = packStarsIntoBinsWithDateRanges(stars, routeRanges, MAX_RESULTS, routeCountData);
  console.log(`[route-optimizer] Phase 2: Packed into ${packedBins.length} bins`);
  
  // Step 6: Ultra-aggressive consolidation using actual date ranges
  const consolidatedBins = consolidateAggressivelyWithDateRanges(packedBins, routeRanges, MAX_RESULTS, routeCountData);
  console.log(`[route-optimizer] Phase 3: Consolidated ${packedBins.length} → ${consolidatedBins.length} bins`);
  
  // Step 7: Calculate date ranges and recalculate estimates for each optimized group
  const initialOptimizedGroups: OptimizedGroup[] = consolidatedBins.map(bin => {
    // Get date ranges for all routes in this bin
    const binRouteRanges = bin.routes
      .map(route => routeRanges.find(r => r.route === route))
      .filter((r): r is NonNullable<typeof r> => r !== undefined && r.needsFetch);
    
    // Calculate envelope (earliest start to latest end)
    const dateRange = calculateEnvelopeDateRange(binRouteRanges);
    const actualDays = generateDateRange(dateRange.start, dateRange.end).length;
    
    // Recalculate estimate using actual date range
    const actualEstimate = calculateResults(bin.origins, bin.destinations, actualDays, routeCountData);
    
    return {
      origins: bin.origins,
      destinations: bin.destinations,
      routes: bin.routes,
      estimatedResults: actualEstimate,
      dateRange
    };
  });
  
  // Step 8: Split date ranges for groups that exceed MAX_RESULTS
  const optimizedGroups: OptimizedGroup[] = [];
  let dateRangeSplits = 0;
  
  for (const group of initialOptimizedGroups) {
    if (group.estimatedResults <= MAX_RESULTS) {
      // Fits within limit, use as-is
      optimizedGroups.push(group);
    } else {
      // Split date range into multiple chunks
      const dateChunks = splitDateRange(
        group.dateRange.start,
        group.dateRange.end,
        group.origins,
        group.destinations,
        MAX_RESULTS,
        routeCountData
      );
      
      dateRangeSplits += dateChunks.length - 1; // Track how many splits we made
      
      // Create a separate optimized group for each date chunk
      for (const chunk of dateChunks) {
        const chunkDays = generateDateRange(chunk.start, chunk.end).length;
        const chunkEstimate = calculateResults(group.origins, group.destinations, chunkDays, routeCountData);
        
        optimizedGroups.push({
          origins: group.origins,
          destinations: group.destinations,
          routes: group.routes,
          estimatedResults: chunkEstimate,
          dateRange: chunk
        });
      }
    }
  }
  
  if (dateRangeSplits > 0) {
    console.log(`[route-optimizer] Phase 4: Split ${dateRangeSplits} oversized groups by date range → ${optimizedGroups.length} API calls`);
  }
  
  // Log summary
  const totalNeeded = optimizedGroups.reduce((sum, g) => sum + g.routes.length, 0);
  const totalCombos = optimizedGroups.reduce((sum, g) => sum + g.origins.length * g.destinations.length, 0);
  const avgUtilization = (optimizedGroups.reduce((sum, g) => sum + g.estimatedResults, 0) / 
                          (optimizedGroups.length * MAX_RESULTS) * 100).toFixed(1);
  
  console.log(`[route-optimizer] Final: ${uncachedRoutes.length} routes → ${optimizedGroups.length} API calls`);
  console.log(`[route-optimizer] Reduction: ${((1 - optimizedGroups.length / uncachedRoutes.length) * 100).toFixed(1)}%`);
  console.log(`[route-optimizer] Needed routes: ${totalNeeded}, Total combos: ${totalCombos}`);
  console.log(`[route-optimizer] Avg utilization: ${avgUtilization}%`);
  
  return { optimizedGroups, cachedRoutes };
}

