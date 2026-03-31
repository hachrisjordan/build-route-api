/**
 * Browser-like headers for AmEx hotel offers API requests.
 * Reduces 403 rate by mimicking real Chrome traffic.
 *
 * This TS module mirrors src/lib/amex-api-headers.js so tsx scripts and Next.js
 * code paths share the same API shape (getAmExBrowserHeaders + getAmExHeaderMeta).
 */

const AMEX_HEADER_PRESET = process.env.AMEX_HEADER_PRESET || 'v1';
const AMEX_HEADER_VERSION = '2';

const AMEX_BROWSER_DEFAULTS = {
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

function buildAmExHeaders() {
  const headers: Record<string, string> = { ...AMEX_BROWSER_DEFAULTS };

  if (process.env.AMEX_USER_AGENT) {
    headers['User-Agent'] = process.env.AMEX_USER_AGENT;
  }
  if (process.env.AMEX_REFERER) {
    headers.Referer = process.env.AMEX_REFERER;
  }
  if (process.env.AMEX_ORIGIN) {
    headers.Origin = process.env.AMEX_ORIGIN;
  }
  if (process.env.AMEX_SEC_CH_UA) {
    headers['Sec-Ch-Ua'] = process.env.AMEX_SEC_CH_UA;
  }
  if (process.env.AMEX_SEC_CH_UA_FULL) {
    headers['Sec-Ch-Ua-Full-Version-List'] = process.env.AMEX_SEC_CH_UA_FULL;
  }
  if (process.env.AMEX_SEC_CH_UA_PLATFORM) {
    headers['Sec-Ch-Ua-Platform'] = process.env.AMEX_SEC_CH_UA_PLATFORM;
  }

  const cookie = process.env.AMEX_COOKIE;
  if (cookie) {
    headers.Cookie = cookie;
  } else if (process.env.NODE_ENV === 'production') {
    console.warn('[AmEx] AMEX_COOKIE is not set in production environment – requests may be rejected with 403');
  }

  return {
    headers,
    headerPreset: AMEX_HEADER_PRESET,
    headerVersion: AMEX_HEADER_VERSION,
  };
}

/**
 * Returns headers for AmEx API requests. Optionally includes Cookie from AMEX_COOKIE env.
 */
export function getAmExBrowserHeaders(): Record<string, string> {
  return buildAmExHeaders().headers;
}

/**
 * Returns headers plus metadata (preset + version) for logging / observability.
 */
export function getAmExHeaderMeta() {
  return buildAmExHeaders();
}
