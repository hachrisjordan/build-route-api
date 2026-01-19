/**
 * FlightRadar24 Airport Cron Job
 * Processes airports sequentially every 12 hours
 */

const AIRPORTS = [
  'ABJ', 'ABV', 'ACC', 'ADD', 'ADL', 'ADZ', 'AER', 'AGA', 'AGP', 'AHU',
  'AKL', 'ALA', 'ALG', 'AMD', 'AMM', 'AMS', 'ANC', 'ANU', 'APW', 'AQJ',
  'ARN', 'ASB', 'ASM', 'ASU', 'ATH', 'ATL', 'ATQ', 'AUA', 'AUH', 'AUS',
  'AXM', 'AYT', 'BAH', 'BAQ', 'BCN', 'BDA', 'BDL', 'BEG', 'BEL', 'BEN',
  'BER', 'BEY', 'BGA', 'BGI', 'BGW', 'BHK', 'BHX', 'BIO', 'BJL', 'BJV',
  'BKK', 'BKO', 'BLQ', 'BLR', 'BNA', 'BNE', 'BOD', 'BOG', 'BOM', 'BON',
  'BOS', 'BRU', 'BSB', 'BSL', 'BSR', 'BUD', 'BUS', 'BVC', 'BWI', 'BZV',
  'CAI', 'CAN', 'CAY', 'CCS', 'CDG', 'CGK', 'CGN', 'CGO', 'CHC', 'CIX',
  'CKG', 'CKY', 'CLE', 'CLO', 'CLT', 'CMB', 'CMN', 'CNF', 'CNS', 'COO',
  'COR', 'CPH', 'CPT', 'CSX', 'CTA', 'CTG', 'CTS', 'CUC', 'CUN', 'CUR',
  'CVG', 'CXI', 'CZL', 'DAC', 'DAM', 'DAR', 'DBB', 'DBV', 'DEL', 'DEN',
  'DFW', 'DIL', 'DJE', 'DLA', 'DME', 'DMM', 'DOH', 'DPS', 'DRW', 'DSS',
  'DTW', 'DUB', 'DUR', 'DUS', 'DWC', 'DXB', 'DYU', 'EBB', 'EBL', 'EDI',
  'EFL', 'ELQ', 'ESB', 'EUN', 'EVN', 'EWR', 'EZE', 'FAO', 'FCO', 'FDF',
  'FEG', 'FEZ', 'FIH', 'FLL', 'FLN', 'FNC', 'FOC', 'FOR', 'FRA', 'FUK',
  'GDL', 'GEO', 'GIG', 'GLA', 'GOH', 'GOX', 'GRU', 'GRZ', 'GUA', 'GUM',
  'GVA', 'GYD', 'GYE', 'HAJ', 'HAM', 'HAN', 'HAV', 'HBE', 'HEL', 'HER',
  'HGH', 'HKG', 'HKT', 'HLD', 'HND', 'HNL', 'HRB', 'HRG', 'HSA', 'HTA',
  'HYD', 'IAD', 'IAH', 'ICN', 'IFN', 'IKA', 'IKT', 'IND', 'ISB', 'IST',
  'JAV', 'JED', 'JFK', 'JIB', 'JMK', 'JNB', 'JRO', 'JTR', 'JUB', 'KAN',
  'KBL', 'KEF', 'KGL', 'KHI', 'KIK', 'KIN', 'KIX', 'KOA', 'KRK', 'KTM',
  'KUL', 'KUS', 'KWI', 'KZN', 'LAD', 'LAS', 'LAX', 'LBV', 'LCA', 'LED',
  'LFW', 'LGW', 'LHE', 'LHR', 'LIM', 'LIR', 'LIS', 'LOS', 'LPA', 'LRM',
  'LUN', 'LUX', 'LXR', 'LYS', 'MAA', 'MAD', 'MAJ', 'MAN', 'MAO', 'MBA',
  'MBJ', 'MCO', 'MCT', 'MDE', 'MDZ', 'MED', 'MEL', 'MEX', 'MGQ', 'MHD',
  'MIA', 'MIR', 'MJI', 'MLA', 'MLE', 'MMX', 'MNL', 'MPL', 'MPM', 'MPN',
  'MRA', 'MRS', 'MRU', 'MSP', 'MSQ', 'MSY', 'MTY', 'MUC', 'MVD', 'MXP',
  'NAN', 'NAP', 'NAS', 'NAT', 'NBO', 'NCE', 'NCL', 'NDJ', 'NDR', 'NGO',
  'NIM', 'NJF', 'NKC', 'NKG', 'NQZ', 'NRT', 'NSI', 'NTE', 'NUE', 'NUM',
  'ONT', 'OOL', 'OPO', 'ORD', 'ORN', 'ORY', 'OSL', 'OTP', 'OUA', 'OUD',
  'OXB', 'PBM', 'PDL', 'PDX', 'PEI', 'PEK', 'PER', 'PFO', 'PHL', 'PHX',
  'PIT', 'PKX', 'PMI', 'PMO', 'PNR', 'POA', 'POM', 'POS', 'PPG', 'PPT',
  'PRG', 'PTP', 'PTY', 'PUJ', 'PUQ', 'PVG', 'PVK', 'PZU', 'RAI', 'RAK',
  'RAR', 'RBA', 'RDU', 'REC', 'RGL', 'RHO', 'RMF', 'RMO', 'ROB', 'ROR',
  'ROS', 'RSW', 'RUH', 'RUN', 'RZE', 'SAL', 'SAN', 'SAP', 'SAW', 'SCL',
  'SCO', 'SDQ', 'SEA', 'SEZ', 'SFO', 'SGN', 'SHE', 'SHJ', 'SID', 'SIN',
  'SJC', 'SJD', 'SJJ', 'SJO', 'SJU', 'SKD', 'SKG', 'SLA', 'SLC', 'SLL',
  'SMR', 'SNN', 'SOF', 'SPN', 'SPX', 'SSA', 'SSH', 'STI', 'STL', 'STN',
  'STR', 'SVO', 'SVQ', 'SXB', 'SXM', 'SYD', 'SYZ', 'SZG', 'SZX', 'TAS',
  'TBS', 'TBZ', 'TER', 'TFS', 'TFU', 'TGD', 'TIA', 'TIF', 'TIJ', 'TIV',
  'TLS', 'TLV', 'TMS', 'TNA', 'TNG', 'TNR', 'TPA', 'TPE', 'TRN', 'TUC',
  'TUN', 'TUU', 'TZX', 'UAK', 'UBN', 'UGC', 'UIO', 'URC', 'UVF', 'VCE',
  'VIE', 'VIL', 'VLC', 'VVI', 'VVO', 'VXE', 'WAW', 'WDH', 'WNZ', 'WRO',
  'WUH', 'XIY', 'XMN', 'YEG', 'YHZ', 'YNB', 'YOW', 'YQB', 'YUL', 'YVR',
  'YYC', 'YYT', 'YYZ', 'ZAG', 'ZNZ', 'ZRH'
];

