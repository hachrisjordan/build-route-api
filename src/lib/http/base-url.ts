import { NextRequest } from 'next/server';
import { getSanitizedEnv } from '@/lib/env-utils';

export function buildBaseUrl(req: NextRequest): string {
  let baseUrl = getSanitizedEnv('NEXT_PUBLIC_BASE_URL');
  if (!baseUrl) {
    const proto = req.headers.get('x-forwarded-proto') || 'http';
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000';
    const sanitizedProto = proto.replace(/[^\x00-\x7F]/g, '');
    const sanitizedHost = host.replace(/[^\x00-\x7F]/g, '');
    baseUrl = `${sanitizedProto}://${sanitizedHost}`;
  }

  try {
    // Validate URL; throws if invalid
    // eslint-disable-next-line no-new
    new URL(baseUrl);
  } catch {
    baseUrl = 'http://localhost:3000';
  }
  
  // For VPS deployment with individual containers, keep localhost:3000 for internal calls
  // since all services are running on the same host
  // No need to change the port - internal API calls should use the same port as the main service
  
  return baseUrl;
}


