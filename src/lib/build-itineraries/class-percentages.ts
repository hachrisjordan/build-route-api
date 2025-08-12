import { AvailabilityFlight } from './types';

export function getClassPercentages(
  flights: AvailabilityFlight[],
  reliability?: Record<string, { min_count: number; exemption?: string }>,
  minReliabilityPercent: number = 100
) {
  const totalFlightDuration = flights.reduce((sum, f) => sum + f.TotalDuration, 0);

  if (!reliability) {
    const y = flights.every(f => f.YCount > 0) ? 100 : 0;

    let w = 0;
    if (flights.some(f => f.WCount > 0)) {
      const wDuration = flights.filter(f => f.WCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
      w = Math.round((wDuration / totalFlightDuration) * 100);
    }

    let j = 0;
    if (flights.some(f => f.JCount > 0)) {
      const jDuration = flights.filter(f => f.JCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
      j = Math.round((jDuration / totalFlightDuration) * 100);
    }

    let f = 0;
    if (flights.some(f => f.FCount > 0)) {
      const fDuration = flights.filter(f => f.FCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
      f = Math.round((fDuration / totalFlightDuration) * 100);
    }
    return { y, w, j, f };
  }

  const reliabilityThreshold = (100 - minReliabilityPercent) / 100;
  const threshold = reliabilityThreshold * totalFlightDuration;

  const adjusted = flights.map((f, index) => {
    const code = f.FlightNumbers.slice(0, 2);
    const rel = reliability[code];
    const min = rel?.min_count ?? 1;
    const exemption = rel?.exemption || '';
    const minY = exemption.includes('Y') ? 1 : min;
    const minW = exemption.includes('W') ? 1 : min;
    const minJ = exemption.includes('J') ? 1 : min;
    const minF = exemption.includes('F') ? 1 : min;

    const overThreshold = f.TotalDuration > threshold;

    const markAsUnreliable = overThreshold;

    return {
      YCount: markAsUnreliable && f.YCount < minY ? 0 : f.YCount,
      WCount: markAsUnreliable && f.WCount < minW ? 0 : f.WCount,
      JCount: markAsUnreliable && f.JCount < minJ ? 0 : f.JCount,
      FCount: markAsUnreliable && f.FCount < minF ? 0 : f.FCount,
      TotalDuration: f.TotalDuration,
    };
  });

  const y = adjusted.every(f => f.YCount > 0) ? 100 : 0;

  let w = 0;
  if (adjusted.some(f => f.WCount > 0)) {
    const wDuration = adjusted.filter(f => f.WCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
    w = Math.round((wDuration / totalFlightDuration) * 100);
  }

  let j = 0;
  if (adjusted.some(f => f.JCount > 0)) {
    const jDuration = adjusted.filter(f => f.JCount > 0).reduce((sum, f) => sum + f.TotalDuration, 0);
    j = Math.round((jDuration / totalFlightDuration) * 100);
  }

  let f = 0;
  if (adjusted.some(flt => flt.FCount > 0)) {
    const fDuration = adjusted.filter(flt => flt.FCount > 0).reduce((sum, flt) => sum + flt.TotalDuration, 0);
    f = Math.round((fDuration / totalFlightDuration) * 100);
  }

  return { y, w, j, f };
}