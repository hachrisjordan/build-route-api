import 'dotenv/config';
import { addDays } from 'date-fns';
import pRetry from 'p-retry';
import fetch, { Headers } from 'node-fetch';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

type ExpertFlyerSearchResult = typeof import('../VNexample.json')['searchResults'];

type AvailabilityRecord = {
  origin: string;
  destination: string;
  flight_number: string;
  date: string; // YYYY-MM-DD
  j: number;
  w: number;
  y: number;
  j_detailed: string;
  w_detailed: string;
  y_detailed: string;
};

const VIETNAM_ORIGINS = ['HAN', 'SGN'] as const;

const EURO_DESTINATIONS: Record<(typeof VIETNAM_ORIGINS)[number], string[]> = {
  HAN: ['CDG', 'LHR', 'FRA', 'MUC', 'MXP'],
  SGN: ['CDG', 'LHR', 'FRA', 'MUC', 'CPH'],
};

const MAX_WEEKS = Number(process.env.VN_AVAIL_WEEKS ?? '8');
const DRY_RUN = process.env.DRY_RUN === 'true';
const CONCURRENCY = Number(process.env.VN_AVAIL_CONCURRENCY ?? '3');

function buildDates(from: Date): string[] {
  const start = addDays(from, 3);
  const dates: string[] = [];

  for (let i = 0; i < MAX_WEEKS; i += 1) {
    const d = addDays(start, i * 7);
    const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD
    dates.push(iso);
  }

  return dates;
}

type Route = {
  origin: string;
  destination: string;
};

function buildRoutes(): Route[] {
  const routes: Route[] = [];

  for (const origin of VIETNAM_ORIGINS) {
    for (const dest of EURO_DESTINATIONS[origin]) {
      routes.push({ origin, destination: dest });
      routes.push({ origin: dest, destination: origin });
    }
  }

  return routes;
}

