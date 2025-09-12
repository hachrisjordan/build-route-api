#!/usr/bin/env node

/**
 * Delta Advanced Challenge Solver - Enhanced handling of 429 challenge responses
 */

const fetch = require('node-fetch');

const DELTA_SERVICE_URL = 'http://localhost:4005/delta';

// Enhanced user agents with more variety
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
];

// Different header combinations to try
const HEADER_STRATEGIES = [
  // Strategy 1: Standard Chrome
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
  // Strategy 2: Windows Chrome
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
  // Strategy 3: Linux Chrome
  {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site'
  },
  // Strategy 4: Safari
  {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site'
  },
  // Strategy 5: Firefox
  {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site'
  }
];

// Request delay strategies
const DELAY_STRATEGIES = [
  { base: 1000, max: 3000, jitter: 0.5 },  // Conservative
  { base: 2000, max: 5000, jitter: 0.3 },  // Moderate
  { base: 3000, max: 8000, jitter: 0.2 },  // Aggressive
  { base: 5000, max: 10000, jitter: 0.1 }  // Very conservative
];

/**
 * Get random user agent and headers for a strategy
 */
function getHeadersForStrategy(strategyIndex) {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const headerSet = HEADER_STRATEGIES[strategyIndex % HEADER_STRATEGIES.length];
  
  return {
    'user-agent': userAgent,
    ...headerSet
  };
}

/**
 * Calculate delay with strategy
 */
function calculateDelay(attempt, strategy) {
  const baseDelay = Math.min(strategy.base * Math.pow(1.5, attempt - 1), strategy.max);
  const jitter = Math.random() * strategy.jitter * baseDelay;
  return Math.floor(baseDelay + jitter);
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
 * Make Delta request with advanced challenge handling
 */
async function makeDeltaRequestWithAdvancedChallengeHandling(from, to, depart, options = {}) {
  const {
    maxRetries = 8,
    strategyIndex = 0,
    delayStrategy = 0
  } = options;
  
  const requestId = `${from}-${to}-${depart}-${Date.now()}`;
  let attempt = 1;
  let currentStrategy = strategyIndex;
  let currentDelayStrategy = delayStrategy;
  
  console.log(`[${requestId}] Starting advanced challenge handling (${from} → ${to} on ${depart})`);
  
  while (attempt <= maxRetries) {
    const startTime = Date.now();
    
    try {
      // Get headers for current strategy
      const headers = getHeadersForStrategy(currentStrategy);
      
      // Generate unique transaction ID
      const transactionId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const response = await fetch(DELTA_SERVICE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': requestId,
          'X-Attempt': attempt.toString(),
          'X-Strategy': currentStrategy.toString(),
          'X-Transaction-ID': transactionId,
          ...headers
        },
        body: JSON.stringify({
          from,
          to,
          depart,
          ADT: 1,
          debugInfo: {
            requestId,
            attempt,
            strategy: currentStrategy,
            delayStrategy: currentDelayStrategy,
            timestamp: new Date().toISOString(),
            userAgent: headers['user-agent']
          }
        }),
        timeout: 30000
      });
      
      const responseTime = Date.now() - startTime;
      const responseText = await response.text();
      
      if (response.ok) {
        console.log(`✅ [${requestId}] SUCCESS (Attempt ${attempt}, Strategy ${currentStrategy}, ${responseTime}ms) - Status: ${response.status}`);
        return {
          requestId,
          success: true,
          status: response.status,
          responseTime,
          attempt,
          strategy: currentStrategy,
          delayStrategy: currentDelayStrategy,
          timestamp: new Date().toISOString(),
          data: JSON.parse(responseText)
        };
      }
      
      if (isChallengeResponse(response, responseText)) {
        const challengeData = extractChallengeData(responseText);
        console.log(`🚫 [${requestId}] CHALLENGE (Attempt ${attempt}, Strategy ${currentStrategy}, ${responseTime}ms) - Status: ${response.status}`);
        
        if (challengeData) {
          console.log(`   Challenge timestamp: ${challengeData.timestamp}`);
        }
        
        if (attempt < maxRetries) {
          // Switch strategy every 2 attempts
          if (attempt % 2 === 0) {
            currentStrategy = (currentStrategy + 1) % HEADER_STRATEGIES.length;
            console.log(`   🔄 Switching to strategy ${currentStrategy}`);
          }
          
          // Switch delay strategy every 3 attempts
          if (attempt % 3 === 0) {
            currentDelayStrategy = (currentDelayStrategy + 1) % DELAY_STRATEGIES.length;
            console.log(`   ⏱️  Switching to delay strategy ${currentDelayStrategy}`);
          }
          
          // Calculate delay with current strategy
          const delay = calculateDelay(attempt, DELAY_STRATEGIES[currentDelayStrategy]);
          console.log(`   ⏳ Retrying in ${delay}ms...`);
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
            strategy: currentStrategy,
            delayStrategy: currentDelayStrategy,
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
          strategy: currentStrategy,
          delayStrategy: currentDelayStrategy,
          error: 'Non-challenge error',
          responseText: responseText.substring(0, 200),
          timestamp: new Date().toISOString()
        };
      }
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      console.log(`💥 [${requestId}] NETWORK ERROR (Attempt ${attempt}, ${responseTime}ms) - ${error.message}`);
      
      if (attempt < maxRetries) {
        const delay = calculateDelay(attempt, DELAY_STRATEGIES[currentDelayStrategy]);
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
          strategy: currentStrategy,
          delayStrategy: currentDelayStrategy,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    }
  }
}

