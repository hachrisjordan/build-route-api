import { getReliabilityTableCached, getReliabilityMap } from '@/lib/reliability-cache';

export async function getReliabilityData() {
  const table = await getReliabilityTableCached();
  const map = getReliabilityMap(table);
  return { table, map };
}


