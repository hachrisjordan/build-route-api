#!/usr/bin/env tsx
import 'dotenv/config';
import { Resend } from 'resend';
import { getSupabaseAdminClient } from '../src/lib/supabase-admin';

type PriceRow = {
  id: string;
  origin_iata: string;
  destination_iata: string;
  roundtrip: string;
  j: string;
  cpm: number | null;
  price: number | null;
  airlines: string[] | null;
  way_too_cheap: boolean | null;
};

type AirportInfo = {
  region: string;
  countryCode: string;
  cityName: string;
};

type AlertRow = {
  id: string;
  email: string | null;
  type: string | null;
  origin_region: string[] | null;
  origin_country: string[] | null;
  origin_airport: string[] | null;
  destination_region: string[] | null;
  destination_country: string[] | null;
  destination_airport: string[] | null;
  airlines_included: string[] | null;
  airlines_excluded: string[] | null;
  active_route: string[] | null;
};

type RouteSummary = {
  routeKey: string;
  originIata: string;
  destinationIata: string;
  originCity: string;
  destinationCity: string;
  roundtrip: string;
  airlineNames: string[];
  price: number | null;
};

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? '').trim()).filter(Boolean);
}

function keyForRow(row: Pick<PriceRow, 'origin_iata' | 'destination_iata' | 'roundtrip' | 'j'>): string {
  return `${row.origin_iata}|${row.destination_iata}|${row.roundtrip}|${row.j}`;
}

function routeKeyForRow(row: Pick<PriceRow, 'origin_iata' | 'destination_iata' | 'roundtrip'>): string {
  return `${row.origin_iata}_${row.destination_iata}_${row.roundtrip}`;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toUpper(value: string): string {
  return value.trim().toUpperCase();
}

function matchesAxis(filtersRegion: string[], filtersCountry: string[], filtersAirport: string[], row: {
  region: string;
  country: string;
  airport: string;
}): boolean {
  if (filtersRegion.length) return filtersRegion.includes(row.region);
  if (filtersCountry.length) return filtersCountry.includes(row.country);
  if (filtersAirport.length) return filtersAirport.includes(row.airport);
  return false;
}

function matchesAirlineFilters(routeCodes: string[], includeCodes: string[], excludeCodes: string[]): boolean {
  const routeSet = new Set(routeCodes.map(toUpper));
  const include = includeCodes.map(toUpper).filter(Boolean);
  const exclude = excludeCodes.map(toUpper).filter(Boolean);
  if (include.length && !include.some((c) => routeSet.has(c))) return false;
  if (exclude.some((c) => routeSet.has(c))) return false;
  return true;
}

function computeWayTooCheap(rows: PriceRow[], airportByIata: Map<string, AirportInfo>): Map<string, boolean> {
  const byBucket = new Map<string, Array<{ key: string; cpm: number }>>();
  const result = new Map<string, boolean>();

  for (const row of rows) {
    const key = keyForRow(row);
    const origin = airportByIata.get(row.origin_iata);
    const destination = airportByIata.get(row.destination_iata);
    const cpm = row.cpm;

    // Hard guards
    if (!origin || !destination || cpm === null || cpm >= 20 || cpm >= 15) {
      result.set(key, false);
      continue;
    }
    if (!destination.region || destination.region.toLowerCase() === 'unknown') {
      result.set(key, false);
      continue;
    }
    if (origin.region === destination.region) {
      result.set(key, false);
      continue;
    }

    const bucket = `${origin.region}|${destination.region}`;
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket)!.push({ key, cpm });
    result.set(key, false);
  }

  for (const items of byBucket.values()) {
    if (items.length < 2) continue;
    const sorted = [...items].sort((a, b) => (a.cpm - b.cpm) || a.key.localeCompare(b.key));
    const bottomN = Math.max(2, Math.ceil(sorted.length * 0.1));
    const bottom = sorted.slice(0, bottomN);

    let bestGap = -Infinity;
    let breakpoint: number | null = null;
    let currForRatio: number | null = null;
    let nextForRatio: number | null = null;

    for (let i = 0; i < bottom.length - 1; i += 1) {
      const curr = bottom[i]!.cpm;
      const next = bottom[i + 1]!.cpm;
      const gap = next - curr;
      if (gap > bestGap) {
        bestGap = gap;
        breakpoint = curr;
        currForRatio = curr;
        nextForRatio = next;
      }
    }

    const ratioOk = !!(currForRatio && nextForRatio && currForRatio > 0 && (nextForRatio / currForRatio) >= 1.2);
    if (!ratioOk || breakpoint === null) continue;

    for (const item of sorted) {
      if (item.cpm <= breakpoint && item.cpm < 15) {
        result.set(item.key, true);
      }
    }
  }

  return result;
}

