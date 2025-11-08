export function getClassPercentages(
  flights: any[],
  minReliabilityPercent: number = 100
) {
  const totalFlightDuration = flights.reduce((sum, f) => sum + f.TotalDuration, 0);
  
  const reliabilityThreshold = (100 - minReliabilityPercent) / 100;
  const threshold = reliabilityThreshold * totalFlightDuration;
  
  // Adjust counts based on Partner fields
  const adjusted = flights.map((f) => {
    const overThreshold = f.TotalDuration > threshold;
    const markAsUnreliable = overThreshold;
    return {
      YCount: markAsUnreliable && !f.YPartner ? 0 : f.YCount,
      WCount: markAsUnreliable && !f.WPartner ? 0 : f.WCount,
      JCount: markAsUnreliable && !f.JPartner ? 0 : f.JCount,
      FCount: markAsUnreliable && !f.FPartner ? 0 : f.FCount,
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
