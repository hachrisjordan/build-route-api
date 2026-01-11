#!/usr/bin/env node

require('dotenv').config();

// Import dependencies
const { getSupabaseAdminClient } = require('../src/lib/supabase-admin');
const { sendPriceDropEmail } = require('../src/lib/hotel-alert/email-service');

// Import price checker - using dynamic import for TypeScript module
import type { AlertData, PriceCheckResult } from '../src/lib/hotel-alert/price-checker';
import type { PriceDropEmailData } from '../src/lib/hotel-alert/email-service';

const AMEX_API_URL = 'https://tlsonlwrappersvcs.americanexpress.com/consumertravel/services/v1/en-US/hotelOffers';
const SUPABASE_URL = 'https://dbaixrvzmfwhhbgyoebt.supabase.co';
const DELAY_BETWEEN_ALERTS = 2000; // 2 seconds between each alert check

interface HotelDetails {
  name: string;
  brand: string | null;
  link: string | null;
}

/**
 * Get hotel image URL from Supabase storage
 * Images are stored as: bbairtools/hotel_images/{hotel_id}.jpg
 */
function getHotelImageUrl(hotelId: number): string {
  return `${SUPABASE_URL}/storage/v1/object/public/bbairtools/hotel_images/${hotelId}.jpg`;
}

/**
 * Format date sets for display in email
 * Converts [2026020120260204] to ["2026-02-01 to 2026-02-04"]
 */
function formatDateSetsForDisplay(dateSets: number[]): string[] {
  return dateSets.map(dateValue => {
    const dateStr = dateValue.toString();
    if (dateStr.length !== 16) return `Invalid: ${dateValue}`;
    
    const checkInRaw = dateStr.substring(0, 8);
    const checkOutRaw = dateStr.substring(8, 16);
    
    const checkIn = `${checkInRaw.substring(0, 4)}-${checkInRaw.substring(4, 6)}-${checkInRaw.substring(6, 8)}`;
    const checkOut = `${checkOutRaw.substring(0, 4)}-${checkOutRaw.substring(4, 6)}-${checkOutRaw.substring(6, 8)}`;
    
    return `${checkIn} to ${checkOut}`;
  });
}

/**
 * Fetch hotel details from database
 */
async function fetchHotelDetails(hotelId: number): Promise<HotelDetails | null> {
  const supabase = getSupabaseAdminClient();
  
  const { data, error } = await supabase
    .from('hotel')
    .select('name, brand, link')
    .eq('hotel_id', hotelId)
    .single();

  if (error || !data) {
    console.error(`[CRON] Error fetching hotel ${hotelId}:`, error);
    return null;
  }

  return data;
}

interface AlertRecord {
  id: string;
  email: string | null;
  type: string | null;
  max_amount: number | null;
  hotels: number[] | null;
  date: number[] | null;
  current_price: number | null;
  current_hotel: number | null;
  current_start: string | null;
  current_end: string | null;
  end_date: string | null;
}

interface ParsedDateSet {
  checkIn: string;
  checkOut: string;
  nights: number;
  raw: number;
}

interface HotelOffer {
  hotelId: number;
  hotelDetailLink?: string;
  offerDetails?: {
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

/**
 * Parse date set from number format to structured object
 */
function parseDateSet(dateValue: number): ParsedDateSet {
  const dateStr = dateValue.toString();
  
  if (dateStr.length !== 16) {
    throw new Error(`Invalid date format: ${dateValue}. Expected 16 digits`);
  }
  
  const checkInRaw = dateStr.substring(0, 8);
  const checkOutRaw = dateStr.substring(8, 16);
  
  // Parse YYYYMMDD to YYYY-MM-DD
  const checkIn = `${checkInRaw.substring(0, 4)}-${checkInRaw.substring(4, 6)}-${checkInRaw.substring(6, 8)}`;
  const checkOut = `${checkOutRaw.substring(0, 4)}-${checkOutRaw.substring(4, 6)}-${checkOutRaw.substring(6, 8)}`;
  
  // Calculate nights
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const nights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
  
  if (nights <= 0) {
    throw new Error(`Invalid date range: ${checkIn} to ${checkOut}`);
  }
  
  return { checkIn, checkOut, nights, raw: dateValue };
}

/**
 * Get browser-like headers for AmEx API
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
 * Build AmEx API URL
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
 * Fetch hotel offers from AmEx API
 */
async function fetchHotelOffers(
  hotelIds: number[],
  checkIn: string,
  checkOut: string
): Promise<HotelOffer[]> {
  const url = buildAmExUrl(checkIn, checkOut, hotelIds);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: getBrowserHeaders(),
    });

