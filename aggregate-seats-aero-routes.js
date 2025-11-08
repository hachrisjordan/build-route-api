require('dotenv').config();
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

/**
 * Script to aggregate routes from seats.aero API across all sources using browser automation
 * Outputs CSV with origin, destination, and count of occurrences
 */

// All available sources
const SOURCES = [
  'eurobonus',
  'virginatlantic',
  'aeromexico',
  'american',
  'delta',
  'etihad',
  'united',
  'emirates',
  'aeroplan',
  'alaska',
  'velocity',
  'qantas',
  'connectmiles',
  'azul',
  'smiles',
  'flyingblue',
  'jetblue',
  'qatar',
  'turkish',
  'singapore',
  'ethiopian',
  'saudia',
  'finnair',
  'lufthansa'
];

// Optional: Cookie string to inject (if provided)
const COOKIE_STRING = process.env.SEATS_AERO_COOKIE || 'bm_sz=2xIbcexjkeBn5knE2Ouut7xreqp; _ga=GA1.1.513666597.1747628618; _gcl_au=1.1.62539559.1755704927; cf_clearance=qScPZcUktMmeuTTYggfkk__ZR36r4g7tnUZE7d4UUaw-1761258218-1.2.1.1-5F5DtRakRLFs2VqaTH5R7glUfXUnOF0MCrgkoRdX2fmfApiEwEgYMia_chrmuIv167oM3cvvFq1CApwHxe3HRLAQng9cPPqJix5DPihD1Wwve_UJlY05dI2O5SXQGpWf_y3xZ4S8nOj_RAh3yD2if6W6YcrgTgodF25EwfqcPxE5fjzUJMd1e4t08EPjCaJKztvLm70G_Y9oSbbogEJEw1UW7l2RiKSWLo7Dpt32.iE; g_state={"i_l":0,"i_ll":1761886237082,"i_b":"jhk7ATeuuKi6dQItfabuKIkTVIj7YuccVIs4m2yakQo"}; __ss_sid=349993ea-4159-4099-ac80-73f27fb97a07; __ss_sid_age=1761886241; __Host-session=34oiHzWhNhe1fhrjjYRRz8txl6S; __Host-session-seamless=34oiHzWhNhe1fhrjjYRRz8txl6S; _ga_QXH2YQTEW3=GS2.1.s1762291285$o184$g1$t1762291508$j54$l0$h0; _abck=ejg-XPpY65bNTz364QnedEy5AY12Z3K7IIJppBYvHgEFw3Tr0TYgjq8K4kcm1ggcCKcYk8F1mhgQ7vrlHpO6xr89ChAsf2lvJNNfOm44t0E61vBXyUPx2wbt5XjO42YVuYL946hx9weDplo5bxOjdVc82LC4XyKf52SdKGBFqch73uEoISWnXE-Db2QFSkZQmQEYgD3KvMahJiM55Sc_TE7sTHVScbrrncHQhf8gEdOIyCjTFXPeTaguqPDHaSNyozFqm17Q_QqqRk1r6SfStWfUgZXQodicQ_q8fyw8a0VV9t-6KaT6K5NzusMCrP2vovEW5APznD_uPalKtYOmTDRDzKSpH0cBecKyjp_15xgrtE1ucFZ-4k4Z-_Sel8KH-CPAR-b7ZC0GVEkI_gzD8A; __cf_bm=QZSH6nwTegZ.2BzrZ.NinZtG7CYkAZ_630yM55Gho0Y-1762292061.6484325-1.0.1.1-FrhirnPB4oy2N.vMvUL7PgGhooACnhBb4qj7uvLbqT_PMwjWtXPt8aryeHbOBCwSdCR_nJtjbpOVCw2wduzGEapjnFyVvn9URmhYwwXbGRhP0OcmmaEqvmmcaIT4HjDT';

/**
 * Load city groups from Supabase
 * Returns maps for airport-to-city and city-to-airports mappings
 */
async function loadCityGroups() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('⚠️  Supabase credentials not found. City group aggregation will be skipped.');
    console.warn('   Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env');
    return {
      airportToCity: new Map(),
      cityToAirports: new Map(),
      loaded: false
    };
  }

  try {
    console.log('Loading city groups from Supabase...');
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from('city_groups')
      .select('city_code, city_name, airports');

    if (error) {
      throw new Error(`Failed to fetch city_groups: ${error.message}`);
    }

    if (!data || data.length === 0) {
      console.warn('⚠️  No city_groups data found in database');
      return {
        airportToCity: new Map(),
        cityToAirports: new Map(),
        loaded: false
      };
    }

    // Initialize maps
    const airportToCity = new Map();
    const cityToAirports = new Map();

    // Process each city group
    for (const row of data) {
      const cityCode = row.city_code;
      const airports = row.airports || [];

      if (cityCode && airports.length > 0) {
        cityToAirports.set(cityCode, airports);
        
        // Map each airport to its city
        for (const airport of airports) {
          airportToCity.set(airport, cityCode);
        }
      }
    }

    console.log(`✅ Loaded ${cityToAirports.size} city groups with ${airportToCity.size} airports`);
    
    return {
      airportToCity,
      cityToAirports,
      loaded: true
    };
  } catch (error) {
    console.error('❌ Failed to load city groups:', error.message);
    console.warn('   Continuing with airport-to-airport aggregation only');
    return {
      airportToCity: new Map(),
      cityToAirports: new Map(),
      loaded: false
    };
  }
}

