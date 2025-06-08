import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/jetblue-lfs';

// If 'start' is not provided, default to today (UTC)
const BatchSchema = z.object({
  from: z.string().min(3),
  to: z.string().min(3),
  start: z.string().min(8).optional(), // YYYY-MM-DD, optional
  days: z.number().min(1).max(60)
});

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = BatchSchema.safeParse(body);
    if (!parsed.success) {
      console.log('Invalid input:', parsed.error.errors);
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
    }
    const { from, to, days } = parsed.data;
    const start = parsed.data.start || formatDate(new Date());
    const startDate = new Date(start);
    const endDate = addDays(startDate, days - 1);

    console.log(`[Batch] Starting rolling batch JetBlue LFS job: from=${from}, to=${to}, start=${start}, days=${days}`);

    const results = [];
    const fetchedDates = new Set();
    let currentSeed = startDate;

    while (currentSeed <= endDate) {
      const seedDateStr = formatDate(currentSeed);
      if (fetchedDates.has(seedDateStr)) {
        currentSeed = addDays(currentSeed, 1);
        continue;
      }
      console.log(`[Batch] Fetching dategroup for ${seedDateStr}`);
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, depart: seedDateStr })
      });
      if (!resp.ok) {
        console.error(`[Batch] Failed to call jetblue-lfs for ${seedDateStr}: status ${resp.status}`);
        currentSeed = addDays(currentSeed, 1);
        continue;
      }
      const data = await resp.json();
      const dategroup = data.dategroup?.[0]?.group || [];
      if (!dategroup.length) {
        console.log(`[Batch] No dategroup for ${seedDateStr}, moving to next day.`);
        currentSeed = addDays(currentSeed, 1);
        continue;
      }
      // Find all dates in the preview after or equal to the seed date, with points !== 'N/A'
      let nextSeed: Date | null = null;
      for (const entry of dategroup) {
        const entryDate = entry.date.slice(0, 10);
        const entryDateObj = new Date(entryDate);
        if (entryDateObj < currentSeed || entryDateObj > endDate) continue;
        if (fetchedDates.has(entryDate)) continue;
        if (entry.points !== 'N/A') {
          // Fetch this date
          if (entryDate === seedDateStr) {
            // Use the data we already have
            console.log(`[Batch] Using seed data for ${entryDate}`);
            results.push(data);
          } else {
            console.log(`[Batch] Fetching data for ${entryDate}`);
            const dayResp = await fetch(API_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from, to, depart: entryDate })
            });
            if (dayResp.ok) {
              results.push(await dayResp.json());
              console.log(`[Batch] Success for ${entryDate}`);
            } else {
              console.error(`[Batch] Failed to fetch for ${entryDate}: status ${dayResp.status}`);
            }
          }
        }
        fetchedDates.add(entryDate);
        // Track the last date in the preview
        if (!nextSeed || entryDateObj > nextSeed) {
          nextSeed = entryDateObj;
        }
      }
      // Move to the first day after the preview window
      if (nextSeed) {
        currentSeed = addDays(nextSeed, 1);
      } else {
        currentSeed = addDays(currentSeed, 1);
      }
    }

    console.log(`[Batch] Finished rolling batch job. Total results: ${results.length}`);
    return NextResponse.json({ results });
  } catch (error: any) {
    console.error('[Batch] Error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
} 