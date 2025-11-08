export function getTotalDuration(flights: (any | undefined)[]): number {
  let total = 0;
  for (let i = 0; i < flights.length; i++) {
    const flight = flights[i];
    if (!flight) continue;
    total += flight.TotalDuration;
    if (i > 0 && flights[i - 1]) {
      const prevArrive = new Date(flights[i - 1].ArrivesAt).getTime();
      const currDepart = new Date(flight.DepartsAt).getTime();
      const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
      total += layover;
    }
  }
  return total;
}

export function getSortValue(
  card: any,
  flights: Record<string, any>,
  sortBy: string,
  minReliabilityPercent: number,
  getClassPercentages: (flightsArr: any[], minReliabilityPercent: number) => { y: number; w: number; j: number; f: number }
) {
  const flightObjs = card.itinerary.map((id: string) => flights[id]);
  if (sortBy === 'duration') return getTotalDuration(flightObjs);
  if (sortBy === 'departure') return new Date(flightObjs[0].DepartsAt).getTime();
  if (sortBy === 'arrival') return new Date(flightObjs[flightObjs.length - 1].ArrivesAt).getTime();
  if (['y', 'w', 'j', 'f'].includes(sortBy)) {
    return getClassPercentages(flightObjs, minReliabilityPercent)[sortBy as 'y' | 'w' | 'j' | 'f'];
  }
  return 0;
}

