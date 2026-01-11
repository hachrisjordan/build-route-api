import { differenceInDays, parse, format } from 'date-fns';

const AMEX_API_URL = 'https://tlsonlwrappersvcs.americanexpress.com/consumertravel/services/v1/en-US/hotelOffers';

/** Parsed date set with check-in, check-out, and number of nights */
export interface ParsedDateSet {
  checkIn: string; // YYYY-MM-DD format
  checkOut: string; // YYYY-MM-DD format
  nights: number;
  raw: number; // Original value from database
}

/** Hotel offer from AmEx API */
export interface HotelOffer {
  hotelId: number;
  hotelDetailLink?: string;
  offerDetails: {
    currency?: string;
    offerPrice?: string;
    dates?: {
      checkInDate?: string;
      checkOutDate?: string;
    };
    remainingCount?: number;
    freeCancellation?: boolean;
    listPrice?: string;
  };
}

/** Result of price check operation */
export interface PriceCheckResult {
  hotelId: number;
  price: number; // Per night price for per_day, total price for total
  perNightPrice: number;
  checkIn: string;
  checkOut: string;
  nights: number;
  bookingLink?: string; // hotelDetailLink from AmEx API
}

/** Alert data from database */
export interface AlertData {
  id: string;
  email: string | null;
  type: string | null; // 'per_day' or 'total'
  max_amount: number | null;
  hotels: number[] | null;
  date: number[] | null; // Array of date sets in YYYYMMDDYYYYMMDD format
}

/**
 * Parse date set from number format to structured object
 * Input: 2026010820260111 (number representing YYYYMMDDYYYYMMDD)
 * Output: { checkIn: "2026-01-08", checkOut: "2026-01-11", nights: 3 }
 */
export function parseDateSet(dateValue: number): ParsedDateSet {
  const dateStr = dateValue.toString();
  
  if (dateStr.length !== 16) {
    throw new Error(`Invalid date format: ${dateValue}. Expected 16 digits (YYYYMMDDYYYYMMDD)`);
  }
  
  const checkInRaw = dateStr.substring(0, 8); // YYYYMMDD
  const checkOutRaw = dateStr.substring(8, 16); // YYYYMMDD
  
  // Parse and format dates
  const checkInDate = parse(checkInRaw, 'yyyyMMdd', new Date());
  const checkOutDate = parse(checkOutRaw, 'yyyyMMdd', new Date());
  
  const checkIn = format(checkInDate, 'yyyy-MM-dd');
  const checkOut = format(checkOutDate, 'yyyy-MM-dd');
  const nights = differenceInDays(checkOutDate, checkInDate);
  
  if (nights <= 0) {
    throw new Error(`Invalid date range: check-out must be after check-in. Got ${checkIn} to ${checkOut}`);
  }
  
  return {
    checkIn,
    checkOut,
    nights,
    raw: dateValue,
  };
}

/**
 * Get browser-like headers for AmEx API requests
 */
