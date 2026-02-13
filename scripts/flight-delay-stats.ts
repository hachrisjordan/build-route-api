#!/usr/bin/env node
/**
 * Flight delay stats: average delay by airline and by destination.
 * Queries flight_data (Supabase) for flights by origin and/or destination and date (or date range).
 *
 * Usage:
 *   npx tsx scripts/flight-delay-stats.ts [--origin SGN] [--destination HAN] [--date 2026-02-11] [--date 2026-02-11:2026-02-15] [--filter domestic|international]
 *
 * --origin: optional. Filter by departing airport (origin_iata). If omitted and --destination is set, only destination is used.
 * --destination: optional. Filter by arrival airport (destination_iata). If only --destination is set, returns all flights to that destination.
 * --date: single day "YYYY-MM-DD" or range "YYYY-MM-DD:YYYY-MM-DD".
 * --filter: optional. "domestic" = same country_code as origin; "international" = different country (from airports table). Omit for all flights.
 *
 * Output:
 *   - By airline (first 2 chars of flight_number): delay_pct, avg_delay_min
 *   - By destination_iata: delay_pct, avg_delay_min
 *
 * Delay: ontime >= 15 means delayed (at least 15 minutes late). delay_pct = % of flights delayed; avg_delay_min = average delay in minutes (among delayed only).
 */

require('dotenv').config();

const c = require('ansi-colors');
const { getSupabaseAdminClient } = require('../src/lib/supabase-admin');

const DEFAULT_ORIGIN = 'SGN';
const DEFAULT_DATE = '2026-02-11';
const PAGE_SIZE = 1000;

interface FlightRow {
  flight_number: string;
  origin_iata: string;
  destination_iata: string;
  ontime: string | null;
}

interface DateRange {
  start: string;
  end: string;
}

interface DelayStats {
  total: number;
  delayed: number;
  delayPct: number;
  avgDelayMin: number;
}

/** Bucket labels in display order. */
const DELAY_BUCKETS = [
  'Early (<0)',
  '0-15',
  '16-30',
  '31-60',
  '61-120',
  '>120'
] as const;

type DelayBucketKey = (typeof DELAY_BUCKETS)[number];

interface DelayBucketCounts {
  'Early (<0)': number;
  '0-15': number;
  '16-30': number;
  '31-60': number;
  '61-120': number;
  '>120': number;
}

function getDelayBucket(minutes: number): DelayBucketKey {
  if (minutes < 0) return 'Early (<0)';
  if (minutes <= 15) return '0-15';
  if (minutes <= 30) return '16-30';
  if (minutes <= 60) return '31-60';
  if (minutes <= 120) return '61-120';
  return '>120';
}

function emptyBucketCounts(): DelayBucketCounts {
  return {
    'Early (<0)': 0,
    '0-15': 0,
    '16-30': 0,
    '31-60': 0,
    '61-120': 0,
    '>120': 0
  };
}

function bucketCountsFromValues(ontimeValues: number[]): DelayBucketCounts {
  const counts = emptyBucketCounts();
  for (const v of ontimeValues) {
    counts[getDelayBucket(v)]++;
  }
  return counts;
}

/** Format bucket line as percentages with colors: early/on-time = green/cyan, medium = yellow, long delay = red. */
function formatBucketLine(counts: DelayBucketCounts, total: number): string {
  if (total === 0) return DELAY_BUCKETS.map((b) => `${b}: 0%`).join('  ');
  return DELAY_BUCKETS.map((b) => {
    const pct = (counts[b] / total) * 100;
    const pctStr = `${pct.toFixed(1)}%`;
    const fmt = (s: string) => `${b}: ${s}`;
    if (b === 'Early (<0)') return c.green(fmt(pctStr));
    if (b === '0-15') return c.cyan(fmt(pctStr));
    if (b === '16-30' || b === '31-60') return c.yellow(fmt(pctStr));
    if (b === '61-120') return c.red(fmt(pctStr));
    return c.redBright.bold(fmt(pctStr));
  }).join('  ');
}

function colorDelayPct(pct: number): string {
  if (pct <= 30) return c.green(pct.toFixed(1) + '%');
  if (pct <= 60) return c.yellow(pct.toFixed(1) + '%');
  return c.red(pct.toFixed(1) + '%');
}

type FilterType = 'domestic' | 'international' | '';

function parseDateRange(dateArg: string): DateRange {
  const colon = dateArg.indexOf(':');
  if (colon !== -1) {
    const start = dateArg.slice(0, colon).trim();
    const end = dateArg.slice(colon + 1).trim();
    if (start && end) return { start, end };
  }
  return { start: dateArg.trim(), end: dateArg.trim() };
}

