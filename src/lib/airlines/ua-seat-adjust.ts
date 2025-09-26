import { PzRecord, UaSeatAdjustment } from '@/types/availability-v2';

export function adjustSeatCountsForUA(
  united: boolean,
  pzData: PzRecord[],
  flightNumber: string,
  originAirport: string,
  destinationAirport: string,
  date: string,
  yCount: number,
  jCount: number,
  seats: number
): UaSeatAdjustment {
  if (!united || !flightNumber.startsWith('UA')) {
    return { yCount, jCount };
  }

  const pzRecord = pzData.find(
    (record) =>
      record.flight_number === flightNumber &&
      record.origin_airport === originAirport &&
      record.destination_airport === destinationAirport &&
      record.departure_date === date
  );

  if (!pzRecord) {
    return { yCount, jCount };
  }

  let adjustedYCount = yCount;
  let adjustedJCount = jCount;

  if (pzRecord.in > seats) {
    adjustedJCount += 2.5;
  }
  if (pzRecord.xn > seats) {
    adjustedYCount += 2.5;
  }

  return { yCount: adjustedYCount, jCount: adjustedJCount };
}


