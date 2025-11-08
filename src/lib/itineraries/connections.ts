import type { AvailabilityGroup, AvailabilityFlight } from '@/types/availability';
import { getFlightUUID } from '@/lib/itineraries/ids';
import { initializeCityGroups, isSameCity } from '@/lib/airports/city-groups';

export interface FlightMetadata {
  uuid: string;
  departureTime: number;
  arrivalTime: number;
  duration: number;
  airlineCode: string;
  originalFlight: AvailabilityFlight;
  fromAirport: string;
  toAirport: string;
}

export function precomputeFlightMetadata(segmentPool: Record<string, AvailabilityGroup[]>): Map<string, FlightMetadata> {
  const metadata = new Map<string, FlightMetadata>();
  for (const groups of Object.values(segmentPool)) {
    for (const group of groups) {
      for (const flight of group.flights) {
        const uuid = getFlightUUID(flight);
        if (!metadata.has(uuid)) {
          metadata.set(uuid, {
            uuid,
            departureTime: new Date(flight.DepartsAt).getTime(),
            arrivalTime: new Date(flight.ArrivesAt).getTime(),
            duration: flight.TotalDuration,
            airlineCode: flight.FlightNumbers.slice(0, 2).toUpperCase(),
            originalFlight: flight,
            fromAirport: group.originAirport,
            toAirport: group.destinationAirport,
          });
        }
      }
    }
  }
  return metadata;
}

export function canGroupsConnect(
  groupA: AvailabilityGroup,
  groupB: AvailabilityGroup,
  minConnectionMinutes = 45
): boolean {
  if (!groupA.earliestArrival || !groupA.latestArrival || !groupB.earliestDeparture || !groupB.latestDeparture) {
    return true;
  }
  const earliestArrivalA = new Date(groupA.earliestArrival).getTime();
  const latestArrivalA = new Date(groupA.latestArrival).getTime();
  const earliestDepartureB = new Date(groupB.earliestDeparture).getTime();
  const latestDepartureB = new Date(groupB.latestDeparture).getTime();
  const shortestConnection = (earliestDepartureB - latestArrivalA) / 60000;
  const longestConnection = (latestDepartureB - earliestArrivalA) / 60000;
  return longestConnection >= minConnectionMinutes && shortestConnection <= 24 * 60;
}

export function buildGroupConnectionMatrix(
  segmentPool: Record<string, AvailabilityGroup[]>,
  minConnectionMinutes = 45
): Map<string, Set<string>> {
  const groupConnections = new Map<string, Set<string>>();
  interface GroupWithTiming {
    group: AvailabilityGroup;
    key: string;
    segmentKey: string;
    earliestArrivalTime?: number;
    latestArrivalTime?: number;
    earliestDepartureTime?: number;
    latestDepartureTime?: number;
  }
  const groupsByOrigin = new Map<string, GroupWithTiming[]>();
  const allGroupKeys: string[] = [];
  const groupsWithTiming: GroupWithTiming[] = [];
  let groupIndex = 0;
  for (const [segmentKey, groups] of Object.entries(segmentPool)) {
    for (const group of groups) {
      const groupKey = `${segmentKey}:${group.date}:${group.alliance}:${groupIndex}`;
      allGroupKeys.push(groupKey);
      const earliestArrivalTime = group.earliestArrival ? new Date(group.earliestArrival).getTime() : undefined;
      const latestArrivalTime = group.latestArrival ? new Date(group.latestArrival).getTime() : undefined;
      const earliestDepartureTime = group.earliestDeparture ? new Date(group.earliestDeparture).getTime() : undefined;
      const latestDepartureTime = group.latestDeparture ? new Date(group.latestDeparture).getTime() : undefined;
      const groupData = { group, key: groupKey, segmentKey, earliestArrivalTime, latestArrivalTime, earliestDepartureTime, latestDepartureTime };
      groupsWithTiming.push(groupData);
      if (!groupsByOrigin.has(group.originAirport)) groupsByOrigin.set(group.originAirport, []);
      groupsByOrigin.get(group.originAirport)!.push(groupData);
      groupIndex++;
    }
  }
  for (const groupA of groupsWithTiming) {
    const validConnections = new Set<string>();
    
    
    // Find potential connections - both same airport and same city
    const potentialConnections: GroupWithTiming[] = [];
    
    // Same airport connections
    const sameAirportConnections = groupsByOrigin.get(groupA.group.destinationAirport) || [];
    potentialConnections.push(...sameAirportConnections);
    
    // Same city connections (cross-airport)
    for (const [originAirport, groups] of groupsByOrigin) {
      if (originAirport !== groupA.group.destinationAirport && 
          isSameCity(groupA.group.destinationAirport, originAirport)) {
        potentialConnections.push(...groups);
      }
    }
    
    
    for (const groupB of potentialConnections) {
      if (groupA.key === groupB.key) continue;
      
      
      // Determine MCT based on connection type
      const sameAirport = groupA.group.destinationAirport === groupB.group.originAirport;
      const sameCity = !sameAirport && isSameCity(groupA.group.destinationAirport, groupB.group.originAirport);
      const requiredMCT = sameAirport ? minConnectionMinutes : sameCity ? 240 : Infinity;
      
      
      if (
        groupA.earliestArrivalTime && groupA.latestArrivalTime &&
        groupB.earliestDepartureTime && groupB.latestDepartureTime
      ) {
        const shortestConnection = (groupB.earliestDepartureTime - groupA.latestArrivalTime) / 60000;
        const longestConnection = (groupB.latestDepartureTime - groupA.earliestArrivalTime) / 60000;
        
        
        if (longestConnection >= requiredMCT && shortestConnection <= 24 * 60) {
          validConnections.add(groupB.key);
        } else if (canGroupsConnect(groupA.group, groupB.group, requiredMCT)) {
          validConnections.add(groupB.key);
        }
      }
    }
    groupConnections.set(groupA.key, validConnections);
  }
  for (const groupKey of allGroupKeys) {
    if (!groupConnections.has(groupKey)) {
      groupConnections.set(groupKey, new Set<string>());
    }
  }
  return groupConnections;
}