/**
 * Get city code for an airport
 * Returns the airport code itself if not in any city group
 */
function getAirportCityCode(airportCode, airportToCity) {
  return airportToCity.get(airportCode) || airportCode;
}

/**
 * Check if a code is a city code (multi-airport city)
 */
function isCityCode(code, cityToAirports) {
  const airports = cityToAirports.get(code);
  return airports && airports.length > 1;
}

/**
 * Parse cookie string into Playwright cookie format
 */
function parseCookies(cookieString) {
  if (!cookieString) return [];
  
  const cookies = [];
  const parts = cookieString.split(';').map(c => c.trim());
  
  for (const part of parts) {
    const [name, ...valueParts] = part.split('=');
    if (!name || valueParts.length === 0) continue;
    
    const cookieName = name.trim();
    const cookieValue = valueParts.join('=').trim();
    
    // Skip empty values
    if (!cookieValue) continue;
    
    // Skip __Host- cookies as they have special requirements that conflict with Playwright
    // The browser will establish its own session anyway
    if (cookieName.startsWith('__Host-')) {
      continue;
    }
    
    // Build cookie object
    const cookie = {
      name: cookieName,
      value: cookieValue,
      domain: 'seats.aero', // Use exact domain
      path: '/',
      secure: true,
    };
    
    // Set httpOnly for session cookies
    if (cookieName.startsWith('__ss_')) {
      cookie.httpOnly = true;
    }
    
    // Validate and add cookie
    if (cookie.name && cookie.value && cookie.domain && cookie.path) {
      cookies.push(cookie);
    }
  }
  
  return cookies;
}

/**
 * Fetch routes for a given source using browser
 */
