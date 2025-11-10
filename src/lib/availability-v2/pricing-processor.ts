import { createHash } from 'crypto';
import { PricingEntry, PricingSource } from '@/types/availability-v2';

/**
 * Maps source names to airline codes
 */
const SOURCE_TO_AIRLINE_CODE: Record<string, string> = {
  'eurobonus': 'SK',
  'virginatlantic': 'VS',
  'aeromexico': 'AM',
  'american': 'AA',
  'delta': 'DL',
  'etihad': 'EY',
  'united': 'UA',
  'emirates': 'EK',
  'aeroplan': 'AC',
  'alaska': 'AS',
  'velocity': 'VA',
  'qantas': 'QF',
  'connectmiles': 'CM',
  'azul': 'AD',
  'smiles': 'G3',
  'flyingblue': 'AF',
  'jetblue': 'B6',
  'qatar': 'QR',
  'turkish': 'TK',
  'singapore': 'SQ',
  'ethiopian': 'ET',
  'saudia': 'SV',
  'finnair': 'AY',
  'lufthansa': 'LH'
};

/**
 * Processes raw seats.aero data to extract and aggregate pricing information
 * Groups by flight number + date combination across multiple sources
 */
export function processPricingData(pages: any[]): PricingEntry[] {
  // Use nested Map for O(1) source lookups instead of O(n) array.find()
  const pricingMap = new Map<string, {
    id: string;
    flightnumbers: string;
    date: string;
    DepartsAt: string;
    ArrivesAt: string;
    departingAirport: string;
    arrivingAirport: string;
    pricing: Map<string, PricingSource>;
  }>();
  
  for (const page of pages) {
    if (!page?.data?.length) continue;

    for (const item of page.data) {
      if (!item.AvailabilityTrips?.length) continue;

      const itemDate = item.Date;
      
      for (const trip of item.AvailabilityTrips) {
        const flightNumbers = trip.FlightNumbers || '';
        const rawSource = trip.Source || '';
        const source = SOURCE_TO_AIRLINE_CODE[rawSource.toLowerCase()] || rawSource;
        const cabin = trip.Cabin?.toLowerCase() || '';
        const mileageCost = trip.MileageCost || 0;
        const totalTaxes = trip.TotalTaxes || 0;
        const taxesCurrency = trip.TaxesCurrency || item.TaxesCurrency || null;
        const departsAt = (trip.DepartsAt || '').replace('Z', '');
        const arrivesAt = (trip.ArrivesAt || '').replace('Z', '');
        const departingAirport = trip.OriginAirport || '';
        const arrivingAirport = trip.DestinationAirport || '';
        
        if (!flightNumbers || !itemDate) continue;
        
        // Create unique key for grouping
        const groupKey = `${flightNumbers}-${itemDate}`;
        
        // Get or create pricing entry
        let pricingEntry = pricingMap.get(groupKey);
        if (!pricingEntry) {
          // Generate deterministic UUID based on flight numbers + date
          const id = generateUUID(groupKey);
          
          // Create new pricing entry with Map for sources
          const sourcesMap = new Map<string, PricingSource>();
          const newSource: PricingSource = {
            source,
            YPrice: null,
            YTaxes: null,
            WPrice: null,
            WTaxes: null,
            JPrice: null,
            JTaxes: null,
            FPrice: null,
            FTaxes: null,
            TaxesCurrency: taxesCurrency
          };
          updatePricingFields(newSource, cabin, mileageCost, totalTaxes, taxesCurrency);
          sourcesMap.set(source, newSource);
          
          pricingEntry = {
            id,
            flightnumbers: flightNumbers,
            date: itemDate,
            DepartsAt: departsAt,
            ArrivesAt: arrivesAt,
            departingAirport: departingAirport,
            arrivingAirport: arrivingAirport,
            pricing: sourcesMap
          };
          pricingMap.set(groupKey, pricingEntry);
        } else {
          // O(1) Map lookup instead of O(n) array.find()
          const existingSource = pricingEntry.pricing.get(source);
          if (existingSource) {
            // Update existing source with new pricing data
            updatePricingFields(existingSource, cabin, mileageCost, totalTaxes, taxesCurrency);
          } else {
            // Create new source entry
            const newSource: PricingSource = {
              source,
              YPrice: null,
              YTaxes: null,
              WPrice: null,
              WTaxes: null,
              JPrice: null,
              JTaxes: null,
              FPrice: null,
              FTaxes: null,
              TaxesCurrency: taxesCurrency
            };
            updatePricingFields(newSource, cabin, mileageCost, totalTaxes, taxesCurrency);
            pricingEntry.pricing.set(source, newSource);
          }
        }
      }
    }
  }
  
  // Convert nested Map structure back to array format for API response
  return Array.from(pricingMap.values()).map(entry => ({
    id: entry.id,
    flightnumbers: entry.flightnumbers,
    date: entry.date,
    DepartsAt: entry.DepartsAt,
    ArrivesAt: entry.ArrivesAt,
    departingAirport: entry.departingAirport,
    arrivingAirport: entry.arrivingAirport,
    pricing: Array.from(entry.pricing.values())
  }));
}

/**
 * Updates pricing fields based on cabin type
 */
function updatePricingFields(
  pricingSource: PricingSource,
  cabin: string,
  mileageCost: number,
  totalTaxes: number,
  taxesCurrency: string | null
): void {
  // Update currency information if not already set
  if (taxesCurrency && !pricingSource.TaxesCurrency) {
    pricingSource.TaxesCurrency = taxesCurrency;
  }

  switch (cabin) {
    case 'economy':
      pricingSource.YPrice = mileageCost;
      pricingSource.YTaxes = totalTaxes;
      break;
    case 'premium':
      pricingSource.WPrice = mileageCost;
      pricingSource.WTaxes = totalTaxes;
      break;
    case 'business':
      pricingSource.JPrice = mileageCost;
      pricingSource.JTaxes = totalTaxes;
      break;
    case 'first':
      pricingSource.FPrice = mileageCost;
      pricingSource.FTaxes = totalTaxes;
      break;
  }
}

/**
 * Generates a deterministic UUID based on flight numbers and date
 */
function generateUUID(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  // Format as UUID v4
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16), // Version 4
    ((parseInt(hash.substring(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.substring(17, 19), // Variant bits
    hash.substring(19, 31)
  ].join('-');
}
