import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import JSON5 from 'json5';
import { getHtmlWithPlaywright } from '@/lib/playwright-html';

const ALASKA_SEARCH_URL = 'https://www.alaskaair.com/search/results';

const LiveSearchASSchema = z.object({
  from: z.string().min(3), // Origin
  to: z.string().min(3), // Destination
  depart: z.string().min(8), // Outbound Date (YYYY-MM-DD)
  ADT: z.number().int().min(1).max(9), // Adults
});

function jsObjectToJson(jsStr: string): string {
  let jsonStr = jsStr
    // Insert missing commas between objects/arrays and next key
    .replace(/([}\]])(\s*)([a-zA-Z0-9_"'])/g, '$1,$2$3')
    // Quote keys at all levels
    .replace(/([,{{\[]})(\s*)([a-zA-Z0-9_]+)(\s*):/g, '$1$2"$3"$4:')
    // Replace single quotes with double quotes
    .replace(/'/g, '"')
    // Remove trailing commas in objects and arrays
    .replace(/,([}\]])/g, '$1');
  return jsonStr;
}

function extractScriptContentDebug(html: string, keyword: string): string[] {
  // Find all <script> tags containing the keyword
  const scriptRegex = /<script[^>]*>[\s\S]*?<\/script>/gi;
  const scripts = html.match(scriptRegex) || [];
  return scripts
    .filter(s => s.includes(keyword))
    .map(s => s.slice(0, 500));
}

function extractScriptContent(html: string, pattern: string): string | null {
  // Find the <script> tag containing the pattern
  const scriptRegex = new RegExp(`<script[^>]*>[\s\S]*?${pattern}[\s\S]*?<\/script>`, 'i');
  const match = html.match(scriptRegex);
  if (!match) return null;
  // Remove the <script> tags
  const scriptContent = match[0].replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
  return scriptContent;
}

function extractJsObjectByBraces(html: string, startPattern: string): string | null {
  // First, extract the relevant <script> tag content
  const scriptContent = extractScriptContent(html, startPattern);
  if (!scriptContent) return null;
  const startIdx = scriptContent.indexOf(startPattern);
  if (startIdx === -1) return null;
  let braceCount = 0;
  let inString = false;
  let lastChar = '';
  let endIdx = -1;
  for (let i = startIdx; i < scriptContent.length; i++) {
    const char = scriptContent[i];
    if (char === '"' && lastChar !== '\\') inString = !inString;
    if (!inString) {
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;
      if (braceCount === 0) {
        endIdx = i + 1;
        break;
      }
    }
    lastChar = char;
  }
  if (endIdx === -1) return null;
  return scriptContent.slice(startIdx, endIdx);
}

function extractJsObjectFromResolveCall(script: string): string | null {
  const callIdx = script.indexOf('.resolve(');
  if (callIdx === -1) return null;
  const firstBraceIdx = script.indexOf('{', callIdx);
  if (firstBraceIdx === -1) return null;
  // Stack-based extraction from firstBraceIdx
  let braceCount = 0;
  let inString = false;
  let lastChar = '';
  let endIdx = -1;
  for (let i = firstBraceIdx; i < script.length; i++) {
    const char = script[i];
    if (char === '"' && lastChar !== '\\') inString = !inString;
    if (!inString) {
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;
      if (braceCount === 0) {
        endIdx = i + 1;
        break;
      }
    }
    lastChar = char;
  }
  if (endIdx === -1) return null;
  return script.slice(firstBraceIdx, endIdx);
}

function extractJsonFromHtml(html: string): { json: any | null, debug: any } {
  // Find all <script> tags containing 'departureStation'
  const scriptRegex = /<script[^>]*>[\s\S]*?<\/script>/gi;
  const scripts = html.match(scriptRegex) || [];
  const relevantScripts = scripts.filter(s => s.includes('departureStation'));
  let debug: any = {
    htmlLength: html.length,
    relevantScriptsMeta: relevantScripts.map(s => ({
      length: s.length,
      preview: s.slice(0, 2000)
    }))
  };
  let attempted: any[] = [];
  for (const script of relevantScripts) {
    const jsStr = extractJsObjectFromResolveCall(script);
    attempted.push({
      jsStrLength: jsStr ? jsStr.length : null,
      jsStrPreview: jsStr ? jsStr.slice(0, 500) : null,
      jsStrEnd: jsStr ? jsStr.slice(-500) : null
    });
    if (!jsStr) {
      attempted[attempted.length - 1].parseError = 'No .resolve({..}) object found';
      continue;
    }
    try {
      const cleanedJsStr = jsStr.replace(/:void 0/g, ':null');
      const json = JSON5.parse(cleanedJsStr);
      return { json, debug };
    } catch (e) {
      attempted[attempted.length - 1].parseError = e instanceof Error ? e.message : e;
    }
  }
  debug.attempted = attempted;
  return { json: null, debug };
}

function mapCabinToClass(cabin: string): "Y" | "W" | "J" | "F" {
  const c = cabin.toUpperCase();
  if (c.includes("PREMIUM")) return "W";
  if (c.includes("BUSINESS")) return "J";
  if (c.includes("FIRST")) return "F";
  return "Y";
}

function normalizeBundlesAndSegmentClasses(solutions: any, segments: any[]) {
  // For each bundle, determine overall class and per-segment class fields
  const bundles = Object.entries(solutions).map(([key, sol]: [string, any]) => {
    let overallClass: "Y" | "W" | "J" | "F" = "Y";
    if (key.includes("PREMIUM")) overallClass = "W";
    else if (key.includes("BUSINESS")) overallClass = "J";
    else if (key.includes("FIRST")) overallClass = "F";
    return {
      class: overallClass,
      points: String(sol.milesPoints),
      fareTax: String(sol.grandTotal),
      cabins: Array.isArray(sol.cabins) ? sol.cabins.map(mapCabinToClass) : [],
      overallClass,
      mixedCabin: !!sol.mixedCabin,
    };
  });
  // For each segment, for each bundle, add the correct class field only if mixedCabin
  const segmentBundleClasses = segments.map((_: any, idx: number) => {
    return bundles.map(bundle => {
      if (!bundle.mixedCabin) return null;
      const field: Record<string, string> = {};
      field[`${bundle.class}Class`] = bundle.cabins[idx] || "";
      return field;
    });
  });
  // Remove helper fields from bundles
  bundles.forEach(b => { delete (b as any).cabins; delete (b as any).overallClass; delete (b as any).mixedCabin; });
  return { bundles, segmentBundleClasses };
}

function normalizeItineraries(data: any): any[] {
  if (!data || !data.data || !Array.isArray(data.data.rows)) return [];
  return data.data.rows.map((row: any) => {
    const segments = Array.isArray(row.segments) ? row.segments : [];
    let bundles: any[] = [];
    let segmentBundleClasses: any[] = [];
    if (row.solutions) {
      const result = normalizeBundlesAndSegmentClasses(row.solutions, segments);
      bundles = result.bundles;
      segmentBundleClasses = result.segmentBundleClasses;
    }
    return {
      from: row.origin,
      to: row.destination,
      connections: segments.length > 1
        ? segments.slice(0, -1).map((s: any) => s.arrivalStation)
        : [],
      depart: segments[0]?.departureTime?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
      arrive: segments[segments.length - 1]?.arrivalTime?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
      duration: row.duration,
      bundles,
      segments: segments.map((s: any, idx: number) => {
        // Only add bundleClasses if at least one is not null
        const bundleClasses = (segmentBundleClasses[idx] || []).filter(Boolean);
        return {
          from: s.departureStation,
          to: s.arrivalStation,
          aircraft: s.aircraftCode,
          stops: 0,
          depart: s.departureTime?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
          arrive: s.arrivalTime?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
          flightnumber: s.publishingCarrier ? `${s.publishingCarrier.carrierCode}${s.publishingCarrier.flightNumber}` : '',
          duration: s.duration,
          layover: s.stopoverDuration || 0,
          distance: s.performance && s.performance[0]?.distance?.length ? s.performance[0].distance.length : undefined,
          ...(bundleClasses.length > 0 ? { bundleClasses } : {}),
        };
      }),
    };
  });
}

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  try {
    const body = await req.json();
    const parsed = LiveSearchASSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
    }
    const { from, to, depart, ADT } = parsed.data;
    // Map to Alaska Airlines query params
    const params = new URLSearchParams({
      O: from,
      D: to,
      OD: depart,
      A: String(ADT),
      C: '0', // Children
      L: '0', // Lap infants
      RT: 'false',
      ShoppingMethod: 'onlineaward',
    });
    const url = `${ALASKA_SEARCH_URL}?${params.toString()}`;
    // Use Playwright to fetch the full HTML response, bypassing JS challenges
    const html = await getHtmlWithPlaywright(url);
    // Extract and normalize JSON
    const { json, debug } = extractJsonFromHtml(html);
    if (!json) {
      return NextResponse.json({ error: 'Could not extract flight data from Alaska Airlines response.', debug, htmlSnippet: html.slice(0, 2000) }, { status: 500 });
    }
    const itinerary = normalizeItineraries(json);
    return NextResponse.json({ itinerary });
  } catch (err) {
    console.error('Error in live-search-AS POST:', err);
    return NextResponse.json({ error: 'Internal server error', details: (err as Error).message }, { status: 500 });
  }
} 