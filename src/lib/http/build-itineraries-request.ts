import { NextRequest } from 'next/server';
import { buildItinerariesSchema } from '@/lib/validation/build-itineraries';
import { ValidationError } from '@/lib/http/errors';

export type BuildItinerariesInput = typeof buildItinerariesSchema._type;

export async function parseBuildItinerariesRequest(req: NextRequest): Promise<BuildItinerariesInput> {
  const body = await req.json();
  const parseResult = buildItinerariesSchema.safeParse(body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid input', parseResult.error.errors);
  }
  return parseResult.data;
}


