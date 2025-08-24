import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { encryptResponseJWT } from '@/lib/jwt-encryption';

const LiveSearchDLSchema = z.object({
  from: z.string().min(3),
  to: z.string().min(3),
  depart: z.string().min(8),
  ADT: z.number().int().min(1).max(9),
  cookie: z.string().optional(),
  transactionid: z.string().optional(),
  query: z.string().optional(),
  variables: z.any().optional(),
  noProxy: z.boolean().optional(),
});

function minutesFromParts(dayCnt?: number | null, hourCnt?: number | null, minuteCnt?: number | null): number | undefined {
  if (dayCnt == null && hourCnt == null && minuteCnt == null) return undefined;
  const d = dayCnt || 0; const h = hourCnt || 0; const m = minuteCnt || 0;
  return d * 24 * 60 + h * 60 + m;
}

function normalizeDLResponse(data: any) {
  const sets = data?.data?.gqlSearchOffers?.gqlOffersSets || [];
  const itineraries: any[] = [];
  for (const set of sets) {
    const trips = set?.trips || [];
    for (const trip of trips) {
      const segmentsSrc = trip?.flightSegment || [];
      // Build segments
      const segments = segmentsSrc.map((seg: any) => {
        const flightLeg = Array.isArray(seg?.flightLeg) ? seg.flightLeg[0] : seg?.flightLeg;
        const durationMin = minutesFromParts(seg?.duration?.dayCnt, seg?.duration?.hourCnt, seg?.duration?.minuteCnt);
        const marketingCarrier = seg?.marketingCarrier?.carrierCode;
        const flightNumber = seg?.marketingCarrier?.carrierNum;
        const flightnumber = marketingCarrier && flightNumber ? `${marketingCarrier}${flightNumber}` : undefined;
        // Layover is provided at leg level sometimes
        let layoverMin: number | undefined;
        if (seg?.layover?.layoverDuration) {
          layoverMin = minutesFromParts(seg.layover.layoverDuration.hourCnt, seg.layover.layoverDuration.minuteCnt, 0);
        }
        return {
          from: seg?.originAirportCode || flightLeg?.originAirportCode,
          to: seg?.destinationAirportCode || flightLeg?.destinationAirportCode,
          aircraft: seg?.aircraft?.subFleetTypeCode || seg?.aircraft?.fleetTypeCode,
          stops: seg?.stopCnt ?? 0,
          depart: seg?.scheduledDepartureLocalTs || flightLeg?.scheduledDepartureLocalTs,
          arrive: seg?.scheduledArrivalLocalTs || flightLeg?.scheduledArrivalLocalTs,
          flightnumber,
          duration: durationMin,
          layover: layoverMin,
          distance: seg?.distance?.unitOfMeasureCnt,
        };
      });

      // Build bundles from offers in the set
      const bundles: any[] = [];
      const offers = set?.offers || [];
      for (const offer of offers) {
        const ap = offer?.additionalOfferProperties;
        const items = offer?.offerItems || [];
        const fareInfos = items.flatMap((it: any) => it?.retailItems || [])
          .flatMap((ri: any) => ri?.retailItemMetaData?.fareInformation ? [ri.retailItemMetaData.fareInformation] : []);
        const firstFare = fareInfos[0];
        let points: number | undefined;
        let fareTax: any;
        if (firstFare?.farePrice?.totalFarePrice?.milesEquivalentPrice?.mileCnt != null) {
          points = firstFare.farePrice.totalFarePrice.milesEquivalentPrice.mileCnt;
        }
        if (firstFare?.farePrice?.totalFarePrice?.currencyEquivalentPrice?.formattedCurrencyAmt) {
          fareTax = firstFare.farePrice.totalFarePrice.currencyEquivalentPrice.formattedCurrencyAmt;
        }
        // Map brand to class code
        const brandId = ap?.dominantSegmentBrandId || firstFare?.brandByFlightLegs?.[0]?.product?.brandId;
        const classMap: Record<string, 'Y' | 'W' | 'J' | 'F'> = { BE: 'Y', PE: 'W', BU: 'J', FI: 'F' };
        const cls = classMap[(brandId || '').toUpperCase()] || 'Y';
        // Keep only bundles with at least points or fareTax
        if (points != null || fareTax != null) {
          bundles.push({ class: cls, points, fareTax });
        }
      }

      itineraries.push({
        from: trip?.originAirportCode,
        to: trip?.destinationAirportCode,
        connections: [],
        depart: trip?.scheduledDepartureLocalTs,
        arrive: trip?.scheduledArrivalLocalTs,
        duration: minutesFromParts(trip?.totalTripTime?.dayCnt, trip?.totalTripTime?.hourCnt, trip?.totalTripTime?.minuteCnt),
        bundles,
        segments,
      });
    }
  }
  return { itinerary: itineraries };
}

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  try {
    const body = await req.json();
    const parsed = LiveSearchDLSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
    }
    const { from, to, depart, ADT, cookie, transactionid, query, variables, noProxy } = parsed.data;

    // Call our Delta microservice
    const microserviceUrl = 'http://localhost:4005/delta';
    const microResp = await fetch(microserviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, depart, ADT, cookie, transactionid, query, variables, noProxy }),
    });
    if (!microResp.ok) {
      const errorText = await microResp.text();
      return NextResponse.json({ error: 'Delta microservice error', status: microResp.status, body: errorText }, { status: microResp.status });
    }
    const raw = await microResp.json();
    
    // Encrypt the response data
    const { token, expiresAt } = encryptResponseJWT(raw);
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt
    });
  } catch (err) {
    console.error('Error in live-search-DL POST:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
}


