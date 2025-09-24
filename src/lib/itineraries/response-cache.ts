import { cacheItineraries } from '@/lib/cache';

export async function cacheFullResponse(cacheKey: string, {
  itineraries,
  flights,
  minRateLimitRemaining,
  minRateLimitReset,
  totalSeatsAeroHttpRequests,
}: {
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Record<string, any>,
  minRateLimitRemaining: number | null,
  minRateLimitReset: number | null,
  totalSeatsAeroHttpRequests: number,
}) {
  const responseObj = {
    itineraries,
    flights,
    minRateLimitRemaining,
    minRateLimitReset,
    totalSeatsAeroHttpRequests,
  };
  await cacheItineraries(cacheKey, responseObj);
  return responseObj;
}


