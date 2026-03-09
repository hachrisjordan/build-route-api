#!/usr/bin/env node

require('dotenv').config();

// Reuse the main cron implementation with test-only options
const { runCronJob } = require('./amex-hotel-offers-cron');

async function main() {
  const nightsValues = [1, 2, 3, 4, 5];

  try {
    for (const nights of nightsValues) {
      console.log(
        `[TEST-CRON] Starting single-chunk test run for nights=${nights} (no purge, no hotel update)...`
      );
      await runCronJob(nights, {
        skipPurge: true,
        maxChunks: 1,
        skipHotelUpdate: true,
      });
      console.log(
        `[TEST-CRON] Finished single-chunk test run for nights=${nights} (cache only, table untouched).`
      );
    }

    console.log('[TEST-CRON] All nights test runs completed.');
    process.exit(0);
  } catch (error) {
    console.error('[TEST-CRON] Test job failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

