#!/usr/bin/env node

/**
 * Load test for AmEx hotel offers API - checks 403 rate under different conditions
 *
 * Usage:
 *   node scripts/amex-hotel-offers-load-test.js [options]
 *
 * Options (env vars):
 *   AMEX_COOKIE     - Optional cookie string from browser (enables auth'd requests)
 *   TOTAL_REQUESTS  - Number of requests to make (default: 20)
 *   CONCURRENCY     - Parallel requests (default: 1)
 *   DELAY_MS        - Delay between request batches in ms (default: 2000)
 */

require('dotenv').config();

const AMEX_API_URL =
  'https://tlsonlwrappersvcs.americanexpress.com/consumertravel/services/v1/en-US/hotelOffers';

// Sample hotel IDs from working curl - small batch for load test
const SAMPLE_HOTEL_IDS = [
  528547, 28044, 31160305, 23855, 55444869, 695991, 83519458, 42075953, 201184,
  2277660, 60020170, 96472655, 4935, 47083262, 72283631, 3629903, 90445125,
  3253, 102449975, 916343, 11492, 102101788, 40338, 16300616, 25559, 88270883,
  19782, 132, 79873064, 170742, 790106, 40553, 3689, 19712, 4195208, 807655,
  2558, 6365, 20213, 12078123, 395, 911477, 21783007, 2175117, 26146, 10231646,
  77126225, 9215515, 9593707, 25007294, 64474828, 10645706, 903185, 13327922,
  1070718, 2714, 11971622, 41198, 454858, 16817106, 1572989, 987554, 108718621,
];

const TOTAL_REQUESTS = parseInt(process.env.TOTAL_REQUESTS || '20', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '2000', 10);

function getHeaders() {
  const headers = {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    Origin: 'https://www.americanexpress.com',
    Pragma: 'no-cache',
    Priority: 'u=1, i',
    Referer: 'https://www.americanexpress.com/en-US/rewards-benefits/travel/hotels/',
    'Sec-Ch-Ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
    'Sec-Ch-Ua-Full-Version-List': '"Not(A:Brand";v="8.0.0.0", "Chromium";v="144.0.7295.109", "Google Chrome";v="144.0.7295.109"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  };
  const cookie = process.env.AMEX_COOKIE;
  if (cookie) {
    headers['Cookie'] = cookie;
  }
  return headers;
}

function buildUrl(checkIn, checkOut, hotelIds) {
  const params = new URLSearchParams({
    availOnly: 'false',
    checkIn,
    checkOut,
    hotelPrograms: '20',
    sortType: 'PREMIUM',
  });
  const idsParam = hotelIds.join('%2C');
  return `${AMEX_API_URL}?${params.toString()}&ecom_hotel_ids=${idsParam}`;
}

async function makeRequest(url, headers) {
  const start = Date.now();
  const res = await fetch(url, { method: 'GET', headers });
  const latencyMs = Date.now() - start;
  const body = await res.text();
  return {
    status: res.status,
    statusText: res.statusText,
    latencyMs,
    bodyPreview: body.substring(0, 200),
  };
}

async function runBatch(batchIndex) {
  const checkIn = '2026-03-10';
  const checkOut = '2026-03-13';
  const url = buildUrl(checkIn, checkOut, SAMPLE_HOTEL_IDS.slice(0, 50));
  const headers = getHeaders();
  return makeRequest(url, headers);
}

async function runLoadTest() {
  console.log('AmEx Hotel Offers API – Load Test (403 check)\n');
  console.log('Config:');
  console.log(`  TOTAL_REQUESTS: ${TOTAL_REQUESTS}`);
  console.log(`  CONCURRENCY:   ${CONCURRENCY}`);
  console.log(`  DELAY_MS:      ${DELAY_MS}`);
  console.log(`  AMEX_COOKIE:   ${process.env.AMEX_COOKIE ? 'set' : 'not set'}`);
  console.log('');

  const results = [];
  const statusCounts = {};

  for (let i = 0; i < TOTAL_REQUESTS; i += CONCURRENCY) {
    const batch = [];
    for (let j = 0; j < CONCURRENCY && i + j < TOTAL_REQUESTS; j++) {
      batch.push(runBatch(i + j));
    }
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);

    for (const r of batchResults) {
      const key = r.status.toString();
      statusCounts[key] = (statusCounts[key] || 0) + 1;
    }

    process.stdout.write(
      `\rProgress: ${Math.min(i + CONCURRENCY, TOTAL_REQUESTS)}/${TOTAL_REQUESTS}`
    );

    if (i + CONCURRENCY < TOTAL_REQUESTS && DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log('\n');

  // Summary
  console.log('Status code distribution:');
  const sorted = Object.entries(statusCounts).sort((a, b) => a[0] - b[0]);
  for (const [code, count] of sorted) {
    const pct = ((count / TOTAL_REQUESTS) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(pct / 2)) + '░'.repeat(50 - Math.round(pct / 2));
    console.log(`  ${code.padStart(3)}: ${count.toString().padStart(4)} (${pct}%) ${bar}`);
  }

  const latencies = results.map((r) => r.latencyMs);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const sortedLat = [...latencies].sort((a, b) => a - b);
  const p50 = sortedLat[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = sortedLat[Math.floor(latencies.length * 0.95)] ?? 0;
  const p99 = sortedLat[Math.floor(latencies.length * 0.99)] ?? 0;

  console.log('\nLatency (ms):');
  console.log(`  avg: ${avg.toFixed(0)}  p50: ${p50}  p95: ${p95}  p99: ${p99}`);

  const forbiddenCount = statusCounts['403'] || 0;
  const successCount = statusCounts['200'] || 0;
  console.log('\n403 Summary:');
  console.log(`  Total 403:  ${forbiddenCount}/${TOTAL_REQUESTS}`);
  console.log(`  Success:   ${successCount}/${TOTAL_REQUESTS}`);

  if (forbiddenCount > 0) {
    const first403 = results.find((r) => r.status === 403);
    console.log(`\nSample 403 response: ${first403?.bodyPreview || ''}...`);
  }

  process.exit(forbiddenCount === TOTAL_REQUESTS ? 1 : 0);
}

runLoadTest().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
