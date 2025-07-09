require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const compression = require('compression'); // 1. Import compression

/**
 * Required environment variables for proxy:
 * - PROXY_HOST
 * - PROXY_PORT
 * - PROXY_USERNAME
 * - PROXY_PASSWORD
 */

const app = express();
app.use(express.json());
app.use(compression()); // 2. Use compression middleware

app.post('/alaska', async (req, res) => {
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
    const postData = {
      origins: [from],
      destinations: [to],
      dates: [depart],
      numADTs: ADT,
      numINFs: 0,
      numCHDs: 0,
      fareView: 'as_awards',
      onba: false,
      dnba: false,
      discount: {
        code: '',
        status: 0,
        expirationDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString(),
        message: '',
        memo: '',
        type: 0,
        searchContainsDiscountedFare: false,
        campaignName: '',
        campaignCode: '',
        distribution: 0,
        amount: 0,
        validationErrors: [],
        maxPassengers: 0
      },
      isAlaska: false,
      isMobileApp: false,
      isWholeTripPricing: false,
      sliceId: 0,
      businessRequest: {
        TravelerId: '',
        BusinessRequestType: 0,
        CountryCode: '',
        StateCode: '',
        ShowOnlySpecialFares: false
      },
      umnrAgeGroup: '',
      lockFare: false,
      sessionID: '',
      solutionIDs: [],
      solutionSetIDs: [],
      qpxcVersion: '',
      trackingTags: [],
      isMultiCityAwards: false
    };
    const url = 'https://www.alaskaair.com/search/api/flightresults';
    const fetchOptions = {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        'adrum': 'isAjax:true',
        'connection': 'keep-alive',
        'content-type': 'text/plain;charset=UTF-8',
        'host': 'www.alaskaair.com',
        'origin': 'https://www.alaskaair.com',
        'referer': `https://www.alaskaair.com/search/results?A=${ADT}&O=${from}&D=${to}&OD=${depart}&OT=Anytime&RT=false&UPG=none&ShoppingMethod=onlineaward&awardType=MilesOnly`,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X; en-us) ALKApp/iOS',
      },
      body: JSON.stringify(postData),
    };
    if (USE_PROXY) fetchOptions.agent = proxyAgent;
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: 'Alaska API error', status: response.status, body: errorText });
    }
    const json = await response.json();
    res.status(200).json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(4001, () => console.log('Alaska microservice running on port 4001')); 