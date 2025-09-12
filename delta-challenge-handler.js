#!/usr/bin/env node

/**
 * Delta Challenge Handler - Handle 429 challenge responses with retry logic
 */

const fetch = require('node-fetch');

const DELTA_SERVICE_URL = 'http://localhost:4005/delta';

// User agents to rotate
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0'
];

// Request headers to rotate
const HEADER_SETS = [
  {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site'
  },
  {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site'
  },
  {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site'
  }
];

/**
 * Get random user agent and headers
 */
function getRandomHeaders() {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const headerSet = HEADER_SETS[Math.floor(Math.random() * HEADER_SETS.length)];
  
  return {
    'user-agent': userAgent,
    ...headerSet
  };
}

/**
 * Check if response is a challenge
 */
function isChallengeResponse(response, responseText) {
  return response.status === 429 && responseText.includes('cpr_chlge');
}

/**
 * Extract challenge data
 */
function extractChallengeData(responseText) {
  try {
    const parsed = JSON.parse(responseText);
    if (parsed.body) {
      const bodyParsed = JSON.parse(parsed.body);
      return {
        challenge: bodyParsed.cpr_chlge === 'true',
        timestamp: bodyParsed.t
      };
    }
  } catch (e) {
    // Ignore parsing errors
  }
  return null;
}

/**
 * Make Delta request with challenge handling
 */
async function makeDeltaRequestWithChallengeHandling(from, to, depart, maxRetries = 5) {
  const requestId = `${from}-${to}-${depart}-${Date.now()}`;
  let attempt = 1;
  
  console.log(`[${requestId}] Starting request (${from} → ${to} on ${depart})`);
  
  while (attempt <= maxRetries) {
    const startTime = Date.now();
    
    try {
      // Get random headers for this attempt
      const randomHeaders = getRandomHeaders();
      
      // Generate unique transaction ID
      const transactionId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const response = await fetch(DELTA_SERVICE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': requestId,
          'X-Attempt': attempt.toString(),
          'X-Transaction-ID': transactionId,
          ...randomHeaders
        },
        body: JSON.stringify({
          from,
          to,
          depart,
          ADT: 1,
          debugInfo: {
            requestId,
            attempt,
            timestamp: new Date().toISOString(),
            userAgent: randomHeaders['user-agent']
          }
        }),
        timeout: 30000
      });
      
      const responseTime = Date.now() - startTime;
      const responseText = await response.text();
      
      if (response.ok) {
        console.log(`✅ [${requestId}] SUCCESS (Attempt ${attempt}, ${responseTime}ms) - Status: ${response.status}`);
        return {
          requestId,
          success: true,
          status: response.status,
          responseTime,
          attempt,
          timestamp: new Date().toISOString(),
          data: JSON.parse(responseText)
        };
      }
      
      if (isChallengeResponse(response, responseText)) {
        const challengeData = extractChallengeData(responseText);
        console.log(`🚫 [${requestId}] CHALLENGE (Attempt ${attempt}, ${responseTime}ms) - Status: ${response.status}`);
        
        if (challengeData) {
          console.log(`   Challenge timestamp: ${challengeData.timestamp}`);
        }
        
        if (attempt < maxRetries) {
          // Exponential backoff with jitter
          const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          const jitter = Math.random() * 1000;
          const delay = baseDelay + jitter;
          
          console.log(`   ⏳ Retrying in ${Math.round(delay)}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          
          attempt++;
          continue;
        } else {
          console.log(`   💀 Max retries exceeded for ${requestId}`);
          return {
            requestId,
            success: false,
            status: response.status,
            responseTime,
            attempt,
            error: 'Challenge not resolved after max retries',
            challengeData,
            timestamp: new Date().toISOString()
          };
        }
      } else {
        console.log(`❌ [${requestId}] ERROR (Attempt ${attempt}, ${responseTime}ms) - Status: ${response.status}`);
        return {
          requestId,
          success: false,
          status: response.status,
          responseTime,
          attempt,
          error: 'Non-challenge error',
          responseText: responseText.substring(0, 200),
          timestamp: new Date().toISOString()
        };
      }
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      console.log(`💥 [${requestId}] NETWORK ERROR (Attempt ${attempt}, ${responseTime}ms) - ${error.message}`);
      
      if (attempt < maxRetries) {
        const delay = 1000 * attempt;
        console.log(`   ⏳ Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
        continue;
      } else {
        return {
          requestId,
          success: false,
          status: 0,
          responseTime,
          attempt,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    }
  }
}

/**
 * Test challenge handling with multiple requests
 */
async function testChallengeHandling() {
  console.log('🧪 Testing Delta Challenge Handling');
  console.log('═'.repeat(60));
  
  const testRequests = [
    { from: 'JFK', to: 'LAX', depart: '2025-09-09' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-10' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-11' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-12' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-13' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-14' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-15' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-16' }
  ];
  
  const results = [];
  
  for (let i = 0; i < testRequests.length; i++) {
    const request = testRequests[i];
    console.log(`\n--- Request ${i + 1}/${testRequests.length} ---`);
    
    const result = await makeDeltaRequestWithChallengeHandling(
      request.from, 
      request.to, 
      request.depart, 
      5 // Max 5 retries
    );
    
    results.push(result);
    
    // Small delay between requests to avoid overwhelming
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Analysis
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const challengeFailures = results.filter(r => !r.success && r.challengeData);
  
  console.log('\n' + '═'.repeat(60));
  console.log('📊 CHALLENGE HANDLING RESULTS');
  console.log('═'.repeat(60));
  console.log(`Total Requests: ${results.length}`);
  console.log(`Successful: ${successful.length} (${Math.round((successful.length / results.length) * 100)}%)`);
  console.log(`Failed: ${failed.length} (${Math.round((failed.length / results.length) * 100)}%)`);
  console.log(`Challenge Failures: ${challengeFailures.length}`);
  
  const avgAttempts = results.reduce((sum, r) => sum + r.attempt, 0) / results.length;
  console.log(`Average Attempts per Request: ${avgAttempts.toFixed(2)}`);
  
  const successfulAfterRetry = results.filter(r => r.success && r.attempt > 1);
  console.log(`Successful after retry: ${successfulAfterRetry.length}`);
  
  if (challengeFailures.length > 0) {
    console.log('\n🚫 CHALLENGE FAILURES:');
    challengeFailures.forEach(failure => {
      console.log(`   ${failure.requestId}: ${failure.error}`);
    });
  }
  
  return results;
}

// Main execution
async function main() {
  try {
    await testChallengeHandling();
  } catch (error) {
    console.error('💥 Test failed:', error.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = { 
  makeDeltaRequestWithChallengeHandling, 
  isChallengeResponse, 
  extractChallengeData,
  getRandomHeaders
};
