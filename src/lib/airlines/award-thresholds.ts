export const DISTANCE_THRESHOLDS = {
  ECONOMY: [
    { maxDistance: 1500, maxMileage: 7500 },
    { maxDistance: 3000, maxMileage: 25000 },
    { maxDistance: 5000, maxMileage: 30000 },
    { maxDistance: 7000, maxMileage: 37500 },
    { maxDistance: 10000, maxMileage: 42500 },
    { maxDistance: Infinity, maxMileage: 65000 }
  ],
  PREMIUM: [
    { maxDistance: 1500, maxMileage: 10000 },
    { maxDistance: 3000, maxMileage: 32500 },
    { maxDistance: 5000, maxMileage: 40000 },
    { maxDistance: 7000, maxMileage: 50000 },
    { maxDistance: 10000, maxMileage: 55000 },
    { maxDistance: Infinity, maxMileage: 85000 }
  ],
  BUSINESS: [
    { maxDistance: 1500, maxMileage: 15000 },
    { maxDistance: 3000, maxMileage: 50000 },
    { maxDistance: 5000, maxMileage: 60000 },
    { maxDistance: 7000, maxMileage: 75000 },
    { maxDistance: 10000, maxMileage: 85000 },
    { maxDistance: Infinity, maxMileage: 130000 }
  ],
  FIRST: [
    { maxDistance: 1500, maxMileage: 22500 },
    { maxDistance: 3000, maxMileage: 75000 },
    { maxDistance: 5000, maxMileage: 90000 },
    { maxDistance: 7000, maxMileage: 110000 },
    { maxDistance: 10000, maxMileage: 130000 },
    { maxDistance: Infinity, maxMileage: 195000 }
  ]
} as const;

export function getDistanceThresholdCount(
  flightPrefix: string,
  distance: number,
  mileageCost: number,
  cabin: string
): number {
  // Only apply filtering to DE and JX flights - other airlines get default count of 1
  if (flightPrefix !== 'DE' && flightPrefix !== 'JX' && flightPrefix !== 'HA') {
    return 1;
  }

  // Determine which cabin thresholds to use
  let thresholds;
  switch ((cabin || '').toLowerCase()) {
    case 'economy':
    case 'y':
      thresholds = DISTANCE_THRESHOLDS.ECONOMY;
      break;
    case 'premium':
    case 'w':
      thresholds = DISTANCE_THRESHOLDS.PREMIUM;
      break;
    case 'business':
    case 'j':
      thresholds = DISTANCE_THRESHOLDS.BUSINESS;
      break;
    case 'first':
    case 'f':
      thresholds = DISTANCE_THRESHOLDS.FIRST;
      break;
    default:
      // Default to economy if cabin is not specified
      thresholds = DISTANCE_THRESHOLDS.ECONOMY;
  }

  // Find the appropriate threshold based on distance
  const threshold = thresholds.find((t) => distance <= t.maxDistance);
  if (!threshold) {
    // Invalid distance - return 0 (exclude from results)
    return 0;
  }

  // Check if mileage cost is within the threshold
  const meetsThreshold = mileageCost <= threshold.maxMileage;
  // Return 2 if meets threshold (reasonably priced), 1 if exceeds threshold (overpriced)
  return meetsThreshold ? 2 : 1;
}


