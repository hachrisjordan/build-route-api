import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { checkPricesForAlert, AlertData } from '@/lib/hotel-alert/price-checker';

/** Zod schema for alert creation request */
const CreateAlertSchema = z.object({
  email: z.string().email('Invalid email address'),
  type: z.enum(['per_day', 'total'], {
    errorMap: () => ({ message: "Type must be 'per_day' or 'total'" }),
  }),
  max_amount: z.number().positive('Max amount must be a positive number'),
  hotels: z
    .array(z.number().int().positive())
    .min(1, 'At least one hotel ID is required')
    .max(50, 'Maximum 50 hotel IDs per alert'),
  date: z
    .array(
      z
        .string()
        .regex(/^\d{16}$/, 'Date must be 16 digits in YYYYMMDDYYYYMMDD format')
    )
    .min(1, 'At least one date set is required')
    .max(10, 'Maximum 10 date sets per alert'),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'End date must be in YYYY-MM-DD format')
    .optional(),
});

type CreateAlertInput = z.infer<typeof CreateAlertSchema>;

/** Response type for created alert */
interface AlertResponse {
  id: string;
  email: string;
  type: string;
  max_amount: number;
  hotels: number[];
  date: number[];
  end_date: string | null;
  current_price: number | null;
  current_hotel: number | null;
  current_start: string | null;
  current_end: string | null;
}

/**
 * POST /api/alert-hotel
 * Create a new hotel price alert and immediately check prices
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const parsed = CreateAlertSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid input',
          details: parsed.error.errors,
        },
        { status: 400 }
      );
    }

    const { email, type, max_amount, hotels, date, end_date } = parsed.data;

    // Convert date strings to numbers for storage
    const dateNumbers = date.map((d) => parseInt(d, 10));

    const supabase = getSupabaseAdminClient();

    // Insert the alert into the database
    const { data: insertedAlert, error: insertError } = await supabase
      .from('alert_hotel')
      .insert({
        email,
        type,
        max_amount,
        hotels,
        date: dateNumbers,
        end_date: end_date || null,
      })
      .select('*')
      .single();

    if (insertError) {
      console.error('[alert-hotel] Insert error:', insertError);
      return NextResponse.json(
        {
          error: 'Failed to create alert',
          details: insertError.message,
        },
        { status: 500 }
      );
    }

    console.log(`[alert-hotel] Created alert ${insertedAlert.id} for ${email}`);

    // Prepare alert data for price check
    const alertData: AlertData = {
      id: insertedAlert.id,
      email: insertedAlert.email,
      type: insertedAlert.type,
      max_amount: insertedAlert.max_amount,
      hotels: insertedAlert.hotels,
      date: insertedAlert.date,
    };

    // Immediately check prices
    const priceResult = await checkPricesForAlert(alertData);

    // Update the alert with current price info if found AND price is within max_amount
    let shouldUpdateCurrentFields = false;
    if (priceResult && priceResult.price <= max_amount) {
      shouldUpdateCurrentFields = true;
      const { error: updateError } = await supabase
        .from('alert_hotel')
        .update({
          current_price: priceResult.price,
          current_hotel: priceResult.hotelId,
          current_start: priceResult.checkIn,
          current_end: priceResult.checkOut,
        })
        .eq('id', insertedAlert.id);

      if (updateError) {
        console.error('[alert-hotel] Price update error:', updateError);
        // Don't fail the request, just log the error
        shouldUpdateCurrentFields = false;
      } else {
        console.log(
          `[alert-hotel] Updated alert ${insertedAlert.id} with price $${priceResult.price}`
        );
      }
    } else if (priceResult && priceResult.price > max_amount) {
      console.log(
        `[alert-hotel] Price $${priceResult.price} exceeds max_amount $${max_amount}, not updating current fields`
      );
    }

    // Build response - only include current fields if we actually updated them
    const response: AlertResponse = {
      id: insertedAlert.id,
      email: insertedAlert.email,
      type: insertedAlert.type,
      max_amount: insertedAlert.max_amount,
      hotels: insertedAlert.hotels,
      date: insertedAlert.date,
      end_date: insertedAlert.end_date,
      current_price: shouldUpdateCurrentFields ? (priceResult?.price ?? null) : null,
      current_hotel: shouldUpdateCurrentFields ? (priceResult?.hotelId ?? null) : null,
      current_start: shouldUpdateCurrentFields ? (priceResult?.checkIn ?? null) : null,
      current_end: shouldUpdateCurrentFields ? (priceResult?.checkOut ?? null) : null,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error('[alert-hotel] Unexpected error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
