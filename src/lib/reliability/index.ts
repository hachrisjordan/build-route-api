export function getCountMultiplier({
  code,
  cabin,
  source,
  reliabilityTable,
}: {
  code: string;
  cabin: string;
  source: string;
  reliabilityTable: Array<{
    code: string;
    min_count?: number;
    exemption?: string;
    ffp_program?: string[];
  }>;
}): number {
  const entry = reliabilityTable.find((r) => r.code === code);
  if (!entry) return 1;

  const cabinInitial = (cabin || '').slice(0, 1).toUpperCase();
  if (
    entry.exemption &&
    typeof entry.exemption === 'string' &&
    entry.exemption.toUpperCase() === cabinInitial
  ) {
    return 1;
  }

  if (Array.isArray(entry.ffp_program) && entry.ffp_program.length > 0) {
    if (entry.ffp_program.includes(source)) return entry.min_count || 1;
  }

  return 1;
}


