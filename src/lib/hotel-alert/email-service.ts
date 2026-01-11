import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

/** Email data for price drop notification */
export interface PriceDropEmailData {
  to: string;
  hotelId: number;
  hotelName: string;
  hotelImageUrl?: string;
  previousPrice: number;
  newPrice: number;
  checkIn: string;
  checkOut: string;
  nights: number;
  alertType: 'per_day' | 'total';
  bookingLink?: string;
  // Original alert parameters
  maxAmount: number;
  watchedHotelIds: number[];
  watchedDateSets: string[]; // Array of date strings like "2026-02-01 to 2026-02-04"
}

/**
 * Generate HTML email template for price drop notification
 */
function generatePriceDropEmailHtml(data: PriceDropEmailData): string {
  const priceDifference = data.previousPrice - data.newPrice;
  const percentDrop = ((priceDifference / data.previousPrice) * 100).toFixed(1);
  const priceLabel = data.alertType === 'per_day' ? 'per night' : 'total';
  
  const bookingButton = data.bookingLink 
    ? `<a href="${data.bookingLink}" style="display: inline-block; background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 16px;">Book Now</a>`
    : '';

  const hotelImage = data.hotelImageUrl
    ? `<img src="${data.hotelImageUrl}" alt="${data.hotelName}" style="width: 100%; max-width: 400px; height: auto; border-radius: 8px; margin-bottom: 16px;" />`
    : '';

  // Format watched dates for display
  const watchedDatesHtml = data.watchedDateSets
    .map(d => `<span style="display: inline-block; background-color: #f3f4f6; padding: 4px 8px; border-radius: 4px; margin: 2px; font-size: 12px;">${d}</span>`)
    .join(' ');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Price Drop Alert - ${data.hotelName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background-color: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      
      <!-- Header -->
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="display: inline-block; background-color: #dcfce7; color: #166534; padding: 8px 16px; border-radius: 20px; font-size: 14px; font-weight: 600;">
          🎉 Price Drop Alert
        </div>
      </div>
      
      <!-- Hotel Image -->
      <div style="text-align: center; margin-bottom: 20px;">
        ${hotelImage}
      </div>
      
      <!-- Main Content -->
      <h1 style="color: #111827; font-size: 24px; font-weight: 700; margin: 0 0 8px 0; text-align: center;">
        Price dropped ${percentDrop}%!
      </h1>
      
      <p style="color: #6b7280; font-size: 16px; text-align: center; margin: 0 0 24px 0;">
        Great news! We found a lower price for your alert.
      </p>
      
      <!-- Price Comparison -->
      <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="text-align: center; flex: 1;">
            <div style="color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Previous</div>
            <div style="color: #6b7280; font-size: 24px; font-weight: 600; text-decoration: line-through;">$${data.previousPrice.toFixed(2)}</div>
          </div>
          <div style="color: #d1d5db; font-size: 24px; padding: 0 16px;">→</div>
          <div style="text-align: center; flex: 1;">
            <div style="color: #16a34a; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">New Price</div>
            <div style="color: #16a34a; font-size: 28px; font-weight: 700;">$${data.newPrice.toFixed(2)}</div>
          </div>
        </div>
        <div style="text-align: center; margin-top: 12px; color: #6b7280; font-size: 14px;">
          ${priceLabel}
        </div>
      </div>
      
      <!-- Stay Details -->
      <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <h3 style="color: #111827; font-size: 16px; font-weight: 600; margin: 0 0 12px 0;">
          🏨 Stay Details
        </h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="color: #6b7280; padding: 6px 0; font-size: 14px;">Hotel</td>
            <td style="color: #111827; padding: 6px 0; font-size: 14px; text-align: right; font-weight: 600;">${data.hotelName}</td>
          </tr>
          <tr>
            <td style="color: #6b7280; padding: 6px 0; font-size: 14px;">Check-in</td>
            <td style="color: #111827; padding: 6px 0; font-size: 14px; text-align: right; font-weight: 500;">${data.checkIn}</td>
          </tr>
          <tr>
            <td style="color: #6b7280; padding: 6px 0; font-size: 14px;">Check-out</td>
            <td style="color: #111827; padding: 6px 0; font-size: 14px; text-align: right; font-weight: 500;">${data.checkOut}</td>
          </tr>
          <tr>
            <td style="color: #6b7280; padding: 6px 0; font-size: 14px;">Nights</td>
            <td style="color: #111827; padding: 6px 0; font-size: 14px; text-align: right; font-weight: 500;">${data.nights}</td>
          </tr>
          <tr>
            <td style="color: #6b7280; padding: 6px 0; font-size: 14px;">You Save</td>
            <td style="color: #16a34a; padding: 6px 0; font-size: 14px; text-align: right; font-weight: 600;">$${priceDifference.toFixed(2)}</td>
          </tr>
        </table>
      </div>
      
      <!-- Alert Parameters -->
      <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px; background-color: #fafafa;">
        <h3 style="color: #111827; font-size: 16px; font-weight: 600; margin: 0 0 12px 0;">
          ⚙️ Your Alert Settings
        </h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="color: #6b7280; padding: 6px 0; font-size: 14px;">Alert Type</td>
            <td style="color: #111827; padding: 6px 0; font-size: 14px; text-align: right; font-weight: 500;">${data.alertType === 'per_day' ? 'Per Night' : 'Total Stay'}</td>
          </tr>
          <tr>
            <td style="color: #6b7280; padding: 6px 0; font-size: 14px;">Max Budget</td>
            <td style="color: #111827; padding: 6px 0; font-size: 14px; text-align: right; font-weight: 500;">$${data.maxAmount.toFixed(2)}</td>
          </tr>
          <tr>
            <td style="color: #6b7280; padding: 6px 0; font-size: 14px;">Hotels Watched</td>
            <td style="color: #111827; padding: 6px 0; font-size: 14px; text-align: right; font-weight: 500;">${data.watchedHotelIds.length} hotel${data.watchedHotelIds.length > 1 ? 's' : ''}</td>
          </tr>
        </table>
        <div style="margin-top: 12px;">
          <div style="color: #6b7280; font-size: 13px; margin-bottom: 6px;">Date Ranges:</div>
          <div>${watchedDatesHtml}</div>
        </div>
      </div>
      
      <!-- CTA Button -->
      <div style="text-align: center;">
        ${bookingButton}
      </div>
      
      <!-- Footer -->
      <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center;">
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">
          You're receiving this email because you set up a price alert.<br>
          Prices are subject to change and availability.
        </p>
      </div>
      
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Generate plain text email for price drop notification
 */
function generatePriceDropEmailText(data: PriceDropEmailData): string {
  const priceDifference = data.previousPrice - data.newPrice;
  const percentDrop = ((priceDifference / data.previousPrice) * 100).toFixed(1);
  const priceLabel = data.alertType === 'per_day' ? 'per night' : 'total';

  return `
🎉 Price Drop Alert!

Great news! We found a ${percentDrop}% price drop for your alert.

PRICE COMPARISON
Previous: $${data.previousPrice.toFixed(2)} ${priceLabel}
New Price: $${data.newPrice.toFixed(2)} ${priceLabel}
You Save: $${priceDifference.toFixed(2)}

STAY DETAILS
Hotel: ${data.hotelName}
Check-in: ${data.checkIn}
Check-out: ${data.checkOut}
Nights: ${data.nights}

YOUR ALERT SETTINGS
Alert Type: ${data.alertType === 'per_day' ? 'Per Night' : 'Total Stay'}
Max Budget: $${data.maxAmount.toFixed(2)}
Hotels Watched: ${data.watchedHotelIds.length}
Date Ranges: ${data.watchedDateSets.join(', ')}

${data.bookingLink ? `Book now: ${data.bookingLink}` : ''}

---
You're receiving this email because you set up a price alert.
Prices are subject to change and availability.
`;
}

/**
 * Send price drop notification email via Resend
 */
export async function sendPriceDropEmail(data: PriceDropEmailData): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    console.error('[email-service] RESEND_API_KEY not configured');
    return false;
  }

  try {
    console.log(`[email-service] Sending price drop email to ${data.to}`);

    // Use configured from email or Resend's default testing email
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: data.to,
      subject: `🎉 Price Drop! ${data.hotelName} now $${data.newPrice.toFixed(2)} (was $${data.previousPrice.toFixed(2)})`,
      html: generatePriceDropEmailHtml(data),
      text: generatePriceDropEmailText(data),
    });

    if (error) {
      console.error('[email-service] Resend error:', error);
      return false;
    }

    console.log(`[email-service] Email sent successfully to ${data.to}`);
    return true;
  } catch (error) {
    console.error('[email-service] Failed to send email:', error);
    return false;
  }
}
