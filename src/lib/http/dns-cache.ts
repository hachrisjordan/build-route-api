/**
 * DNS Caching and Network Optimization
 * 
 * Improves production performance by caching DNS lookups and optimizing network settings
 */

// Simple in-memory DNS cache (TTL: 5 minutes)
const dnsCache = new Map<string, { address: string; expires: number }>();
const DNS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Initialize DNS caching for better production performance
 * This reduces DNS lookup overhead which can add 50-200ms per request
 */
export function initializeDnsCache() {
  if (typeof process === 'undefined' || process.env.NODE_ENV !== 'production') {
    return; // Only enable in production
  }

  try {
    const dns = require('dns');
    
    // Use custom lookup function with caching
    const originalLookup = dns.lookup;
    
    dns.lookup = function(hostname: string, options: any, callback?: any) {
      // Handle both callback and promise styles
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      
      const cacheKey = `${hostname}:${options?.family || 4}`;
      const cached = dnsCache.get(cacheKey);
      
      if (cached && cached.expires > Date.now()) {
        // Return cached result
        if (callback) {
          return callback(null, cached.address, options?.family || 4);
        }
        return Promise.resolve({ address: cached.address, family: options?.family || 4 });
      }
      
      // Call original lookup
      const wrappedCallback = callback 
        ? (err: any, address: string, family: number) => {
            if (!err && address) {
              dnsCache.set(cacheKey, {
                address,
                expires: Date.now() + DNS_CACHE_TTL,
              });
            }
            callback(err, address, family);
          }
        : undefined;
      
      const result = originalLookup.call(dns, hostname, options, wrappedCallback);
      
      if (!callback && result && typeof result.then === 'function') {
        // Promise-based
        return result.then((res: { address: string; family: number }) => {
          if (res && res.address) {
            dnsCache.set(cacheKey, {
              address: res.address,
              expires: Date.now() + DNS_CACHE_TTL,
            });
          }
          return res;
        });
      }
      
      return result;
    };
    
    console.log('[dns-cache] DNS caching enabled for production');
  } catch (error) {
    console.warn('[dns-cache] Failed to initialize DNS cache:', error);
  }
}

/**
 * Clear DNS cache (useful for testing or when DNS changes)
 */
export function clearDnsCache() {
  dnsCache.clear();
}

/**
 * Get cache stats (for monitoring)
 */
export function getDnsCacheStats() {
  return {
    size: dnsCache.size,
    entries: Array.from(dnsCache.entries()).map(([key, value]) => ({
      key,
      address: value.address,
      expiresIn: Math.max(0, value.expires - Date.now()),
    })),
  };
}