    if (!response.ok) {
      console.error(`[CRON] AmEx API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.hotels || [];
  } catch (error) {
    console.error('[CRON] Error fetching offers:', error);
    return [];
  }
}

/**
 * Find best price from offers
 */
function findBestPrice(
  offers: Array<{ offer: HotelOffer; dateSet: ParsedDateSet }>,
  type: 'per_day' | 'total'
): PriceCheckResult | null {
  let bestResult: PriceCheckResult | null = null;
  let bestComparisonPrice = Infinity;

  for (const { offer, dateSet } of offers) {
    const offerPrice = offer.offerDetails?.offerPrice;
    if (!offerPrice) continue;

    const perNightPrice = parseFloat(offerPrice);
    if (isNaN(perNightPrice) || perNightPrice <= 0) continue;

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
 * Check prices for a single alert
 */
async function checkPricesForAlert(alert: AlertRecord): Promise<PriceCheckResult | null> {
  const { hotels, date, type } = alert;

  if (!hotels || hotels.length === 0 || !date || date.length === 0) {
    return null;
  }

  const alertType = (type === 'total' ? 'total' : 'per_day') as 'per_day' | 'total';
  
  // Parse all date sets
  const parsedDateSets: ParsedDateSet[] = [];
  for (const dateValue of date) {
    try {
      parsedDateSets.push(parseDateSet(dateValue));
    } catch (error) {
      console.error(`[CRON] Error parsing date ${dateValue}:`, error);
    }
  }

  if (parsedDateSets.length === 0) return null;

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
      if (hotels.includes(offer.hotelId)) {
        allOffers.push({ offer, dateSet });
      }
    }
  }

  return findBestPrice(allOffers, alertType);
}

/**
 * Fetch all active alerts from database
 */
async function fetchActiveAlerts(): Promise<AlertRecord[]> {
  console.log('[CRON] Fetching active alerts...');
  
  const supabase = getSupabaseAdminClient();
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('alert_hotel')
    .select('*')
    .or(`end_date.gte.${today},end_date.is.null`);

  if (error) {
    console.error('[CRON] Error fetching alerts:', error);
    throw error;
  }

  console.log(`[CRON] Found ${data?.length || 0} active alerts`);
  return data || [];
}

/**
 * Update alert with new price data
 */
async function updateAlertPrice(
  alertId: string,
  currentData: {
    price: number | null;
    hotel: number | null;
    start: string | null;
    end: string | null;
  },
  newResult: PriceCheckResult | null
): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const updateData: Record<string, any> = {
    // Move current to past
    past_price: currentData.price,
    past_hotel: currentData.hotel,
    past_start: currentData.start,
    past_end: currentData.end,
  };

  // Update current with new values
  if (newResult) {
    updateData.current_price = newResult.price;
    updateData.current_hotel = newResult.hotelId;
    updateData.current_start = newResult.checkIn;
    updateData.current_end = newResult.checkOut;
  } else {
    updateData.current_price = null;
    updateData.current_hotel = null;
    updateData.current_start = null;
    updateData.current_end = null;
  }

  const { error } = await supabase
    .from('alert_hotel')
    .update(updateData)
    .eq('id', alertId);

  if (error) {
    console.error(`[CRON] Error updating alert ${alertId}:`, error);
  }
}

/**
 * Process a single alert - only update DB and send email when price decreases
 */
async function processAlert(alert: AlertRecord): Promise<{ updated: boolean; priceFound: boolean; emailSent: boolean }> {
  console.log(`[CRON] Processing alert ${alert.id} for ${alert.email}`);

  try {
    const priceResult = await checkPricesForAlert(alert);

    if (!priceResult) {
      console.log(`[CRON] Alert ${alert.id}: No prices available`);
      return { updated: false, priceFound: false, emailSent: false };
    }

    // Only update if price decreased (or if there was no previous price)
    const currentPrice = alert.current_price;
    const isPriceDecrease = currentPrice === null || priceResult.price < currentPrice;

    if (!isPriceDecrease) {
      console.log(`[CRON] Alert ${alert.id}: Price $${priceResult.price} is not lower than current $${currentPrice}, skipping`);
      return { updated: false, priceFound: true, emailSent: false };
    }

    // Price decreased - update the database
    console.log(`[CRON] Alert ${alert.id}: Price dropped from $${currentPrice} to $${priceResult.price}`);

    await updateAlertPrice(
      alert.id,
      {
        price: alert.current_price,
        hotel: alert.current_hotel,
        start: alert.current_start,
        end: alert.current_end,
      },
      priceResult
    );

    // Send email notification (only if there was a previous price to compare)
    let emailSent = false;
    if (currentPrice !== null && alert.email) {
      // Fetch hotel details for the email
      const hotelDetails = await fetchHotelDetails(priceResult.hotelId);
      const alertType = (alert.type === 'total' ? 'total' : 'per_day') as 'per_day' | 'total';
      
      const emailData: PriceDropEmailData = {
        to: alert.email,
        hotelId: priceResult.hotelId,
        hotelName: hotelDetails?.name || `Hotel #${priceResult.hotelId}`,
        hotelImageUrl: getHotelImageUrl(priceResult.hotelId),
        previousPrice: currentPrice,
        newPrice: priceResult.price,
        checkIn: priceResult.checkIn,
        checkOut: priceResult.checkOut,
        nights: priceResult.nights,
        alertType,
        bookingLink: priceResult.bookingLink,
        // Original alert parameters
        maxAmount: alert.max_amount || 0,
        watchedHotelIds: alert.hotels || [],
        watchedDateSets: formatDateSetsForDisplay(alert.date || []),
      };

      emailSent = await sendPriceDropEmail(emailData);
      
      if (emailSent) {
        console.log(`[CRON] Alert ${alert.id}: Email sent to ${alert.email} for ${emailData.hotelName}`);
      } else {
        console.log(`[CRON] Alert ${alert.id}: Failed to send email to ${alert.email}`);
      }
    }

