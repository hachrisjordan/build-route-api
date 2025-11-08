import { addDays, parseISO, format, subDays, eachDayOfInterval } from 'date-fns';

/**
 * Format a Date object to YYYY-MM-DD string using UTC components
 * This avoids timezone shifts when formatting dates
 */
function formatDateUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parses a date string that can be either ISO format or YYYY-MM-DD format
 * For YYYY-MM-DD format, creates a UTC date to avoid timezone shifts
 * @param dateString Date string to parse
 * @returns Parsed Date object (UTC for date-only strings)
 * @throws Error if date format is invalid
 */
export function parseDateString(dateString: string): Date {
  try {
    // If it's a date-only string (YYYY-MM-DD), parse as UTC to avoid timezone issues
    if (dateString.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      const [year, month, day] = dateString.split('-').map(Number);
      // Create UTC date at midnight to avoid timezone shifts
      return new Date(Date.UTC(year, month - 1, day));
    }
    // For ISO format strings with time, use parseISO
    return parseISO(dateString);
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
  const addedDate = addDays(parsedEndDate, 3);
  // Use UTC formatting to avoid timezone shifts
  return formatDateUTC(addedDate);
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

/**
 * Generate all dates between startDate and endDate (inclusive)
 * Works entirely in UTC to avoid timezone shifts
 * @param startDate Start date string (ISO or YYYY-MM-DD format)
 * @param endDate End date string (ISO or YYYY-MM-DD format)
 * @returns Array of date strings in YYYY-MM-DD format
 */
export function generateDateRange(startDate: string, endDate: string): string[] {
  // Parse as UTC dates
  const parsedStartDate = parseDateString(startDate);
  const parsedEndDate = parseDateString(endDate);
  
  // Extract UTC components
  const startYear = parsedStartDate.getUTCFullYear();
  const startMonth = parsedStartDate.getUTCMonth();
  const startDay = parsedStartDate.getUTCDate();
  
  const endYear = parsedEndDate.getUTCFullYear();
  const endMonth = parsedEndDate.getUTCMonth();
  const endDay = parsedEndDate.getUTCDate();
  
  // Calculate difference in days
  const startTime = Date.UTC(startYear, startMonth, startDay);
  const endTime = Date.UTC(endYear, endMonth, endDay);
  const daysDiff = Math.floor((endTime - startTime) / (1000 * 60 * 60 * 24));
  
  // Generate date range using UTC
  const dates: string[] = [];
  for (let i = 0; i <= daysDiff; i++) {
    const date = new Date(Date.UTC(startYear, startMonth, startDay + i));
    dates.push(formatDateUTC(date));
  }
  
  return dates;
}