function buildHeaders(): Headers {
  const headers = new Headers();
  headers.set('accept', 'text/x-component');
  headers.set('accept-language', 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7');
  headers.set('content-type', 'text/plain;charset=UTF-8');
  headers.set('next-action', '7f1bf3f37c753641ae12afb9105968c5e7f13cd06e');
  headers.set(
    'next-router-state-tree',
    '%5B%22%22%2C%7B%22children%22%3A%5B%22air%22%2C%7B%22children%22%3A%5B%22availability%22%2C%7B%22children%22%3A%5B%22results%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Cfalse%5D%7D%2Cnull%2Cnull%2Cfalse%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
  );

  headers.set('origin', 'https://www.expertflyer.com');
  headers.set('priority', 'u=1, i');
  headers.set('referer', 'https://www.expertflyer.com/air/availability/results');
  headers.set('sec-ch-ua', '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"');
  headers.set('sec-ch-ua-mobile', '?0');
  headers.set('sec-ch-ua-platform', '"macOS"');
  headers.set('sec-fetch-dest', 'empty');
  headers.set('sec-fetch-mode', 'cors');
  headers.set('sec-fetch-site', 'same-origin');
  headers.set(
    'user-agent',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  );

  headers.set('x-deployment-id', '33fdf5bf-af52-429b-bde0-87e4181cf635');
  headers.set(
    'Cookie',
    '_gcl_au=1.1.470302226.1771723459; OptanonAlertBoxClosed=2026-03-05T20:58:52.772Z; __dpl=33fdf5bf-af52-429b-bde0-87e4181cf635; OptanonConsent=isGpcEnabled=0&datestamp=Tue+Mar+17+2026+10%3A34%3A57+GMT%2B0700+(Indochina+Time)&version=202601.1.0&browserGpcFlag=0&isIABGlobal=false&hosts=&consentId=1b11c6f0-4482-4f4d-b747-64a429f99afe&interactionCount=2&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1&crTime=1771725611444&AwaitingReconsent=false&intType=3&geolocation=US%3BIL; __session__0=eyJlbmMiOiJBMjU2R0NNIiwiYWxnIjoiZGlyIn0..kIbyaLo2095rEg87.SQB7H-mOgWFGqxk-jdCosAEWSLnirNh2HAqentNtOm4yIb1kSdMZ4vy2kULncCH8ciwG9F3_f-cg9BdPTeBqLcg2lVQgF-lLuS7bxJeXG_RlDUVaJBnf1LOjI4quxerPYv96a-qOoUgTr4VAJEpCALXW5zhYZ8-QhBHl674PgRRJFTTb40J6UheVKpprxF4pzApNdcxFrx63LBBQywSg7vbFZ61X0t2fecI2FcOP2iGxXzgI7jdYjCyciwsm-uOLY5C-bwRh-P6mgvvwKue9TfwqQWmnzipciVVhTLpnGY1Z4yQj1QgG4_EZRbbJ-cT5SbSZvjEP2ZNQ7arGxaoimuLMikU_OwGl5_Bsm3kEdYBipNab0tJ6mXQ23F67DnZQ87tTiptCRma3D2V33wJjpCi9tojQJ4FazvE05sekAcuUHBom6RoHO4vdl9eNJrEaCSehHp3sia3Gxit6m7V-A1jyG4k4HdpV_b17ZmqJkITPQeNXl76nJZQ_bhm27Ss1KrL33gOa1ZeyfAyPqKc6sbuqDIFJysKyr83HCsO9O851DBwmuL2U-tdSaWxDdN3UwO-x0nleaKV89hmkMgcZQKTVt06o6fodmOdL0dgBpC4LrQo_CVTQATvE64Y6E96eI42ggmSJMG9NwcoOQRjJUV2-s9hzAWJGnsfORohMRRd3PADDcYRcRi1yj-I5rsvhDihe25i9b4Hw0SlYmInZH8iQaNQB7s2RDc2o5VUrx83-rXEGug0h2FabVLm5CDvXKbo6vO8Cp5sinOXXcF8BtfyrYZlw9wfl8ivQuoRxYJUJjDKMhdvVEC56pGTAPg4CoWW0IB9aDcktXNRZ_rp_DsHOIyTJGmv8gO1-KT4yICuuGYDuJLhRKvrdAOkfcFHxyQ_YOE9haZijDXGR9XV2Y4KLlTN-mLqFle1CIazOGCbL9-LdSKefsJDswAkIdi12scJ0vO7QhJ9LG0trP9LgITr4AUXpNSj6XppBMhkk8KZyaNj4bZFRavUJuLnOhrEpLHCo9Pm8kVIXGMmR4FTHuBQhjEtH_K1JHDhOLbrHTlZ9TRU4ZdY4Ji-yef8FrMZIaynh288Szr6vgkRThrYMMwyf5Kzg_GnAqEjJkrfEeQT5JyyfVaz2cH8mXs3JlzQmQqnDT9YRYKak4i7_qHZ11T0ipoQ_M0HuYCnSTx8qMF5TGUuUFsJHh0zckiX37fyKKot_iSne6lFp2m6b9T86HAFWShMxaPrcJ84F6LYZ7H4ohNh08qUy62RnaTmFOpp96jA8epB53Qru3YGXnxuraOcvFceviixVPyVWnSZae2-6guvMBCx6eRKj66BTaxIkVm8wStHO6q4RhYMQPskGoTT2m0LIWAiDWl5n0eHcVJPeqfkoZNeL41BynR3JnYQnEUxQNW77ThmGjyGhv646CaFaDoxq8kZa1UlsTj5Wut5ZUBsfor7ULU5MDYqOCOGpUMgDPeDUzTnXQMNwukZ0SrkCejMLya7wfmnllB9fp6nPvDotSR13_3FCtMjmelWTa2z19ka43QH3rXA4yqAmZP_fkPrAciOoG370s0cTWZtll478WEOe0-OC3x_Ich-wJ68zykbEW3rGMYVItDQ4V4Btsyp5ngVp2bRHxYCggMHJdB521YgrebeyIUbT8vpI63joQNNbZ6K9tQYnWIwsnEpiuock4Ns10tCRHKrAYxamrtQe8WRszABx5Il7Uz5qAmdXgBVbLWM_gbpMH3TpBoK78VEZ2ge_FAeusOxPPANyjcQyxVOx3CdMnxO53vflly4vHb9a1CfqLbJTyIOPt5ueCuL1kUpJPCer3A5FvbKbwd7YpWtyQ_edMCptILaXrvFpIP0r7-x1sKqJWBZKq4ceTNarNmqe--4Ib_NmARgDXdE4W7yRfWTuCmuk_XKh2V1yBNY9Pr1VFsP8W_uvB8EOsnY8MdrFUQIiQIKbAgPl-M0zhRGwkx3ZOiOBl25n0LIEtN5aHYNj5_gUn_H5_jx86WlV2fPZl7DHPajvZUTP6tOw7Lx0LeTUKPOCT_hHpfYQoN29Hrn4xpYhvP4-XZMl6q7-8-q6aHTvSOsuxvAY776MkkmAa5YJYynA1YnXIJPHpH5Mwp2gGx_HoB3QHXW8Aj3_x5ZxAzy1A6QZFhFpWRYC6aT-1xNoUjw2ejZk5k8rp4Cz0mJfE8NjssSBnqKTYt4tz2lkU3f9uQsUF-_0yd31ysfU8Ph2L009ostxR_yzlMyGRvkHNIKghugcWPocII6X7r4VAUrmZmjr3jyYD8bBgtDXQKeBrWXsIkCUXA3lqDVRj963X9cl8aT3dNKst8Sin-5tiEwOSW7F9fwRiLQESUwNjdSkavHOvn7DJfnk70AicXV9ocbk4fT4tMumGhOtJ_cNFNcrisAA6lSULKRUuhhZRd0B2fFW8vb83pFbhfMYEODIiFF_x94Jm51pplxvIrAv7Sza7FDwF53Z7RWBbKsxlnTCAk529BCJVNZW4nZaN4Zd3ktn2VZDF5IGtFepIJfNWR0gZWX_d4ggz_cXV1OjedgcknqGPWIBOMQOJrVyxKI8gG7b4h1hfHcvD8n2p4UHgfKqJxwgXpq6oTWowGY44ndMn-PXuE93olPbvkIeliVZ15ugQ-TABRhb8CbZE8Y06_9ellFPruw_Qx7UDYcmjwJT0ftv6ScJTUEgQ-5aUqzTXAjojkbUxDaMTyVyTYkA2aEv_E8zzCpfo_5fjWn5pTatSqw7yoqKmviz7N7i3tlAEGP5ubsGu7mbfyd4ty2l-mtumGvmu-3MVz5ApUEnUO9zhrxnL3fd3wlFqheOXVzdZcYt85BiA653qygRD0Ql9V_v9LJHLdaOY6jeMYyZ05j4hND1kGZDEg1EV-2wBSPwIxrJBWNTKCEDDFlagE_9Px5YWXJo_VNsRZf_zr5lC-E4X6Tph4BIkMa-AUYbwOLQck-n5gX1XXa-MtlCpm_95uQ0_t5nURyPB_DIHuYpkJ-Qw6L_Xpzg1gJM9u3TRxCR0wUuqSfsQSYRfv-LY5JD6gDHq0h0RjiizbIV4VvjP1cmHiHOYECx25DMBG8cwS6rmWwPgY3d7vV-YPhwEKwXxqxPxJRJXSvnVb-ZJd-MO32ZUGxUd20xtBOkH2etaNfW7Bh17dT1Kj_81gKNr5BMvtjoMtvqUfmZjSLdD2DuEE7KxKwJ9HgwXbvNssCws4en9nUz4I6Txa51Orf6Dy2WIROzkrlxplFFk2seYJ0gWmSVJ8qoTzPnKJkVNZOJUyBw6HoRnegiWeykxdxD3mURPhSk1iN2AeZkAV1-BcrUlKLQqLsO0SHoEz1SOmmuxdbp5HglrHRzxCjOuQukdU7iqYOdzZCti4duV0K6CPNlBpAkWQ4-RJEirzg633plIghk67sK4UFxukT8AHWy4e8njJYH5USPhED1KypXnm; __session__1=5qzQ3qSI_d9wz5WAVX3qFnu1-nInDjVwz6p5w3gux2SqXuLH2GWYaCpDfSf3f0db4Yt2dTUsqEjJZNZ80JLVkn_DHLsRzAGUawGGwAvBTSn5lIBGG1w0bEhAymqPlRanTBUr6FKAE_FQC-c03eJOj_EAJGSm_abikdFlfkXfSqhRuHgXpqvbz_IIozqwL2xFogPoqUvgb7s9yikiFUhebdDQkKduYc7wU9I1ivSaKZDK66rnxhebHQkDkfix2frGaSHToOD1KIbeYIXL_5b42NHZ1fNR3O3_ZWq5b1A69g7PQHvTMpptPwsv_zo2Wf5s6B4oWVYg_vavnFesazgaigsX-XPlbLPcBzlNZjdjGqsYquOr0x1oLmGeUmvLxtEFO_4-sZIaW5FkA7eSdq1onreLAJAJUb1J0JiBdUFx0DbzoBWcVauZQTE0pgi-SM9RhyNCby1Ak2nv2XLZEhMsn38gnKJ2mbG_WWqtB_pEn6q_xHAy0-YCcJsndxJxSPnjRLVGK_yeFCvnHdCVTtmnjfNlX0SJUqX9LpnR26fcsvDIDk4HkdLc8H_aHY04yttTlXMFxzBd6hIUN6ReCFlLVfSnYVXc8x4Zlvu9IkW1xQ1X_1bbvXM6h_GNRrr-kjKy701_YK-vimPW7e1N35a1ZyPYCUM5GpcKABNvUX1UXRpceHwxI0CPuprk0ULBJtHTin22URVes6chk2_CK4kzA4paBfI3yOEbbE4_XkgJqbgAH9kzfZZVQVA-SWPphHX946qrUygBX6laFaTe8rCnLMVzPX3r9zFhl7CvAqJ9TLslLpAVSeFJwA7hQXxBCBvnHr-uJTvjMIgOZNYfdumpIHunKNO4pMfXBKH38dhfms_zoDbjHmLByDk6Xb2f1c6P16Yzxu886CQb7guK8i2cz9TPueTvSuuD3jdQW7pooWuoaz05L45mV3kdn1_IE_JsvI8C2gQ8P9dOXW51qyTVpOrEckyhbkeekN-DLH3-CPOPDNvXXF_WGtB7bgNprmqxix0tcWaOyDCY_j_quDmq1sgM33NEbk4kYQouXIb8O5T1lhbaP1HetMUa699QZCiVX_KsPXGKggGEhZ9tZWbUuzRrJ3j9a1GAcQlHiv7jz490vhJakkKUaQxVeBKxed-rsnF35r9hl0Q8P8i_kEIhju_-8DHJdWH_KRZpUf6sbaZD3x3dTzNNPZzc5_Ttn3GJgImOokb-ttZJphclZnzgaKCQFtmNvmFnZmgZoALWQ7a0JVSg3GQoH4KLI8hO_DMJlbkyMN4m97iYV6Yu-uQM1cgYs1AXWwDZRO48xK-lorVa-mcd8FRFJFhXSLyMahX-HtNH4kAjq2S_20aaHxsG8HlxNjFp34PQeHOps3ZPpQpjRtfoL00VJvwvDbORevENqFD6YoN63oy7xJ6D-DsvU.5-pQjQdfzOKo_C8wWikGzA',
  );

  return headers;
}

function buildRequestBody(origin: string, destination: string, departureDate: string) {
  return JSON.stringify([
    {
      origin,
      destination,
      departureDateTime: `${departureDate}T00:00`,
      returnDateTime: '$undefined',
      airLineCodes: '$undefined',
      alliance: '$undefined',
      excludeCodeshares: true,
      directAccess: false,
      connectionLocations: '$undefined',
      connectionPreference: 'direct',
      classFilter: '$undefined',
      departureExactDate: 'plusminus3',
      returnExactDate: '$undefined',
      pcc: 'USA (Default)',
      resultsDisplay: 'single',
      withRawXML: false,
    },
  ]);
}

async function fetchAvailability(origin: string, destination: string, departureDate: string): Promise<ExpertFlyerSearchResult | null> {
  const url = new URL('https://www.expertflyer.com/air/availability/results');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  url.searchParams.set('departureDateTime', `${departureDate}T00%3A00`);
  url.searchParams.set('alliance', 'none');
  url.searchParams.set('airLineCodes', '');
  url.searchParams.set('excludeCodeshares', 'true');
  url.searchParams.set('connectionPreference', 'direct');
  url.searchParams.set('departureExactDate', 'plusminus3');
  url.searchParams.set('pcc', 'USA (Default)');
  url.searchParams.set('resultsDisplay', 'single');

  const headers = buildHeaders();
  const body = buildRequestBody(origin, destination, departureDate);

  const doRequest = async () => {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body,
    });

    if (!res.ok) {
      throw new Error(`ExpertFlyer HTTP ${res.status} for ${origin}-${destination} ${departureDate}`);
    }

    const text = await res.text();

    try {
      const trimmed = text.trimStart();
      // ExpertFlyer RSC stream format:
      // 0:{"a":"$@1","f":"","b":"..."}
      // 1:{"searchResults":{...}}
      const lines = trimmed.split('\n').map((line) => line.trim());

      const dataLine = lines.find((line) => /"searchResults"\s*:/.test(line));
      if (!dataLine) {
        throw new Error('No searchResults JSON object found in response.');
      }

      const cleaned = dataLine.replace(/^\d+:\s*/, '');

      const json = JSON.parse(cleaned) as { searchResults: ExpertFlyerSearchResult };
      return json.searchResults;
    } catch (error) {
      throw new Error(`Failed to parse ExpertFlyer response as JSON: ${(error as Error).message}`);
    }
  };

  try {
    return await pRetry(doRequest, { retries: 3 });
  } catch (error) {
    console.error(`Failed to fetch availability for ${origin}-${destination} ${departureDate}:`, error);
    return null;
  }
}

