/**
 * Browser-like headers for AmEx hotel offers API requests.
 * Reduces 403 rate by mimicking real Chrome traffic.
 *
 * Header values are:
 * - Backed by sensible Chrome defaults
 * - Overrideable via env so we can rotate fingerprints without code changes:
 *   - AMEX_USER_AGENT
 *   - AMEX_REFERER
 *   - AMEX_ORIGIN
 *   - AMEX_SEC_CH_UA
 *   - AMEX_SEC_CH_UA_FULL
 *   - AMEX_SEC_CH_UA_PLATFORM
 * - Cookie is NEVER hardcoded; it must come from AMEX_COOKIE.
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
};

function buildAmExHeaders() {
  const headers = { ...AMEX_BROWSER_DEFAULTS };

  // Env overrides for high-risk fingerprint fields
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
    // Guard clause: warn loudly in production when we are missing the browser cookie
    // This is a strong signal for persistent 403 from AmEx.
    // eslint-disable-next-line no-console
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
function getAmExBrowserHeaders() {
  return buildAmExHeaders().headers;
}

/**
 * Returns headers plus metadata (preset + version) for logging / observability.
 * Use this when you want to log which fingerprint configuration produced a given response.
 */
function getAmExHeaderMeta() {
  return buildAmExHeaders();
}

module.exports = { getAmExBrowserHeaders, getAmExHeaderMeta };
