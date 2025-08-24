import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { encryptResponseJWT } from '@/lib/jwt-encryption';

const AA_SEARCH_URL = 'https://www.aa.com/booking/api/search/itinerary';

const LiveSearchAASchema = z.object({
  from: z.string().min(3),
  to: z.string().min(3),
  depart: z.string().min(8),
  ADT: z.number().int().min(1).max(9),
});

function mapProductToClass(product: string): 'Y' | 'W' | 'J' | 'F' {
  if (!product) return 'Y';
  const p = product.toUpperCase();
  if (p.includes('PREMIUM')) return 'W';
  if (p.includes('BUSINESS')) return 'J';
  if (p.includes('FIRST')) return 'F';
  return 'Y';
}

function stripTimezone(dt: string | null | undefined): string | null {
  if (!dt) return null;
  return dt.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z|\.\d{3})$/g, '');
}

function getConnections(segments: any[]): string[] {
  const connections: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const currLeg = segments[i]?.legs?.[0];
    const nextLeg = segments[i + 1]?.legs?.[0];
    if (currLeg?.destination?.code && nextLeg?.origin?.code) {
      if (currLeg.destination.code !== nextLeg.origin.code) {
        // Airport change: combine as "NRT/HND"
        connections.push(`${currLeg.destination.code}/${nextLeg.origin.code}`);
      } else {
        // Normal connection
        connections.push(currLeg.destination.code);
      }
    } else if (currLeg?.destination?.code) {
      connections.push(currLeg.destination.code);
    }
  }
  // Remove duplicates while preserving order
  return [...new Set(connections)];
}

function normalizeAAResponse(data: any) {
  if (!data || !Array.isArray(data.slices)) return { itinerary: [] };
  const classMap = {
    COACH: 'Y',
    PREMIUM_ECONOMY: 'W',
    BUSINESS: 'J',
    FIRST: 'F',
  } as const;

  function mapProductToClass(product: string): 'Y' | 'W' | 'J' | 'F' {
    if (!product) return 'Y';
    const p = product.toUpperCase();
    if (p.includes('PREMIUM')) return 'W';
    if (p.includes('BUSINESS')) return 'J';
    if (p.includes('FIRST')) return 'F';
    return 'Y';
  }

  function isNonEmptyBundle(points: any, fareTax: any) {
    const hasPoints = points !== undefined && points !== null && String(points).trim() !== '' && String(points) !== '0';
    const hasFareTax = fareTax !== undefined && fareTax !== null && String(fareTax).trim() !== '' && String(fareTax) !== '0' && String(fareTax) !== '0.0';
    return hasPoints || hasFareTax;
  }

  function getBundleInfo(pd: any) {
    return {
      class: mapProductToClass(pd.productType),
      points: pd.perPassengerAwardPoints ? String(pd.perPassengerAwardPoints) : '',
      fareTax: pd.allPassengerTaxesAndFees?.amount ? String(pd.allPassengerTaxesAndFees.amount) : '',
      productType: pd.productType,
    };
  }

  const itineraries = data.slices.map((slice: any) => {
    const segments = Array.isArray(slice.segments) ? slice.segments : [];
    const connections = getConnections(segments);
    const firstLeg = segments[0]?.legs?.[0];
    const lastLeg = segments[segments.length - 1]?.legs?.[0];
    const depart = stripTimezone(firstLeg?.departureDateTime);
    const arrive = stripTimezone(lastLeg?.arrivalDateTime);
    const duration = slice.durationInMinutes;

    // Bundles: from pricingDetail, filter out unavailable bundles
    const rawBundles = (slice.pricingDetail || []).map(getBundleInfo);
    const bundles = rawBundles.filter((b: any) => isNonEmptyBundle(b.points, b.fareTax));

    // For each segment, build bundleClasses for bundles that are available for the itinerary but not for the segment
    const segmentsOut = segments.map((seg: any, idx: number) => {
      const leg = seg.legs && seg.legs[0];
      const bundleClasses = bundles.map((bundle: any) => {
        if (!leg || !Array.isArray(leg.productDetails)) return null;
        // Find productDetail with productType matching the bundle and no alerts
        const pdMatch = leg.productDetails.find((pd: any) => pd.productType === bundle.productType && (!pd.alerts || pd.alerts.length === 0));
        if (pdMatch) {
          const mappedClass = mapProductToClass(pdMatch.cabinType || pdMatch.productType);
          if (mappedClass === bundle.class) {
            // The bundle's class is available for this segment, do not output bundleClasses
            return null;
          } else {
            // The bundle's class is not available, but a different class is, output bundleClasses with the mapped class
            return { [`${bundle.class}Class`]: mappedClass };
          }
        }
        // If not found, find the first available productDetail with no alerts
        const available = leg.productDetails.find((pd: any) => (!pd.alerts || pd.alerts.length === 0));
        const mapped = available ? mapProductToClass(available.cabinType || available.productType) : '';
        return { [`${bundle.class}Class`]: mapped };
      }).filter(Boolean);
      return {
        from: leg?.origin?.code || seg.origin?.code,
        to: leg?.destination?.code || seg.destination?.code,
        aircraft: leg?.aircraftCode || leg?.aircraft?.code || '',
        stops: 0,
        depart: stripTimezone(leg?.departureDateTime),
        arrive: stripTimezone(leg?.arrivalDateTime),
        flightnumber: seg.flight?.carrierCode && seg.flight?.flightNumber ? `${seg.flight.carrierCode}${seg.flight.flightNumber}` : '',
        duration: leg?.durationInMinutes || 0,
        layover: leg?.connectionTimeInMinutes || 0,
        distance: leg?.distanceInMiles || 0,
        ...(bundleClasses.length > 0 ? { bundleClasses } : {}),
      };
    });

    return {
      from: firstLeg?.origin?.code || segments[0]?.origin?.code,
      to: lastLeg?.destination?.code || segments[segments.length - 1]?.destination?.code,
      connections,
      depart,
      arrive,
      duration,
      bundles: bundles.map(({ class: c, points, fareTax }: any) => ({ class: c, points, fareTax })),
      segments: segmentsOut,
    };
  });
  return { itinerary: itineraries };
}

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  try {
    const body = await req.json();
    const parsed = LiveSearchAASchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
    }
    const { from, to, depart, ADT } = parsed.data;
    // Instead of direct AA fetch, call the American microservice
    const microserviceUrl = 'http://localhost:4002/american';
    const microResp = await fetch(microserviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, depart, ADT }),
    });
    if (!microResp.ok) {
      const errorText = await microResp.text();
      return NextResponse.json({ error: 'American microservice error', status: microResp.status, body: errorText }, { status: microResp.status });
    }
    const data = await microResp.json();
    // Normalize the response
    const normalized = normalizeAAResponse(data);
    
    // Encrypt the response data
    const { token, expiresAt } = encryptResponseJWT(normalized);
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt
    });
  } catch (err) {
    console.error('Error in live-search-AA POST:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 