import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { customAlphabet } from 'nanoid';
import { parseISO } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@/lib/route-helpers';
import { getSupabaseConfig } from '@/lib/env-utils';

const { url: SUPABASE_URL, serviceRoleKey: SUPABASE_KEY } = getSupabaseConfig();

const nanoid = customAlphabet('1234567890abcdef', 32);

const JetBlueSchema = z.object({
  from: z.string().min(3),
  to: z.string().min(3),
  depart: z.string().min(8),
});

const JETBLUE_LFS_URL = 'https://cb-api.jetblue.com/cb-flight-search/v1/search/NGB?digb_enable_cb_profile=true&crystal_blue_price_summary=true&crystal_blue_seats_extras=true&digb_acfp_previewseatmap=true&digb_acfp_opsseatmap=true&is_cb_flow=true';

function getJetBlueHeaders(from: string, to: string, depart: string) {
  const traceId = Math.random().toString(16).substring(2, 18);
  const spanId = Date.now().toString();
  
  return {
    'X-B3-SpanId': spanId,
    'sec-ch-ua-platform': '"macOS"',
    'Referer': `https://www.jetblue.com/booking/cb-flights?from=${from}&to=${to}&depart=${depart}&isMultiCity=false&noOfRoute=1&adults=1&children=0&infants=0&sharedMarket=false&roundTripFaresFlag=false&usePoints=true`,
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'sec-ch-ua-mobile': '?0',
    'X-B3-TraceId': traceId,
    'ocp-apim-subscription-key': 'a5ee654e981b4577a58264fed9b1669c',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Cookie': 'ADRUM_BT=R:195|i:285972|g:02e1b4ee-f370-4c74-ad8e-14ef5c42bc30486290|e:1786|n:jetblue_05da9771-4dd4-4420-bf5f-6b666ab2c532',
  };
}

