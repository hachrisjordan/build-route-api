const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * Required environment variables for proxy:
 * - PROXY_HOST
 * - PROXY_PORT
 * - PROXY_USERNAME
 * - PROXY_PASSWORD
 */

// Add error handling for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Add error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

const app = express();
app.use(express.json());

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error('Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

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
    const traceId = Math.random().toString(16).substring(2, 18);
    const spanId = Date.now().toString();
    
    // Call both APIs in parallel to get both Economy and Business class results
    const [newApiResponse, oldApiResponse] = await Promise.allSettled([
      // New API for Economy class
      fetch(`https://cb-api.jetblue.com/cb-flight-search/v1/search/NGB?digb_enable_cb_profile=true&crystal_blue_price_summary=true&crystal_blue_seats_extras=true&digb_acfp_previewseatmap=true&digb_acfp_opsseatmap=true&is_cb_flow=true`, {
        method: 'POST',
        headers: {
          'X-B3-SpanId': spanId,
          'sec-ch-ua-platform': '"macOS"',
          'Referer': `https://www.jetblue.com/booking/cb-flights?from=${from}&to=${to}&depart=${depart}&isMultiCity=false&noOfRoute=1&adults=${ADT}&children=0&infants=0&sharedMarket=false&roundTripFaresFlag=false&usePoints=true`,
          'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
          'sec-ch-ua-mobile': '?0',
          'X-B3-TraceId': traceId,
          'ocp-apim-subscription-key': 'a5ee654e981b4577a58264fed9b1669c',
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          'Cookie': 'ADRUM_BT=R:195|i:285972|g:02e1b4ee-f370-4c74-ad8e-14ef5c42bc30486290|e:1786|n:jetblue_05da9771-4dd4-4420-bf5f-6b666ab2c532',
        },
        body: JSON.stringify({
          awardBooking: true,
          travelerTypes: [{ type: "ADULT", quantity: ADT }],
          searchComponents: [{ from, to, date: depart }]
        }),
        agent: proxyAgent,
      }),
      
      // Old API for Business class
      fetch('https://jbrest.jetblue.com/lfs-rwb/outboundLFS', {
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
          'X-B3-TraceId': traceId,
          'X-B3-SpanId': spanId,
        },
        body: JSON.stringify({
          from,
          to,
          depart: depart.slice(0, 10),
          ADT,
          cabin: 'business'
        }),
        agent: proxyAgent,
      })
    ]);

    // Process responses
    let combinedData = {
      status: { transactionStatus: 'success' },
      data: { searchResults: [] }
    };

    // Handle new API response (Economy class)
    if (newApiResponse.status === 'fulfilled' && newApiResponse.value.ok) {
      const newApiData = await newApiResponse.value.json();
      if (newApiData.status?.transactionStatus === 'success' && newApiData.data?.searchResults) {
        combinedData.data.searchResults.push(...newApiData.data.searchResults);
      }
    }

    // Handle old API response (Business class)
    if (oldApiResponse.status === 'fulfilled' && oldApiResponse.value.ok) {
      const oldApiData = await oldApiResponse.value.json();
      if (oldApiData.itinerary) {
        // Convert old API format to new API format
        const convertedResults = oldApiData.itinerary.map(itin => ({
          productOffers: [{
            originAndDestination: [{
              departure: { date: itin.depart, airport: itin.from },
              arrival: { date: itin.arrive, airport: itin.to },
              flightSegments: itin.segments?.map(seg => ({
                departure: { date: seg.depart, airport: seg.from },
                arrival: { date: seg.arrive, airport: seg.to },
                flightInfo: {
                  marketingAirlineCode: seg.flightno?.substring(0, 2),
                  marketingFlightNumber: seg.flightno?.substring(2)
                }
              })) || []
            }],
            offers: [{
              cabinClass: itin.bundles?.[0]?.class === 'J' ? 'Business' : 
                        itin.bundles?.[0]?.class === 'F' ? 'First' : 'Economy',
              price: itin.bundles?.[0] ? [{
                amount: itin.bundles[0].points,
                currency: 'FFCURRENCY'
              }, {
                amount: itin.bundles[0].fareTax,
                currency: 'USD'
              }] : []
            }]
          }]
        }));
        combinedData.data.searchResults.push(...convertedResults);
      }
    }

    res.status(200).json(combinedData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = 4000;
const server = app.listen(PORT, () => {
  console.log(`JetBlue microservice running on port ${PORT}`);
  console.log(`Health check available at: http://localhost:${PORT}/health`);
});

// Add server error handling
server.on('error', (error) => {
  console.error('Server error:', error);
});

// Keep the process alive
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

console.log('Service starting up...'); 