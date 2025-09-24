import type { AvailabilityFlight } from '@/types/availability';

export function extractFilterMetadata(
  itineraries: Record<string, Record<string, string[][]>>,
  flights: Record<string, AvailabilityFlight>
) {
  const metadata = {
    stops: new Set<number>(),
    airlines: new Set<string>(),
    airports: {
      origins: new Set<string>(),
      destinations: new Set<string>(),
      connections: new Set<string>(),
    },
    duration: { min: Infinity, max: -Infinity },
    departure: { min: Infinity, max: -Infinity },
    arrival: { min: Infinity, max: -Infinity },
    cabinClasses: { y: { min: 0, max: 100 }, w: { min: 0, max: 100 }, j: { min: 0, max: 100 }, f: { min: 0, max: 100 } },
  };

  for (const routeKey of Object.keys(itineraries)) {
    const routeSegments = routeKey.split('-');
    const stopCount = routeSegments.length - 2;
    metadata.stops.add(stopCount);

    const origin = routeSegments[0];
    const destination = routeSegments[routeSegments.length - 1];
    if (origin) metadata.airports.origins.add(origin);
    if (destination) metadata.airports.destinations.add(destination);
    for (let i = 1; i < routeSegments.length - 1; i++) {
      const connection = routeSegments[i];
      if (connection) metadata.airports.connections.add(connection);
    }

    const routeData = itineraries[routeKey];
    if (!routeData) continue;
    for (const date of Object.keys(routeData)) {
      const dateItineraries = routeData[date];
      if (!dateItineraries) continue;
      for (const itinerary of dateItineraries) {
        const flightObjs = itinerary.map(uuid => flights[uuid]).filter(Boolean);
        if (flightObjs.length === 0) continue;

        flightObjs.forEach(flight => {
          if (flight && flight.FlightNumbers) {
            const airlineCode = flight.FlightNumbers.slice(0, 2).toUpperCase();
            metadata.airlines.add(airlineCode);
          }
        });

        let totalDuration = 0;
        for (let i = 0; i < flightObjs.length; i++) {
          const currentFlight = flightObjs[i];
          const prevFlight = flightObjs[i - 1];
          if (!currentFlight) continue;
          totalDuration += currentFlight.TotalDuration;
          if (i > 0 && prevFlight && prevFlight.ArrivesAt && currentFlight.DepartsAt) {
            const prevArrive = new Date(prevFlight.ArrivesAt).getTime();
            const currDepart = new Date(currentFlight.DepartsAt).getTime();
            const layover = Math.max(0, Math.round((currDepart - prevArrive) / (1000 * 60)));
            totalDuration += layover;
          }
        }
        metadata.duration.min = Math.min(metadata.duration.min, totalDuration);
        metadata.duration.max = Math.max(metadata.duration.max, totalDuration);

        const firstFlight = flightObjs[0];
        const lastFlight = flightObjs[flightObjs.length - 1];
        if (!firstFlight?.DepartsAt || !lastFlight?.ArrivesAt) continue;
        const depTime = new Date(firstFlight.DepartsAt).getTime();
        const arrTime = new Date(lastFlight.ArrivesAt).getTime();
        metadata.departure.min = Math.min(metadata.departure.min, depTime);
        metadata.departure.max = Math.max(metadata.departure.max, depTime);
        metadata.arrival.min = Math.min(metadata.arrival.min, arrTime);
        metadata.arrival.max = Math.max(metadata.arrival.max, arrTime);
      }
    }
  }

  return {
    stops: Array.from(metadata.stops).sort((a, b) => a - b),
    airlines: Array.from(metadata.airlines).sort(),
    airports: {
      origins: Array.from(metadata.airports.origins).sort(),
      destinations: Array.from(metadata.airports.destinations).sort(),
      connections: Array.from(metadata.airports.connections).sort(),
    },
    duration: {
      min: metadata.duration.min === Infinity ? 0 : metadata.duration.min,
      max: metadata.duration.max === -Infinity ? 0 : metadata.duration.max,
    },
    departure: {
      min: metadata.departure.min === Infinity ? Date.now() : metadata.departure.min,
      max: metadata.departure.max === -Infinity ? Date.now() : metadata.departure.max,
    },
    arrival: {
      min: metadata.arrival.min === Infinity ? Date.now() : metadata.arrival.min,
      max: metadata.arrival.max === -Infinity ? Date.now() : metadata.arrival.max,
    },
    cabinClasses: metadata.cabinClasses,
  };
}
