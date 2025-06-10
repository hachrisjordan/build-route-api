import { chromium } from 'playwright';

/**
 * Fetches the full HTML content of a page using Playwright (headless Chromium).
 * @param url The URL to visit
 * @returns The HTML content of the page after scripts have run
 */
export async function getHtmlWithPlaywright(url: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  const html = await page.content();
  await browser.close();
  return html;
} 