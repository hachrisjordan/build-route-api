import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { saveCompressedJson } from '@/lib/redis/client';
import { RateLimitInfo, AvailabilityV2Response, ResponseBuilderOptions, PricingEntry } from '@/types/availability-v2';

/**
 * Builds the final response with rate limit headers and Redis caching
 */
export function buildAvailabilityResponse(options: ResponseBuilderOptions): NextResponse {
  const {
    groupedResults,
    seatsAeroRequests,
    rateLimit,
    routeId,
    startDate,
    endDate,
    cabin,
    carriers,
    seats,
    united,
    startTime,
    pricingData
  } = options;

  // Forward rate limit headers captured from client pagination
  const rlRemaining: string | null = rateLimit?.remaining || null;
  const rlReset: string | null = rateLimit?.reset || null;
  const responsePayload: AvailabilityV2Response = { 
    groups: groupedResults, 
    seatsAeroRequests,
    ...(pricingData && { pricing: pricingData })
  };
  
  // Save compressed response to Redis (async, non-blocking)
  const redisStartTime = Date.now();
  const hash = createHash('sha256').update(JSON.stringify({ routeId, startDate, endDate, cabin, carriers, seats, united })).digest('hex');
  const redisKey = `availability-v2-response:${hash}`;
  const redisPromise = saveCompressedJson(redisKey, responsePayload, 1800);
  // Don't await Redis save to avoid blocking response
  redisPromise.then(() => {
    // Redis save completed
  }).catch(err => {
    console.error('Redis save error:', err);
  });
  
  const totalTime = Date.now() - startTime;
  // Total API request completed
  
  const nextRes = NextResponse.json(responsePayload);
  if (rlRemaining) nextRes.headers.set('x-ratelimit-remaining', rlRemaining);
  if (rlReset) nextRes.headers.set('x-ratelimit-reset', rlReset);
  
  return nextRes;
}
