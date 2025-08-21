require('dotenv').config();
const express = require('express');
const compression = require('compression');
const { spawn } = require('child_process');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json());
app.use(compression());

// Valkey connection for session pooling
let valkey = null;
try {
  const Redis = require('ioredis');
  valkey = new Redis({
    host: process.env.VALKEY_HOST || 'localhost',
    port: process.env.VALKEY_PORT || 6379,
    password: process.env.VALKEY_PASSWORD || undefined,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
  });
  console.log('[delta] Valkey connected for session pooling');
} catch (err) {
  console.log('[delta] Valkey not available, using in-memory session pool');
}

// Optional proxy support via environment variables
let proxyAgent = undefined;
try {
  const USE_PROXY = process.env.USE_PROXY !== 'true';
  const proxy_host = process.env.PROXY_HOST;
  const proxy_port = process.env.PROXY_PORT;
  const proxy_username = process.env.PROXY_USERNAME;
  const proxy_password = process.env.PROXY_PASSWORD;
  if (USE_PROXY && proxy_host && proxy_port && proxy_username && proxy_password) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const proxyUrl = `http://${proxy_username}:${proxy_password}@${proxy_host}:${proxy_port}`;
    proxyAgent = new HttpsProxyAgent(proxyUrl);
  }
} catch (_) {
  proxyAgent = undefined;
}

function makeUuidV4Like() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function makeTransactionId() {
  return `${makeUuidV4Like()}_${Date.now()}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// FIXED transaction ID as requested
const FIXED_TRANSACTION_ID = '5f240a16-24f4-4dd1-882e-9dc8f9410117_1755780702111';

// Session management with Redis persistence
const SESSION_POOL_SIZE = 5; // Maintain 5 browser sessions
const SESSION_TTL = 300; // 5 minutes TTL for sessions
const SESSION_REFRESH_THRESHOLD = 240; // Refresh after 4 minutes

class SessionPool {
  constructor() {
    this.sessions = new Map();
    this.currentIndex = 0;
    this.lastCleanup = Date.now();
  }

  async getSession() {
    // Cleanup old sessions periodically
    if (Date.now() - this.lastCleanup > 60000) { // Every minute
      await this.cleanupSessions();
      this.lastCleanup = Date.now();
    }

    // Try to get an existing valid session
    for (const [id, session] of this.sessions) {
      if (Date.now() - session.lastUsed < SESSION_REFRESH_THRESHOLD * 1000) {
        session.lastUsed = Date.now();
        session.useCount = (session.useCount || 0) + 1;
        return session;
      }
    }

    // Create new session if needed
    return await this.createNewSession();
  }

  async createNewSession() {
    try {
      const searchDt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const mm = String(searchDt.getMonth() + 1).padStart(2, '0');
      const dd = String(searchDt.getDate()).padStart(2, '0');
      const yyyy = searchDt.getFullYear();
      const dateStr = `${mm}/${dd}/${yyyy}`;
      const searchUrl = `https://www.delta.com/flight-search/search?action=findFlights&searchByCabin=true&deltaOnlySearch=false&deltaOnly=off&go=Find%20Flights&tripType=ONE_WAY&passengerInfo=ADT:1&priceSchedule=price&awardTravel=true&originCity=SAN&destinationCity=LAS&departureDate=${encodeURIComponent(dateStr)}&returnDate=&forceMiles=true&utm_source=seatsaero`;
      
      const child = spawn('python', ['delta-microservice/delta_cookie_fetcher.py', searchUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
      let bout = '';
      let berr = '';
      await new Promise((resolve) => {
        child.stdout.on('data', (d) => (bout += d.toString()));
        child.stderr.on('data', (d) => (berr += d.toString()));
        child.on('close', resolve);
      });
      
      try {
        const parsed = JSON.parse(bout.trim() || '{}');
        if (parsed.cookie) {
          const sessionId = makeUuidV4Like();
          const session = {
            id: sessionId,
            cookie: parsed.cookie,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            useCount: 1
          };
          
          this.sessions.set(sessionId, session);
          
          // Store in Valkey if available
          if (valkey) {
            await valkey.setex(`delta_session:${sessionId}`, SESSION_TTL, JSON.stringify(session));
          }
          
          // Keep pool size manageable
          if (this.sessions.size > SESSION_POOL_SIZE) {
            const oldestId = Array.from(this.sessions.keys())[0];
            this.sessions.delete(oldestId);
            if (valkey) {
              await valkey.del(`delta_session:${oldestId}`);
            }
          }
          
          return session;
        }
      } catch (_) {}
    } catch (_) {}
    
    return null;
  }

  async cleanupSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > SESSION_TTL * 1000) {
        this.sessions.delete(id);
        if (valkey) {
          await valkey.del(`delta_session:${id}`);
        }
      }
    }
  }

  async loadFromValkey() {
    if (!valkey) return;
    
    try {
      const keys = await valkey.keys('delta_session:*');
      for (const key of keys) {
        const sessionData = await valkey.get(key);
        if (sessionData) {
          const session = JSON.parse(sessionData);
          this.sessions.set(session.id, session);
        }
      }
    } catch (err) {
      console.log('[delta] Valkey load error:', err.message);
    }
  }
}

