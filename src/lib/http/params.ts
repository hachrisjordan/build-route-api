export function parseCsvParam(param: string | null): string[] {
  if (!param) return [];
  return param.split(',').map(s => s.trim()).filter(Boolean);
}

export function parseNumberCsvParam(param: string | null): number[] {
  return parseCsvParam(param).map(Number).filter(n => !isNaN(n));
}
