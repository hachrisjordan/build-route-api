import { parseCsvParam, parseNumberCsvParam } from '@/lib/http/params';

export function buildFilterParamsFromUrl(url: string) {
  const { searchParams } = new URL(url);
  const stops = parseNumberCsvParam(searchParams.get('stops'));
  const includeAirlines = parseCsvParam(searchParams.get('includeAirlines')).map(s => s.toUpperCase());
  const excludeAirlines = parseCsvParam(searchParams.get('excludeAirlines')).map(s => s.toUpperCase());
  const maxDuration = searchParams.get('maxDuration') ? Number(searchParams.get('maxDuration')) : undefined;
  const minYPercent = searchParams.get('minYPercent') ? Number(searchParams.get('minYPercent')) : undefined;
  const minWPercent = searchParams.get('minWPercent') ? Number(searchParams.get('minWPercent')) : undefined;
  const minJPercent = searchParams.get('minJPercent') ? Number(searchParams.get('minJPercent')) : undefined;
  const minFPercent = searchParams.get('minFPercent') ? Number(searchParams.get('minFPercent')) : undefined;
  const depTimeMin = searchParams.get('depTimeMin') ? Number(searchParams.get('depTimeMin')) : undefined;
  const depTimeMax = searchParams.get('depTimeMax') ? Number(searchParams.get('depTimeMax')) : undefined;
  const arrTimeMin = searchParams.get('arrTimeMin') ? Number(searchParams.get('arrTimeMin')) : undefined;
  const arrTimeMax = searchParams.get('arrTimeMax') ? Number(searchParams.get('arrTimeMax')) : undefined;
  const includeOrigin = parseCsvParam(searchParams.get('includeOrigin'));
  const includeDestination = parseCsvParam(searchParams.get('includeDestination'));
  const includeConnection = parseCsvParam(searchParams.get('includeConnection'));
  const excludeOrigin = parseCsvParam(searchParams.get('excludeOrigin'));
  const excludeDestination = parseCsvParam(searchParams.get('excludeDestination'));
  const excludeConnection = parseCsvParam(searchParams.get('excludeConnection'));
  const search = searchParams.get('search') || undefined;
  let sortBy = searchParams.get('sortBy') || undefined;
  let sortOrder = (searchParams.get('sortOrder') as 'asc' | 'desc') || 'asc';
  if (!sortBy) {
    sortBy = 'duration';
    sortOrder = 'asc';
  }
  let page = parseInt(searchParams.get('page') || '1', 10);
  page = isNaN(page) || page < 1 ? 1 : page;
  const pageSize = parseInt(searchParams.get('pageSize') || '10', 10);
  return {
    stops,
    includeAirlines,
    excludeAirlines,
    maxDuration,
    minYPercent,
    minWPercent,
    minJPercent,
    minFPercent,
    depTimeMin,
    depTimeMax,
    arrTimeMin,
    arrTimeMax,
    includeOrigin,
    includeDestination,
    includeConnection,
    excludeOrigin,
    excludeDestination,
    excludeConnection,
    search,
    sortBy,
    sortOrder,
    page,
    pageSize,
  };
}


