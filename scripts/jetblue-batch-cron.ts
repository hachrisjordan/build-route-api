import fetch from 'node-fetch';
import { format } from 'date-fns';
import { HttpsProxyAgent } from 'https-proxy-agent';

const FROM_AIRPORTS = ['IAD','ORD','JFK','ATL','BOS','YYZ'];
const TO_AIRPORTS = [
  'BKK','BAH','PEK','CAI','AHD','BLR','MAA','DEL','HYD','JAI','COK','CCU','CCJ','TRV','BOM','DPS','CGK','AMM','KWI','BEY','KUL','MLE','CMH','MCT','ISB','KHI','LHE','MNL','DOH','JED','DMM','SEZ','CMB','HKT','IST','RUH'
];
const API_URL = process.env.BATCH_API_URL || 'http://localhost:3000/api/jetblue-lfs-batch';
const DAYS = 16;

// Proxy credentials
const USE_PROXY = false;
const proxy_host = "geo.iproyal.com";
const proxy_port = 12321;
const proxy_username = "kPMj8aoitK1MVa3e";
const proxy_password = "pookydooki_country-us";

const PROXY_URL = `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`;
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

async function runBatch(from: string, to: string) {
  if (from === to) return;
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14);
  const start = format(startDate, 'yyyy-MM-dd');
  const body = { from, to, days: DAYS, start };
  try {
    const fetchOptions: any = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    };
    if (USE_PROXY) {
      fetchOptions.agent = proxyAgent;
    }
    const res = await fetch(API_URL, fetchOptions);
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