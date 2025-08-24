require('dotenv').config({ path: '../.env' });
const express = require('express');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fetchCookie = require('fetch-cookie');
const { CookieJar } = require('tough-cookie');
const fs = require('fs');

// Oxylabs proxy configuration
const username = process.env.OXYLABS_USERNAME;
const password = process.env.OXYLABS_PASSWORD;
const country = process.env.OXYLABS_COUNTRY;
const proxy = process.env.OXYLABS_PROXY;

// Validate required environment variables
if (!username || !password || !country || !proxy) {
  console.error('Missing required Oxylabs environment variables:');
  console.error('OXYLABS_USERNAME:', username ? '✓' : '✗');
  console.error('OXYLABS_PASSWORD:', password ? '✓' : '✗');
  console.error('OXYLABS_COUNTRY:', country ? '✓' : '✗');
  console.error('OXYLABS_PROXY:', proxy ? '✓' : '✗');
  process.exit(1);
}

// Use HTTP proxy with advanced SSL handling to bypass SSL pinning
const agent = new HttpsProxyAgent(`http://${username}-cc-${country}:${password}@${proxy}`, {
  rejectUnauthorized: false, // Bypass SSL certificate validation
  secureProxy: false, // Allow insecure proxy connections
  keepAlive: true, // Keep connection alive
  timeout: 30000, // 30 second timeout
  // Additional SSL bypass options
  ciphers: 'ALL', // Accept all ciphers
  minVersion: 'TLSv1', // Accept older TLS versions
  maxVersion: 'TLSv1.3', // Accept newer TLS versions
});

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
  const { from, to, depart, ADT } = req.body;
  
  try {
    console.log(`Using Oxylabs proxy with SSL bypass`);
    
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
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
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
        'x-requested-with': 'XMLHttpRequest',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
      },
      body: JSON.stringify(aaBody),
    };
    
    fetchOptions.agent = agent;
    console.log(`Using proxy agent for Oxylabs proxy`);
    
    console.log(`Making request to: ${AA_SEARCH_URL}`);
    const response = await fetchWithCookies(AA_SEARCH_URL, fetchOptions);
    const text = await response.text();
    
    console.log(`Response status: ${response.status}`);
    console.log(`Response preview (first 200 chars): ${text.substring(0, 200)}`);
    
    // Check if we got blocked
    if (text.includes('Access Denied') || text.includes('SSL') || text.includes('Forbidden') || text.includes('edgesuite.net') || text.includes('<HTML>') || text.includes('<html>')) {
      console.log(`❌ BLOCKED - detected blocking response`);
      return res.status(502).json({ 
        error: 'American Airlines blocked the request through proxy',
        details: {
          reason: 'SSL pinning or anti-proxy detection active',
          suggestions: [
            'Try using a different Oxylabs endpoint or country',
            'Check if the API endpoint has changed',
            'Verify the request format is still valid'
          ]
        }
      });
    }
    
    // Try to parse as JSON
    try {
      const data = JSON.parse(text);
      console.log(`✅ SUCCESS - got valid JSON response through Oxylabs proxy`);
      return res.status(200).json(data);
    } catch (err) {
      // If JSON parsing fails, it might be HTML content or other blocking
      if (text.includes('<HTML>') || text.includes('<html>') || text.includes('<title>')) {
        console.log(`❌ Got HTML response - likely blocked`);
        return res.status(502).json({ 
          error: 'American Airlines returned HTML instead of JSON',
          details: {
            reason: 'Request was blocked or redirected',
            response: text.substring(0, 500)
          }
        });
      }
      // If it's not JSON and not HTML, it might be a different error
      return res.status(502).json({ 
        error: 'Unexpected response format from American Airlines',
        details: {
          reason: 'Response is neither valid JSON nor HTML',
          response: text.substring(0, 500)
        }
      });
    }
    
  } catch (err) {
    console.log(`❌ Network error: ${err.message}`);
    return res.status(500).json({ 
      error: 'Network error when connecting to American Airlines',
      details: {
        reason: err.message,
        suggestions: [
          'Check network connectivity',
          'Verify proxy configuration',
          'Check if American Airlines is accessible'
        ]
      }
    });
  }
});

app.listen(4002, () => console.log('American microservice running on port 4002'));

/**
 * Oxylabs proxy configuration (environment variables):
 * - OXYLABS_USERNAME: customer-binbinhihi_7NB4d
 * - OXYLABS_PASSWORD: 19062001_Bin1
 * - OXYLABS_COUNTRY: US
 * - OXYLABS_PROXY: pr.oxylabs.io:7777
 */ 