function buildSummaryEmail(routes: RouteSummary[]): { subject: string; text: string; html: string } {
  const first = routes[0];
  if (!first) {
    throw new Error('buildSummaryEmail requires at least one route');
  }
  const firstFrom = first.originCity ? `${first.originCity} (${first.originIata})` : first.originIata;
  const firstTo = first.destinationCity ? `${first.destinationCity} (${first.destinationIata})` : first.destinationIata;
  const firstPrice = first.price !== null ? `${Math.round(first.price)} USD` : 'new price';
  const subject = routes.length === 1
    ? `Mistake Fare Alert: ${firstFrom} -> ${firstTo} from ${firstPrice}`
    : `Mistake Fare Alert: ${routes.length} routes turned way too cheap`;

  const lines = routes.map((r) => {
    const from = r.originCity ? `${r.originCity} (${r.originIata})` : r.originIata;
    const to = r.destinationCity ? `${r.destinationCity} (${r.destinationIata})` : r.destinationIata;
    const trip = r.roundtrip === 'roundtrip' ? 'Round-trip' : 'One-way';
    const airlines = r.airlineNames.length ? r.airlineNames.join(', ') : 'Not available';
    const price = r.price !== null ? `${Math.round(r.price)} USD` : 'n/a';
    return `- ${from} -> ${to} | ${trip} | ${airlines} | ${price}`;
  });

  const text = [
    'We found an unusually cheap price that might be a mistake fare.',
    '',
    'Newly armed routes in this backfill run:',
    ...lines,
    '',
    'You are receiving this because your google_alerts filters matched these routes.',
  ].join('\n');

  const rowsHtml = routes.map((r) => {
    const from = r.originCity ? `${r.originCity} (${r.originIata})` : r.originIata;
    const to = r.destinationCity ? `${r.destinationCity} (${r.destinationIata})` : r.destinationIata;
    const trip = r.roundtrip === 'roundtrip' ? 'Round-trip' : 'One-way';
    const airlines = r.airlineNames.length ? r.airlineNames.join(', ') : 'Not available';
    const price = r.price !== null ? `${Math.round(r.price)} USD` : 'n/a';
    return `<tr><td style="padding:8px 6px;">${from}</td><td style="padding:8px 6px;">${to}</td><td style="padding:8px 6px;">${trip}</td><td style="padding:8px 6px;">${airlines}</td><td style="padding:8px 6px;color:#059669;font-weight:700;">${price}</td></tr>`;
  }).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;"><div style="max-width:760px;margin:0 auto;padding:20px;"><div style="background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e7eb;"><div style="display:inline-block;background:#fee2e2;color:#991b1b;padding:6px 12px;border-radius:999px;font-weight:700;font-size:12px;">Mistake Fare Alert</div><h2 style="margin:14px 0 6px 0;color:#111827;">We found an unusually cheap price that might be a mistake fare.</h2><p style="margin:0 0 12px 0;color:#6b7280;">Newly armed routes in this backfill run:</p><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;"><thead><tr><th style="text-align:left;padding:8px 6px;color:#6b7280;font-size:12px;border-bottom:1px solid #e5e7eb;">From</th><th style="text-align:left;padding:8px 6px;color:#6b7280;font-size:12px;border-bottom:1px solid #e5e7eb;">To</th><th style="text-align:left;padding:8px 6px;color:#6b7280;font-size:12px;border-bottom:1px solid #e5e7eb;">Trip type</th><th style="text-align:left;padding:8px 6px;color:#6b7280;font-size:12px;border-bottom:1px solid #e5e7eb;">Operated by</th><th style="text-align:left;padding:8px 6px;color:#6b7280;font-size:12px;border-bottom:1px solid #e5e7eb;">Price</th></tr></thead><tbody>${rowsHtml}</tbody></table><p style="margin-top:18px;color:#6b7280;font-size:13px;">You are receiving this because your google_alerts filters matched these routes.</p></div></div></body></html>`;

  return { subject, text, html };
}

