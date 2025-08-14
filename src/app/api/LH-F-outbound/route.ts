import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAvailableProKey } from '@/lib/supabase-admin';
import { parseISO, addMinutes, isAfter, isBefore, addDays, format, subDays } from 'date-fns';
import { createClient } from '@supabase/supabase-js';
import { CONCURRENCY_CONFIG } from '@/lib/concurrency-config';

// Use environment variables for Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Zod schema for request validation
const lhFOutboundSchema = z.object({
  O: z.string().length(3), // Origin airport
  D: z.string().length(3), // Destination airport
  T: z.string().min(8), // Timestamp (inbound arrival time)
  cabin: z.string().optional(),
  carriers: z.string().optional(),
  seats: z.coerce.number().int().min(1).default(1).optional(),
});

interface AvailabilityFlight {
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
  originAirport: string;
  destinationAirport: string;
}

interface AvailabilityGroup {
  originAirport: string;
  destinationAirport: string;
  date: string;
  alliance: string;
  earliestDeparture: string;
  latestDeparture: string;
  earliestArrival: string;
  latestArrival: string;
  flights: AvailabilityFlight[];
}

interface FlightMapEntry {
  id: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  duration: string;
  cabin: string;
  carrier: string;
  flightNumber: string;
}

// LH destinations by region
const LH_DESTINATIONS = {
  WEST: ['YUL', 'YYZ', 'YVR', 'SJO', 'MEX', 'ATL', 'AUS', 'BOS', 'CLT', 'ORD', 'DFW', 'DEN', 'DTW', 'IAH', 'LAX', 'MIA', 'EWR', 'JFK', 'RDU', 'STL', 'SAN', 'SFO', 'SEA', 'IAD', 'EZE', 'GIG', 'GRU', 'BOG'],
  EAST: ['EVN', 'GYD', 'PEK', 'PVG', 'TBS', 'HKG', 'BLR', 'MAA', 'DEL', 'HYD', 'BOM', 'IKA', 'KIX', 'HND', 'AMM', 'ALA', 'NQZ', 'BEY', 'DMM', 'RUH', 'SIN', 'ICN', 'BKK', 'DXB'],
  CENTRAL: ['TIA', 'GRZ', 'SZG', 'VIE', 'BRU', 'SJJ', 'SOF', 'DBV', 'ZAG', 'LCA', 'PRG', 'BLL', 'CPH', 'TLL', 'HEL', 'IVL', 'RVN', 'BSL', 'BOD', 'LYS', 'MRS', 'NTE', 'NCE', 'CDG', 'SXB', 'TLS', 'BER', 'BRE', 'CGN', 'DRS', 'DUS', 'FRA', 'HAM', 'HAJ', 'LEJ', 'FMO', 'MUC', 'NUE', 'STR', 'ATH', 'HER', 'JMK', 'RHO', 'SKG', 'JTR', 'BUD', 'KEF', 'DUB', 'BLQ', 'CTA', 'LIN', 'MXP', 'NAP', 'PMO', 'FCO', 'VCE', 'RIX', 'VNO', 'LUX', 'MLA', 'RMO', 'AMS', 'SKP', 'BGO', 'OSL', 'SVG', 'TOS', 'GDN', 'KTW', 'KRK', 'POZ', 'RZE', 'WAW', 'WRO', 'FAO', 'LIS', 'PDL', 'OPO', 'OTP', 'SBZ', 'TSR', 'BEG', 'LJU', 'ALC', 'BCN', 'BIO', 'MAD', 'AGP', 'PMI', 'SVQ', 'VLC', 'GOT', 'ARN', 'GVA', 'ZRH', 'IST', 'ADB', 'BHX', 'EDI', 'GLA', 'LHR', 'STN', 'MAN', 'NCL', 'ALG', 'LAD', 'CAI', 'SSG', 'NBO', 'CMN', 'ABV', 'LOS', 'PHC', 'CPT', 'JNB', 'TUN']
};

