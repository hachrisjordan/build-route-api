/**
 * Browser-like headers for AmEx hotel offers API requests.
 * Reduces 403 rate by mimicking real Chrome traffic.
 */

const AMEX_BROWSER_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  Origin: 'https://www.americanexpress.com',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  Referer: 'https://www.americanexpress.com/en-US/rewards-benefits/travel/hotels/',
  'Sec-Ch-Ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
  'Sec-Ch-Ua-Full-Version-List':
    '"Not(A:Brand";v="8.0.0.0", "Chromium";v="144.0.7295.109", "Google Chrome";v="144.0.7295.109"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
} as const;

/**
 * Returns headers for AmEx API requests. Optionally includes Cookie from AMEX_COOKIE env.
 */
export function getAmExBrowserHeaders(): Record<string, string> {
  const headers = { ...AMEX_BROWSER_HEADERS };
  const cookie = process.env.AMEX_COOKIE;
  if (cookie) {
    headers['Cookie'] = cookie;
  }
  return headers;
}
