const flightNumberCache = new Map<string, string>();

export function normalizeFlightNumber(flightNumber: string): string {
  const cached = flightNumberCache.get(flightNumber);
  if (cached) return cached;

  const match = flightNumber.match(/^([A-Z]{2,3})(0*)(\d+)$/i);
  let normalized = flightNumber;
  if (match && match[1] && match[3]) {
    const airlinePrefix: string = match[1];
    const flightNumericPart: string = match[3];
    normalized = `${airlinePrefix.toUpperCase()}${parseInt(flightNumericPart, 10)}`;
  }

  flightNumberCache.set(flightNumber, normalized);
  return normalized;
}