const API_URL = process.env.API_URL || 'http://localhost:3000';
const DELAY_BETWEEN_AIRPORTS = 5000; // 5 seconds delay between airports

/**
 * Process a single airport
 */
async function processAirport(airport: string, index: number, total: number): Promise<boolean> {
  try {
    console.log(`[FR24 Airport Cron] Processing ${airport} (${index + 1}/${total})...`);
    
    const url = `${API_URL}/api/flightradar24/airport/${airport}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[FR24 Airport Cron] Failed to process ${airport}: ${response.status} ${response.statusText}`);
      console.error(`[FR24 Airport Cron] Error details: ${errorText.substring(0, 200)}`);
      return false;
    }

    const data = await response.json();
    const flightCount = Array.isArray(data) ? data.length : 0;
    console.log(`[FR24 Airport Cron] ✅ ${airport}: ${flightCount} flights processed`);
    return true;

  } catch (error) {
    console.error(`[FR24 Airport Cron] Error processing ${airport}:`, error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Main cron job function
 */
async function runCronJob() {
  console.log(`[FR24 Airport Cron] Starting job at ${new Date().toISOString()}`);
  console.log(`[FR24 Airport Cron] Processing ${AIRPORTS.length} airports sequentially`);
  
  let successCount = 0;
  let failureCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < AIRPORTS.length; i++) {
    const airport = AIRPORTS[i]!;
    const success = await processAirport(airport, i, AIRPORTS.length);
    
    if (success) {
      successCount++;
    } else {
      failureCount++;
    }

    // Add delay between airports (except for the last one)
    if (i < AIRPORTS.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_AIRPORTS));
    }
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  const durationMinutes = Math.round(duration / 60);

  console.log(`[FR24 Airport Cron] Job completed:`);
  console.log(`[FR24 Airport Cron] - Total airports: ${AIRPORTS.length}`);
  console.log(`[FR24 Airport Cron] - Successful: ${successCount}`);
  console.log(`[FR24 Airport Cron] - Failed: ${failureCount}`);
  console.log(`[FR24 Airport Cron] - Duration: ${durationMinutes} minutes (${duration} seconds)`);
}

// Run the cron job if this script is executed directly
if (require.main === module) {
  runCronJob()
    .then(() => {
      console.log('[FR24 Airport Cron] Job finished successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[FR24 Airport Cron] Job failed:', error);
      process.exit(1);
    });
}

export { runCronJob };
