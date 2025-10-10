import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const AmExHotelOffersSchema = z.object({
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Check-in date must be in YYYY-MM-DD format'),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Check-out date must be in YYYY-MM-DD format'),
  ecom_hotel_ids: z.array(z.union([z.string(), z.number()])).min(1, 'At least one hotel ID is required').max(200, 'Maximum 200 hotel IDs per request'),
});

const AMEX_API_URL = 'https://tlsonlwrappersvcs.americanexpress.com/consumertravel/services/v1/en-US/hotelOffers';

/**
 * Transform AmEx API response to return only required fields
 */
function transformAmExResponse(data: any) {
  if (!data || !Array.isArray(data.hotels)) {
    return { hotels: [] };
  }

  return {
    hotels: data.hotels.map((hotel: any) => ({
      hotelCollection: hotel.hotelCollection,
      hotelId: hotel.hotelId,
      hotelDetailLink: hotel.hotelDetailLink,
      offerDetails: {
        currency: hotel.offerDetails?.currency,
        offerPrice: hotel.offerDetails?.offerPrice,
        dates: {
          checkInDate: hotel.offerDetails?.dates?.checkInDate,
          checkOutDate: hotel.offerDetails?.dates?.checkOutDate,
        },
        remainingCount: hotel.offerDetails?.remainingCount,
        freeCancellation: hotel.offerDetails?.freeCancellation,
        marketingText: hotel.offerDetails?.marketingText,
        listPrice: hotel.offerDetails?.listPrice,
      },
    })),
  };
}

/**
 * Build AmEx API URL with query parameters
 */
function buildAmExUrl(checkIn: string, checkOut: string, hotelIds: (string | number)[]): string {
  // Manually build the query string to avoid double encoding issues
  const baseParams = new URLSearchParams({
    availOnly: 'false',
    checkIn,
    checkOut,
    hotelPrograms: '20',
    sortType: 'PREMIUM',
  });
  
  // Add hotel IDs with proper %2C encoding
  const hotelIdsParam = hotelIds.join('%2C');
  const fullUrl = `${AMEX_API_URL}?${baseParams.toString()}&ecom_hotel_ids=${hotelIdsParam}`;
  
  return fullUrl;
}

/**
 * Get browser-like headers to mimic real browser behavior
 */
function getBrowserHeaders() {
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

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = await req.json();
    const parsed = AmExHotelOffersSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { 
          error: 'Invalid input', 
          details: parsed.error.errors 
        }, 
        { status: 400 }
      );
    }

    const { checkIn, checkOut, ecom_hotel_ids } = parsed.data;

    // Build the AmEx API URL
    const url = buildAmExUrl(checkIn, checkOut, ecom_hotel_ids);

    // Make request to AmEx API with browser-like headers
    const response = await fetch(url, {
      method: 'GET',
      headers: getBrowserHeaders(),
    });

    if (!response.ok) {
      console.error(`AmEx API error: ${response.status} ${response.statusText}`);
      return NextResponse.json(
        { 
          error: 'AmEx API error', 
          status: response.status,
          statusText: response.statusText 
        }, 
        { status: response.status }
      );
    }

    const data = await response.json();
    
    // Transform response to return only required fields
    const transformedData = transformAmExResponse(data);

    return NextResponse.json(transformedData);

  } catch (error) {
    console.error('Error in amex-hotel-offers POST:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      }, 
      { status: 500 }
    );
  }
}
