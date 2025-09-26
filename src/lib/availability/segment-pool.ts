import type { AvailabilityGroup } from '@/types/availability';

export function buildSegmentPool(availabilityResults: Array<{ error: boolean; data: any }>): Record<string, AvailabilityGroup[]> {
  const segmentPool: Record<string, AvailabilityGroup[]> = {};
  for (const result of availabilityResults) {
    if (
      !result.error &&
      result.data &&
      typeof result.data === 'object' &&
      result.data !== null &&
      Array.isArray(result.data.groups)
    ) {
      for (const group of result.data.groups as AvailabilityGroup[]) {
        const segKey = `${group.originAirport}-${group.destinationAirport}`;
        if (!segmentPool[segKey]) segmentPool[segKey] = [];
        segmentPool[segKey].push(group);
      }
    }
  }
  return segmentPool;
}


