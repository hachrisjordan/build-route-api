require('dotenv').config();
const nodeFetch = (url: string, options?: any) => import('node-fetch').then(mod => mod.default(url, options));
const { format } = require('date-fns');
const { HttpsProxyAgent } = require('https-proxy-agent');

const FROM_AIRPORTS = ['ORD','JFK','BOS','YYZ','ATL','IAD'];
const TO_AIRPORTS = [
  'BKK','CAI','BLR','DEL','JAI','COK','BOM','DPS','MCT','MNL','IST'
];
const API_URL = process.env.BATCH_API_URL || 'http://localhost:3000/api/jetblue-lfs-batch';
const DAYS = 16;

/**
 * Required environment variables for proxy:
 * - PROXY_HOST
 * - PROXY_PORT
 * - PROXY_USERNAME
 * - PROXY_PASSWORD
 */

async function runBatch(from: string, to: string) {
  if (from === to) return;
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14);
  const start = format(startDate, 'yyyy-MM-dd');
  const body = { from, to, days: DAYS, start };
  try {
    // Proxy config (runtime only)
    const USE_PROXY = false;
    const proxy_host = process.env.PROXY_HOST;
    const proxy_port = process.env.PROXY_PORT;
    const proxy_username = process.env.PROXY_USERNAME;
    const proxy_password = process.env.PROXY_PASSWORD;
    if (USE_PROXY && (!proxy_host || !proxy_port || !proxy_username || !proxy_password)) {
      throw new Error('Proxy configuration is missing. Please set PROXY_HOST, PROXY_PORT, PROXY_USERNAME, and PROXY_PASSWORD in your environment variables.');
    }
    const PROXY_URL = USE_PROXY
      ? `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`
      : undefined;
    const proxyAgent = USE_PROXY && PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

    const fetchOptions: any = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    };
    if (USE_PROXY) {
      fetchOptions.agent = proxyAgent;
    }
    const res = await nodeFetch(API_URL, fetchOptions);
    let data: any = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    console.log(`[BATCH] ${from} -> ${to}: status=${res.status}, results=${data?.results?.length ?? 0}`);
    if (res.status !== 200) {
      console.error(`[BATCH] Error:`, data);
    }
  } catch (err) {
    console.error(`[BATCH] Exception for ${from} -> ${to}:`, err);
  }
}

async function runAllPairs(reverse = false) {
  const pairs: [string, string][] = [];
  for (const from of FROM_AIRPORTS) {
    for (const to of TO_AIRPORTS) {
      if (from !== to) pairs.push(reverse ? [to, from] : [from, to]);
    }
  }
  for (const [from, to] of pairs) {
    await runBatch(from, to);
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5s delay
  }
}

async function main() {
  const reverse = process.argv.includes('--reverse');
  console.log(`[BATCH] Starting batch job. Reverse: ${reverse}`);
  await runAllPairs(reverse);
  console.log('[BATCH] All jobs done.');
}

main(); 