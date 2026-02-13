#!/usr/bin/env node
/**
 * Fetch distinct flight numbers from flight_data (Supabase) for a given origin/destination,
 * then call /api/flightradar24/[flightNumber] for each.
 *
 * Usage:
 *   npx tsx scripts/fr24-route-flight-numbers.ts --origin SGN --destination HAN
 *   npx tsx scripts/fr24-route-flight-numbers.ts --origin SGN --destination HAN --dry-run
 *   npx tsx scripts/fr24-route-flight-numbers.ts --origin SGN --destination HAN --limit 3
 *
 * Options:
 *   --origin       (required) Origin airport IATA code
 *   --destination  (required) Destination airport IATA code
 *   --api-url      Base URL for API (default: API_URL env or http://localhost:3000)
 *   --dry-run      Only print distinct flight numbers, do not call the API
 *   --limit        Max number of flight numbers to process (default: no limit)
 *   --delay-ms     Delay in ms between API calls (default: 1000)
 */

require('dotenv').config();

const { getSupabaseAdminClient } = require('../src/lib/supabase-admin');

const DEFAULT_API_URL = process.env.API_URL || 'http://localhost:3000';
const PAGE_SIZE = 1000;
const DEFAULT_DELAY_MS = 1000;

function parseArgs(): {
  origin: string;
  destination: string;
  apiUrl: string;
  dryRun: boolean;
  limit: number | undefined;
  delayMs: number;
} {
  const args = process.argv.slice(2);
  let origin: string | undefined;
  let destination: string | undefined;
  let apiUrl = DEFAULT_API_URL;
  let dryRun = false;
  let limit: number | undefined;
  let delayMs = DEFAULT_DELAY_MS;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--origin':
        origin = args[++i];
        break;
      case '--destination':
        destination = args[++i];
        break;
      case '--api-url':
        apiUrl = args[++i] ?? apiUrl;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--limit':
        limit = parseInt(args[++i] ?? '0', 10);
        if (!Number.isFinite(limit) || limit < 1) limit = undefined;
        break;
      case '--delay-ms':
        delayMs = parseInt(args[++i] ?? String(DEFAULT_DELAY_MS), 10);
        if (!Number.isFinite(delayMs) || delayMs < 0) delayMs = DEFAULT_DELAY_MS;
        break;
      default:
        break;
    }
  }

  if (!origin || !destination) {
    console.error('Usage: npx tsx scripts/fr24-route-flight-numbers.ts --origin <IATA> --destination <IATA> [--dry-run] [--limit N] [--api-url URL] [--delay-ms MS]');
    process.exit(1);
  }

  return { origin: origin.toUpperCase(), destination: destination.toUpperCase(), apiUrl, dryRun, limit, delayMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch distinct flight_number values from flight_data for the given origin/destination.
 */
async function getDistinctFlightNumbers(origin: string, destination: string): Promise<string[]> {
  const supabase = getSupabaseAdminClient();
  const seen = new Set<string>();
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('flight_data')
      .select('flight_number')
      .eq('origin_iata', origin)
      .eq('destination_iata', destination)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Supabase error: ${error.message}`);
    if (!data?.length) break;

    for (const row of data as { flight_number: string }[]) {
      if (row.flight_number) seen.add(row.flight_number);
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return Array.from(seen).sort();
}

/**
 * Call GET /api/flightradar24/[flightNumber]?origin=...&destination=...
 */
async function callFlightRadar24Api(
  apiUrl: string,
  flightNumber: string,
  origin: string,
  destination: string
): Promise<{ ok: boolean; status: number; error?: string }> {
  const url = `${apiUrl}/api/flightradar24/${encodeURIComponent(flightNumber)}?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: -1, error: msg };
  }
}

async function main(): Promise<void> {
  const { origin, destination, apiUrl, dryRun, limit, delayMs } = parseArgs();

  console.log(`[fr24-route] Origin: ${origin}, Destination: ${destination}`);
  console.log(`[fr24-route] Querying distinct flight numbers from flight_data (Supabase)...`);

  const flightNumbers = await getDistinctFlightNumbers(origin, destination);
  console.log(`[fr24-route] Found ${flightNumbers.length} distinct flight number(s).`);

  if (flightNumbers.length === 0) {
    console.log('[fr24-route] Nothing to do.');
    return;
  }

  const toProcess = limit !== undefined ? flightNumbers.slice(0, limit) : flightNumbers;
  if (limit !== undefined && flightNumbers.length > limit) {
    console.log(`[fr24-route] Limiting to first ${limit} flight number(s).`);
  }

  if (dryRun) {
    console.log('[fr24-route] Dry run – flight numbers:', toProcess.join(', '));
    return;
  }

  console.log(`[fr24-route] Calling ${apiUrl}/api/flightradar24/[flightNumber] for each (delay ${delayMs}ms)...`);
  let success = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const fn = toProcess[i];
    const result = await callFlightRadar24Api(apiUrl, fn, origin, destination);
    if (result.ok) {
      success++;
      console.log(`[fr24-route] ${i + 1}/${toProcess.length} ${fn} OK`);
    } else {
      failed++;
      console.error(`[fr24-route] ${i + 1}/${toProcess.length} ${fn} FAIL status=${result.status} ${result.error ?? ''}`);
    }
    if (i < toProcess.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  console.log(`[fr24-route] Done. Success: ${success}, Failed: ${failed}`);
}

main().catch((err) => {
  console.error('[fr24-route] Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
