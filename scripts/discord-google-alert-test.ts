#!/usr/bin/env tsx
/**
 * Test Discord webhook with real rows already `way_too_cheap = true` in Supabase.
 *
 * Env:
 *   DISCORD_GOOGLE_ALERTS_WEBHOOK_URL — required (do not commit)
 *   SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL (via getSupabaseAdminClient)
 *
 * Usage:
 *   npx tsx scripts/discord-google-alert-test.ts
 *   npx tsx scripts/discord-google-alert-test.ts --limit 10
 */
import 'dotenv/config';
import { getSupabaseAdminClient } from '../src/lib/supabase-admin';
import { formatDiscordMistakeFareRouteContent, postDiscordWebhook } from '../src/lib/discord-google-alerts-webhook';

function parseLimit(argv: string[]): number {
  const i = argv.indexOf('--limit');
  if (i >= 0 && argv[i + 1]) {
    const n = parseInt(argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 25);
  }
  return 5;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  const webhookUrl = (process.env.DISCORD_GOOGLE_ALERTS_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    throw new Error('Set DISCORD_GOOGLE_ALERTS_WEBHOOK_URL in the environment');
  }

  const supabase = getSupabaseAdminClient();
  const { data: priceRows, error: priceError } = await supabase
    .from('google_flights_explore_destination_prices')
    .select('origin_iata,destination_iata,roundtrip,price,cpm,airlines,departDate,arriveDate')
    .eq('way_too_cheap', true)
    .limit(limit);

  if (priceError) {
    throw new Error(`Failed to load prices: ${priceError.message}`);
  }
  const rows = priceRows || [];
  if (!rows.length) {
    console.log('No rows with way_too_cheap=true; nothing to send.');
    return;
  }

  const iatas = new Set<string>();
  for (const r of rows as Array<{ origin_iata?: string; destination_iata?: string }>) {
    if (r.origin_iata) iatas.add(String(r.origin_iata).toUpperCase());
    if (r.destination_iata) iatas.add(String(r.destination_iata).toUpperCase());
  }

  const cityByIata = new Map<string, string>();
  if (iatas.size) {
    const { data: ap, error: apErr } = await supabase
      .from('airports')
      .select('iata,city_name')
      .in('iata', Array.from(iatas));
    if (!apErr && ap) {
      for (const row of ap as Array<{ iata: string; city_name: string | null }>) {
        const code = String(row.iata || '').toUpperCase();
        if (code) cityByIata.set(code, String(row.city_name || '').trim());
      }
    }
  }

  const iso = (v: unknown): string | null =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;

  let posted = 0;
  for (const r of rows as Array<{
    origin_iata: string;
    destination_iata: string;
    roundtrip: string;
    price: number | null;
    cpm: number | null;
    airlines: string[] | null;
    departDate?: string | null;
    arriveDate?: string | null;
  }>) {
    const oi = String(r.origin_iata || '').toUpperCase();
    const di = String(r.destination_iata || '').toUpperCase();
    const oc = cityByIata.get(oi) || '';
    const dc = cityByIata.get(di) || '';
    const airlineCodes = Array.isArray(r.airlines) ? r.airlines.map((c) => String(c).toUpperCase()) : [];
    const airlineNames = airlineCodes.map((c) => c);

    const content = formatDiscordMistakeFareRouteContent({
      originIata: oi,
      destinationIata: di,
      originCity: oc,
      destinationCity: dc,
      roundtrip: String(r.roundtrip || ''),
      price: r.price !== null && r.price !== undefined ? Number(r.price) : null,
      cpm: r.cpm !== null && r.cpm !== undefined ? Number(r.cpm) : null,
      airlineNames,
      departDate: iso(r.departDate),
      arriveDate: iso(r.arriveDate),
    });

    const { ok, status, bodySnippet } = await postDiscordWebhook(webhookUrl, { content });
    if (!ok) {
      throw new Error(`Discord webhook failed: HTTP ${status} ${bodySnippet}`);
    }
    posted += 1;
  }

  console.log(`Posted ${posted} test message(s) (one per row) to Discord.`);
}

main().catch((err) => {
  console.error('[discord-google-alert-test]', err instanceof Error ? err.message : err);
  process.exit(1);
});
