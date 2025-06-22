const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * Required environment variables for proxy:
 * - PROXY_HOST
 * - PROXY_PORT
 * - PROXY_USERNAME
 * - PROXY_PASSWORD
 */

const app = express();
app.use(express.json());

app.post('/jetblue', async (req, res) => {
  // Proxy config (runtime only)
  const USE_PROXY = true;
  const proxy_host = process.env.PROXY_HOST;
  const proxy_port = process.env.PROXY_PORT;
  const proxy_username = process.env.PROXY_USERNAME;
  const proxy_password = process.env.PROXY_PASSWORD;
  if (USE_PROXY && (!proxy_host || !proxy_port || !proxy_username || !proxy_password)) {
    return res.status(500).json({ error: 'Proxy configuration is missing. Please set PROXY_HOST, PROXY_PORT, PROXY_USERNAME, and PROXY_PASSWORD in your environment variables.' });
  }
  const PROXY_URL = USE_PROXY
    ? `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`
    : undefined;
  const proxyAgent = USE_PROXY && PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

  const { from, to, depart, ADT } = req.body;
  try {
    const response = await fetch('https://jbrest.jetblue.com/lfs-rwb/outboundLFS', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'API-Version': 'v3',
        'Application-Channel': 'Desktop_Web',
        'Booking-Application-Type': 'NGB',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Referer': `https://www.jetblue.com/booking/flights?from=${from}&to=${to}&depart=${depart}&isMultiCity=false&noOfRoute=1&adults=${ADT}&children=0&infants=0&sharedMarket=false&roundTripFaresFlag=false&usePoints=true`,
        'X-B3-TraceId': '6aaca3c26c23f81c',
        'X-B3-SpanId': '1749578192171',
      },
      body: JSON.stringify({
        tripType: 'oneWay',
        from,
        to,
        depart,
        cabin: 'economy',
        refundable: false,
        dates: { before: '3', after: '3' },
        pax: { ADT, CHD: 0, INF: 0, UNN: 0 },
        redempoint: true,
        pointsBreakup: { option: '', value: 0 },
        isMultiCity: false,
        isDomestic: false,
        'outbound-source': 'fare-setSearchParameters',
      }),
      agent: proxyAgent,
    });
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`JetBlue microservice running on port ${PORT}`);
}); 