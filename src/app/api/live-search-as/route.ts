import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { encryptResponseJWT } from '@/lib/jwt-encryption';

const LiveSearchASSchema = z.object({
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

function normalizeBundlesAndSegmentClasses(solutions: any, segments: any[]) {
  const bundles = Object.entries(solutions).map(([key, sol]: [string, any]) => {
    let overallClass: "Y" | "W" | "J" | "F" = "Y";
    if (key.includes("PREMIUM")) overallClass = "W";
    else if (key.includes("BUSINESS")) overallClass = "J";
    else if (key.includes("FIRST")) overallClass = "F";
    return {
      class: overallClass,
      points: String(sol.atmosPoints),
      fareTax: String(sol.grandTotal),
      cabins: Array.isArray(sol.cabins) ? sol.cabins.map(mapCabinToClass) : [],
      overallClass,
      mixedCabin: !!sol.mixedCabin,
    };
  });
  const segmentBundleClasses = segments.map((_: any, idx: number) => {
    return bundles.map(bundle => {
      if (!bundle.mixedCabin) return null;
      const field: Record<string, string> = {};
      field[`${bundle.class}Class`] = bundle.cabins[idx] || "";
      return field;
    });
  });
  bundles.forEach(b => { delete (b as any).cabins; delete (b as any).overallClass; delete (b as any).mixedCabin; });
  return { bundles, segmentBundleClasses };
}

function normalizeItineraries(data: any): any[] {
  if (!data || !Array.isArray(data.rows)) return [];
  return data.rows.map((row: any) => {
    const segments = Array.isArray(row.segments) ? row.segments : [];
    let bundles: any[] = [];
    let segmentBundleClasses: any[] = [];
    if (row.solutions) {
      const result = normalizeBundlesAndSegmentClasses(row.solutions, segments);
      bundles = result.bundles;
      segmentBundleClasses = result.segmentBundleClasses;
    }
    return {
      from: row.origin,
      to: row.destination,
      connections: segments.length > 1
        ? segments.slice(0, -1).map((s: any) => s.arrivalStation)
        : [],
      depart: segments[0]?.departureTime?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
      arrive: segments[segments.length - 1]?.arrivalTime?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
      duration: row.duration,
      bundles,
      segments: segments.map((s: any, idx: number) => {
        const bundleClasses = (segmentBundleClasses[idx] || []).filter(Boolean);
        return {
          from: s.departureStation,
          to: s.arrivalStation,
          aircraft: s.aircraftCode,
          stops: 0,
          depart: s.departureTime?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
          arrive: s.arrivalTime?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
          flightnumber: s.publishingCarrier ? `${s.publishingCarrier.carrierCode}${s.publishingCarrier.flightNumber}` : '',
          duration: s.duration,
          layover: s.stopoverDuration || 0,
          distance: s.performance && s.performance[0]?.distance?.length ? s.performance[0].distance.length : undefined,
          ...(bundleClasses.length > 0 ? { bundleClasses } : {}),
        };
      }),
    };
  });
}

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  try {
    const body = await req.json();
    const parsed = LiveSearchASSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
    }
    const { from, to, depart, ADT } = parsed.data;
    // Call Alaska microservice
    const microserviceUrl = 'http://localhost:4001/alaska';
    const microResp = await fetch(microserviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, depart, ADT }),
    });
    if (!microResp.ok) {
      const errorText = await microResp.text();
      return NextResponse.json({ error: 'Alaska microservice error', status: microResp.status, body: errorText }, { status: microResp.status });
    }
    const json = await microResp.json();
    const itinerary = normalizeItineraries(json);
    
    // Encrypt the response data
    const { token, expiresAt } = encryptResponseJWT({ itinerary });
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt
    });
  } catch (err) {
    console.error('Error in live-search-AS POST:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 