// Global session pool
const sessionPool = new SessionPool();

// Browser pool for reusing browser instances
class BrowserPool {
  constructor(maxBrowsers = 3) {
    this.maxBrowsers = maxBrowsers;
    this.browsers = new Map();
    this.availableBrowsers = [];
    this.browserCounter = 0;
  }

  async getBrowser() {
    // Return an available browser if any
    if (this.availableBrowsers.length > 0) {
      const browserId = this.availableBrowsers.pop();
      return this.browsers.get(browserId);
    }

    // Create new browser if under limit
    if (this.browsers.size < this.maxBrowsers) {
      return await this.createBrowser();
    }

    // Wait for a browser to become available
    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        if (this.availableBrowsers.length > 0) {
          clearInterval(checkInterval);
          const browserId = this.availableBrowsers.pop();
          resolve(this.browsers.get(browserId));
        }
      }, 100);
    });
  }

  async createBrowser() {
    try {
      const browserId = `browser_${++this.browserCounter}`;
      console.log(`[delta] Creating new browser instance: ${browserId}`);
      
      // Create a persistent browser process
      const child = spawn('python', ['delta-microservice/delta_browser_fetch.py', '--persistent'], { 
        stdio: ['pipe', 'pipe', 'pipe'] 
      });
      
      const browser = {
        id: browserId,
        process: child,
        inUse: false,
        lastUsed: Date.now()
      };
      
      // Handle browser process errors
      child.on('error', (err) => {
        console.error(`[delta] Browser ${browserId} process error:`, err.message);
        this.removeBrowser(browserId);
      });
      
      child.on('exit', (code, signal) => {
        console.log(`[delta] Browser ${browserId} exited with code ${code}, signal ${signal}`);
        this.removeBrowser(browserId);
      });
      
      this.browsers.set(browserId, browser);
      return browser;
    } catch (error) {
      console.error('[delta] Failed to create browser:', error);
      throw error;
    }
  }

  releaseBrowser(browserId) {
    const browser = this.browsers.get(browserId);
    if (browser) {
      browser.inUse = false;
      browser.lastUsed = Date.now();
      this.availableBrowsers.push(browserId);
    }
  }

  removeBrowser(browserId) {
    const browser = this.browsers.get(browserId);
    if (browser) {
      try {
        if (!browser.process.killed) {
          browser.process.kill('SIGTERM');
        }
      } catch (e) {
        console.log(`[delta] Error killing browser ${browserId}:`, e.message);
      }
      
      this.browsers.delete(browserId);
      this.availableBrowsers = this.availableBrowsers.filter(id => id !== browserId);
      console.log(`[delta] Removed browser ${browserId}, pool size: ${this.browsers.size}`);
    }
  }

  async cleanup() {
    console.log(`[delta] Cleaning up ${this.browsers.size} browser instances...`);
    
    for (const [id, browser] of this.browsers) {
      try {
        console.log(`[delta] Terminating browser: ${id}`);
        browser.process.kill('SIGTERM');
        
        // Wait a bit for graceful shutdown, then force kill if needed
        setTimeout(() => {
          try {
            if (!browser.process.killed) {
              console.log(`[delta] Force killing browser: ${id}`);
              browser.process.kill('SIGKILL');
            }
          } catch (e) {
            console.log(`[delta] Force kill failed for browser ${id}:`, e.message);
          }
        }, 5000);
        
      } catch (e) {
        console.log(`[delta] Cleanup error for browser ${id}:`, e.message);
      }
    }
    
    this.browsers.clear();
    this.availableBrowsers = [];
    console.log('[delta] Browser cleanup completed');
  }
}

