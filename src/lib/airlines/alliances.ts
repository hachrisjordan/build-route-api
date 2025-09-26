export const ALLIANCE_MAP = new Map<string, string>([
  // Star Alliance
  ['A3', 'SA'], ['AC', 'SA'], ['CA', 'SA'], ['AI', 'SA'], ['NZ', 'SA'], ['NH', 'SA'],
  ['OZ', 'SA'], ['OS', 'SA'], ['AV', 'SA'], ['SN', 'SA'], ['CM', 'SA'], ['OU', 'SA'],
  ['MS', 'SA'], ['ET', 'SA'], ['BR', 'SA'], ['LO', 'SA'], ['LH', 'SA'], ['CL', 'SA'],
  ['ZH', 'SA'], ['SQ', 'SA'], ['SA', 'SA'], ['LX', 'SA'], ['TP', 'SA'], ['TG', 'SA'],
  ['TK', 'SA'], ['UA', 'SA'],
  // SkyTeam
  ['AR', 'ST'], ['AM', 'ST'], ['UX', 'ST'], ['AF', 'ST'], ['CI', 'ST'], ['MU', 'ST'],
  ['DL', 'ST'], ['GA', 'ST'], ['KQ', 'ST'], ['ME', 'ST'], ['KL', 'ST'], ['KE', 'ST'],
  ['SV', 'ST'], ['SK', 'ST'], ['RO', 'ST'], ['VN', 'ST'], ['VS', 'ST'], ['MF', 'ST'],
  // OneWorld
  ['AS', 'OW'], ['AA', 'OW'], ['BA', 'OW'], ['CX', 'OW'], ['FJ', 'OW'], ['AY', 'OW'],
  ['IB', 'OW'], ['JL', 'OW'], ['QF', 'OW'], ['QR', 'OW'], ['RJ', 'OW'], ['AT', 'OW'],
  ['UL', 'OW'], ['MH', 'OW'], ['WY', 'OW'],
  // Individual carriers
  ['EY', 'EY'], ['EK', 'EK'], ['JX', 'JX'], ['B6', 'B6'], ['GF', 'GF'], ['DE', 'DE'], ['GF', 'GF'], ['LY', 'LY'],
  ['LA', 'LA'],
  ['HA', 'HA'],
  ['VA', 'VA'],
  ['G3', 'G3'],
  ['AD', 'AD']
]);

export function getAlliance(flightPrefix: string): string | undefined {
  return ALLIANCE_MAP.get(flightPrefix);
}


