import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { encryptResponseJWT } from '@/lib/jwt-encryption';

const LiveSearchUASchema = z.object({
  from: z.string().min(3), // Origin
  to: z.string().min(3), // Destination
  depart: z.string().min(8), // Outbound Date (YYYY-MM-DD)
  ADT: z.number().int().min(1).max(9), // Adults
});

function mapCabinToClass(cabin: string): "Y" | "W" | "J" | "F" {
  const c = cabin.toUpperCase();
  if (c.includes("PREMIUM")) return "W";
  if (c.includes("BUSINESS")) return "J";
  if (c.includes("FIRST")) return "F";
  return "Y";
}

// Helper to format date string to ISO8601 with T
function toIso(date: string | undefined): string | undefined {
  if (!date) return undefined;
  return date.replace(' ', 'T') + (date.length === 16 ? ':00' : '');
}

// Recursively flatten main flight and connections into segments
function flattenSegments(flight: any, prevArrive?: string): any[] {
  const segments: any[] = [];
  const main = flight;
  const depart = toIso(main.DepartDateTime);
  const arrive = toIso(main.DestinationDateTime);
  const layover = prevArrive && depart ? Math.max(0, (new Date(depart).getTime() - new Date(prevArrive).getTime()) / 60000) : 0;
  segments.push({
    from: main.Origin,
    to: main.Destination,
    aircraft: main.EquipmentDisclosures?.EquipmentType || '',
    stops: 0,
    depart,
    arrive,
    flightnumber: `${main.MarketingCarrier}${main.FlightNumber}`,
    duration: main.TravelMinutes || 0,
    layover,
    distance: main.MileageActual || 0,
    bundleClasses: [] // Will be filled later
  });
  if (Array.isArray(main.Connections)) {
    let prev = arrive;
    for (const conn of main.Connections) {
      segments.push(...flattenSegments(conn, prev));
      prev = toIso(conn.DestinationDateTime);
    }
  }
  return segments;
}

// Extract bundles (award classes, points, taxes) from Products array
function extractBundles(products: any[]): any[] {
  const bundles: any[] = [];
  for (const p of products) {
    if (!p.Prices || !Array.isArray(p.Prices)) continue;
    const points = p.Prices.find((pr: any) => pr.Currency === 'MILES')?.Amount;
    const fareTax = p.Prices.find((pr: any) => pr.Currency === 'USD' && pr.PricingType === 'Tax')?.Amount;
    let cabin = p.CabinType || p.CabinTypeText || p.ProductType || '';
    let classCode = mapCabinToClass(cabin);
    if (points && fareTax !== undefined) {
      bundles.push({
        class: classCode,
        points: String(points),
        fareTax: String(fareTax)
      });
    }
  }
  return bundles;
}

// Assign bundleClasses to each segment based on bundles
function assignBundleClasses(segments: any[], bundles: any[]): void {
  // For each segment, assign bundleClasses for each bundle type
  for (const seg of segments) {
    seg.bundleClasses = bundles.map((b) => {
      return {
        JClass: b.class === 'J' ? b.class : seg.bundleClasses?.find((c: any) => c.JClass) || 'Y',
        FClass: b.class === 'F' ? b.class : seg.bundleClasses?.find((c: any) => c.FClass) || 'Y',
      };
    });
  }
}

function normalizeItinerariesUA(data: any): any[] {
  // Handle the data wrapper structure
  const responseData = data?.data || data;
  if (!responseData || !Array.isArray(responseData.Trips)) return [];
  const itineraries: any[] = [];
  for (const trip of responseData.Trips) {
    if (!Array.isArray(trip.Flights) || trip.Flights.length === 0) continue;
    // Only process the first (best) flight for now
    const mainFlight = trip.Flights[0];
    const segments = flattenSegments(mainFlight);
    // Connections are all intermediate stops
    const connections = segments.slice(1, -1).map((s) => s.from);
    // Bundles from Products at the trip level (or fallback to mainFlight.Products)
    const bundles = extractBundles(trip.Products || mainFlight.Products || []);
    assignBundleClasses(segments, bundles);
    itineraries.push({
      from: segments[0].from,
      to: segments[segments.length - 1].to,
      connections,
      depart: segments[0].depart,
      arrive: segments[segments.length - 1].arrive,
      duration: mainFlight.TravelMinutesTotal || 0,
      bundles,
      segments
    });
  }
  return itineraries;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = LiveSearchUASchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error }, { status: 400 });
    }
    // Call the microservice
    const resp = await fetch('http://localhost:4004/united', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data)
    });
    const data = await resp.json();
    const itinerary = normalizeItinerariesUA(data);
    
    // Encrypt the response data
    const { token, expiresAt } = encryptResponseJWT({ itinerary });
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal error', details: String(error) }, { status: 500 });
  }
} 