    return { updated: true, priceFound: true, emailSent };
  } catch (error) {
    console.error(`[CRON] Error processing alert ${alert.id}:`, error);
    return { updated: false, priceFound: false, emailSent: false };
  }
}

/**
 * Main cron job function
 */
async function runCronJob(): Promise<void> {
  console.log('[CRON] Starting hotel alert price check job...');
  console.log(`[CRON] Started at: ${new Date().toISOString()}`);

  try {
    const alerts = await fetchActiveAlerts();

    if (alerts.length === 0) {
      console.log('[CRON] No active alerts to process');
      return;
    }

    let totalUpdated = 0;
    let totalPricesFound = 0;
    let totalEmailsSent = 0;

    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      console.log(`[CRON] Processing alert ${i + 1}/${alerts.length}`);

      const result = await processAlert(alert);
      
      if (result.updated) totalUpdated++;
      if (result.priceFound) totalPricesFound++;
      if (result.emailSent) totalEmailsSent++;

      // Add delay between alerts to avoid rate limiting
      if (i < alerts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ALERTS));
      }
    }

    console.log('[CRON] Job completed successfully:');
    console.log(`[CRON] - Total alerts processed: ${alerts.length}`);
    console.log(`[CRON] - Price drops found & updated: ${totalUpdated}`);
    console.log(`[CRON] - Prices available: ${totalPricesFound}`);
    console.log(`[CRON] - Emails sent: ${totalEmailsSent}`);
    console.log(`[CRON] Finished at: ${new Date().toISOString()}`);

  } catch (error) {
    console.error('[CRON] Job failed:', error);
    process.exit(1);
  }
}

// Run the cron job if executed directly
if (require.main === module) {
  runCronJob()
    .then(() => {
      console.log('[CRON] Cron job finished successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[CRON] Cron job failed:', error);
      process.exit(1);
    });
}

module.exports = { runCronJob };
