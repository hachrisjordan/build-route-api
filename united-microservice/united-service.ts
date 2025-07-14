import express, { Request, Response } from 'express';
import compression from 'compression';
import { runArkalis } from '../arkalis/arkalis.js';

const app = express();
app.use(express.json());
app.use(compression());

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason)
})

app.post('/united', async (req: Request, res: Response) => {
  try {
    const { from, to, depart, ADT } = req.body;
    
    // Validate required fields
    if (!from || !to || !depart || !ADT) {
      return res.status(400).json({ error: 'Missing required fields: from, to, depart, ADT' });
    }

    // United booking search URL
    const searchUrl = `https://www.united.com/en/us/fsr/choose-flights?f=${from}&t=${to}&d=${depart}&tt=1&at=1&sc=7&px=${ADT}&taxng=1&newHP=True&clm=7&st=bestmatches&tqp=A`;

    console.log(`United microservice: Searching for flights from ${from} to ${to} on ${depart} for ${ADT} adults`);
    console.log(`URL: ${searchUrl}`);

    // Proxy config (runtime only)
    const USE_PROXY = process.env.USE_PROXY === 'false';
    const proxy_host = process.env.PROXY_HOST;
    const proxy_port = process.env.PROXY_PORT;
    const proxy_username = process.env.PROXY_USERNAME;
    const proxy_password = process.env.PROXY_PASSWORD;
    let proxyUrl: string | undefined = undefined;
    if (USE_PROXY) {
      if (!proxy_host || !proxy_port || !proxy_username || !proxy_password) {
        return res.status(500).json({ error: 'Proxy configuration is missing. Please set PROXY_HOST, PROXY_PORT, PROXY_USERNAME, and PROXY_PASSWORD in your environment variables.' });
      }
      proxyUrl = `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`;
      // Set the environment variable for Arkalis to pick up
      process.env.PROXY_ADDRESS_UNITED_MICROSERVICE = proxyUrl;
    }

    console.log('About to call runArkalis...')
    const results = await runArkalis(
      async (arkalis) => {
        console.log('Navigating to United search URL...');
        await arkalis.goto(searchUrl);
        console.log('Navigation complete. Waiting for result...');
        
        const waitForResult = await arkalis.waitFor({
          "success": {
            type: "url",
            url: "https://www.united.com/api/flight/FetchFlights",
            onlyStatusCode: 200,
            othersThrow: true
          },
          "invalid airport": { type: "html", html: "you entered is not valid or the airport is not served" },
          "invalid input": { type: "html", html: "We can't process this request. Please restart your search." },
          "anti-botting": { type: "html", html: "united.com was unable to complete" }
        });
        console.log('waitForResult:', waitForResult)

        if (waitForResult.name !== "success") {
          return { error: waitForResult.name };
        }

        // Get the raw response
        const rawResponse = JSON.parse(waitForResult.response?.body || '{}');
        
        return rawResponse;
      },
      {
        useProxy: USE_PROXY,
        browserDebug: false,
        showRequests: true,
        maxAttempts: 3
      },
      {
        name: "united-microservice",
        defaultTimeoutMs: 30000,
        // Block only truly unnecessary resources while keeping essential functionality
        blockUrls: [
          // Analytics and tracking (these are not needed for API functionality)
          "google-analytics.com",
          "googletagmanager.com",
          "doubleclick.net",
          "googleadservices.com",
          "analytics.tiktok.com",
          "pinterest.com",
          "ct.pinterest.com",
          "s.pinimg.com",
          
          // Third-party tracking and ads
          "tags.tiqcdn.com",
          "cdn.quantummetric.com",
          "cdn.optimizely.com",
          "cdn-prod.securiti.ai",
          "cdn.lpsnmedia.net",
          "lpcdn.lpsnmedia.net",
          "static-assets.dev.fs.liveperson.com",
          "liveperson.net",
          "liveperson.com",
          
          // External tracking and analytics
          "s.go-mpulse.net",
          "c.go-mpulse.net",
          "ep1.adtrafficquality.google",
          "ep2.adtrafficquality.google",
          "uniteddigital.siteintercept.qualtrics.com",
          "siteintercept.qualtrics.com",
          "securepubads.g.doubleclick.net",
          "pagead2.googlesyndication.com",
          "api.ipify.org",
          "d.agkn.com",
          "di.rlcdn.com",
          "js-cdn.dynatrace.com",
          
          // Fonts (not essential for API functionality)
          "*.woff2",
          "*.woff",
          
          // Images (not essential for API functionality)
          "*.png",
          "*.jpg",
          "*.jpeg",
          "*.gif",
          "*.ico",
          "*.svg",
          
          // Specific United assets that aren't essential
          "adBlockBait.png",
          "manifest.json"
        ]
      },
      `united-microservice-${from}-${to}-${depart}`
    );
    console.log('runArkalis finished:', results)

    if (results.result) {
      console.log(`✅ United microservice: Success! Raw FetchFlights response retrieved`);
      res.status(200).json(results.result);
    } else {
      console.log(`❌ United microservice: No results returned`);
      res.status(404).json({ error: 'No flight results found' });
    }

  } catch (error) {
    console.error(`❌ United microservice error:`, error);
    res.status(500).json({ error: (error as Error).message });
  }
});

app.listen(4004, () => console.log('United microservice running on port 4004')); 