async function fetchAllRows<T>(fetchPage: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const pageSize = 2000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    const rows = await fetchPage(from, from + pageSize - 1);
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function withRetries<T>(fn: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const runId = `backfill-${new Date().toISOString()}`;
  const shouldSendEmail = (process.env.BACKFILL_SEND_EMAIL || 'true').toLowerCase() !== 'false';
  const isDryRun = (process.env.BACKFILL_DRY_RUN || 'false').toLowerCase() === 'true';
  const resendApiKey = process.env.RESEND_API_KEY || '';
  const resendFromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const resend = new Resend(resendApiKey);

  const airportRows = await fetchAllRows(async (from, to) => {
    const { data, error } = await supabase.from('airports').select('iata,region,country_code,city_name').range(from, to);
    if (error) throw new Error(`Failed loading airports: ${error.message}`);
    return data || [];
  });
  const airportByIata = new Map<string, AirportInfo>();
  for (const row of airportRows as Array<{ iata: string; region: string | null; country_code: string | null; city_name: string | null }>) {
    const iata = String(row.iata || '').trim().toUpperCase();
    if (!iata) continue;
    airportByIata.set(iata, {
      region: String(row.region || '').trim(),
      countryCode: String(row.country_code || '').trim().toUpperCase(),
      cityName: String(row.city_name || '').trim(),
    });
  }

  const priceRowsRaw = await fetchAllRows(async (from, to) => {
    const { data, error } = await supabase
      .from('google_flights_explore_destination_prices')
      .select('id,origin_iata,destination_iata,roundtrip,j,cpm,price,airlines,way_too_cheap')
      .range(from, to);
    if (error) throw new Error(`Failed loading prices: ${error.message}`);
    return data || [];
  });

  const priceRows: PriceRow[] = (priceRowsRaw as any[]).map((r) => ({
    id: String(r.id),
    origin_iata: toUpper(String(r.origin_iata || '')),
    destination_iata: toUpper(String(r.destination_iata || '')),
    roundtrip: String(r.roundtrip || '').trim().toLowerCase(),
    j: String(r.j || 'j').trim(),
    cpm: toNumberOrNull(r.cpm),
    price: toNumberOrNull(r.price),
    airlines: normalizeArray(r.airlines).map(toUpper),
    way_too_cheap: r.way_too_cheap === true ? true : r.way_too_cheap === false ? false : null,
  }));

  const oldFlagByKey = new Map<string, boolean | null>();
  for (const row of priceRows) oldFlagByKey.set(keyForRow(row), row.way_too_cheap);

  const newFlagByKey = computeWayTooCheap(priceRows, airportByIata);

  const updates = priceRows
    .map((row) => {
      const oldFlag = oldFlagByKey.get(keyForRow(row));
      const newFlag = newFlagByKey.get(keyForRow(row)) ?? false;
      return { id: row.id, oldFlag, way_too_cheap: newFlag };
    })
    .filter((u) => (u.oldFlag === true) !== (u.way_too_cheap === true));

  console.log(`[google-alerts-backfill-run] rows_to_update=${updates.length}`);

  if (!isDryRun) {
    // Update only changed rows by id (not upsert) so we don't hit NOT NULL insert paths.
    // Keep writes intentionally conservative to avoid API pressure.
    for (let i = 0; i < updates.length; i += 10) {
      const chunk = updates.slice(i, i + 10);
      for (const u of chunk) {
        await withRetries(async () => {
          const { error } = await supabase
            .from('google_flights_explore_destination_prices')
            .update({ way_too_cheap: u.way_too_cheap })
            .eq('id', u.id);
          if (error) {
            throw new Error(`Failed updating way_too_cheap for id=${u.id}: ${error.message}`);
          }
        }, 4, 750);
      }
    }
  }

  const becameTrue = new Set<string>();
  const becameFalse = new Set<string>();
  for (const row of priceRows) {
    const key = keyForRow(row);
    const oldFlag = oldFlagByKey.get(key);
    const newFlag = newFlagByKey.get(key) ?? false;
    if (oldFlag !== true && newFlag === true) becameTrue.add(key);
    if (oldFlag === true && newFlag !== true) becameFalse.add(key);
  }

  const alertRows = await fetchAllRows(async (from, to) => {
    const { data, error } = await supabase
      .from('google_alerts')
      .select('id,email,type,origin_region,origin_country,origin_airport,destination_region,destination_country,destination_airport,airlines_included,airlines_excluded,active_route')
      .range(from, to);
    if (error) throw new Error(`Failed loading alerts: ${error.message}`);
    return data || [];
  }) as AlertRow[];

  const airlineCodes = new Set<string>();
  for (const row of priceRows) {
    if (!becameTrue.has(keyForRow(row))) continue;
    for (const code of normalizeArray(row.airlines).map(toUpper)) airlineCodes.add(code);
  }
  const airlineNameByCode = new Map<string, string>();
  if (airlineCodes.size) {
    const { data, error } = await supabase.from('airlines').select('code,name').in('code', Array.from(airlineCodes));
    if (error) throw new Error(`Failed loading airline names: ${error.message}`);
    for (const row of (data || []) as Array<{ code: string; name: string | null }>) {
      const code = toUpper(String(row.code || ''));
      if (code) airlineNameByCode.set(code, String(row.name || '').trim() || code);
    }
  }

  const rowByKey = new Map<string, PriceRow>();
  for (const row of priceRows) rowByKey.set(keyForRow(row), row);

  let emailsSent = 0;
  let alertsTouched = 0;
  for (const alert of alertRows) {
    const alertId = String(alert.id || '').trim();
    if (!alertId) continue;
    const alertType = ['oneway', 'roundtrip', 'all'].includes(String(alert.type || '').toLowerCase())
      ? String(alert.type || 'all').toLowerCase()
      : 'all';

    const originRegionFilters = normalizeArray(alert.origin_region);
    const originCountryFilters = normalizeArray(alert.origin_country).map(toUpper);
    const originAirportFilters = normalizeArray(alert.origin_airport).map(toUpper);
    const destinationRegionFilters = normalizeArray(alert.destination_region);
    const destinationCountryFilters = normalizeArray(alert.destination_country).map(toUpper);
    const destinationAirportFilters = normalizeArray(alert.destination_airport).map(toUpper);
    const includeAirlines = normalizeArray(alert.airlines_included).map(toUpper);
    const excludeAirlines = normalizeArray(alert.airlines_excluded).map(toUpper);
    const activeRouteSet = new Set(normalizeArray(alert.active_route));

    const summaryRoutes: RouteSummary[] = [];
    let changed = false;

    for (const key of new Set([...becameTrue, ...becameFalse])) {
      const row = rowByKey.get(key);
      if (!row) continue;
      if (alertType !== 'all' && row.roundtrip !== alertType) continue;
      const originInfo = airportByIata.get(row.origin_iata);
      const destinationInfo = airportByIata.get(row.destination_iata);
      if (!originInfo || !destinationInfo) continue;

      const originMatch = matchesAxis(
        originRegionFilters,
        originCountryFilters,
        originAirportFilters,
        { region: originInfo.region, country: originInfo.countryCode, airport: row.origin_iata },
      );
      if (!originMatch) continue;

      const destinationMatch = matchesAxis(
        destinationRegionFilters,
        destinationCountryFilters,
        destinationAirportFilters,
        { region: destinationInfo.region, country: destinationInfo.countryCode, airport: row.destination_iata },
      );
      if (!destinationMatch) continue;

      const routeCodes = normalizeArray(row.airlines).map(toUpper);
      if (!matchesAirlineFilters(routeCodes, includeAirlines, excludeAirlines)) continue;

      const rKey = routeKeyForRow(row);
      if (becameTrue.has(key)) {
        if (!activeRouteSet.has(rKey)) {
          activeRouteSet.add(rKey);
          changed = true;
          summaryRoutes.push({
            routeKey: rKey,
            originIata: row.origin_iata,
            destinationIata: row.destination_iata,
            originCity: originInfo.cityName,
            destinationCity: destinationInfo.cityName,
            roundtrip: row.roundtrip,
            airlineNames: routeCodes.map((c) => airlineNameByCode.get(c) || c),
            price: row.price,
          });
        }
      } else if (becameFalse.has(key)) {
        if (activeRouteSet.has(rKey)) {
          activeRouteSet.delete(rKey);
          changed = true;
        }
      }
    }

    if (changed && !isDryRun) {
      const { error } = await supabase
        .from('google_alerts')
        .update({ active_route: Array.from(activeRouteSet).sort(), updated_at: new Date().toISOString() })
        .eq('id', alertId);
      if (error) throw new Error(`Failed updating alert ${alertId}: ${error.message}`);
      alertsTouched += 1;
    }

    if (summaryRoutes.length > 0 && shouldSendEmail && !isDryRun) {
      const toEmail = String(alert.email || '').trim();
      if (toEmail && resendApiKey) {
        const message = buildSummaryEmail(summaryRoutes);
        const { error } = await resend.emails.send({
          from: resendFromEmail,
          to: toEmail,
          subject: message.subject,
          html: message.html,
          text: message.text,
        });
        if (error) {
          throw new Error(`Failed summary email for alert ${alertId}: ${error.message}`);
        }
        emailsSent += 1;
      }
    }
  }

  console.log(`[google-alerts-backfill-run] run_id=${runId}`);
  console.log(`[google-alerts-backfill-run] rows_scanned=${priceRows.length}`);
  console.log(`[google-alerts-backfill-run] transitioned_true=${becameTrue.size}`);
  console.log(`[google-alerts-backfill-run] transitioned_false=${becameFalse.size}`);
  console.log(`[google-alerts-backfill-run] alerts_touched=${alertsTouched}`);
  console.log(`[google-alerts-backfill-run] emails_sent=${emailsSent}`);
  console.log(`[google-alerts-backfill-run] send_email=${shouldSendEmail}`);
  console.log(`[google-alerts-backfill-run] dry_run=${isDryRun}`);
}

main().catch((error) => {
  console.error('[google-alerts-backfill-run] failed:', error);
  process.exit(1);
});