function extractAvailability(searchResults: ExpertFlyerSearchResult): AvailabilityRecord[] {
  const records: AvailabilityRecord[] = [];

  for (const dep of searchResults.departure ?? []) {
    const searchDate = dep.date;
    const itineraries = dep.data?.itineraries ?? [];

    for (const itin of itineraries) {
      for (const segment of itin.segments ?? []) {
        const origin = segment.departureAirport;
        const destination = segment.arrivalAirport;
        const flightNumber = `${segment.marketingAirlineCode ?? ''}${segment.flightNumber ?? ''}`;

        const classes = segment.bookingClassAvailability ?? [];

        const j = findAvailability(classes, 'J');
        const w = findAvailability(classes, 'W');
        const y = findAvailability(classes, 'Y');

        const jDetailed = buildDetailed(classes, 'Business');
        const wDetailed = buildDetailed(classes, 'Premium Coach');
        const yDetailed = buildDetailed(classes, 'Coach');

        const date = (searchDate ?? '').slice(0, 10);

        records.push({
          origin,
          destination,
          flight_number: flightNumber,
          date,
          j,
          w,
          y,
          j_detailed: jDetailed,
          w_detailed: wDetailed,
          y_detailed: yDetailed,
        });
      }
    }
  }

  return records;
}

function findAvailability(
  classes: { code: string; availability: number | null | undefined }[],
  code: string,
): number {
  const item = classes.find((c) => c.code === code);
  if (!item || item.availability == null) return 0;
  return Number.isFinite(item.availability) ? Number(item.availability) : 0;
}

