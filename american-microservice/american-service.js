require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fetchCookie = require('fetch-cookie');
const { CookieJar } = require('tough-cookie');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');

const jar = new CookieJar();
const cookieFilePath = './aa-cookies.txt';
let cookies = [];
try {
  cookies = JSON.parse(fs.readFileSync('./aa-cookies.json', 'utf-8'));
  cookies.forEach(cookie => {
    // tough-cookie expects a Set-Cookie string, so reconstruct it
    let cookieStr = `${cookie.name}=${cookie.value}`;
    if (cookie.domain) cookieStr += `; Domain=${cookie.domain}`;
    if (cookie.path) cookieStr += `; Path=${cookie.path}`;
    if (cookie.expires && cookie.expires !== -1) cookieStr += `; Expires=${new Date(cookie.expires * 1000).toUTCString()}`;
    if (cookie.httpOnly) cookieStr += '; HttpOnly';
    if (cookie.secure) cookieStr += '; Secure';
    try {
      jar.setCookieSync(cookieStr, 'https://www.aa.com');
    } catch (err) {
      console.warn('Failed to set cookie:', cookieStr, err.message);
    }
  });
} catch (err) {
  console.warn('Could not read AA cookies JSON file:', err.message);
}
const fetchWithCookies = fetchCookie(fetch, jar);

const AA_SEARCH_URL = 'https://www.aa.com/booking/api/search/itinerary';

const app = express();
app.use(express.json());

app.post('/american', async (req, res) => {
  // Proxy config (runtime only)
  const USE_PROXY = false;
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
    const aaBody = {
      metadata: {
        selectedProducts: [],
        tripType: 'OneWay',
        udo: {},
      },
      passengers: [
        { type: 'adult', count: ADT }
      ],
      requestHeader: {
        clientId: 'AAcom',
      },
      slices: [
        {
          allCarriers: true,
          cabin: '',
          departureDate: depart,
          destination: to,
          destinationNearbyAirports: false,
          maxStops: null,
          origin: from,
          originNearbyAirports: false,
        }
      ],
      tripOptions: {
        corporateBooking: false,
        fareType: 'Lowest',
        locale: 'en_US',
        pointOfSale: null,
        searchType: 'Award',
      },
      loyaltyInfo: null,
      version: '',
      queryParams: {
        sliceIndex: 0,
        sessionId: '',
        solutionSet: '',
        solutionId: '',
        sort: 'CARRIER',
      },
    };
    const fetchOptions = {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US',
        'content-type': 'application/json',
        'origin': 'https://www.aa.com',
        'priority': 'u=1, i',
        'referer': 'https://www.aa.com/booking/choose-flights/1?sid=a1e8c530-f444-4b3a-a536-7778ac431b9e',
        'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        // 'cookie': '...' // Only if you want to override the jar for testing
      },
      body: JSON.stringify(aaBody),
    };
    if (USE_PROXY) fetchOptions.agent = proxyAgent;
    const response = await fetchWithCookies(AA_SEARCH_URL, fetchOptions);
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      res.status(200).json(data);
    } catch (err) {
      res.status(502).json({ error: 'Invalid JSON from AA', text });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(4002, () => console.log('American microservice running on port 4002'));

/**
 * Required environment variables for proxy:
 * - PROXY_HOST
 * - PROXY_PORT
 * - PROXY_USERNAME
 * - PROXY_PASSWORD
 */ 