function getBrowserHeaders(): Record<string, string> {
  return {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
    'Origin': 'https://www.americanexpress.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

/**
 * Build AmEx API URL with query parameters
 */
function buildAmExUrl(checkIn: string, checkOut: string, hotelIds: number[]): string {
  const baseParams = new URLSearchParams({
    availOnly: 'false',
    checkIn,
    checkOut,
    hotelPrograms: '20',
    sortType: 'PREMIUM',
  });
  
  const hotelIdsParam = hotelIds.join('%2C');
  return `${AMEX_API_URL}?${baseParams.toString()}&ecom_hotel_ids=${hotelIdsParam}`;
}

/**
 * Fetch hotel offers from AmEx API for a specific date range
 */
export async function fetchHotelOffers(
  hotelIds: number[],
  checkIn: string,
  checkOut: string
): Promise<HotelOffer[]> {
  const url = buildAmExUrl(checkIn, checkOut, hotelIds);
  
  console.log(`[price-checker] Fetching offers for ${hotelIds.length} hotels, ${checkIn} to ${checkOut}`);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: getBrowserHeaders(),
    });

    if (!response.ok) {
      console.error(`[price-checker] AmEx API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    
    if (!data.hotels || !Array.isArray(data.hotels)) {
      console.log('[price-checker] No hotels in response');
      return [];
    }

    console.log(`[price-checker] Found ${data.hotels.length} offers`);
    return data.hotels;
    
  } catch (error) {
    console.error('[price-checker] Error fetching hotel offers:', error);
    return [];
  }
}

/**
 * Find the best price from a list of offers
 * For per_day: returns the cheapest per-night price
 * For total: returns the cheapest total stay price (per_night × nights)
 */
export function findBestPrice(
  offers: Array<{ offer: HotelOffer; dateSet: ParsedDateSet }>,
  type: 'per_day' | 'total'
): PriceCheckResult | null {
  if (offers.length === 0) {
    return null;
  }

  let bestResult: PriceCheckResult | null = null;
  let bestComparisonPrice = Infinity;

  for (const { offer, dateSet } of offers) {
    const offerPrice = offer.offerDetails?.offerPrice;
    if (!offerPrice) continue;

    const perNightPrice = parseFloat(offerPrice);
    if (isNaN(perNightPrice) || perNightPrice <= 0) continue;

    // Calculate comparison price based on type
    const comparisonPrice = type === 'per_day' 
      ? perNightPrice 
      : perNightPrice * dateSet.nights;

    if (comparisonPrice < bestComparisonPrice) {
      bestComparisonPrice = comparisonPrice;
      bestResult = {
        hotelId: offer.hotelId,
        price: comparisonPrice,
        perNightPrice,
        checkIn: dateSet.checkIn,
        checkOut: dateSet.checkOut,
        nights: dateSet.nights,
        bookingLink: offer.hotelDetailLink,
      };
    }
  }

  return bestResult;
}

/**
 * Check prices for an alert and return the best price result
 * This is the main function used by both the API and cron job
 */
export async function checkPricesForAlert(alert: AlertData): Promise<PriceCheckResult | null> {
  const { hotels, date, type } = alert;

  // Validate required fields
  if (!hotels || hotels.length === 0) {
    console.log(`[price-checker] Alert ${alert.id}: No hotels specified`);
    return null;
  }

  if (!date || date.length === 0) {
    console.log(`[price-checker] Alert ${alert.id}: No dates specified`);
    return null;
  }

  const alertType = (type === 'total' ? 'total' : 'per_day') as 'per_day' | 'total';
  console.log(`[price-checker] Checking prices for alert ${alert.id} (type: ${alertType})`);

  // Parse all date sets
  const parsedDateSets: ParsedDateSet[] = [];
  for (const dateValue of date) {
    try {
      const parsed = parseDateSet(dateValue);
      parsedDateSets.push(parsed);
    } catch (error) {
      console.error(`[price-checker] Error parsing date ${dateValue}:`, error);
    }
  }

  if (parsedDateSets.length === 0) {
    console.log(`[price-checker] Alert ${alert.id}: No valid dates after parsing`);
    return null;
  }

  // Fetch all date sets concurrently for better performance
  const offerResults = await Promise.all(
    parsedDateSets.map(async (dateSet) => {
      const offers = await fetchHotelOffers(hotels, dateSet.checkIn, dateSet.checkOut);
      return { offers, dateSet };
    })
  );

  // Flatten and filter results
  const allOffers: Array<{ offer: HotelOffer; dateSet: ParsedDateSet }> = [];
  for (const { offers, dateSet } of offerResults) {
    for (const offer of offers) {
      // Only include offers for hotels in our list
      if (hotels.includes(offer.hotelId)) {
        allOffers.push({ offer, dateSet });
      }
    }
  }

  console.log(`[price-checker] Alert ${alert.id}: Found ${allOffers.length} total offers across ${parsedDateSets.length} date sets (concurrent)`);

  // Find the best price
  const bestPrice = findBestPrice(allOffers, alertType);

  if (bestPrice) {
    console.log(`[price-checker] Alert ${alert.id}: Best price found - Hotel ${bestPrice.hotelId}, $${bestPrice.price} (${alertType})`);
  } else {
    console.log(`[price-checker] Alert ${alert.id}: No valid prices found`);
  }

  return bestPrice;
}
