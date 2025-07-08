require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fetchCookie = require('fetch-cookie');
const { CookieJar } = require('tough-cookie');
const { HttpsProxyAgent } = require('https-proxy-agent');

const jar = new CookieJar();
// Seed the jar with the working cookie string from curl
jar.setCookieSync('_abck=E88330E2FA18B3CAE62C64C036328BFE~-1~YAAQ20ItF8PCALKXAQAAptdL6g54eIXFO5x4bqfDlsV3F+iRwc2oYzo5qu9KrteZaH5Rqiea0iFAchFLxk9j0bxz8fpxj+6+Q2La8HK+lLHJkOiGIkXatq6l8BTNMj3OI3vSTQQpnwrOIR1E0Pr0FoozeW20lMiS9T+VIciXpnhl2TAfwOgFb3K/udN0u6R1DWKjoYqBM1fpRgLd24mwHE8MVybmcvozNcBc6a7LoqF0ZgBcZPAP86Wz35QIAB8Duo5SIE/ZGNJ9sU+TMe8krTfgj8oOAGpHkd8Ia21y2vR71N6o7LvNs2tlNzmEkhBu7ulF1eFN1PIZGWx1XCMLMs4a5YbcE/WM0vMLEEVZi1PbbY4su518IMEYa5I9/1sPRRTjFIX2F0tCJk8Hx1ArTCXAjBpYbkirDq1KpKL1BaREs4ykzClojE6eXOr5H3OGJoR2LIbUnbLP1Xz4p91QvAo4Zmh44Ar8EbjdY/SDvk2gBZmKbEWfyrVJrDW3dk12JJERsUl5v9Es41AiQLAPzY3cDmbouuHLkNl/aNWKIkSBraKPLChFi/jtgsK7IMQS52seJaEWE6xmRM3cHbL/cR5iwOvgzq/mVyc8aoNxhO59gNFoNYlDrAW98cJTcKwAOWhK/pY5fpCyi/+VoL+ZjaQM+2H/yPs3qi3zloMxzPfAvVFQwlmF8J7zDESM/CbALsk4nYVhTKHQ0sVRF7WtlrWfp9/TvkEXSh8v4eYd5s+mwpaI28/iSyHu9kDR6cx0PuB2AwZq753f09NyZF6OleLc4dBNfssOTCdmKDVwTY1JaVaR5hIn3xTsHLae6DZSnBA43laK6dXjjoUbAro/YrH7Xgo6Hh60u491z2COeOiunrVUzhOP4+b5AEMstDf8aFPLtokBlFjUMq8pC0fZGwQcybKP7rW/7Z1gkb2GVGd1JuivC4u3o6c89vQK+AVRtT0YvLKitlcmmHFLLp4=~-1~-1~-1; bm_s=YAAQ20ItF8TCALKXAQAAptdL6gNHeAr8BtguWLmp+1T52Mp910ZBQHz6bkitl+s/y6BeGqjVJVV5XJyGg331+FM9H8HOiJh/TVqux2oKsBuEuD0CTr2QFOPIBqMQJx0wIt8KmxjsYZG3p99tSboU9wl0JKhSC44I8VThoW9JYqs6Huax9GfpAXULb9WKnkTZfaeJU2K5XYu3aMHRdQ49j1LvoEj63Sn7ennIBvI2oaZ29MftCsveqeExqyU/oSt9dBDe/cETd1nxIitZnbZvrWYo9ag1dfxx16o7rwZ8B7B0UJaimLD1jQi6UDPAlpNM097cqeWvNG9QA6Uq24fe1DrZC9B37jb8oQWPgFd/elDPvXTkX4A0G6kOhxB8ZxXifdVEXqORpSOvTxMPO5slBNk4dg98VNLs9h8YCpJqt08kFSN3tZ4vasQ6Dg9z1IIDr3pW7dLrWTu7YF+uO64OKk0dIF4MHZzdhxadKPWrTYneri4BlTElm9e+AND+P+5dvYd5nD5HK/QqPgz67w1t0CjFTzFy8DOFfcW6hdvLahTcz47h; bm_ss=ab8e18ef4e; bm_sz=B222DE2547BD467C6E36342EDA1C26FE~YAAQ20ItF8XCALKXAQAAptdL6hwSNNHWy4fkTDYnpcovmeDp1QtICLNmaUJQbXz3+8OQVAgas9EjWFjL2DWpuWDVGFPzhRaMUgGrW0PRor/VZMxoaxoluhxalKcaFMH3/286qITi2K9x5I6ZNCJGLw3YZdPrKQ+VtJwOsoXuaxpE6DNWObQJqQtwk7Rp7q5YpaRaM6DaPxefpeJ+J7jmSqfaOWcOphUFIXne/MTw8JzfiK+f55WE9FWpT5HiflkoRaH9FckSu1W2kDf2mcWFWgEVu4dZkA+FjaSIOYgoBx4+1pJZJVqYSK6MFXuZlVyXHyt+aNsNjavMeFiUGaDp3xbkP7KQ2+EvtHSAYLiyy/XcEz6b4ahQMHRVooMGhUY0LqEv2d3MwXSizA==~4408370~4403508; aka_cr_code=US-OH; aka_lc_code=ML; aka_state_code=OH; akavpau_www_aafullsite=1751982828~id=4a9d982305254433f23b4af7b5d98ca4', 'https://www.aa.com');
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