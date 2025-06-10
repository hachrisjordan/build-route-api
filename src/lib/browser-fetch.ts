import puppeteer from 'puppeteer';

export type PuppeteerFetchOptions = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  isJson?: boolean; // If true, parse response as JSON
  timeoutMs?: number;
};

/**
 * Fetch a URL using Puppeteer, returning HTML or JSON.
 * @param url The URL to fetch
 * @param options Fetch options (method, headers, body, isJson, timeoutMs)
 * @returns The response text or JSON, or throws on error
 */
export async function fetchWithPuppeteer(
  url: string,
  options: PuppeteerFetchOptions = {}
): Promise<string | any> {
  const {
    method = 'GET',
    headers = {},
    body,
    isJson = false,
    timeoutMs = 30000,
  } = options;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders(headers);
    let response;
    if (method === 'POST') {
      response = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: timeoutMs,
      });
      await page.evaluate(
        (body: string | undefined) => {
          fetch(window.location.href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
        },
        body
      );
    } else {
      response = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: timeoutMs,
      });
    }
    if (!response) throw new Error('No response from page.goto');
    if (isJson) {
      const content = await page.content();
      // Try to extract JSON from <pre> or <body>
      const jsonText = await page.evaluate(() => {
        const pre = document.querySelector('pre');
        if (pre) return pre.textContent;
        return document.body ? document.body.innerText : '';
      });
      return JSON.parse(jsonText || '');
    }
    return await page.content();
  } catch (err) {
    throw new Error(`Puppeteer fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser.close();
  }
} 