const browserPool = new BrowserPool(3); // Max 3 browser instances

// Load existing sessions from Valkey on startup
sessionPool.loadFromValkey();

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('[delta] Received SIGTERM, shutting down gracefully...');
  await browserPool.cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[delta] Received SIGINT, shutting down gracefully...');
  await browserPool.cleanup();
  process.exit(0);
});

// Cleanup on process exit
process.on('exit', () => {
  console.log('[delta] Process exiting, cleaning up...');
  browserPool.cleanup();
});

// Periodic browser cleanup (every 10 minutes)
setInterval(async () => {
  try {
    await browserPool.cleanup();
    console.log('[delta] Periodic browser cleanup completed');
  } catch (err) {
    console.error('[delta] Periodic cleanup error:', err.message);
  }
}, 10 * 60 * 1000);

async function executeInBrowser(url, headers, body) {
  let browser = null;
  try {
    // Get a browser from the pool
    browser = await browserPool.getBrowser();
    browser.inUse = true;
    
    console.log(`[delta] Using browser: ${browser.id} for request`);
    
    // Send the request data to the persistent browser process
    const requestData = JSON.stringify({
      url: url,
      headers: headers,
      body: body
    });
    
    browser.process.stdin.write(requestData + '\n');
    
    // Wait for response with timeout
    const response = await Promise.race([
      new Promise((resolve, reject) => {
        let bout = '';
        let berr = '';
        
        const timeout = setTimeout(() => {
          reject(new Error('Browser request timeout'));
        }, 120000); // 2 minute timeout
        
        const onData = (d) => (bout += d.toString());
        const onError = (d) => (berr += d.toString());
        
        browser.process.stdout.once('data', onData);
        browser.process.stderr.once('data', onError);
        
        // Listen for the response marker
        const checkResponse = () => {
          if (bout.includes('RESPONSE_START') && bout.includes('RESPONSE_END')) {
            clearTimeout(timeout);
            browser.process.stdout.removeListener('data', onData);
            browser.process.stderr.removeListener('data', onError);
            
            const responseData = bout.substring(
              bout.indexOf('RESPONSE_START') + 'RESPONSE_START'.length,
              bout.indexOf('RESPONSE_END')
            );
            
            try {
              const parsed = JSON.parse(responseData.trim());
              resolve(parsed);
            } catch (e) {
              reject(new Error('Invalid response format'));
            }
          } else {
            setTimeout(checkResponse, 100);
          }
        };
        
        checkResponse();
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 120000))
    ]);
    
    if (response.status && response.body) {
      return {
        ok: response.status === 200,
        status: response.status,
        text: () => response.body,
        json: () => {
          try {
            return JSON.parse(response.body);
          } catch (_) {
            return { error: 'Invalid JSON response' };
          }
        }
      };
    }
    
    return { ok: false, status: 500, text: () => 'Browser execution failed' };
  } catch (error) {
    console.error('[delta] Browser execution error:', error.message);
    return { ok: false, status: 500, text: () => error.message };
  } finally {
    // Release the browser back to the pool
    if (browser) {
      browserPool.releaseBrowser(browser.id);
    }
  }
}

