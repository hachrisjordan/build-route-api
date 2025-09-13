import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { encryptResponseAES } from '@/lib/aes-encryption';

const JETBLUE_LFS_URL = 'https://jbrest.jetblue.com/lfs-rwb/outboundLFS';
const JETBLUE_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'content-type': 'application/json',
  'API-Version': 'v3',
  'Application-Channel': 'Desktop_Web',
  'Booking-Application-Type': 'NGB',
  'sec-ch-ua-platform': '"Windows"',
  'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Referer': 'https://www.jetblue.com/booking/flights',
};

const LiveSearchSchema = z.object({
  from: z.string().min(3),
  to: z.string().min(3),
  depart: z.string().min(8),
  ADT: z.number().int().min(1).max(9),
});

const bundleClassMap: Record<string, string> = {
  'PREM._ECONOMY_REDEMPTION': 'W',
  'ECONOMY_REDEMPTION': 'Y',
  'BUSINESS_REDEMPTION': 'J',
  'FIRST_REDEMPTION': 'F',
};

function removeTimezone(dt: string | null | undefined): string | null {
  if (!dt) return null;
  // Remove timezone info (e.g., "+07:00" or "-05:00")
  return dt.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, '');
}

function isoDurationToMinutes(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const match = duration.match(/^P(?:([0-9]+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!match) return null;
  const days = match[1] ? parseInt(match[1], 10) : 0;
  const hours = match[2] ? parseInt(match[2], 10) : 0;
  const minutes = match[3] ? parseInt(match[3], 10) : 0;
  return days * 24 * 60 + hours * 60 + minutes;
}

function normalizeItinerary(itin: any) {
  return {
    from: itin.from,
    to: itin.to,
    connections: itin.connections || [],
    depart: removeTimezone(itin.depart),
    arrive: removeTimezone(itin.arrive),
    duration: isoDurationToMinutes(itin.duration),
    bundles: (itin.bundles || []).map((b: any) => ({
      class: bundleClassMap[b.code] || b.code,
      points: b.points,
      fareTax: b.fareTax,
    })),
    segments: (itin.segments || []).map((s: any) => ({
      from: s.from,
      to: s.to,
      aircraft: s.aircraft,
      stops: s.stops,
      depart: removeTimezone(s.depart),
      arrive: removeTimezone(s.arrive),
      flightnumber: (s.flightno || '').replace(/\s+/g, ''),
      duration: isoDurationToMinutes(s.duration),
      layover: s.layover ? isoDurationToMinutes(s.layover) : undefined,
      distance: s.distance,
    })),
  };
}

/**
 * Transforms the itinerary array:
 * - Keeps only BLUE_BASIC (as Y) and MINT (as J) bundles
 * - Removes all other bundles
 * - Prepends 'B6' to segment flight numbers if class is Y or J
 * @param itineraryArr The original itinerary array
 * @returns The transformed itinerary array
 */
function transformItineraries(itineraryArr: any[]): any[] {
  return itineraryArr.map((itin) => {
    // Filter and map bundles
    const filteredBundles = (itin.bundles || [])
      .filter((b: any) => ['Y', 'J', 'W', 'F', 'BLUE_BASIC', 'MINT'].includes(b.class))
      .map((b: any) => ({
        ...b,
        class: b.class === 'BLUE_BASIC' ? 'Y' : b.class === 'MINT' ? 'J' : b.class,
      }))
      // Remove bundles that only have 'class' property (no points or fareTax)
      .filter((b: any) => {
        const keys = Object.keys(b);
        // Keep if there is at least one property besides 'class'
        return keys.some((k) => k !== 'class');
      });

    // Determine if we have BLUE_BASIC or MINT class in the original bundles
    const hasBlueBasicOrMint = (itin.bundles || []).some((b: any) => b.class === 'BLUE_BASIC' || b.class === 'MINT');

    // Update segments
    const updatedSegments = (itin.segments || []).map((seg: any) => {
      if (hasBlueBasicOrMint && seg.flightnumber && !seg.flightnumber.startsWith('B6')) {
        return { ...seg, flightnumber: `B6${seg.flightnumber}` };
      }
      return seg;
    });

    return {
      ...itin,
      bundles: filteredBundles,
      segments: updatedSegments,
    };
  });
}

/**
 * Required environment variables for proxy:
 * - PROXY_HOST
 * - PROXY_PORT
 * - PROXY_USERNAME
 * - PROXY_PASSWORD
 */

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  try {
    const body = await req.json();
    const parsed = LiveSearchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
    }
    const { from, to, depart, ADT } = parsed.data;
    // Updated payload format for new JetBlue API
    const payload = {
      awardBooking: true,
      travelerTypes: [{ type: "ADULT", quantity: ADT }],
      searchComponents: [{ from, to, date: depart }]
    };

    // Proxy config (runtime only)
    const USE_PROXY = true;
    const proxy_host = process.env.PROXY_HOST;
    const proxy_port = process.env.PROXY_PORT;
    const proxy_username = process.env.PROXY_USERNAME;
    const proxy_password = process.env.PROXY_PASSWORD;
    if (USE_PROXY && (!proxy_host || !proxy_port || !proxy_username || !proxy_password)) {
      return NextResponse.json({ error: 'Proxy configuration is missing. Please set PROXY_HOST, PROXY_PORT, PROXY_USERNAME, and PROXY_PASSWORD in your environment variables.' }, { status: 500 });
    }
    const PROXY_URL = USE_PROXY
      ? `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`
      : undefined;
    const proxyAgent = USE_PROXY && PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

    // Generate random trace/span IDs
    const traceId = crypto.randomBytes(8).toString('hex');
    const spanId = Date.now().toString();

    const headers = {
      ...JETBLUE_HEADERS,
      'Referer': `https://www.jetblue.com/booking/flights?from=${from}&to=${to}&depart=${depart}&isMultiCity=false&noOfRoute=1&adults=${ADT}&children=0&infants=0&sharedMarket=false&roundTripFaresFlag=false&usePoints=true`,
      'X-B3-TraceId': traceId,
      'X-B3-SpanId': spanId,
    };

    const fetchOptions: any = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    };
    if (USE_PROXY) {
      fetchOptions.agent = proxyAgent;
    }

    const microserviceUrl = 'http://localhost:4000/jetblue';
    const microResp = await fetch(microserviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, depart, ADT }),
    });
    if (!microResp.ok) {
      const errorText = await microResp.text();
      console.error('JetBlue microservice error:', microResp.status, errorText);
      return NextResponse.json({ error: 'JetBlue microservice error', status: microResp.status, body: errorText }, { status: microResp.status });
    }
    const data = await microResp.json();
    
    // Handle new JetBlue API response format
    let itineraries = [];
    if (data.status?.transactionStatus === 'success' && data.data?.searchResults) {
      // New API format - map to old format structure
      itineraries = data.data.searchResults.flatMap(result => 
        result.productOffers?.flatMap(offer => 
          offer.originAndDestination?.map(route => {
            const firstSegment = route.flightSegments?.[0];
            const lastSegment = route.flightSegments?.[route.flightSegments.length - 1];
            const price = offer.offers?.[0]?.price || [];
            
            // Map to old format
            const connections = [];
            if (route.flightSegments && route.flightSegments.length > 1) {
              for (let i = 0; i < route.flightSegments.length - 1; i++) {
                const currSeg = route.flightSegments[i];
                const nextSeg = route.flightSegments[i + 1];
                if (currSeg?.arrival?.airport && nextSeg?.departure?.airport) {
                  if (currSeg.arrival.airport !== nextSeg.departure.airport) {
                    connections.push(`${currSeg.arrival.airport}/${nextSeg.departure.airport}`);
                  } else {
                    connections.push(currSeg.arrival.airport);
                  }
                }
              }
            }
            
            return {
              from: firstSegment?.departure?.airport || route.departure?.airport,
              to: lastSegment?.arrival?.airport || route.arrival?.airport,
              connections,
              depart: route.departure?.date || firstSegment?.departure?.date,
              arrive: route.arrival?.date || lastSegment?.arrival?.date,
              duration: route.totalDuration || 0,
              bundles: price.length > 0 ? [{
                class: 'Y', // Default class
                points: price.find(p => p.currency === 'FFCURRENCY')?.amount || 0,
                fareTax: price.find(p => p.currency === 'USD')?.amount || 0,
              }] : [],
              segments: route.flightSegments?.map(segment => ({
                from: segment.departure?.airport,
                to: segment.arrival?.airport,
                aircraft: segment.aircraft,
                stops: segment.stopAirport?.length || 0,
                depart: segment.departure?.date,
                arrive: segment.arrival?.date,
                flightnumber: segment.flightInfo ? `${segment.flightInfo.marketingAirlineCode}${segment.flightInfo.marketingFlightNumber}` : '',
                duration: segment.duration || 0,
                layover: segment.layoverDuration,
                distance: segment.distance || 0,
              })) || [],
            };
          }) || []
        ) || []
      );
    } else if (Array.isArray(data.itinerary)) {
      // Old API format
      itineraries = data.itinerary.map(normalizeItinerary);
    }
    
    const transformedItineraries = transformItineraries(itineraries);
    
    // Encrypt the response data (can be disabled with DISABLE_ENCRYPTION=true)
    if (process.env.DISABLE_ENCRYPTION === 'true') {
      return NextResponse.json({
        encrypted: false,
        itinerary: transformedItineraries
      });
    }
    
    const { token, expiresAt } = encryptResponseAES({ itinerary: transformedItineraries });
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt
    });
  } catch (err) {
    console.error('Error in live-search-B6 POST:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 