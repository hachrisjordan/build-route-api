const fetch = require('node-fetch');

// Configuration
const CONCURRENT_CALLS = 15;
const NEXT_BASE_URL = process.env.NEXT_BASE_URL || process.env.BASE_URL || 'http://localhost:3000';
const API_URL = `${NEXT_BASE_URL.replace(/\/$/, '')}/api/live-search-dl`;
const DELTA_BASE_URL = process.env.DELTA_BASE_URL || 'http://localhost:4005';

// Test payload (adjust if needed)
const TEST_DATA = {
  from: 'LAX',
  to: 'SEA',
  depart: '2025-08-28',
  ADT: 1,
};

async function makeApiCall(callNumber) {
  const startTime = Date.now();
  try {
    console.log(`[${callNumber}] Starting API call to ${API_URL} ...`);
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_DATA),
    });

    const endTime = Date.now();
    const duration = endTime - startTime;

    if (response.ok) {
      const data = await response.json();
      const size = JSON.stringify(data).length;
      console.log(`[${callNumber}] ✅ SUCCESS (${duration}ms) - Size: ${size} chars`);
      return { success: true, duration, status: response.status, size };
    }

    const errorText = await response.text();
    console.log(`[${callNumber}] ❌ FAILED (${duration}ms) - Status: ${response.status} - Error: ${errorText}`);
    return { success: false, duration, status: response.status, error: errorText };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`[${callNumber}] 💥 EXCEPTION (${duration}ms) - Error: ${error.message}`);
    return { success: false, duration, error: error.message };
  }
}

async function checkSessionPool() {
  const url = `${DELTA_BASE_URL.replace(/\/$/, '')}/sessions`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();
    console.log('\n📊 SESSION POOL STATUS:');
    console.log(`   Pool Size: ${data.poolSize}/${data.maxSize}`);
    console.log(`   Redis: ${data.redis}`);
    if (Array.isArray(data.sessions) && data.sessions.length > 0) {
      console.log('   Active Sessions:');
      data.sessions.forEach((s, i) => {
        console.log(`     ${i + 1}. ID: ${String(s.id).slice(0, 8)}... | Use Count: ${s.useCount} | Age: ${s.age}s`);
      });
    }
  } catch (err) {
    console.log(`\n❌ Could not check session pool at ${url}: ${err.message}`);
  }
}

async function runConcurrentTest() {
  console.log(`🚀 Starting concurrent test against ${API_URL} with ${CONCURRENT_CALLS} requests...\n`);

  await checkSessionPool();

  const promises = [];
  for (let i = 1; i <= CONCURRENT_CALLS; i++) {
    promises.push(makeApiCall(i));
  }

  console.log(`\n🔥 Executing ${CONCURRENT_CALLS} concurrent requests...\n`);
  const startTime = Date.now();
  const results = await Promise.all(promises);
  const totalTime = Date.now() - startTime;

  const successful = results.filter((r) => r.success).length;
  const failed = results.length - successful;
  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
  const minDuration = Math.min(...results.map((r) => r.duration));
  const maxDuration = Math.max(...results.map((r) => r.duration));

  console.log('\n' + '='.repeat(60));
  console.log('📈 TEST RESULTS SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Calls: ${CONCURRENT_CALLS}`);
  console.log(`Successful: ${successful} ✅`);
  console.log(`Failed: ${failed} ❌`);
  console.log(`Success Rate: ${((successful / CONCURRENT_CALLS) * 100).toFixed(1)}%`);
  console.log(`Total Time: ${totalTime}ms`);
  console.log(`Average Response Time: ${avgDuration.toFixed(0)}ms`);
  console.log(`Fastest Response: ${minDuration}ms`);
  console.log(`Slowest Response: ${maxDuration}ms`);
  console.log(`Throughput: ${(CONCURRENT_CALLS / (totalTime / 1000)).toFixed(1)} requests/second`);

  await checkSessionPool();

  console.log('\n📋 INDIVIDUAL CALL RESULTS:');
  console.log('-'.repeat(60));
  results.forEach((result, index) => {
    const status = result.success ? '✅' : '❌';
    const info = result.success ? `Size: ${result.size} chars` : `Error: ${result.error || result.status}`;
    console.log(`${String(index + 1).padStart(2)}. ${status} ${result.duration}ms - ${info}`);
  });

  console.log('\n🎯 Test completed!');
}

if (require.main === module) {
  runConcurrentTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { runConcurrentTest, makeApiCall };


