/**
 * Post to a Discord incoming webhook (Execute Webhook API).
 * Success: HTTP 204 No Content or 2xx with body.
 * Env: DISCORD_GOOGLE_ALERTS_WEBHOOK_URL — do not commit secrets.
 */

export type DiscordWebhookPayload = {
  content?: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
  }>;
  username?: string;
};

const MAX_CONTENT_LENGTH = 1900;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function addDaysUtc(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function defaultDepartIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

/**
 * Google Travel Flights search (business class), matching the site's `q` shape:
 * one-way: Flights to {DEST} from {ORIG} on {YYYY-MM-DD} one way business class
 * round-trip: Flights to {DEST} from {ORIG} on {depart} through {return} business class round trip
 */
export function buildGoogleTravelFlightsBusinessUrl(params: {
  originIata: string;
  destinationIata: string;
  roundtrip: string;
  departDate?: string | null;
  arriveDate?: string | null;
}): string {
  const dest = params.destinationIata.trim().toUpperCase();
  const orig = params.originIata.trim().toUpperCase();
  const isRt = params.roundtrip.trim().toLowerCase() === 'roundtrip';

  const depRaw = params.departDate?.trim();
  const depart = depRaw && ISO_DATE.test(depRaw) ? depRaw : defaultDepartIso();

  if (isRt) {
    const arrRaw = params.arriveDate?.trim();
    const ret = arrRaw && ISO_DATE.test(arrRaw) ? arrRaw : addDaysUtc(depart, 7);
    const q = `Flights to ${dest} from ${orig} on ${depart} through ${ret} business class round trip`;
    return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
  }
  const q = `Flights to ${dest} from ${orig} on ${depart} one way business class`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

/** Plain-text body for one route (Discord `content`). */
export function formatDiscordMistakeFareRouteContent(params: {
  originIata: string;
  destinationIata: string;
  originCity?: string;
  destinationCity?: string;
  roundtrip: string;
  price: number | null;
  cpm: number | null;
  airlineNames: string[];
  departDate?: string | null;
  arriveDate?: string | null;
}): string {
  const tripLabel = params.roundtrip.trim().toLowerCase() === 'roundtrip' ? 'Round-trip' : 'One-way';
  const oc = (params.originCity || '').trim();
  const dc = (params.destinationCity || '').trim();
  const oi = params.originIata.trim().toUpperCase();
  const di = params.destinationIata.trim().toUpperCase();
  const fromLabel = oc ? `${oc} (${oi})` : oi;
  const toLabel = dc ? `${dc} (${di})` : di;
  const priceText =
    params.price !== null && params.price !== undefined ? `${Math.round(Number(params.price))} USD` : 'n/a';
  const cpmText =
    params.cpm !== null && params.cpm !== undefined ? Number(params.cpm).toFixed(4) : 'n/a';
  const airlinesText = params.airlineNames.length ? params.airlineNames.join(', ') : 'Not available';
  const url = buildGoogleTravelFlightsBusinessUrl({
    originIata: oi,
    destinationIata: di,
    roundtrip: params.roundtrip,
    departDate: params.departDate,
    arriveDate: params.arriveDate,
  });
  return [
    `**Mistake Fare Alert**: ${fromLabel} → ${toLabel}`,
    `Trip: ${tripLabel} | Price: ${priceText} | CPM: ${cpmText}`,
    `Airlines: ${airlinesText}`,
    url,
  ].join('\n');
}

export function truncateDiscordContent(text: string, maxLen = MAX_CONTENT_LENGTH): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 20)}\n…(truncated)`;
}

export async function postDiscordWebhook(
  webhookUrl: string,
  payload: DiscordWebhookPayload
): Promise<{ ok: boolean; status: number; bodySnippet: string }> {
  const url = (webhookUrl || '').trim();
  if (!url) {
    return { ok: false, status: 0, bodySnippet: 'empty webhook url' };
  }

  const body: DiscordWebhookPayload = { ...payload };
  if (body.content) {
    body.content = truncateDiscordContent(body.content);
  }
  if (body.embeds?.length) {
    body.embeds = body.embeds.map((e) => ({
      ...e,
      description: e.description ? truncateDiscordContent(e.description, 4000) : e.description,
    }));
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const bodySnippet = text.slice(0, 200);
  const ok = res.status === 204 || (res.status >= 200 && res.status < 300);
  return { ok, status: res.status, bodySnippet };
}