function parseArgs(): {
  origin: string | undefined;
  destination: string | undefined;
  dateRange: DateRange;
  filter: FilterType;
} {
  const args = process.argv.slice(2);
  let origin: string | undefined = undefined;
  let destination: string | undefined = undefined;
  let date = DEFAULT_DATE;
  let filter: FilterType = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--origin' && args[i + 1]) {
      origin = args[i + 1];
      i++;
    } else if (args[i] === '--destination' && args[i + 1]) {
      destination = args[i + 1];
      i++;
    } else if (args[i] === '--date' && args[i + 1]) {
      date = args[i + 1];
      i++;
    } else if (args[i] === '--filter' && args[i + 1]) {
      const v = args[i + 1].toLowerCase();
      if (v === 'domestic' || v === 'international') filter = v;
      i++;
    }
  }
  if (!origin && !destination) origin = DEFAULT_ORIGIN;
  return { origin, destination, dateRange: parseDateRange(date), filter };
}

/**
 * Parse ontime string to number (minutes). Positive = delayed.
 */
function parseOntime(ontime: string | null): number | null {
  if (ontime == null || ontime === '') return null;
  const n = Number(ontime);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch flight_data rows with optional origin, optional destination, and date range. Paginates.
 */
async function fetchFlights(
  origin: string | undefined,
  destination: string | undefined,
  dateRange: DateRange
): Promise<FlightRow[]> {
  const supabase = getSupabaseAdminClient();
  const rows: FlightRow[] = [];
  let offset = 0;
  const select = 'flight_number, origin_iata, destination_iata, ontime';
  while (true) {
    let q = supabase
      .from('flight_data')
      .select(select)
      .gte('date', dateRange.start)
      .lte('date', dateRange.end)
      .range(offset, offset + PAGE_SIZE - 1);
    if (origin) q = q.eq('origin_iata', origin);
    if (destination) q = q.eq('destination_iata', destination);
    const { data, error } = await q;
    if (error) throw new Error(`Supabase error: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as FlightRow[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

/**
 * Fetch iata -> country_code from airports for given IATA codes.
 */
async function fetchAirportCountryCodes(
  iataCodes: string[]
): Promise<Record<string, string>> {
  if (iataCodes.length === 0) return {};
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('airports')
    .select('iata, country_code')
    .in('iata', iataCodes);
  if (error) throw new Error(`Supabase error: ${error.message}`);
  const map: Record<string, string> = {};
  for (const row of data || []) {
    if (row.iata && row.country_code) map[row.iata] = row.country_code;
  }
  return map;
}

/**
 * Filter rows by domestic (same country as origin) or international (different country).
 * Uses queryOrigin when set (single departure airport), else each row's origin_iata (e.g. destination-only mode).
 */
function filterByDomesticInternational(
  rows: FlightRow[],
  queryOrigin: string | undefined,
  iataToCountry: Record<string, string>,
  filter: FilterType
): FlightRow[] {
  if (!filter) return rows;
  return rows.filter((row) => {
    const originIata = queryOrigin ?? row.origin_iata;
    const originCountry = iataToCountry[originIata];
    const destCountry = iataToCountry[row.destination_iata];
    if (!originCountry || !destCountry) return false;
    const isDomestic = originCountry === destCountry;
    return filter === 'domestic' ? isDomestic : !isDomestic;
  });
}

/**
 * Compute delay stats for a list of ontime values (numeric, positive = delayed).
 */
function computeStats(ontimeValues: number[]): DelayStats {
  const total = ontimeValues.length;
  const delayedValues = ontimeValues.filter((v) => v >= 15);
  const delayed = delayedValues.length;
  const delayPct = total > 0 ? (delayed / total) * 100 : 0;
  const avgDelayMin =
    delayedValues.length > 0
      ? delayedValues.reduce((a, b) => a + b, 0) / delayedValues.length
      : 0;
  return { total, delayed, delayPct, avgDelayMin };
}

interface StatsWithBuckets {
  stats: DelayStats;
  buckets: DelayBucketCounts;
}

/**
 * Aggregate by key and return stats plus delay-time bucket counts per key.
 */
function aggregateByKeyWithBuckets(
  rows: FlightRow[],
  getKey: (r: FlightRow) => string
): Record<string, StatsWithBuckets> {
  const byKey: Record<string, number[]> = {};
  for (const row of rows) {
    const ontime = parseOntime(row.ontime);
    if (ontime === null) continue;
    const key = getKey(row);
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(ontime);
  }
  const result: Record<string, StatsWithBuckets> = {};
  for (const [key, values] of Object.entries(byKey)) {
    result[key] = {
      stats: computeStats(values),
      buckets: bucketCountsFromValues(values)
    };
  }
  return result;
}

/**
 * For destination-only: aggregate by origin, then by airline within each origin.
 * Returns Map<origin, { totals: StatsWithBuckets, byAirline: Record<airline, StatsWithBuckets> }>
 */
function aggregateByOriginThenAirline(
  rows: FlightRow[]
): Record<string, { totals: StatsWithBuckets; byAirline: Record<string, StatsWithBuckets> }> {
  const byOrigin: Record<
    string,
    { values: number[]; byAirline: Record<string, number[]> }
  > = {};
  for (const row of rows) {
    const ontime = parseOntime(row.ontime);
    if (ontime === null) continue;
    const orig = row.origin_iata;
    const airline = (row.flight_number || '').slice(0, 2);
    if (!byOrigin[orig]) {
      byOrigin[orig] = { values: [], byAirline: {} };
    }
    byOrigin[orig].values.push(ontime);
    if (!byOrigin[orig].byAirline[airline]) byOrigin[orig].byAirline[airline] = [];
    byOrigin[orig].byAirline[airline].push(ontime);
  }
  const result: Record<
    string,
    { totals: StatsWithBuckets; byAirline: Record<string, StatsWithBuckets> }
  > = {};
  for (const [orig, data] of Object.entries(byOrigin)) {
    result[orig] = {
      totals: {
        stats: computeStats(data.values),
        buckets: bucketCountsFromValues(data.values)
      },
      byAirline: {}
    };
    for (const [airline, values] of Object.entries(data.byAirline)) {
      result[orig].byAirline[airline] = {
        stats: computeStats(values),
        buckets: bucketCountsFromValues(values)
      };
    }
  }
  return result;
}

function main(): void {
  const { origin, destination, dateRange, filter } = parseArgs();
  const dateLabel =
    dateRange.start === dateRange.end
      ? dateRange.start
      : `${dateRange.start} to ${dateRange.end}`;
  const parts = [
    origin != null ? `Origin: ${origin}` : null,
    destination != null ? `Destination: ${destination}` : null,
    `Date: ${dateLabel}`,
    filter ? `Filter: ${filter}` : null
  ].filter(Boolean);
  console.log(parts.join(', ') + '\n');

  fetchFlights(origin, destination, dateRange)
    .then(async (rows) => {
      let filtered = rows;
      if (filter) {
        const iataSet = new Set<string>();
        if (origin) iataSet.add(origin);
        rows.forEach((r) => {
          iataSet.add(r.origin_iata);
          iataSet.add(r.destination_iata);
        });
        const iataToCountry = await fetchAirportCountryCodes([...iataSet]);
        filtered = filterByDomesticInternational(
          rows,
          origin,
          iataToCountry,
          filter
        );
      }
      if (filtered.length === 0) {
        console.log('No flights found.');
        return;
      }
      console.log(`Total flights: ${filtered.length}\n`);

      const byAirline = aggregateByKeyWithBuckets(filtered, (r) =>
        (r.flight_number || '').slice(0, 2)
      );
      const destinationOnly = destination != null && origin == null;
      const byOriginOrDest = aggregateByKeyWithBuckets(
        filtered,
        (r) => (destinationOnly ? r.origin_iata : r.destination_iata)
      );
      const byOriginThenAirline = destinationOnly
        ? aggregateByOriginThenAirline(filtered)
        : null;

      console.log('--- By airline (first 2 chars of flight_number) ---');
      const airlineEntries = Object.entries(byAirline).sort(
        (a, b) => b[1].stats.total - a[1].stats.total
      );
      for (const [airline, { stats: s, buckets }] of airlineEntries) {
        console.log(
          `${airline}: total=${s.total} delay_pct=${colorDelayPct(s.delayPct)} avg_delay_min=${s.avgDelayMin.toFixed(1)}`
        );
        console.log(`  ${formatBucketLine(buckets, s.total)}`);
      }

      if (destinationOnly && byOriginThenAirline) {
        console.log('\n--- By origin (with per-airline breakdown) ---');
        const originEntries = Object.entries(byOriginThenAirline).sort(
          (a, b) => b[1].totals.stats.total - a[1].totals.stats.total
        );
        for (const [orig, { totals, byAirline: airlines }] of originEntries) {
          const s = totals.stats;
          console.log(
            `${orig}: total=${s.total} delay_pct=${colorDelayPct(s.delayPct)} avg_delay_min=${s.avgDelayMin.toFixed(1)}`
          );
          console.log(`  ${formatBucketLine(totals.buckets, s.total)}`);
          const sortedAirlines = Object.entries(airlines).sort(
            (a, b) => b[1].stats.total - a[1].stats.total
          );
          for (const [airline, { stats: sa, buckets: ab }] of sortedAirlines) {
            console.log(
              `  ${airline}: total=${sa.total} delay_pct=${colorDelayPct(sa.delayPct)} avg_delay_min=${sa.avgDelayMin.toFixed(1)}`
            );
            console.log(`    ${formatBucketLine(ab, sa.total)}`);
          }
        }
      } else {
        console.log('\n--- By destination ---');
        const destEntries = Object.entries(byOriginOrDest).sort(
          (a, b) => b[1].stats.total - a[1].stats.total
        );
        for (const [key, { stats: s, buckets }] of destEntries) {
          console.log(
            `${key}: total=${s.total} delay_pct=${colorDelayPct(s.delayPct)} avg_delay_min=${s.avgDelayMin.toFixed(1)}`
          );
          console.log(`  ${formatBucketLine(buckets, s.total)}`);
        }
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

main();