// Function to determine destination airports based on origin region
function getDestinationAirports(origin: string): string[] {
  const originUpper = origin.toUpperCase();
  
  // Determine origin region
  let originRegion: 'WEST' | 'EAST' | 'CENTRAL' = 'CENTRAL';
  if (LH_DESTINATIONS.WEST.includes(originUpper)) {
    originRegion = 'WEST';
  } else if (LH_DESTINATIONS.EAST.includes(originUpper)) {
    originRegion = 'EAST';
  }
  
  // Return destinations based on origin region
  switch (originRegion) {
    case 'WEST':
      // If origin is West, use East + Central
      return [...LH_DESTINATIONS.EAST, ...LH_DESTINATIONS.CENTRAL];
    case 'EAST':
      // If origin is East, use West + Central
      return [...LH_DESTINATIONS.WEST, ...LH_DESTINATIONS.CENTRAL];
    default:
      // If origin is Central, use West + East
      return [...LH_DESTINATIONS.WEST, ...LH_DESTINATIONS.EAST];
  }
}

/**
 * Calculate haversine distance between two points in miles
 */
function calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Cache for airport data and pricing to avoid repeated queries
const airportCache = new Map<string, any>();
const pricingCache = new Map<string, any>();

/**
 * Calculate multi-segment pricing for complex routes
 */
async function calculateMultiSegmentPricing(
  originAirport: string,
  destinationAirport: string,
  routeSegments: string[]
): Promise<{
  f1: number | null;
  y2: number | null;
  j2: number | null;
  f2: number | null;
  y3: number | null;
  j3: number | null;
  f3: number | null;
  totalRouteDistance: number;
  segmentDistances: number[];
}> {
  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Get airport coordinates for distance calculation (with caching)
    const uncachedAirports = routeSegments.filter(airport => !airportCache.has(airport));
    
    if (uncachedAirports.length > 0) {
      const { data: airports, error: airportError } = await supabase
        .from('airports')
        .select('iata, latitude, longitude')
        .in('iata', uncachedAirports);
      
      if (airportError || !airports) {
        console.error('Error fetching airport coordinates:', airportError);
        return {
          f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
          totalRouteDistance: 0, segmentDistances: []
        };
      }
      
      // Cache the new airports
      airports.forEach((airport: any) => {
        airportCache.set(airport.iata, airport);
      });
    }
    
    // Get all airports from cache
    const airports = routeSegments.map(airport => airportCache.get(airport)).filter(Boolean);

    // Calculate segment distances using haversine
    const segmentDistances: number[] = [];
    for (let i = 0; i < routeSegments.length - 1; i++) {
      const origin = airports.find((a: any) => a.iata === routeSegments[i]);
      const destination = airports.find((a: any) => a.iata === routeSegments[i + 1]);
      
      if (origin && destination) {
        const distance = calculateHaversineDistance(
          origin.latitude, origin.longitude,
          destination.latitude, destination.longitude
        );
        segmentDistances.push(Math.round(distance));
      } else {
        segmentDistances.push(0);
      }
    }

    const totalRouteDistance = segmentDistances.reduce((sum, dist) => sum + dist, 0);

    // Check pricing cache first
    const pricingKey = `${originAirport}-${destinationAirport}`;
    let pricing = pricingCache.get(pricingKey);
    
    if (!pricing) {
      // Get pricing for the overall route (origin to final destination)
      const { data: airportsForPricing, error: pricingAirportError } = await supabase
        .from('airports')
        .select('iata, iso')
        .in('iata', [originAirport, destinationAirport]);

      if (pricingAirportError || !airportsForPricing || airportsForPricing.length !== 2) {
        console.error('Error fetching airport data for pricing:', pricingAirportError);
        return {
          f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
          totalRouteDistance, segmentDistances
        };
      }

      const originAirportData = airportsForPricing.find((a: any) => a.iata === originAirport);
      const destinationAirportData = airportsForPricing.find((a: any) => a.iata === destinationAirport);

      if (!originAirportData?.iso || !destinationAirportData?.iso) {
        console.error('Missing ISO codes for pricing airports:', { originAirport, destinationAirport });
        return {
          f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
          totalRouteDistance, segmentDistances
        };
      }

      // Get zones for pricing
      const { data: zones, error: zoneError } = await supabase
        .from('av')
        .select('code, zone')
        .in('code', [originAirportData.iso, destinationAirportData.iso]);

      if (zoneError || !zones || zones.length !== 2) {
        console.error('Error fetching zone data for pricing:', zoneError);
        return {
          f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
          totalRouteDistance, segmentDistances
        };
      }

      const originZone = zones.find((z: any) => z.code === originAirportData.iso)?.zone;
      const destinationZone = zones.find((z: any) => z.code === destinationAirportData.iso)?.zone;

      if (!originZone || !destinationZone) {
        console.error('Missing zones for pricing:', { originZone, destinationZone });
        return {
          f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
          totalRouteDistance, segmentDistances
        };
      }

      // Get pricing for the route
      const { data: pricingData, error: pricingError } = await supabase
        .from('av_pricing')
        .select('economy, business, first')
        .eq('from_region', originZone)
        .eq('to_region', destinationZone)
        .single();

      if (pricingError || !pricingData) {
        console.error('Error fetching pricing data:', pricingError);
        return {
          f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
          totalRouteDistance, segmentDistances
        };
      }
      
      pricing = pricingData;
      pricingCache.set(pricingKey, pricing);
    }

    // Calculate multi-segment pricing based on segment distances
    const f1 = totalRouteDistance > 0 && segmentDistances[0] && pricing.first ? Math.round((segmentDistances[0] / totalRouteDistance) * pricing.first) : null;
    const y2 = totalRouteDistance > 0 && segmentDistances[1] && pricing.economy ? Math.round((segmentDistances[1] / totalRouteDistance) * pricing.economy) : null;
    const j2 = totalRouteDistance > 0 && segmentDistances[1] && pricing.business ? Math.round((segmentDistances[1] / totalRouteDistance) * pricing.business) : null;
    const f2 = totalRouteDistance > 0 && segmentDistances[1] && pricing.first ? Math.round((segmentDistances[1] / totalRouteDistance) * pricing.first) : null;
    
    // For 3+ segments, calculate y3, j3, f3
    const y3 = segmentDistances.length > 2 && totalRouteDistance > 0 && segmentDistances[2] && pricing.economy ? Math.round((segmentDistances[2] / totalRouteDistance) * pricing.economy) : null;
    const j3 = segmentDistances.length > 2 && totalRouteDistance > 0 && segmentDistances[2] && pricing.business ? Math.round((segmentDistances[2] / totalRouteDistance) * pricing.business) : null;
    const f3 = segmentDistances.length > 2 && totalRouteDistance > 0 && segmentDistances[2] && pricing.first ? Math.round((segmentDistances[2] / totalRouteDistance) * pricing.first) : null;

    return {
      f1, y2, j2, f2, y3, j3, f3, totalRouteDistance, segmentDistances
    };

  } catch (error) {
    console.error('Error calculating multi-segment pricing:', error);
    return {
      f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
      totalRouteDistance: 0, segmentDistances: []
    };
  }
}

