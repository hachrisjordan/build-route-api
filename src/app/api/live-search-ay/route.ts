import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { encryptResponseAES } from '@/lib/aes-encryption';

const LiveSearchAYSchema = z.object({
  from: z.string().min(3), // Origin
  to: z.string().min(3), // Destination
  depart: z.string().min(8), // Outbound Date (YYYY-MM-DD)
  ADT: z.number().int().min(1).max(9), // Adults
});

function msToMinutes(ms: number | undefined) {
  if (!ms) return undefined;
  return Math.round(ms / 60000);
}

function mapCabinToClassAY(cabin: string): "Y" | "W" | "J" | "F" {
  const c = cabin.toUpperCase();
  if (c.includes("PREMIUM")) return "W";
  if (c.includes("BUSINESS")) return "J";
  if (c.includes("FIRST")) return "F";
  return "Y";
}

function normalizeItinerariesAY(data: any): any[] {
  if (!data || !data.outbounds || !data.offers) return [];
  const outbounds = data.outbounds;
  const offers = data.offers;
  const fareFamilies = data.fareFamilies || {};

  // Group offers by outboundId
  const offersByOutbound: Record<string, any[]> = {};
  for (const offer of offers) {
    if (!offersByOutbound[offer.outboundId]) offersByOutbound[offer.outboundId] = [];
    offersByOutbound[offer.outboundId].push(offer);
  }

  // For each outbound, build the itinerary object
  return Object.values(outbounds).map((ob: any) => {
    const segments: any[] = [];
    const layovers: any[] = [];
    (ob.itinerary || []).forEach((seg: any) => {
      if (seg.type === 'FLIGHT') segments.push(seg);
      else if (seg.type === 'LAYOVER') layovers.push(seg);
    });
    // Bundles: for each quota (fare code), find the matching offer and map to bundle
    const bundles: any[] = [];
    if (ob.quotas) {
      for (const fareCode of Object.keys(ob.quotas)) {
        const offer = (offersByOutbound[ob.boundId] || []).find((o: any) => o.outboundFareFamily === fareCode);
        if (offer) {
          // Map fare code to class
          let fareFamily = fareFamilies[fareCode];
          let classCode: "Y" | "W" | "J" | "F" = "Y";
          if (fareFamily) classCode = mapCabinToClassAY(fareFamily.brandName || '');
          else if (offer.outboundFareInformation && offer.outboundFareInformation[0]) {
            classCode = mapCabinToClassAY(offer.outboundFareInformation[0].cabinClass || '');
          }
          bundles.push({
            class: classCode,
            points: offer.totalPointsPrice,
            fareTax: offer.totalPrice,
          });
        }
      }
    }
    // Segments with layover durations
    const formattedSegments: any[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const layover = i > 0 && layovers[i - 1] ? layovers[i - 1] : null;
      formattedSegments.push({
        from: seg.departure.locationCode,
        to: seg.arrival.locationCode,
        aircraft: seg.aircraftCode,
        stops: 0,
        depart: seg.departure.dateTime?.replace(/([+-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
        arrive: seg.arrival.dateTime?.replace(/([+-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
        flightnumber: seg.flightNumber,
        duration: msToMinutes(seg.duration?.milliseconds),
        layover: layover ? msToMinutes(layover.duration?.milliseconds) : undefined,
        distance: 1,
      });
    }
    return {
      from: ob.departure.locationCode,
      to: ob.arrival.locationCode,
      connections: segments.length > 1 ? segments.slice(0, -1).map((s: any) => s.arrival.locationCode) : [],
      depart: segments[0]?.departure?.dateTime?.replace(/([+-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
      arrive: segments[segments.length - 1]?.arrival?.dateTime?.replace(/([+-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
      duration: msToMinutes(ob.duration?.milliseconds),
      bundles,
      segments: formattedSegments,
    };
  });
}

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  try {
    const body = await req.json();
    const parsed = LiveSearchAYSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
    }
    const { from, to, depart, ADT } = parsed.data;
    // Prepare Finnair microservice payload
    const microserviceUrl = 'http://localhost:4003/finnair';
    const microBody = {
      itinerary: [
        {
          departureLocationCode: from,
          destinationLocationCode: to,
          departureDate: depart,
          isRequestedBound: true,
        },
      ],
      adults: ADT,
      children: 0,
      c15s: 0,
      infants: 0,
      cabin: 'MIXED',
      directFlights: false,
      locale: 'en',
      isAward: true,
    };
    const microResp = await fetch(microserviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(microBody),
    });
    if (!microResp.ok) {
      const errorText = await microResp.text();
      return NextResponse.json({ error: 'Finnair microservice error', status: microResp.status, body: errorText }, { status: microResp.status });
    }
    const json = await microResp.json();
    const itinerary = normalizeItinerariesAY(json);
    
    // Encrypt the response data
    const { token, expiresAt } = encryptResponseAES({ currency: json.currency, itinerary });
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt
    });
  } catch (err) {
    console.error('Error in live-search-AY POST:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 