function buildDetailed(
  classes: { code: string; codeDescription: string; availability: number | null | undefined }[],
  description: string,
): string {
  const parts: string[] = [];
  for (const c of classes) {
    if (c.codeDescription !== description) continue;
    const availability = c.availability ?? 0;
    parts.push(`${c.code}${availability}`);
  }
  return parts.join(' ');
}

async function upsertAvailability(rows: AvailabilityRecord[]): Promise<void> {
  if (!rows.length) return;

  if (DRY_RUN) {
    console.log(`DRY_RUN: would upsert ${rows.length} VN_avail rows`);
    return;
  }

  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase
      .from('VN_avail')
      .upsert(chunk, { onConflict: 'origin,destination,flight_number,date' });
    if (error) {
      console.error('Supabase insert error for VN_avail chunk:', error);
    }
  }
}

async function purgeOldAvailability(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const supabase = getSupabaseAdminClient();

  console.log(`Purging VN_avail rows with date < ${today}...`);
  const { error } = await supabase.from('VN_avail').delete().lt('date', today);

  if (error) {
    console.error('Failed to purge old VN_avail rows:', error);
  }
}

async function run() {
  const today = new Date();
  const dates = buildDates(today);
  const routes = buildRoutes();

  console.log(`Scraping VN availability for ${routes.length} routes over ${dates.length} weeks`);

  await purgeOldAvailability();

  type Task = { origin: string; destination: string; date: string };
  const tasks: Task[] = [];
  for (const route of routes) {
    for (const date of dates) {
      tasks.push({ origin: route.origin, destination: route.destination, date });
    }
  }

  const allRows: AvailabilityRecord[] = [];

  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const current = index;
      index += 1;
      const task = tasks[current];

      const searchResults = await fetchAvailability(task.origin, task.destination, task.date);
      if (!searchResults) continue;

      const rows = extractAvailability(searchResults);
      allRows.push(...rows);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log(`Parsed ${allRows.length} VN_avail rows; writing to Supabase...`);
  await upsertAvailability(allRows);
  console.log('Done.');
}

run().catch((error) => {
  console.error('vn-avail-scraper failed:', error);
  process.exitCode = 1;
});

