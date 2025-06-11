const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const USE_PROXY = false;
const proxy_host = "geo.iproyal.com";
const proxy_port = 12321;
const proxy_username = "kPMj8aoitK1MVa3e";
const proxy_password = "pookydooki_country-us";
const PROXY_URL = `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`;
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

const AA_SEARCH_URL = 'https://www.aa.com/booking/api/search/itinerary';

const app = express();
app.use(express.json());

app.post('/american', async (req, res) => {
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
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': 'https://www.aa.com/booking/find-flights',
        'Origin': 'https://www.aa.com',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-User': '?1',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(aaBody),
    };
    if (USE_PROXY) fetchOptions.agent = proxyAgent;
    const response = await fetch(AA_SEARCH_URL, fetchOptions);
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