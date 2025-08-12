import { createHash } from 'crypto';
import zlib from 'zlib';

let valkey: any = null;

export function getValkeyClient(): any {
  if (valkey) return valkey;
  const host = process.env.VALKEY_HOST;
  const port = process.env.VALKEY_PORT ? parseInt(process.env.VALKEY_PORT, 10) : 6379;
  const password = process.env.VALKEY_PASSWORD;
  if (!host) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  valkey = new (require('iovalkey'))({ host, port, password });
  return valkey;
}

export async function getCachedAvailabilityV2Response(params: any) {
  const client = getValkeyClient();
  if (!client) return null;
  try {
    const hash = createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const key = `availability-v2-response:${hash}`;
    const compressed = await client.getBuffer(key);
    if (!compressed) return null;
    const json = zlib.gunzipSync(compressed).toString();
    return JSON.parse(json);
  } catch (err) {
    console.error('Valkey getCachedAvailabilityV2Response error:', err);
    return null;
  }
}