/**
 * Test advanced challenge handling with multiple strategies
 */
async function testAdvancedChallengeHandling() {
  console.log('🧪 Testing Advanced Delta Challenge Handling');
  console.log('═'.repeat(70));
  
  const testRequests = [
    { from: 'JFK', to: 'LAX', depart: '2025-09-09' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-10' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-11' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-12' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-13' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-14' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-15' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-16' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-17' },
    { from: 'JFK', to: 'LAX', depart: '2025-09-18' }
  ];
  
  const results = [];
  
  for (let i = 0; i < testRequests.length; i++) {
    const request = testRequests[i];
    console.log(`\n--- Request ${i + 1}/${testRequests.length} ---`);
    
    // Try different strategies for different requests
    const strategyIndex = i % HEADER_STRATEGIES.length;
    const delayStrategy = i % DELAY_STRATEGIES.length;
    
    const result = await makeDeltaRequestWithAdvancedChallengeHandling(
      request.from, 
      request.to, 
      request.depart, 
      {
        maxRetries: 8,
        strategyIndex,
        delayStrategy
      }
    );
    
    results.push(result);
    
    // Longer delay between requests to avoid overwhelming
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  // Analysis
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const challengeFailures = results.filter(r => !r.success && r.challengeData);
  
  console.log('\n' + '═'.repeat(70));
  console.log('📊 ADVANCED CHALLENGE HANDLING RESULTS');
  console.log('═'.repeat(70));
  console.log(`Total Requests: ${results.length}`);
  console.log(`Successful: ${successful.length} (${Math.round((successful.length / results.length) * 100)}%)`);
  console.log(`Failed: ${failed.length} (${Math.round((failed.length / results.length) * 100)}%)`);
  console.log(`Challenge Failures: ${challengeFailures.length}`);
  
  const avgAttempts = results.reduce((sum, r) => sum + r.attempt, 0) / results.length;
  console.log(`Average Attempts per Request: ${avgAttempts.toFixed(2)}`);
  
  const successfulAfterRetry = results.filter(r => r.success && r.attempt > 1);
  console.log(`Successful after retry: ${successfulAfterRetry.length}`);
  
  // Strategy analysis
  const strategySuccess = {};
  results.forEach(r => {
    const strategy = r.strategy || 0;
    if (!strategySuccess[strategy]) {
      strategySuccess[strategy] = { total: 0, successful: 0 };
    }
    strategySuccess[strategy].total++;
    if (r.success) {
      strategySuccess[strategy].successful++;
    }
  });
  
  console.log('\n📊 STRATEGY ANALYSIS:');
  Object.entries(strategySuccess).forEach(([strategy, stats]) => {
    const successRate = Math.round((stats.successful / stats.total) * 100);
    console.log(`   Strategy ${strategy}: ${stats.successful}/${stats.total} (${successRate}%)`);
  });
  
  if (challengeFailures.length > 0) {
    console.log('\n🚫 CHALLENGE FAILURES:');
    challengeFailures.forEach(failure => {
      console.log(`   ${failure.requestId}: ${failure.error} (Strategy ${failure.strategy})`);
    });
  }
  
  return results;
}

// Main execution
async function main() {
  try {
    await testAdvancedChallengeHandling();
  } catch (error) {
    console.error('💥 Test failed:', error.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = { 
  makeDeltaRequestWithAdvancedChallengeHandling,
  testAdvancedChallengeHandling
};
