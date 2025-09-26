import { NextRequest } from 'next/server';
import { smartRateLimit } from '@/lib/smart-rate-limiter';
import { RateLimitError } from '@/lib/http/errors';

export async function enforceRateLimit(req: NextRequest, payload: unknown) {
  const result = await smartRateLimit(req, payload);
  if (!result.allowed) {
    throw new RateLimitError(result.reason || 'Rate limit exceeded', result.retryAfter ? { retryAfter: result.retryAfter } : undefined);
  }
  return result;
}