export async function buildConnectionMatrix(
  metadata: Map<string, FlightMetadata>,
  segmentPool: Record<string, AvailabilityGroup[]>,
  groupConnections: Map<string, Set<string>>,
  minConnectionMinutes = 45
): Promise<Map<string, Set<string>>> {
  const connections = new Map<string, Set<string>>();
  const flightToGroup = new Map<string, string>();
  const groupToFlights = new Map<string, string[]>();

  // Initialize city groups
  await initializeCityGroups();

  let groupIndex = 0;
  for (const [segmentKey, groups] of Object.entries(segmentPool)) {
    for (const group of groups) {
      const groupKey = `${segmentKey}:${group.date}:${group.alliance}:${groupIndex}`;
      const groupFlights: string[] = [];
      for (const flight of group.flights) {
        const uuid = getFlightUUID(flight);
        flightToGroup.set(uuid, groupKey);
        groupFlights.push(uuid);
      }
      groupToFlights.set(groupKey, groupFlights);
      groupIndex++;
    }
  }

  for (const [flightUuid, flightMeta] of metadata) {
    const fromGroupKey = flightToGroup.get(flightUuid);
    if (!fromGroupKey) continue;

    const validConnections = new Set<string>();
    const connectedGroups = groupConnections.get(fromGroupKey);
    if (!connectedGroups) continue;


    for (const toGroupKey of connectedGroups) {
      const groupFlights = groupToFlights.get(toGroupKey);
      if (!groupFlights) continue;
      for (const toFlightUuid of groupFlights) {
        if (flightUuid === toFlightUuid) continue;
        const toFlightMeta = metadata.get(toFlightUuid);
        if (!toFlightMeta) continue;
        
        const diffMinutes = (toFlightMeta.departureTime - flightMeta.arrivalTime) / 60000;
        
        // Determine minimum connection time based on airport change
        const sameAirport = flightMeta.toAirport === toFlightMeta.fromAirport;
        const sameCity = !sameAirport && isSameCity(flightMeta.toAirport, toFlightMeta.fromAirport);
        
        const requiredMinConn = sameAirport ? 45 : sameCity ? 240 : Infinity;
        
        
        if (diffMinutes >= requiredMinConn && diffMinutes <= 24 * 60) {
          validConnections.add(toFlightUuid);
        }
      }
    }
    connections.set(flightUuid, validConnections);
  }

  return connections;
}