export function filterSortSearchPaginate(
  cards: Array<{ route: string; date: string; itinerary: string[] }>,
  flights: Record<string, any>,
  minReliabilityPercent: number,
  query: {
    stops?: number[];
    includeAirlines?: string[];
    excludeAirlines?: string[];
    maxDuration?: number;
    minYPercent?: number;
    minWPercent?: number;
    minJPercent?: number;
    minFPercent?: number;
    depTimeMin?: number;
    depTimeMax?: number;
    arrTimeMin?: number;
    arrTimeMax?: number;
    includeOrigin?: string[];
    includeDestination?: string[];
    includeConnection?: string[];
    excludeOrigin?: string[];
    excludeDestination?: string[];
    excludeConnection?: string[];
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
  },
  getSortValueFn: typeof getSortValue,
  getTotalDurationFn: typeof getTotalDuration,
  getClassPercentages: (flightsArr: any[], minReliabilityPercent: number) => { y: number; w: number; j: number; f: number }
) {
  let result = cards;
  if (query.stops && query.stops.length > 0) {
    result = result.filter(card => query.stops!.includes(card.route.split('-').length - 2));
  }
  if (query.includeAirlines && query.includeAirlines.length > 0) {
    result = result.filter(card => {
      const airlineCodes = card.itinerary.map(fid => flights[fid]?.FlightNumbers.slice(0, 2).toUpperCase());
      return airlineCodes.some(code => query.includeAirlines!.includes(code));
    });
  }
  if (query.excludeAirlines && query.excludeAirlines.length > 0) {
    result = result.filter(card => {
      const airlineCodes = card.itinerary.map(fid => flights[fid]?.FlightNumbers.slice(0, 2).toUpperCase());
      return !airlineCodes.some(code => query.excludeAirlines!.includes(code));
    });
  }
  if (typeof query.maxDuration === 'number') {
    result = result.filter(card => {
      const flightsArr = card.itinerary.map(fid => flights[fid]).filter(Boolean);
      return getTotalDurationFn(flightsArr) <= query.maxDuration!;
    });
  }
  if (
    (typeof query.minYPercent === 'number' && query.minYPercent > 0) ||
    (typeof query.minWPercent === 'number' && query.minWPercent > 0) ||
    (typeof query.minJPercent === 'number' && query.minJPercent > 0) ||
    (typeof query.minFPercent === 'number' && query.minFPercent > 0)
  ) {
    result = result.filter(card => {
      const flightsArr = card.itinerary.map(fid => flights[fid]).filter(Boolean);
      if (flightsArr.length === 0) return false;
      const { y, w, j, f } = getClassPercentages(flightsArr, minReliabilityPercent);
      return (
        (typeof query.minYPercent !== 'number' || y >= query.minYPercent) &&
        (typeof query.minWPercent !== 'number' || w >= query.minWPercent) &&
        (typeof query.minJPercent !== 'number' || j >= query.minJPercent) &&
        (typeof query.minFPercent !== 'number' || f >= query.minFPercent)
      );
    });
  }
  if (typeof query.depTimeMin === 'number' || typeof query.depTimeMax === 'number' || typeof query.arrTimeMin === 'number' || typeof query.arrTimeMax === 'number') {
    result = result.filter(card => {
      const flightsArr = card.itinerary.map(fid => flights[fid]).filter(Boolean);
      if (!flightsArr.length) return false;
      const dep = new Date(flightsArr[0].DepartsAt).getTime();
      const arr = new Date(flightsArr[flightsArr.length - 1].ArrivesAt).getTime();
      if (typeof query.depTimeMin === 'number' && dep < query.depTimeMin) return false;
      if (typeof query.depTimeMax === 'number' && dep > query.depTimeMax) return false;
      if (typeof query.arrTimeMin === 'number' && arr < query.arrTimeMin) return false;
      if (typeof query.arrTimeMax === 'number' && arr > query.arrTimeMax) return false;
      return true;
    });
  }
  if ((query.includeOrigin && query.includeOrigin.length) || (query.includeDestination && query.includeDestination.length) || (query.includeConnection && query.includeConnection.length)) {
    result = result.filter(card => {
      const segs = card.route.split('-');
      const origin = segs[0] || '';
      const destination = segs[segs.length - 1] || '';
      const connections = segs.slice(1, -1);
      let match = true;
      if (query.includeOrigin && query.includeOrigin.length) match = match && query.includeOrigin.includes(origin);
      if (query.includeDestination && query.includeDestination.length) match = match && query.includeDestination.includes(destination);
      if (query.includeConnection && query.includeConnection.length) match = match && connections.some(c => query.includeConnection!.includes(c));
      return match;
    });
  }
  if ((query.excludeOrigin && query.excludeOrigin.length) || (query.excludeDestination && query.excludeDestination.length) || (query.excludeConnection && query.excludeConnection.length)) {
    result = result.filter(card => {
      const segs = card.route.split('-');
      const origin = segs[0] || '';
      const destination = segs[segs.length - 1] || '';
      const connections = segs.slice(1, -1);
      let match = true;
      if (query.excludeOrigin && query.excludeOrigin.length) match = match && !query.excludeOrigin.includes(origin);
      if (query.excludeDestination && query.excludeDestination.length) match = match && !query.excludeDestination.includes(destination);
      if (query.excludeConnection && query.excludeConnection.length) match = match && !connections.some(c => query.excludeConnection!.includes(c));
      return match;
    });
  }
  if (query.search && query.search.trim()) {
    const terms = query.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    result = result.filter(card => {
      return terms.every(term => {
        if (card.route.toLowerCase().includes(term)) return true;
        if (card.date.toLowerCase().includes(term)) return true;
        return card.itinerary.some(fid => {
          const flight = flights[fid];
          return flight && flight.FlightNumbers.toLowerCase().includes(term);
        });
      });
    });
  }
  if (query.sortBy) {
    result = result.sort((a, b) => {
      const aVal = getSortValueFn(a, flights, query.sortBy!, minReliabilityPercent, getClassPercentages);
      const bVal = getSortValueFn(b, flights, query.sortBy!, minReliabilityPercent, getClassPercentages);
      if (aVal !== bVal) {
        if (["arrival", "y", "w", "j", "f"].includes(query.sortBy!)) {
          return query.sortOrder === 'asc' ? bVal - aVal : bVal - aVal;
        }
        if (["duration", "departure"].includes(query.sortBy!)) {
          return query.sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
        }
        return query.sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      }
      const aFlights = a.itinerary.map((fid: string) => flights[fid]).filter(Boolean);
      const bFlights = b.itinerary.map((fid: string) => flights[fid]).filter(Boolean);
      const aDur = getTotalDurationFn(aFlights);
      const bDur = getTotalDurationFn(bFlights);
      return aDur - bDur;
    });
  }
  const total = result.length;
  const page = query.page || 1;
  const pageSize = query.pageSize || 10;
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const pageData = result.slice(start, end);
  return { total, page, pageSize, data: pageData };
}


