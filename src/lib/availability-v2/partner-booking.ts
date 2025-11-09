/**
 * Partner booking eligibility logic based on airline-specific fare class rules
 */

/**
 * Mapping of airline codes to allowed fare classes for partner booking
 */
const PARTNER_FARE_CLASSES: Record<string, string[]> = {
  'AA': ['T', 'U', 'X', 'Z'],
  'AS': ['T', 'U', 'E'],
  'HA': ['D', 'O'],
  'UA': ['X', 'I', 'O'],
  'AC': ['X', 'I', 'O'],
  'SQ': ['X', 'I', 'O'],
  'CM': ['X', 'I', 'O'],
  'QR': ['X', 'U'],
  'FJ': ['X', 'U'],
  'JX': ['X', 'P', 'U'],
  'AF': ['X', 'O'],
  'KL': ['X', 'O'],
  "DL": ['X', 'O'],
  'VA': ['X', 'Z'],
  'QF': ['X', 'U'],
  'TK': ['X', 'I'],
  'EY': ['N', 'I'],
  'SK': ['X', 'F', 'I'],
  'G3': ['O'],
  'AD': ['V','R'],
  'AM': ['X', 'O'],
  'DE': ['X', 'A', 'I'],
  'B6': ['X', 'A'],
};

/**
 * Airlines that require count >= 2 for partner booking
 */
const MIN_COUNT_TWO_AIRLINES = new Set(['LH', 'LX', 'OS', 'LO', 'SN', 'VS','CL','EK']);

/**
 * Determines if partner booking is allowed for a given airline, fare classes, and count
 * 
 * @param airlineCode - Two-letter airline code (first 2 characters of flight number)
 * @param fareClasses - Array of fare class codes
 * @param count - Seat count
 * @returns true if partner booking is allowed, false otherwise
 */
export function isPartnerBookingAllowed(
  airlineCode: string,
  fareClasses: string[],
  count: number
): boolean {
  // Check count threshold first
  const minCount = MIN_COUNT_TWO_AIRLINES.has(airlineCode) ? 2 : 1;
  if (count < minCount) {
    return false;
  }

  // If airline has specific fare class requirements
  const allowedFareClasses = PARTNER_FARE_CLASSES[airlineCode];
  if (allowedFareClasses) {
    // Check if at least one fare class matches the allowed fare classes
    return fareClasses.some(fareClass => allowedFareClasses.includes(fareClass));
  }

  // For other airlines, any fare class is ok as long as count >= minCount (already checked above)
  // and at least one fare class exists
  return fareClasses.length > 0;
}

/**
 * Calculates partner booking booleans for all cabins (Y, W, J, F)
 * 
 * @param airlineCode - Two-letter airline code
 * @param yFare - Economy fare classes
 * @param wFare - Premium fare classes
 * @param jFare - Business fare classes
 * @param fFare - First fare classes
 * @param yCount - Economy seat count
 * @param wCount - Premium seat count
 * @param jCount - Business seat count
 * @param fCount - First seat count
 * @returns Object with YPartner, WPartner, JPartner, FPartner booleans
 */
export function calculatePartnerBooleans(
  airlineCode: string,
  yFare: string[],
  wFare: string[],
  jFare: string[],
  fFare: string[],
  yCount: number,
  wCount: number,
  jCount: number,
  fCount: number
): {
  YPartner: boolean;
  WPartner: boolean;
  JPartner: boolean;
  FPartner: boolean;
} {
  return {
    YPartner: isPartnerBookingAllowed(airlineCode, yFare, yCount),
    WPartner: isPartnerBookingAllowed(airlineCode, wFare, wCount),
    JPartner: isPartnerBookingAllowed(airlineCode, jFare, jCount),
    FPartner: isPartnerBookingAllowed(airlineCode, fFare, fCount),
  };
}

