import type { FullRoutePathResult } from '@/types/route';
import type { AvailabilityGroup } from '@/types/availability';

export function prefilterValidRoutes(
  routes: FullRoutePathResult[],
  filteredSegmentPool: Record<string, AvailabilityGroup[]>
) {
  const allRoutes = routes;
  const validRoutes = allRoutes.filter(route => {
    const codes = [route.O, route.A, route.h1, route.h2, route.B, route.D].filter((c): c is string => !!c);
    if (codes.length < 2) return false;
    for (let i = 0; i < codes.length - 1; i++) {
      const from = codes[i];
      const to = codes[i + 1];
      if (!from || !to) return false;
      const segKey = `${from}-${to}`;
      const availability = filteredSegmentPool[segKey];
      if (!availability || availability.length === 0) return false;
    }
    return true;
  });
  return { allRoutes, validRoutes };
}


