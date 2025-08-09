import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseISO, addMinutes, isAfter, isBefore } from 'date-fns';
import { createClient } from '@supabase/supabase-js';

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
          date,
          itinerary,
          totalDuration,
          departureTime: flight.DepartsAt,
          arrivalTime: flight.ArrivesAt,
          connections,
          classPercentages: { y, w, j, f },
          ...filteredPricing
        });

        // Now look for connecting flights through the other hub
        const hub = originAirport === 'FRA' ? 'MUC' : 'FRA';
        
        // Find connecting flights from the hub to the same destination
        for (const hubGroup of availabilityData.groups || []) {
          if (hubGroup.originAirport === hub && hubGroup.destinationAirport === destinationAirport) {
            for (const hubFlight of hubGroup.flights) {
              const hubDepartureTime = parseISO(hubFlight.DepartsAt);
              
              // Check if hub flight departs within connection window
              const minHubDepartureTime = addMinutes(departureTime, minConnectionMinutes);
              const maxHubDepartureTime = addMinutes(departureTime, maxConnectionMinutes);
              
              if (isBefore(hubDepartureTime, minHubDepartureTime) || isAfter(hubDepartureTime, maxHubDepartureTime)) {
                continue;
              }

              // Create connecting flight itinerary
              const hubFlightUUID = getFlightUUID(hubFlight);
              flightMap.set(hubFlightUUID, hubFlight);

              const connectingRoute = `${originAirport}-${hub}-${destinationAirport}`;
              const connectingItinerary = [flightUUID, hubFlightUUID];
              const connectingConnections = [hub];

              // Calculate total duration and class percentages for connecting itinerary
              const connectingTotalDuration = flight.TotalDuration + hubFlight.TotalDuration;
              const connectingY = (flight.YCount > 0 && hubFlight.YCount > 0) ? 100 : 0;
              const connectingW = (flight.WCount > 0 && hubFlight.WCount > 0) ? 100 : 0;
              const connectingJ = (flight.JCount > 0 && hubFlight.JCount > 0) ? 100 : 0;
              const connectingF = (flight.FCount > 0 && hubFlight.FCount > 0) ? 100 : 0;

              // Get cached pricing for connecting route
              const connectingRouteKey = `${origin}-${originAirport}-${hub}-${destinationAirport}`;
              const connectingPricing = pricingCache.get(connectingRouteKey) || {
                f1: null, y2: null, j2: null, f2: null, y3: null, j3: null, f3: null,
                totalRouteDistance: 0, segmentDistances: []
              };

              // Apply seat availability filtering for connecting flights
              const filteredConnectingPricing = {
                f1: connectingPricing.f1, // Always keep f1
                y2: (flight.YCount > 0 && hubFlight.YCount > 0) ? connectingPricing.y2 : null,
                j2: (flight.JCount > 0 && hubFlight.JCount > 0) ? connectingPricing.j2 : null,
                f2: (flight.FCount > 0 && hubFlight.FCount > 0) ? connectingPricing.f2 : null,
                y3: connectingPricing.y3,
                j3: connectingPricing.j3,
                f3: connectingPricing.f3,
                totalRouteDistance: connectingPricing.totalRouteDistance,
                segmentDistances: connectingPricing.segmentDistances
              };

              results.push({
                route: connectingRoute,
                date,
                itinerary: connectingItinerary,
                totalDuration: connectingTotalDuration,
                departureTime: flight.DepartsAt,
                arrivalTime: hubFlight.ArrivesAt,
                connections: connectingConnections,
                classPercentages: { 
                  y: connectingY, 
                  w: connectingW, 
                  j: connectingJ, 
                  f: connectingF 
                },
                ...filteredConnectingPricing
              });
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

    // Call the LH-F API to get availability data
    const lhFResponse = await fetch(`${req.nextUrl.origin}/api/LH-F`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        O: origin,
        D: destination,
        T: timestamp,
        cabin,
        carriers,
        seats
      })
    });

    if (!lhFResponse.ok) {
      return NextResponse.json({ error: 'Failed to fetch LH-F availability data' }, { status: 500 });
    }

    const availabilityData = await lhFResponse.json();

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