function getFlightUUID(flight: AvailabilityFlight): string {
  return `${flight.FlightNumbers}-${flight.DepartsAt}-${flight.ArrivesAt}`;
}

async function buildOutboundItineraries(
  availabilityData: any,
  inboundArrivalTime: string,
  origin: string,
  destination: string,
  flightMap: Map<string, AvailabilityFlight>,
  minConnectionMinutes = 90,
  maxConnectionMinutes = 360 // 6 hours
): Promise<Array<{
  route: string;
  date: string;
  itinerary: string[];
  totalDuration: number;
  departureTime: string;
  arrivalTime: string;
  connections: string[];
  classPercentages: { y: number; w: number; j: number; f: number };
  f1: number | null;
  y2: number | null;
  j2: number | null;
  f2: number | null;
  y3: number | null;
  j3: number | null;
  f3: number | null;
  totalRouteDistance: number;
  segmentDistances: number[];
}>> {
  const results: Array<{
    route: string;
    date: string;
    itinerary: string[];
    totalDuration: number;
    departureTime: string;
    arrivalTime: string;
    connections: string[];
    classPercentages: { y: number; w: number; j: number; f: number };
    f1: number | null;
    y2: number | null;
    j2: number | null;
    f2: number | null;
    y3: number | null;
    j3: number | null;
    f3: number | null;
    totalRouteDistance: number;
    segmentDistances: number[];
  }> = [];
  const inboundArrival = parseISO(inboundArrivalTime);
  
  // Track processed flights to avoid duplicates
  const processedFlights = new Set<string>();

  // Pre-calculate pricing for all unique routes to avoid repeated queries
  const uniqueRoutes = new Set<string>();
  const pricingCache = new Map<string, any>();
  
  // Collect all unique routes from the availability data
  if (availabilityData.groups) {
    for (const group of availabilityData.groups) {
      const { originAirport, destinationAirport } = group;
      
      // Only process flights from the destination of the inbound flight (FRA or MUC)
      if (originAirport !== destination) {
        continue;
      }
      
      // Direct route
      const directRouteKey = `${origin}-${originAirport}-${destinationAirport}`;
      uniqueRoutes.add(directRouteKey);
      
      // Connecting route through other hub
      const hub = originAirport === 'FRA' ? 'MUC' : 'FRA';
      const connectingRouteKey = `${origin}-${originAirport}-${hub}-${destinationAirport}`;
      uniqueRoutes.add(connectingRouteKey);
    }
  }

  // Batch calculate pricing for all unique routes
  const pricingPromises: Promise<[string, any]>[] = [];
  
  for (const routeKey of uniqueRoutes) {
    const routeSegments = routeKey.split('-');
    if (routeSegments.length >= 3) {
      const finalDestination = routeSegments[routeSegments.length - 1];
      if (finalDestination) {
        const promise = calculateMultiSegmentPricing(
          origin,
          finalDestination,
          routeSegments
        ).then(pricing => [routeKey, pricing] as [string, any]);
        pricingPromises.push(promise);
      }
    }
  }
  
  // Wait for all pricing calculations to complete in parallel
  const pricingResults = await Promise.all(pricingPromises);
  
  // Store results in cache
  for (const [routeKey, pricing] of pricingResults) {
    pricingCache.set(routeKey, pricing);
  }

  // Process each availability group
  if (availabilityData.groups) {
    for (const group of availabilityData.groups) {
      const { originAirport, destinationAirport, date, flights } = group;

      // Only process flights from the destination of the inbound flight (FRA or MUC)
      if (originAirport !== destination) {
        continue;
      }

      // Process each flight in the group
      for (const flight of flights) {
        // Create unique flight identifier for deduplication
        const flightKey = `${flight.FlightNumbers}-${flight.DepartsAt}-${flight.ArrivesAt}`;
        
        // Skip if we've already processed this exact flight
        if (processedFlights.has(flightKey)) {
          continue;
        }
        
        const departureTime = parseISO(flight.DepartsAt);
        
        // Check if departure is within the allowed window (after inbound arrival - 6 hours max)
        const maxDepartureTime = addMinutes(inboundArrival, maxConnectionMinutes);
        
        if (isBefore(departureTime, inboundArrival) || isAfter(departureTime, maxDepartureTime)) {
          continue;
        }

        // Create direct flight itinerary
        const flightUUID = getFlightUUID(flight);
        flightMap.set(flightUUID, flight);

        const route = `${originAirport}-${destinationAirport}`;
        const itinerary = [flightUUID];
        const connections: string[] = [];

        // Calculate class percentages
        const totalDuration = flight.TotalDuration;
        const y = flight.YCount > 0 ? 100 : 0;
        const w = flight.WCount > 0 ? 100 : 0;
        const j = flight.JCount > 0 ? 100 : 0;
        const f = flight.FCount > 0 ? 100 : 0;

        // Get cached pricing for direct route
        const directRouteKey = `${origin}-${originAirport}-${destinationAirport}`;
        const pricing = pricingCache.get(directRouteKey) || {
          f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
          totalRouteDistance: 0, segmentDistances: []
        };

        // Apply seat availability filtering
        const filteredPricing = {
          f1: pricing.f1, // Always keep f1
          y2: flight.YCount > 0 ? pricing.y2 : null,
          j2: flight.JCount > 0 ? pricing.j2 : null,
          f2: flight.FCount > 0 ? pricing.f2 : null,
          y3: pricing.y3,
          j3: pricing.j3,
          f3: pricing.f3,
          totalRouteDistance: pricing.totalRouteDistance,
          segmentDistances: pricing.segmentDistances
        };

        results.push({
          route,
          date: format(parseISO(flight.DepartsAt), 'yyyy-MM-dd'),
          itinerary,
          totalDuration,
          departureTime: flight.DepartsAt,
          arrivalTime: flight.ArrivesAt,
          connections,
          classPercentages: { y, w, j, f },
          ...filteredPricing
        });
        
        // Mark this flight as processed to avoid duplicates
        processedFlights.add(flightKey);

        // Now look for connecting flights through the other hub
        const hub = originAirport === 'FRA' ? 'MUC' : 'FRA';
        
        // First, find flights from originAirport to hub (first leg)
        for (const firstLegGroup of availabilityData.groups || []) {
          if (firstLegGroup.originAirport === originAirport && firstLegGroup.destinationAirport === hub) {
            for (const firstLegFlight of firstLegGroup.flights) {
              const firstLegDepartureTime = parseISO(firstLegFlight.DepartsAt);
              
              // Check if first leg departs within the allowed window (after inbound arrival)
              if (isBefore(firstLegDepartureTime, inboundArrival) || isAfter(firstLegDepartureTime, addMinutes(inboundArrival, maxConnectionMinutes))) {
                continue;
              }

              // Now find connecting flights from hub to destinationAirport (second leg)
              for (const secondLegGroup of availabilityData.groups || []) {
                if (secondLegGroup.originAirport === hub && secondLegGroup.destinationAirport === destinationAirport) {
                  for (const secondLegFlight of secondLegGroup.flights) {
                    const secondLegDepartureTime = parseISO(secondLegFlight.DepartsAt);
                    const firstLegArrivalTime = parseISO(firstLegFlight.ArrivesAt);
                    
                    // Check if second leg departs within connection window after first leg arrival
                    const minSecondLegDepartureTime = addMinutes(firstLegArrivalTime, minConnectionMinutes);
                    const maxSecondLegDepartureTime = addMinutes(firstLegArrivalTime, maxConnectionMinutes);
                    
                    if (isBefore(secondLegDepartureTime, minSecondLegDepartureTime) || isAfter(secondLegDepartureTime, maxSecondLegDepartureTime)) {
                continue;
              }

              // Create unique identifier for connecting itinerary to avoid duplicates
              const connectingKey = `${firstLegFlight.FlightNumbers}-${firstLegFlight.DepartsAt}-${firstLegFlight.ArrivesAt}-${secondLegFlight.FlightNumbers}-${secondLegFlight.DepartsAt}-${secondLegFlight.ArrivesAt}`;
              
              // Skip if we've already processed this exact connecting itinerary
              if (processedFlights.has(connectingKey)) {
                continue;
              }
              
              // Create connecting flight itinerary
                    const firstLegUUID = getFlightUUID(firstLegFlight);
                    const secondLegUUID = getFlightUUID(secondLegFlight);
                    flightMap.set(firstLegUUID, firstLegFlight);
                    flightMap.set(secondLegUUID, secondLegFlight);

              const connectingRoute = `${originAirport}-${hub}-${destinationAirport}`;
                    const connectingItinerary = [firstLegUUID, secondLegUUID];
              const connectingConnections = [hub];

                                  // Calculate total duration and class percentages for connecting itinerary
                    const connectingTotalDuration = firstLegFlight.TotalDuration + secondLegFlight.TotalDuration;
                    
                    // Calculate percentage of total flight duration where that cabin class has availability
                    let connectingY = 0;
                    let connectingW = 0;
                    let connectingJ = 0;
                    let connectingF = 0;
                    
                    if (firstLegFlight.YCount > 0) connectingY += Math.round((firstLegFlight.TotalDuration / connectingTotalDuration) * 100);
                    if (secondLegFlight.YCount > 0) connectingY += Math.round((secondLegFlight.TotalDuration / connectingTotalDuration) * 100);
                    
                    if (firstLegFlight.WCount > 0) connectingW += Math.round((firstLegFlight.TotalDuration / connectingTotalDuration) * 100);
                    if (secondLegFlight.WCount > 0) connectingW += Math.round((secondLegFlight.TotalDuration / connectingTotalDuration) * 100);
                    
                    if (firstLegFlight.JCount > 0) connectingJ += Math.round((firstLegFlight.TotalDuration / connectingTotalDuration) * 100);
                    if (secondLegFlight.JCount > 0) connectingJ += Math.round((secondLegFlight.TotalDuration / connectingTotalDuration) * 100);
                    
                    if (firstLegFlight.FCount > 0) connectingF += Math.round((firstLegFlight.TotalDuration / connectingTotalDuration) * 100);
                    if (secondLegFlight.FCount > 0) connectingF += Math.round((secondLegFlight.TotalDuration / connectingTotalDuration) * 100);

              // Get cached pricing for connecting route
              const connectingRouteKey = `${origin}-${originAirport}-${hub}-${destinationAirport}`;
              const connectingPricing = pricingCache.get(connectingRouteKey) || {
                f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
                totalRouteDistance: 0, segmentDistances: []
              };

              // Apply seat availability filtering for connecting flights
              const filteredConnectingPricing = {
                f1: connectingPricing.f1, // Always keep f1
                      y2: firstLegFlight.YCount > 0 ? connectingPricing.y2 : null,
                      j2: firstLegFlight.JCount > 0 ? connectingPricing.j2 : null,
                      f2: firstLegFlight.FCount > 0 ? connectingPricing.f2 : null,
                      y3: secondLegFlight.YCount > 0 ? connectingPricing.y3 : null,
                      j3: secondLegFlight.JCount > 0 ? connectingPricing.j3 : null,
                      f3: secondLegFlight.FCount > 0 ? connectingPricing.f3 : null,
                totalRouteDistance: connectingPricing.totalRouteDistance,
                segmentDistances: connectingPricing.segmentDistances
              };

              results.push({
                route: connectingRoute,
                date: format(parseISO(firstLegFlight.DepartsAt), 'yyyy-MM-dd'),
                itinerary: connectingItinerary,
                totalDuration: connectingTotalDuration,
                      departureTime: firstLegFlight.DepartsAt,
                      arrivalTime: secondLegFlight.ArrivesAt,
                connections: connectingConnections,
                classPercentages: { 
                  y: connectingY, 
                  w: connectingW, 
                  j: connectingJ, 
                  f: connectingF 
                },
                ...filteredConnectingPricing
              });
              
              // Mark this connecting itinerary as processed to avoid duplicates
              processedFlights.add(connectingKey);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return results;
}

export async function POST(req: NextRequest) {
  try {
    // Parse and validate body
    const body = await req.json();
    const parseResult = lhFOutboundSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json({ error: 'Invalid input', details: parseResult.error.errors }, { status: 400 });
    }
    const { O: origin, D: destination, T: timestamp, cabin, carriers, seats } = parseResult.data;

    // Get API key using admin client
    const proKeyData = await getAvailableProKey();
    if (!proKeyData || !proKeyData.pro_key) {
      return NextResponse.json({ 
        error: 'No available pro_key found' 
      }, { status: 500 });
    }

    const apiKey = proKeyData.pro_key;

    // Parse timestamp and extract date
    let startDate: string;
    let endDate: string;
    try {
      const parsedTimestamp = parseISO(timestamp);
      startDate = format(parsedTimestamp, 'yyyy-MM-dd');
      endDate = format(addDays(parsedTimestamp, 1), 'yyyy-MM-dd');
    } catch (e) {
      return NextResponse.json({ error: 'Invalid timestamp format' }, { status: 400 });
    }

    // Calculate 7 days ago for filtering
    const sevenDaysAgo = subDays(new Date(), 7);

    // Get destination airports based on origin
    const destinationAirports = getDestinationAirports(origin);
    const originAirports = ['FRA', 'MUC']; // LH hubs

    // Build seats.aero API parameters
    const baseParams: Record<string, string> = {
      origin_airport: originAirports.join(','),
      destination_airport: destinationAirports.join(','),
      start_date: startDate,
      end_date: endDate,
      take: '1000',
      include_trips: 'true',
      only_direct_flights: 'true',
      include_filtered: 'false',
      carriers: 'LH',
      sources: 'aeroplan,united',
      disable_live_filtering: 'true'
    };
    if (cabin) baseParams.cabin = cabin;
    if (carriers) baseParams.carriers = carriers;

    // Helper to build URL
    const buildUrl = (params: Record<string, string | number>) => {
      const sp = new URLSearchParams(params as any);
      return `https://seats.aero/partnerapi/search?${sp.toString()}`;
    };

    // Fetch first page
    const firstUrl = buildUrl({ ...baseParams });
    
    // Log the seats.aero curl command
    console.log('Seats.aero API URL:', firstUrl);
    console.log('Seats.aero curl command:');
    console.log(`curl -X GET "${firstUrl}" \\`);
    console.log(`  -H "accept: application/json" \\`);
    console.log(`  -H "Partner-Authorization: ${apiKey}"`);

    const firstRes = await fetch(firstUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'Partner-Authorization': apiKey,
      },
    });

    if (firstRes.status === 429) {
      const retryAfter = firstRes.headers.get('Retry-After');
      return NextResponse.json(
        {
          error: 'Rate limit exceeded. Please try again later.',
          retryAfter: retryAfter ? Number(retryAfter) : undefined,
        },
        { status: 429 }
      );
    }

    if (!firstRes.ok) {
      return NextResponse.json(
        { error: `Seats.aero API Error: ${firstRes.statusText}` },
        { status: firstRes.status }
      );
    }

    const firstData = await firstRes.json();
    let allPages = [firstData];
    let hasMore = firstData.hasMore || false;
    let cursor = firstData.cursor;

    // Sequential pagination
    if (hasMore && typeof cursor === 'string') {
      while (hasMore && cursor) {
        const params = { ...baseParams, cursor };
        const url = buildUrl(params);
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'Partner-Authorization': apiKey,
          },
        });
        if (!res.ok) break;
        const data = await res.json();
        allPages.push(data);
        hasMore = data.hasMore || false;
        cursor = data.cursor;
      }
    }

    // Process all pages and build availability data
    const uniqueItems = new Map<string, boolean>();
    const results: any[] = [];

    for (const page of allPages) {
      if (page && page.data && Array.isArray(page.data) && page.data.length > 0) {
        for (const item of page.data) {
          if (uniqueItems.has(item.ID)) continue;
          if (item.AvailabilityTrips && Array.isArray(item.AvailabilityTrips) && item.AvailabilityTrips.length > 0) {
            for (const trip of item.AvailabilityTrips) {
              if (trip.Stops !== 0) continue;
              
              // Filter out trips older than 7 days
              if (trip.UpdatedAt) {
                const tripUpdatedAt = new Date(trip.UpdatedAt);
                if (tripUpdatedAt < sevenDaysAgo) continue;
              }

              // Only include trips with enough RemainingSeats for the requested cabin
              let includeTrip = false;
              let cabinType = '';
              const seatsCount = seats || 1;
              if (cabin) {
                if (
                  trip.Cabin &&
                  trip.Cabin.toLowerCase() === cabin.toLowerCase() &&
                  typeof trip.RemainingSeats === 'number' &&
                  (seatsCount === 1 ? trip.RemainingSeats >= 0 : trip.RemainingSeats >= seatsCount)
                ) {
                  includeTrip = true;
                  cabinType = trip.Cabin.toLowerCase();
                }
              } else {
                if (
                  typeof trip.RemainingSeats === 'number' &&
                  (seatsCount === 1 ? trip.RemainingSeats >= 0 : trip.RemainingSeats >= seatsCount)
                ) {
                  includeTrip = true;
                  cabinType = trip.Cabin ? trip.Cabin.toLowerCase() : '';
                }
              }
              if (!includeTrip) continue;
              
              // Filter out flights that depart too early (before T + 60 minutes)
              if (trip.DepartsAt) {
                const departureTime = new Date(trip.DepartsAt);
                const minDepartureTime = addDays(parseISO(timestamp), 0); // Same day as timestamp
                const minDepartureTimeWithBuffer = addDays(minDepartureTime, 0); // Add 60 minutes buffer
                minDepartureTimeWithBuffer.setMinutes(minDepartureTimeWithBuffer.getMinutes() + 60);
                
                if (departureTime < minDepartureTimeWithBuffer) {
                  continue; // Skip flights that depart too early
                }
              }
              
              const flightNumbersArr = (trip.FlightNumbers || '').split(/,\s*/);
              for (const flightNumber of flightNumbersArr) {
                const normalizedFlightNumber = flightNumber.replace(/^([A-Z]{2,3})(0*)(\d+)$/i, (_: string, prefix: string, zeros: string, number: string) => `${prefix.toUpperCase()}${parseInt(number, 10)}`);
                const flightPrefix = normalizedFlightNumber.slice(0, 2).toUpperCase();
                
                // Only include LH flights
                if (flightPrefix !== 'LH') {
                  continue;
                }
                
                results.push({
                  originAirport: item.Route.OriginAirport,
                  destinationAirport: item.Route.DestinationAirport,
                  date: item.Date,
                  distance: item.Route.Distance,
                  FlightNumbers: normalizedFlightNumber,
                  TotalDuration: trip.TotalDuration || 0,
                  Aircraft: Array.isArray(trip.Aircraft) && trip.Aircraft.length > 0 ? trip.Aircraft[0] : '',
                  DepartsAt: trip.DepartsAt || '',
                  ArrivesAt: trip.ArrivesAt || '',
                  YCount: (cabinType === 'economy') ? 1 : 0,
                  WCount: (cabinType === 'premium') ? 1 : 0,
                  JCount: (cabinType === 'business') ? 1 : 0,
                  FCount: (cabinType === 'first') ? 1 : 0,
                  Source: trip.Source || item.Source || '',
                  Cabin: trip.Cabin || '',
                });
              }
            }
          }
          uniqueItems.set(item.ID, true);
        }
      }
    }

    // Group by originAirport, destinationAirport, date, alliance
    const finalGroupedMap = new Map<string, any>();
    const aggregatedFlightMap = new Map<string, any>(); // Track individual flights by flight number + time
    
    for (const entry of results) {
      const groupKey = [
        entry.originAirport,
        entry.destinationAirport,
        entry.date,
        'SA' // LH is Star Alliance
      ].join('|');
      
      // Create unique flight key for cabin aggregation
      const flightKey = `${entry.FlightNumbers}-${entry.DepartsAt}-${entry.ArrivesAt}`;
      
      if (!finalGroupedMap.has(groupKey)) {
        finalGroupedMap.set(groupKey, {
          originAirport: entry.originAirport,
          destinationAirport: entry.destinationAirport,
          date: entry.date,
          distance: entry.distance,
          alliance: 'SA',
          earliestDeparture: entry.DepartsAt,
          latestDeparture: entry.DepartsAt,
          earliestArrival: entry.ArrivesAt,
          latestArrival: entry.ArrivesAt,
          flights: []
        });
      }
      
      const group = finalGroupedMap.get(groupKey);
      
      // Update earliest/latest departure/arrival
      if (entry.DepartsAt && (!group.earliestDeparture || entry.DepartsAt < group.earliestDeparture)) {
        group.earliestDeparture = entry.DepartsAt;
      }
      if (entry.DepartsAt && (!group.latestDeparture || entry.DepartsAt > group.latestDeparture)) {
        group.latestDeparture = entry.DepartsAt;
      }
      if (entry.ArrivesAt && (!group.earliestArrival || entry.ArrivesAt < group.earliestArrival)) {
        group.earliestArrival = entry.ArrivesAt;
      }
      if (entry.ArrivesAt && (!group.latestArrival || entry.ArrivesAt > group.latestArrival)) {
        group.latestArrival = entry.ArrivesAt;
      }
      
      // Aggregate cabin availability for the same flight
      if (!aggregatedFlightMap.has(flightKey)) {
        aggregatedFlightMap.set(flightKey, {
          FlightNumbers: entry.FlightNumbers,
          TotalDuration: entry.TotalDuration,
          Aircraft: entry.Aircraft,
          DepartsAt: entry.DepartsAt,
          ArrivesAt: entry.ArrivesAt,
          YCount: entry.YCount,
          WCount: entry.WCount,
          JCount: entry.JCount,
          FCount: entry.FCount,
          distance: entry.distance,
          originAirport: entry.originAirport,
          destinationAirport: entry.destinationAirport,
        });
      } else {
        // Merge cabin availability
        const existingFlight = aggregatedFlightMap.get(flightKey);
        if (existingFlight) {
          existingFlight.YCount = Math.max(existingFlight.YCount, entry.YCount);
          existingFlight.WCount = Math.max(existingFlight.WCount, entry.WCount);
          existingFlight.JCount = Math.max(existingFlight.JCount, entry.JCount);
          existingFlight.FCount = Math.max(existingFlight.FCount, entry.FCount);
        }
      }
    }
    
    // Add aggregated flights to groups
    for (const [groupKey, group] of finalGroupedMap) {
      for (const [flightKey, flight] of aggregatedFlightMap) {
        const flightGroupKey = [
          flight.originAirport,
          flight.destinationAirport,
          flight.date || group.date,
          'SA'
        ].join('|');
        
        if (flightGroupKey === groupKey) {
          group.flights.push(flight);
        }
      }
    }

    const availabilityData = { groups: Array.from(finalGroupedMap.values()) };

    // Build outbound itineraries
    const flightMap = new Map<string, AvailabilityFlight>();
    const itineraries = await buildOutboundItineraries(availabilityData, timestamp, origin, destination, flightMap);

    // Sort by departure time
    itineraries.sort((a: any, b: any) => new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime());

    return NextResponse.json({
      itineraries,
      flights: Object.fromEntries(flightMap),
      totalCount: itineraries.length,
      inboundArrivalTime: timestamp,
      origin,
      destination
    });

  } catch (error: any) {
    console.error('Error in /api/LH-F-outbound:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
