import { runArkalis } from "./arkalis/arkalis.js"
import { writeFileSync, mkdirSync } from "fs"
import { join } from "path"

/**
 * Test Arkalis with United flight search, blocking unnecessary resources
 * Only allows essential API calls and core functionality
 */
async function testArkalisSimple() {
  // Dynamic query parameters for United
  const query = {
    origin: "HAN",
    destination: "CVG",
    departureDate: "2025-07-17"
  }

  // United booking search URL
  const searchUrl = `https://www.united.com/en/us/fsr/choose-flights?f=${query.origin}&t=${query.destination}&d=${query.departureDate}&tt=1&at=1&sc=7&px=1&taxng=1&newHP=True&clm=7&st=bestmatches&tqp=A`

  console.log(`Testing Arkalis with United flight search (optimized)...`)
  console.log(`Searching for flights from ${query.origin} to ${query.destination} on ${query.departureDate}`)
  console.log(`URL: ${searchUrl}`)

  try {
    const results = await runArkalis(
      async (arkalis) => {
        arkalis.goto(searchUrl)
        
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
        })

        if (waitForResult.name !== "success") {
          return { error: waitForResult.name }
        }

        // Get the raw response
        const rawResponse = JSON.parse(waitForResult.response?.body || '{}')
        
        // Calculate response size in bytes
        const responseSize = Buffer.byteLength(waitForResult.response?.body || '', 'utf8')
        
        // Get request stats for proxy sizing
        const stats = arkalis.stats()
        
        return rawResponse
      },
      {
        useProxy: true,
        browserDebug: false,
        showRequests: true,
        maxAttempts: 3
      },
      {
        name: "united-optimized-test",
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
      `united-optimized-${query.origin}-${query.destination}-${query.departureDate}`
    )

    if (results.result) {
      console.log(`✅ Success! Raw FetchFlights response retrieved`)
      
      // Create output directory
      const outputDir = join(process.cwd(), 'test-outputs')
      mkdirSync(outputDir, { recursive: true })
      
      // Save the raw response to a file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `united-response-${query.origin}-${query.destination}-${query.departureDate}-${timestamp}.json`
      const filepath = join(outputDir, filename)
      
      writeFileSync(filepath, JSON.stringify(results.result, null, 2))
      console.log(`📁 Raw response saved to: ${filepath}`)
      
      // Show a sample of the raw response (first 500 chars)
      const sampleResponse = JSON.stringify(results.result).substring(0, 500)
      console.log(`\n📄 Sample Response (first 500 chars):`)
      console.log(sampleResponse + (sampleResponse.length >= 500 ? '...' : ''))
      
    } else {
      console.log(`❌ No results returned`)
    }

  } catch (error) {
    console.error(`❌ Error:`, error)
  }
}

// Run the test
testArkalisSimple()
  .then(() => console.log(`\n✅ Test completed`))
  .catch((error) => console.error(`\n❌ Test failed:`, error)) 