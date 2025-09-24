import type { AvailabilityFlight } from '@/types/availability';
import { createHash } from 'crypto';

const uuidCache = new Map<string, string>();

export function getFlightUUID(flight: AvailabilityFlight): string {
  const key = `${flight.FlightNumbers}|${flight.DepartsAt}|${flight.ArrivesAt}`;
  let uuid = uuidCache.get(key);
  if (uuid) return uuid;
  uuid = createHash('sha1').update(key).digest('hex');
  uuidCache.set(key, uuid);
  if (uuidCache.size > 50000) {
    const keysToDelete = Array.from(uuidCache.keys()).slice(0, 5000);
    keysToDelete.forEach(k => uuidCache.delete(k));
  }
  return uuid;
}
