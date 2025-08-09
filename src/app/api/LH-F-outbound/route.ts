import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseISO, addMinutes, isAfter, isBefore } from 'date-fns';

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

function getFlightUUID(flight: AvailabilityFlight): string {
  return `${flight.FlightNumbers}-${flight.DepartsAt}-${flight.ArrivesAt}`;
}

function buildOutboundItineraries(
  availabilityData: any,
  inboundArrivalTime: string,
  destination: string,
  flightMap: Map<string, AvailabilityFlight>,
  minConnectionMinutes = 90,
  maxConnectionMinutes = 360 // 6 hours
): Array<{
  route: string;
  date: string;
  itinerary: string[];
  totalDuration: number;
  departureTime: string;
  arrivalTime: string;
  connections: string[];
  classPercentages: { y: number; w: number; j: number; f: number };
}> {
  const results: Array<{
    route: string;
    date: string;
    itinerary: string[];
    totalDuration: number;
    departureTime: string;
    arrivalTime: string;
    connections: string[];
    classPercentages: { y: number; w: number; j: number; f: number };
  }> = [];
  const inboundArrival = parseISO(inboundArrivalTime);

      // Process each availability group
    for (const group of availabilityData.groups || []) {
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

      results.push({
        route,
        date,
        itinerary,
        totalDuration,
        departureTime: flight.DepartsAt,
        arrivalTime: flight.ArrivesAt,
        connections,
        classPercentages: { y, w, j, f }
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
              }
            });
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
    const itineraries = buildOutboundItineraries(availabilityData, timestamp, destination, flightMap);

    // Sort by departure time
    itineraries.sort((a, b) => new Date(a.departureTime).getTime() - new Date(b.departureTime).getTime());

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