// Helper to parse ISO 8601 durations (PTxxHxxM, PTxxM, etc.) to minutes
function isoDurationToMinutes(duration: string | number | null | undefined): number | null {
  if (!duration) return null;
  
  // If it's already a number (from new API), return it
  if (typeof duration === 'number') return duration;
  
  // If it's a string, parse it as ISO duration
  const match = duration.match(/^P(?:([0-9]+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!match) return null;
  const days = match[1] ? parseInt(match[1], 10) : 0;
  const hours = match[2] ? parseInt(match[2], 10) : 0;
  const minutes = match[3] ? parseInt(match[3], 10) : 0;
  return days * 24 * 60 + hours * 60 + minutes;
}

function removeTimezone(dt: string | null | undefined): string | null {
  if (!dt) return null;
  try {
    return parseISO(dt).toISOString().replace(/Z$/, '');
  } catch {
    return dt.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, '');
  }
}

function normalizeCabinClass(cabin: string | null | undefined): string | null {
  if (!cabin) return null;
  if (cabin === 'C') return 'business';
  if (cabin === 'Y') return 'economy';
  if (cabin === 'F') return 'first';
  if (cabin === 'P') return 'economy';
  return cabin;
}

function parseItinerary(itin: any) {
  // Find the first non-null layover from segments
  const segments = (itin.segments || []).map((s: any) => ({
    id: s.id,
    from_airport: s.from,
    to_airport: s.to,
    aircraft: s.aircraft,
    depart: removeTimezone(s.depart),
    arrive: removeTimezone(s.arrive),
    flightno: (s.flightno || '').replace(/\s+/g, ''),
    duration: isoDurationToMinutes(s.duration),
    // layover will be handled at itinerary level
    bookingclass: s.bookingclass,
    cabinclass: normalizeCabinClass(s.cabinclass),
    operating_airline_code: s.operatingAirlineCode,
    distance: s.distance,
  }));
  const layover = (itin.segments || [])
    .map((s: any) => isoDurationToMinutes(s.layover))
    .find((v: number | null) => v !== null) ?? null;
  return {
    id: uuidv4(),
    from_airport: itin.from,
    to_airport: itin.to,
    connections: itin.connections || [],
    depart: removeTimezone(itin.depart),
    arrive: removeTimezone(itin.arrive),
    duration: isoDurationToMinutes(itin.duration),
    layover,
    price: (itin.bundles || []).map((b: any) => ({
      points: b.points,
      fareTax: b.fareTax,
      cabinclass: normalizeCabinClass(b.cabinclass),
      inventoryQuantity: b.inventoryQuantity != null ? b.inventoryQuantity : 6,
    })),
    segments,
  };
}

async function upsertSegments(segments: any[], supabase: SupabaseClient) {
  for (const seg of segments) {
    await supabase.from('segments').upsert(seg, { onConflict: 'id' });
  }
}

async function upsertItinerary(itin: any, supabase: SupabaseClient) {
  const { segments, ...itinDb } = itin;
  await supabase.from('itinerary').upsert({
    ...itinDb,
    price: JSON.stringify(itinDb.price),
    segment_ids: Array.from(new Set(segments.map((s: any) => s.id))),
  }, { onConflict: 'id' });
}

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  // Create Supabase client at runtime
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  try {
    const body = await req.json();
    const parsed = JetBlueSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
    }
    const { from, to, depart } = parsed.data;
    const departDate = depart.slice(0, 10); // 'YYYY-MM-DD'
    await supabase
      .from('itinerary')
      .delete()
      .eq('from_airport', from)
      .eq('to_airport', to)
      .gte('depart', `${departDate} 00:00:00`)
      .lt('depart', `${departDate} 23:59:59.999`);
    // Now fetch from JetBlue API with new format
    const payload = {
      awardBooking: true,
      travelerTypes: [{ type: "ADULT", quantity: 1 }],
      searchComponents: [{ from, to, date: depart.slice(0, 10) }]
    };
    const headers = getJetBlueHeaders(from, to, depart.slice(0, 10));
    const resp = await fetch(JETBLUE_LFS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      return NextResponse.json({ error: 'JetBlue API error', status: resp.status }, { status: resp.status });
    }
    const data = await resp.json();
    
    // Handle new API response format
    let itineraries = [];
    if (data.status?.transactionStatus === 'success' && data.data?.searchResults) {
      // New API format - extract from searchResults
      for (const result of data.data.searchResults) {
        for (const offer of result.productOffers || []) {
          for (const route of offer.originAndDestination || []) {
            const firstSegment = route.flightSegments?.[0];
            const lastSegment = route.flightSegments?.[route.flightSegments.length - 1];
            const price = offer.offers?.[0]?.price || [];
            
            // Map to old format structure
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
            
            // Only include business class results for LFS
            const cabinClass = offer.offers?.[0]?.cabinClass;
            if (cabinClass !== 'Business' && cabinClass !== 'First') {
              continue; // Skip non-business class results
            }

            const itinerary = {
              from: firstSegment?.departure?.airport || route.departure?.airport,
              to: lastSegment?.arrival?.airport || route.arrival?.airport,
              connections,
              depart: route.departure?.date || firstSegment?.departure?.date,
              arrive: route.arrival?.date || lastSegment?.arrival?.date,
              duration: route.totalDuration || 0,
              bundles: price.length > 0 ? [{
                class: cabinClass === 'First' ? 'F' : 'C', // Map to airline codes
                points: price.find(p => p.currency === 'FFCURRENCY')?.amount || 0,
                fareTax: price.find(p => p.currency === 'USD')?.amount || 0,
              }] : [],
              segments: route.flightSegments?.map(segment => ({
                id: segment['@id'],
                from: segment.departure?.airport,
                to: segment.arrival?.airport,
                aircraft: segment.aircraft,
                stops: segment.stopAirport?.length || 0,
                depart: segment.departure?.date,
                arrive: segment.arrival?.date,
                flightno: segment.flightInfo ? `${segment.flightInfo.marketingAirlineCode}${segment.flightInfo.marketingFlightNumber}` : '',
                duration: segment.duration || 0,
                layover: segment.layoverDuration,
                distance: segment.distance || 0,
              })) || [],
            };
            itineraries.push(itinerary);
          }
        }
      }
    } else {
      // Old API format fallback
      itineraries = data.itinerary || [];
    }
    
    const parsedItineraries = itineraries.map(parseItinerary);
    // Build dategroup from the raw JetBlue API data
    let dategroup = [];
    if (Array.isArray(data.dategroup)) {
      dategroup = data.dategroup;
    } else if (Array.isArray(data.group)) {
      // Some JetBlue responses may have group at the top level
      dategroup = [{ from, to, group: data.group }];
    } else if (Array.isArray(data.itinerary)) {
      // Fallback: build dategroup from itineraries if group is not present
      const group = data.itinerary.map((itin: any) => ({
        date: itin.depart,
        points: Array.isArray(itin.bundles) && itin.bundles[0]?.points ? itin.bundles[0].points : 'N/A',
        fareTax: Array.isArray(itin.bundles) && itin.bundles[0]?.fareTax ? itin.bundles[0].fareTax : 'N/A',
      }));
      dategroup = [{ from, to, group }];
    } else if (parsedItineraries.length > 0) {
      // New API format: build dategroup from parsed itineraries
      const group = parsedItineraries.map((itin: any) => ({
        date: itin.depart,
        points: Array.isArray(itin.price) && itin.price[0]?.points ? itin.price[0].points : 'N/A',
        fareTax: Array.isArray(itin.price) && itin.price[0]?.fareTax ? itin.price[0].fareTax : 'N/A',
      }));
      dategroup = [{ from, to, group }];
    }
    let totalSegments = 0;
    for (const itin of parsedItineraries) {
      await upsertSegments(itin.segments, supabase);
      // Build upsert payload with only valid columns and correct types, no undefined, no extra fields
      const { segments, price, ...itinDb } = itin;
      const priceObj = Array.isArray(price) && price.length > 0 ? price[0] : {};
      const upsertPayload = {
        id: itinDb.id,
        from_airport: itinDb.from_airport ? String(itinDb.from_airport) : null,
        to_airport: itinDb.to_airport ? String(itinDb.to_airport) : null,
        connections: Array.isArray(itinDb.connections) ? itinDb.connections.map(String) : [],
        depart: itinDb.depart ?? null,
        arrive: itinDb.arrive ?? null,
        duration: typeof itinDb.duration === 'number' ? itinDb.duration : null,
        segment_ids: Array.isArray(segments) ? segments.map((s: any) => String(s.id)) : [],
        layover: typeof itinDb.layover === 'number' ? itinDb.layover : null,
        points: priceObj.points !== undefined ? String(priceObj.points) : null,
        fare_tax: priceObj.fareTax !== undefined ? String(priceObj.fareTax) : null,
        cabin_class: priceObj.cabinclass !== undefined ? String(priceObj.cabinclass) : null,
        inventory_quantity: priceObj.inventoryQuantity !== undefined ? String(priceObj.inventoryQuantity) : null,
        last_updated: new Date().toISOString(),
      };
      const upsertResult = await supabase.from('itinerary').upsert(upsertPayload, { onConflict: 'id' });
      if (upsertResult.error) {
        console.error('[Itinerary Upsert] Failed:', {
          status: upsertResult.status,
          message: upsertResult.error.message,
          from_airport: upsertPayload.from_airport,
          to_airport: upsertPayload.to_airport,
          depart: upsertPayload.depart,
        });
      } else {
        totalSegments += Array.isArray(segments) ? segments.length : 0;
      }
    }
    return NextResponse.json({ itineraries: parsedItineraries, totalSegments, dategroup });
  } catch (err) {
    console.error('Error in JetBlue LFS POST:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 