app.post('/delta', async (req, res) => {
  try {
    const { from, to, depart, ADT, transactionid: transactionIdOverride, cookie, noProxy } = req.body || {};
    if (!from || !to || !depart || !ADT) {
      return res.status(400).json({ error: 'Missing required fields: from, to, depart, ADT' });
    }

    const gqlQuery = `query ($offerSearchCriteria: OfferSearchCriteriaInput!) {
  gqlSearchOffers(offerSearchCriteria: $offerSearchCriteria) {
    offerResponseId
    gqlOffersSets {
      trips {
        tripId
        scheduledDepartureLocalTs
        scheduledArrivalLocalTs
        originAirportCode
        destinationAirportCode
        stopCnt
        flightSegment {
          aircraftTypeCode
          dayChange
          destinationAirportCode
          flightLeg {
            legId
            dayChange
            destinationAirportCode
            feeRestricted
            scheduledArrivalLocalTs
            scheduledDepartureLocalTs
            layover {
              destinationAirportCode
              layoverAirportCode
              layoverDuration { hourCnt minuteCnt }
              departureFlightNum
              equipmentChange
              originAirportCode
              scheduledArrivalLocalTs
              scheduledDepartureLocalTs
            }
            operatedByOwnerCarrier
            redEye
            operatingCarrier { carrierCode carrierName }
            marketingCarrier { carrierCode carrierName }
            earnLoyaltyMiles
            loyaltyMemberBenefits
            dominantLeg
            duration { dayCnt hourCnt minuteCnt }
            originAirport { airportTerminals { terminalId } }
            destinationAirport { airportTerminals { terminalId } }
            originAirportCode
            aircraft { fleetTypeCode subFleetTypeCode newSubFleetType }
            carrierCode
            distance { unitOfMeasure unitOfMeasureCnt }
          }
          layover {
            destinationAirportCode
            layoverAirportCode
            layoverDuration { hourCnt minuteCnt }
            departureFlightNum
            equipmentChange
            originAirportCode
            scheduledArrivalLocalTs
            scheduledDepartureLocalTs
          }
          marketingCarrier { carrierCode carrierNum }
          operatingCarrier { carrierCode carrierNum carrierName }
          pendingGovtApproval
          destinationCityCode
          flightSegmentNum
          originAirportCode
          originCityCode
          scheduledArrivalLocalTs
          scheduledDepartureLocalTs
          aircraft { fleetTypeCode subFleetTypeCode newSubFleetType }
        }
        totalTripTime { dayCnt hourCnt minuteCnt }
        summarizedProductId
      }
      additionalOfferSetProperties {
        globalUpgradeCertificateTripStatus { brandId upgradeAvailableStatusProductId }
        regionalUpgradeCertificateTripStatus { brandId upgradeAvailableStatusProductId }
        offerSetId
        seatReferenceId
        discountInfo { discountPct discountTypeCode nonDiscountedOffersAvailable }
        promotionsInfo { promotionalCode promotionalPct }
        discountInEligibilityList { code reason }
      }
      offerSetBadges { brandId }
      offers {
        offerId
        additionalOfferProperties {
          offered
          offerPriorityNum
          fareType
          dominantSegmentBrandId
          priorityNum
          soldOut
          unavailableForSale
          refundable
          offerBadges { brandId }
          payWithMilesEligible
          discountAvailable
          travelPolicyStatus
          secondarySolutionRefIds
        }
        soldOut
        offerItems {
          retailItems {
            retailItemMetaData {
              fareInformation {
                solutionId
                ticketDesignatorCode
                brandByFlightLegs { brandId cosCode tripId product { brandId typeCode } }
                discountInEligibilityList { code reason }
                availableSeatCnt
                farePrice {
                  discountsApplied { pct code description reason amount { currencyEquivalentPrice { currencyAmt } milesEquivalentPrice { mileCnt discountMileCnt } } }
                  totalFarePrice {
                    currencyEquivalentPrice { roundedCurrencyAmt formattedCurrencyAmt }
                    milesEquivalentPrice { mileCnt cashPlusMilesCnt cashPlusMiles }
                  }
                  originalTotalPrice {
                    currencyEquivalentPrice { roundedCurrencyAmt formattedCurrencyAmt }
                    milesEquivalentPrice { mileCnt cashPlusMilesCnt cashPlusMiles }
                  }
                  promotionalPrices {
                    price {
                      currencyEquivalentPrice { roundedCurrencyAmt formattedCurrencyAmt }
                      milesEquivalentPrice { mileCnt cashPlusMilesCnt cashPlusMiles }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    offerDataList {
      responseProperties {
        discountInfo { discountPct discountTypeCode nonDiscountedOffersAvailable }
        promotionsInfo { promotionalCode promotionalPct }
        discountInEligibilityList { code reason }
        resultsPerRequestNum
        pageResultCnt
        resultsPageNum
        sortOptionsList { sortableOptionDesc sortableOptionId }
        tripTypeText
      }
      offerPreferences {
        stopCnt
        destinationAirportCode
        connectionTimeRange { maximumNum minimumNum }
        originAirportCode
        flightDurationRange { maximumNum minimumNum }
        layoverAirportCode
        totalMilesRange { maximumNum minimumNum }
        totalPriceRange { maximumNum minimumNum }
      }
      retailItemDefinitionList { brandType retailItemBrandId refundable retailItemPriorityText }
      pricingOptions { pricingOptionDetail { currencyCode } }
    }
    gqlSelectedOfferSets {
      trips {
        tripId
        scheduledDepartureLocalTs
        scheduledArrivalLocalTs
        originAirportCode
        destinationAirportCode
        stopCnt
        flightSegment {
          destinationAirportCode
          marketingCarrier { carrierCode carrierNum }
          operatingCarrier { carrierCode carrierNum }
          flightSegmentNum
          originAirportCode
          scheduledArrivalLocalTs
          scheduledDepartureLocalTs
          aircraft { fleetTypeCode subFleetTypeCode newSubFleetType }
          flightLeg {
            destinationAirportCode
            feeRestricted
            layover {
              destinationAirportCode
              layoverAirportCode
              layoverDuration { hourCnt minuteCnt }
              departureFlightNum
              equipmentChange
              originAirportCode
              scheduledArrivalLocalTs
              scheduledDepartureLocalTs
            }
            operatedByOwnerCarrier
            redEye
            operatingCarrier { carrierCode carrierName }
            marketingCarrier { carrierCode carrierName }
            earnLoyaltyMiles
            loyaltyMemberBenefits
            dominantLeg
            duration { dayCnt hourCnt minuteCnt }
            originAirport { airportTerminals { terminalId } }
            destinationAirport { airportTerminals { terminalId } }
            originAirportCode
            aircraft { fleetTypeCode subFleetTypeCode newSubFleetType }
            carrierCode
            distance { unitOfMeasure unitOfMeasureCnt }
            scheduledArrivalLocalTs
            scheduledDepartureLocalTs
            dayChange
            legId
          }
        }
        totalTripTime { dayCnt hourCnt minuteCnt }
      }
      offers {
        additionalOfferProperties { dominantSegmentBrandId fareType }
        soldOut
        offerItems {
          retailItems {
            retailItemMetaData {
              fareInformation { brandByFlightLegs { tripId brandId cosCode } }
            }
          }
        }
      }
      additionalOfferSetProperties { seatReferenceId }
    }
  }
}`;

    const variables = {
      offerSearchCriteria: {
        productGroups: [{ productCategoryCode: 'FLIGHTS' }],
        offersCriteria: {
          resultsPageNum: 1,
          resultsPerRequestNum: 20,
          preferences: {
            refundableOnly: false,
            showGlobalRegionalUpgradeCertificate: true,
            nonStopOnly: false
          },
          pricingCriteria: { priceableIn: ['MILES'] },
          flightRequestCriteria: {
            currentTripIndexId: '0',
            sortableOptionId: null,
            selectedOfferId: '',
            searchOriginDestination: [
              {
                departureLocalTs: `${depart}T00:00:00`,
                destinations: [{ airportCode: to }],
                origins: [{ airportCode: from }]
              }
            ],
            sortByBrandId: 'BE',
            additionalCriteriaMap: { rollOutTag: 'GBB' }
          }
        },
        customers: [{ passengerTypeCode: 'ADT', passengerId: '1' }]
      }
    };

    const url = 'https://offer-api-prd.delta.com/prd/rm-offer-gql';
    let transactionId = transactionIdOverride || FIXED_TRANSACTION_ID;
    const baseHeaders = {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'airline': 'DL',
      'applicationid': 'DC',
      'authorization': 'GUEST',
      'channelid': 'DCOM',
      'content-type': 'application/json',
      'origin': 'https://www.delta.com',
      'priority': 'u=1, i',
      'referer': 'https://www.delta.com/',
      'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
      'x-app-type': 'shop-mach'
    };

    // Use provided cookie or get from session pool
    if (cookie) {
      baseHeaders['Cookie'] = cookie;
    } else {
      const session = await sessionPool.getSession();
      if (session) {
        baseHeaders['Cookie'] = session.cookie;
      }
    }

    // If caller provides a raw GraphQL query/variables, forward exactly; otherwise use our builder
    const outgoingQuery = req.body && req.body.query ? req.body.query : gqlQuery;
    const outgoingVariables = req.body && req.body.variables ? req.body.variables : variables;
    const outgoingPayload = { query: outgoingQuery, variables: outgoingVariables };

    // Strategy: Use browser execution with session pooling for high-volume requests
    const maxAttempts = 3;
    let attempt = 0;
    let lastStatus = 0;
    let lastText = '';

    while (attempt < maxAttempts) {
      const headers = { ...baseHeaders, transactionid: transactionId };
      
      // Use browser execution with session pooling
      console.log(`[delta] Attempt ${attempt + 1}/${maxAttempts}: Using browser execution with session pooling`);
      
      const browserResp = await executeInBrowser(url, headers, outgoingPayload);
      
      if (browserResp.ok) {
        return res.status(200).json(await browserResp.json());
      }

      lastStatus = browserResp.status;
      lastText = await browserResp.text();
      
      if (browserResp.status !== 429 && browserResp.status < 500) {
        return res.status(browserResp.status).json({ error: 'Delta API error', status: browserResp.status, body: lastText });
      }

      // Handle 429 with progressive backoff
      if (browserResp.status === 429) {
        const baseDelay = Math.min((attempt + 1) * 2000, 10000);
        const jitter = Math.floor(Math.random() * 2000);
        const delayMs = baseDelay + jitter;
        
        console.log(`[delta] Attempt ${attempt + 1}/${maxAttempts}: Got 429, waiting ${delayMs}ms`);
        
        await sleep(delayMs);
        
        // Rotate transaction ID for next attempt
        transactionId = makeTransactionId();
      }
      
      attempt++;
    }

    return res.status(lastStatus || 502).json({ 
      error: 'Delta API error (all attempts exhausted)', 
      status: lastStatus || 502, 
      body: lastText,
      attempts: maxAttempts
    });

  } catch (err) {
    console.error('[delta] Service error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Add session pool status endpoint
app.get('/sessions', async (req, res) => {
  try {
    const sessionInfo = Array.from(sessionPool.sessions.values()).map(s => ({
      id: s.id,
      createdAt: new Date(s.createdAt).toISOString(),
      lastUsed: new Date(s.lastUsed).toISOString(),
      useCount: s.useCount,
      age: Math.floor((Date.now() - s.createdAt) / 1000)
    }));
    
    res.json({
      poolSize: sessionPool.sessions.size,
      maxSize: SESSION_POOL_SIZE,
      sessions: sessionInfo,
      valkey: valkey ? 'connected' : 'not available'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(4005, () => console.log('Delta microservice running on port 4005 with Valkey session pooling'));

// Add a simple test endpoint
app.get('/test', (req, res) => {
  res.json({ message: 'Delta service is working!', timestamp: new Date().toISOString() });
});


