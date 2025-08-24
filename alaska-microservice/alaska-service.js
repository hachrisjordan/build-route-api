require('dotenv').config();
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { HttpsProxyAgent } = require('https-proxy-agent');
const compression = require('compression'); // 1. Import compression

/**
 * Required environment variables for Oxylabs proxy:
 * - OXYLABS_USERNAME
 * - OXYLABS_PASSWORD
 * - OXYLABS_COUNTRY
 * - OXYLABS_PROXY
 */

const app = express();
app.use(express.json());
app.use(compression()); // 2. Use compression middleware

app.post('/alaska', async (req, res) => {
  // Oxylabs proxy config
  const USE_PROXY = true;
  const username = process.env.OXYLABS_USERNAME;
  const password = process.env.OXYLABS_PASSWORD;
  const country = process.env.OXYLABS_COUNTRY;
  const proxy = process.env.OXYLABS_PROXY;
  
  if (USE_PROXY && (!username || !password || !country || !proxy)) {
    return res.status(500).json({ error: 'Oxylabs proxy configuration is missing. Please set OXYLABS_USERNAME, OXYLABS_PASSWORD, OXYLABS_COUNTRY, and OXYLABS_PROXY in your environment variables.' });
  }
  
  // Use HTTP proxy with advanced SSL handling to bypass SSL pinning
  const proxyAgent = USE_PROXY ? new HttpsProxyAgent(`http://${username}-cc-${country}:${password}@${proxy}`, {
    rejectUnauthorized: false, // Bypass SSL certificate validation
    secureProxy: false, // Allow insecure proxy connections
    keepAlive: true, // Keep connection alive
    timeout: 30000, // 30 second timeout
    // Additional SSL bypass options
    ciphers: 'ALL', // Accept all ciphers
    minVersion: 'TLSv1', // Accept older TLS versions
    maxVersion: 'TLSv1.3', // Accept newer TLS versions
  }) : undefined;

  const { from, to, depart, ADT } = req.body;
  try {
    console.log(`Using Oxylabs proxy with SSL bypass for Alaska Airlines`);
    
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
    
    console.log(`Making request to Alaska Airlines through Oxylabs proxy`);
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: 'Alaska API error', status: response.status, body: errorText });
    }
    const json = await response.json();
    console.log(`✅ SUCCESS - got valid response from Alaska Airlines through Oxylabs proxy`);
    res.status(200).json(json);
  } catch (err) {
    console.log(`❌ Network error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(4001, () => console.log('Alaska microservice running on port 4001')); 