import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { customAlphabet } from 'nanoid';
import { parseISO } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@/lib/route-helpers';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const nanoid = customAlphabet('1234567890abcdef', 32);

const JetBlueSchema = z.object({
  from: z.string().min(3),
  to: z.string().min(3),
  depart: z.string().min(8),
});

const JETBLUE_LFS_URL = 'https://jbrest.jetblue.com/lfs-rwb/outboundLFS';
const JETBLUE_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'api-version': 'v3',
  'application-channel': 'Desktop_Web',
  'booking-application-type': 'NGB',
  'content-type': 'application/json',
  'origin': 'https://www.jetblue.com',
  'priority': 'u=1, i',
  'referer': 'https://www.jetblue.com/booking/flights',
  'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
};

// Helper to parse ISO 8601 durations (PTxxHxxM, PTxxM, etc.) to minutes
function isoDurationToMinutes(duration: string | null | undefined): number | null {
  if (!duration) return null;
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
    const payload = {
      tripType: 'oneWay',
      from,
      to,
      depart,
      cabin: 'business',
      refundable: false,
      dates: { before: '3', after: '3' },
      pax: { ADT: 1, CHD: 0, INF: 0, UNN: 0 },
      redempoint: true,
      pointsBreakup: { option: '', value: 0 },
      isMultiCity: false,
      isDomestic: false,
      'outbound-source': 'fare-setSearchParameters',
    };
    const resp = await fetch(JETBLUE_LFS_URL, {
      method: 'POST',
      headers: JETBLUE_HEADERS,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      // If JetBlue API error is 502, delete any existing itinerary rows for this from/to/depart
      if (resp.status === 502) {
        const { data: deletedRows, error: deleteError } = await supabase
          .from('itinerary')
          .delete()
          .eq('from_airport', from)
          .eq('to_airport', to)
          .eq('depart', depart);
        if (deleteError) {
          console.error(`[Itinerary Delete] Failed to delete itinerary for ${from} -> ${to} on ${depart}:`, deleteError);
        } else {
          console.log(`[Itinerary Delete] Deleted itinerary rows for ${from} -> ${to} on ${depart}`);
        }
      }
      return NextResponse.json({ error: 'JetBlue API error', status: resp.status }, { status: 502 });
    }
    const data = await resp.json();
    const itineraries = (data.itinerary || []).map(parseItinerary);
    let totalSegments = 0;
    for (const itin of itineraries) {
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
    return NextResponse.json({ itineraries, totalSegments });
  } catch (err) {
    console.error('Error in JetBlue LFS POST:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 