import { addDays, parseISO, format, subDays } from 'date-fns';

/**
 * Parses a date string that can be either ISO format or YYYY-MM-DD format
 * @param dateString Date string to parse
 * @returns Parsed Date object
 * @throws Error if date format is invalid
 */
export function parseDateString(dateString: string): Date {
  try {
    // Accept both ISO and YYYY-MM-DD formats
    return dateString.length > 10 ? parseISO(dateString) : new Date(dateString);
  } catch (error) {
    throw new Error(`Invalid date format: ${dateString}`);
  }
}

/**
 * Computes seatsAeroEndDate as +3 days after the user input endDate
 * @param endDate End date string (ISO or YYYY-MM-DD format)
 * @returns Formatted date string in YYYY-MM-DD format
 * @throws Error if endDate format is invalid
 */
export function computeSeatsAeroEndDate(endDate: string): string {
  const parsedEndDate = parseDateString(endDate);
  return format(addDays(parsedEndDate, 3), 'yyyy-MM-dd');
}

/**
 * Calculates a date that is 7 days ago from now
 * @returns Date object representing 7 days ago
 */
export function getSevenDaysAgo(): Date {
  return subDays(new Date(), 7);
}

/**
 * Validates and parses date range for availability search
 * @param startDate Start date string
 * @param endDate End date string
 * @returns Object with parsed dates and seatsAeroEndDate
 * @throws Error if any date format is invalid
 */
export function parseDateRange(startDate: string, endDate: string): {
  startDate: Date;
  endDate: Date;
  seatsAeroEndDate: string;
  sevenDaysAgo: Date;
} {
  const parsedStartDate = parseDateString(startDate);
  const parsedEndDate = parseDateString(endDate);
  const seatsAeroEndDate = computeSeatsAeroEndDate(endDate);
  const sevenDaysAgo = getSevenDaysAgo();

  return {
    startDate: parsedStartDate,
    endDate: parsedEndDate,
    seatsAeroEndDate,
    sevenDaysAgo
  };
}
