const { execSync } = require('child_process');
const fs = require('fs');

// Ensure Playwright browsers are installed
try {
  require('playwright').chromium.launch({ headless: true }).then(browser => browser.close());
} catch (e) {
  console.log('Playwright browsers not installed. Installing...');
  execSync('npx playwright install', { stdio: 'inherit' });
}

const { chromium } = require('playwright');

async function fetchAndSaveCookies() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://www.aa.com/booking/find-flights');
  await page.waitForTimeout(5000);
  const cookies = await context.cookies('https://www.aa.com');
  fs.writeFileSync('aa-cookies.json', JSON.stringify(cookies, null, 2));
  console.log(`[${new Date().toISOString()}] Refreshed cookies and saved to aa-cookies.json`);
  await browser.close();
}

(async () => {
  while (true) {
    try {
      await fetchAndSaveCookies();
    } catch (err) {
      console.error('Failed to fetch cookies:', err);
    }
    // Wait 10 minutes
    await new Promise(res => setTimeout(res, 10 * 60 * 1000));
  }
})(); 