async function fetchRoutesForSource(page, source) {
  const url = `https://seats.aero/_api/routes_new?source=${source}`;
  
  console.log(`Fetching routes for source: ${source}...`);
  
  try {
    // Use page.evaluate to make fetch request in browser context
    const response = await page.evaluate(async (apiUrl) => {
      try {
        const res = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'accept': 'application/json',
          },
        });
        
        const status = res.status;
        const data = await res.json();
        
        return {
          status,
          data,
          error: null,
        };
      } catch (error) {
        return {
          status: 0,
          data: null,
          error: error.message,
        };
      }
    }, url);

    if (response.status === 403) {
      console.error(`  ⚠️  Got 403 for ${source}, skipping...`);
      return [];
    }

    if (response.status === 429) {
      const waitTime = 5000;
      console.log(`  ⏳ Rate limited for ${source}, waiting ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return fetchRoutesForSource(page, source); // Retry
    }

    if (response.status !== 200 || response.error) {
      console.error(`  ❌ Error fetching ${source}: ${response.status} ${response.error || 'Unknown error'}`);
      return [];
    }

    const data = response.data;
    
    if (!Array.isArray(data)) {
      console.error(`  ⚠️  Unexpected response format for ${source}`);
      return [];
    }

    console.log(`  ✅ Fetched ${data.length} routes for ${source}`);
    return data;
  } catch (error) {
    console.error(`  ❌ Exception fetching ${source}:`, error.message);
    return [];
  }
}

/**
 * Aggregate routes by origin-destination pairs
 * Includes three types: airport-to-airport, airport-to-city, and city-to-city
 */
function aggregateRoutes(allRoutes, cityGroups) {
  const { airportToCity, cityToAirports, loaded } = cityGroups;
  const routeMap = new Map();

  // Step 1: Aggregate airport-to-airport routes (always included)
  for (const route of allRoutes) {
    const origin = route.originCode;
    const destination = route.destinationCode;

    if (!origin || !destination) {
      continue;
    }

    // Airport-to-airport route
    const airportKey = `${origin},${destination}`;
    const currentCount = routeMap.get(airportKey) || 0;
    routeMap.set(airportKey, currentCount + 1);
  }

  if (!loaded) {
    // If city groups not loaded, return only airport-to-airport routes
    return routeMap;
  }

  // Step 2: Aggregate airport-to-city routes
  // For each origin airport, group destination airports by city
  const airportToCityMap = new Map(); // key: "originAirport,cityCode" -> count

  for (const route of allRoutes) {
    const origin = route.originCode;
    const destination = route.destinationCode;

    if (!origin || !destination) {
      continue;
    }

    const destinationCity = getAirportCityCode(destination, airportToCity);
    
    // Only create airport-to-city entry if destination is part of a multi-airport city
    if (isCityCode(destinationCity, cityToAirports) && destinationCity !== destination) {
      const key = `${origin},${destinationCity}`;
      const currentCount = airportToCityMap.get(key) || 0;
      airportToCityMap.set(key, currentCount + 1);
    }
  }

  // Add airport-to-city routes to main map
  for (const [key, count] of airportToCityMap.entries()) {
    routeMap.set(key, count);
  }

  // Step 3: Aggregate city-to-city routes
  // For routes between cities, aggregate all airport pairs
  const cityToCityMap = new Map(); // key: "originCity,destinationCity" -> count

  for (const route of allRoutes) {
    const origin = route.originCode;
    const destination = route.destinationCode;

    if (!origin || !destination) {
      continue;
    }

    const originCity = getAirportCityCode(origin, airportToCity);
    const destinationCity = getAirportCityCode(destination, airportToCity);

    // Only create city-to-city entry if both are multi-airport cities
    const originIsCity = isCityCode(originCity, cityToAirports);
    const destIsCity = isCityCode(destinationCity, cityToAirports);

    if (originIsCity && destIsCity) {
      const key = `${originCity},${destinationCity}`;
      const currentCount = cityToCityMap.get(key) || 0;
      cityToCityMap.set(key, currentCount + 1);
    }
  }

  // Add city-to-city routes to main map
  for (const [key, count] of cityToCityMap.entries()) {
    routeMap.set(key, count);
  }

  return routeMap;
}

/**
 * Generate CSV content
 */
function generateCSV(routeMap) {
  const lines = ['origin,destination,count'];
  
  // Sort by count (descending), then by origin, then by destination
  const sortedRoutes = Array.from(routeMap.entries())
    .map(([key, count]) => {
      const [origin, destination] = key.split(',');
      return { origin, destination, count };
    })
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      if (a.origin !== b.origin) {
        return a.origin.localeCompare(b.origin);
      }
      return a.destination.localeCompare(b.destination);
    });

  for (const route of sortedRoutes) {
    lines.push(`${route.origin},${route.destination},${route.count}`);
  }

  return lines.join('\n');
}

/**
 * Main execution function
 */
async function main() {
  console.log('Starting aggregation of seats.aero routes using browser automation...\n');
  
  let browser;
  let context;
  let page;

  try {
    // Launch browser
    console.log('Launching browser...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });

    // Create context with cookies if provided
    const cookies = parseCookies(COOKIE_STRING);
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    if (cookies.length > 0) {
      try {
        await context.addCookies(cookies);
        console.log(`Injected ${cookies.length} cookies`);
      } catch (error) {
        console.warn(`Warning: Failed to inject some cookies: ${error.message}`);
        console.log('Continuing without cookies - browser will establish its own session');
      }
    }

    // Navigate to seats.aero first to establish session
    console.log('Establishing session with seats.aero...');
    page = await context.newPage();
    await page.goto('https://seats.aero/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000); // Wait for any JS to run
    
    console.log('Session established\n');

    // Load city groups before fetching routes
    const cityGroups = await loadCityGroups();
    console.log('');

    console.log('Starting to fetch routes...\n');

    const allRoutes = [];
    const sourceStats = {};

    // Fetch routes for each source
    for (let i = 0; i < SOURCES.length; i++) {
      const source = SOURCES[i];
      const routes = await fetchRoutesForSource(page, source);
      
      sourceStats[source] = routes.length;
      allRoutes.push(...routes);

      // Add a small delay between requests to avoid rate limiting
      if (i < SOURCES.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log('\n=== Fetch Summary ===');
    for (const [source, count] of Object.entries(sourceStats)) {
      console.log(`${source}: ${count} routes`);
    }
    console.log(`Total routes: ${allRoutes.length}\n`);

    // Aggregate routes
    console.log('Aggregating routes...');
    const routeMap = aggregateRoutes(allRoutes, cityGroups);
    
    if (cityGroups.loaded) {
      console.log(`Found ${routeMap.size} unique route pairs (airport-to-airport, airport-to-city, and city-to-city)`);
    } else {
      console.log(`Found ${routeMap.size} unique airport-to-airport pairs (city groups not loaded)`);
    }
    console.log('');

    // Generate CSV
    console.log('Generating CSV...');
    const csvContent = generateCSV(routeMap);

    // Write to file
    const outputDir = path.join(process.cwd(), 'csv-output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filepath = path.join(outputDir, 'route_count.csv');

    fs.writeFileSync(filepath, csvContent, 'utf-8');
    
    console.log(`✅ CSV written to: ${filepath}`);
    console.log(`\nTotal unique routes: ${routeMap.size}`);
    console.log(`Total route occurrences: ${allRoutes.length}`);
  } catch (error) {
    console.error('\n❌ Script failed:', error);
    throw error;
  } finally {
    // Cleanup
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// Run the script
main()
  .then(() => {
    console.log('\n✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
