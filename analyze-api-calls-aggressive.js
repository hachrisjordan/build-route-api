const fs = require('fs');

// Load dataset
const routes = JSON.parse(fs.readFileSync('dataset.json', 'utf-8'));

// Load route count data
const routeCountData = new Map();
const csvData = fs.readFileSync('csv-output/route_count.csv', 'utf-8');
const lines = csvData.split('\n').slice(1);

for (const line of lines) {
  const [origin, destination, count] = line.trim().split(',');
  if (origin && destination && count) {
    routeCountData.set(`${origin},${destination}`, parseInt(count, 10));
  }
}

const DAYS = 14;
const MAX_RESULTS = 1000;
const TARGET_UTILIZATION = 0.85; // Aim for 850+ results per call

// Calculate results
function calculateResults(origins, destinations, days) {
  let total = 0;
  for (const origin of origins) {
    for (const destination of destinations) {
      const key = `${origin},${destination}`;
      const perDay = routeCountData.get(key) || 5;
      total += perDay * days;
    }
  }
  return total;
}

// ULTRA AGGRESSIVE: Pack everything possible into bins using First-Fit Decreasing
function aggressivePackRoutes(routes, days, maxResults) {
  // Sort routes by estimated results (DESCENDING) - key for FFD algorithm
  const routesWithEstimates = routes.map(route => {
    const [origin, destination] = route.split('-');
    const perDay = routeCountData.get(`${origin},${destination}`) || 5;
    return {
      route,
      origin,
      destination,
      estimate: perDay * days
    };
  });
  
  // Sort descending by estimate
  routesWithEstimates.sort((a, b) => b.estimate - a.estimate);
  
  const bins = [];
  const remaining = new Set(routesWithEstimates.map(r => r.route));
  
  while (remaining.size > 0) {
    const currentBin = {
      origins: new Set(),
      destinations: new Set(),
      routes: []
    };
    
    let currentEstimate = 0;
    let addedInThisPass = true;
    
    // Keep trying to add routes until nothing fits
    while (addedInThisPass && remaining.size > 0) {
      addedInThisPass = false;
      
      // Try routes in sorted order (largest first)
      for (const routeData of routesWithEstimates) {
        if (!remaining.has(routeData.route)) continue;
        
        const { route, origin, destination } = routeData;
        
        // Try adding this route
        const newOrigins = new Set([...currentBin.origins, origin]);
        const newDestinations = new Set([...currentBin.destinations, destination]);
        
        const newEstimate = calculateResults(
          Array.from(newOrigins),
          Array.from(newDestinations),
          days
        );
        
        // Add if under limit
        if (newEstimate <= maxResults) {
          currentBin.origins.add(origin);
          currentBin.destinations.add(destination);
          currentBin.routes.push(route);
          currentEstimate = newEstimate;
          remaining.delete(route);
          addedInThisPass = true;
          break; // Start over to find next best fit
        }
      }
    }
    
    // Save this bin
    if (currentBin.routes.length > 0) {
      bins.push({
        origins: Array.from(currentBin.origins),
        destinations: Array.from(currentBin.destinations),
        neededRoutes: currentBin.routes.length,
        estimatedResults: currentEstimate
      });
    }
  }
  
  return bins;
}

// Main
console.log('🚀 ULTRA AGGRESSIVE API Call Optimization\n');
console.log(`Dataset: ${routes.length} routes`);
console.log(`Date range: ${DAYS} days`);
console.log(`Max results per call: ${MAX_RESULTS}`);
console.log(`Strategy: Pack until 1000 limit, ignore waste\n`);

const apiCalls = aggressivePackRoutes(routes, DAYS, MAX_RESULTS);

console.log(`✓ Packed into ${apiCalls.length} API calls\n`);

// Display results
console.log('═'.repeat(120));
console.log('ULTRA AGGRESSIVE PACKING RESULTS');
console.log('═'.repeat(120));
console.log(
  'ID'.padEnd(5) +
  'Origins'.padEnd(8) +
  'Destinations'.padEnd(15) +
  'Total Combos'.padEnd(15) +
  'Needed Routes'.padEnd(15) +
  'Total Results'.padEnd(16) +
  'Wasted Results'.padEnd(16) +
  'Utilization'
);
console.log('─'.repeat(120));

let totalNeededResults = 0;
let totalWastedResults = 0;
let totalResultsCapacity = 0;

apiCalls.forEach((call, index) => {
  const totalCombos = call.origins.length * call.destinations.length;
  const totalResults = calculateResults(call.origins, call.destinations, DAYS);
  
  // Calculate actual needed results
  let actualNeededResults = 0;
  for (const origin of call.origins) {
    for (const destination of call.destinations) {
      const route = `${origin}-${destination}`;
      if (routes.includes(route)) {
        const perDay = routeCountData.get(`${origin},${destination}`) || 5;
        actualNeededResults += perDay * DAYS;
      }
    }
  }
  
  const wastedResults = totalResults - actualNeededResults;
  const utilization = (totalResults / MAX_RESULTS * 100).toFixed(1);
  
  totalNeededResults += actualNeededResults;
  totalWastedResults += wastedResults;
  totalResultsCapacity += totalResults;
  
  console.log(
    `${(index + 1).toString().padEnd(5)}` +
    `${call.origins.length.toString().padEnd(8)}` +
    `${call.destinations.length.toString().padEnd(15)}` +
    `${totalCombos.toString().padEnd(15)}` +
    `${call.neededRoutes.toString().padEnd(15)}` +
    `${totalResults.toString().padEnd(16)}` +
    `${wastedResults.toString().padEnd(16)}` +
    `${utilization}%`
  );
});

console.log('─'.repeat(120));
console.log(
  'TOTAL'.padEnd(5) +
  ''.padEnd(8) +
  ''.padEnd(15) +
  ''.padEnd(15) +
  `${routes.length.toString().padEnd(15)}` +
  `${totalResultsCapacity.toString().padEnd(16)}` +
  `${totalWastedResults.toString().padEnd(16)}` +
  `${(totalResultsCapacity / (apiCalls.length * MAX_RESULTS) * 100).toFixed(1)}%`
);
console.log('═'.repeat(120));

// Calculate wasted API call capacity
const maxPossibleResults = apiCalls.length * MAX_RESULTS;
const wastedApiCapacity = maxPossibleResults - totalResultsCapacity;

console.log('\n📈 COMPREHENSIVE METRICS');
console.log('─'.repeat(60));
console.log(`Total Routes:                     ${routes.length}`);
console.log(`Total API Calls:                  ${apiCalls.length}`);
console.log(`Reduction from naive:             ${((1 - apiCalls.length / routes.length) * 100).toFixed(1)}%`);
console.log(`\nRESULTS ANALYSIS:`);
console.log(`Total Needed Results:             ${totalNeededResults.toLocaleString()}`);
console.log(`Total Wasted Results:             ${totalWastedResults.toLocaleString()}`);
console.log(`Waste Ratio (results):            ${(totalWastedResults / totalNeededResults * 100).toFixed(2)}%`);
console.log(`\nAPI CALL CAPACITY ANALYSIS:`);
console.log(`Max Possible Capacity:            ${maxPossibleResults.toLocaleString()} (${apiCalls.length} × 1000)`);
console.log(`Actual Results Returned:          ${totalResultsCapacity.toLocaleString()}`);
console.log(`Wasted API Capacity:              ${wastedApiCapacity.toLocaleString()}`);
console.log(`API Utilization:                  ${(totalResultsCapacity / maxPossibleResults * 100).toFixed(1)}%`);
console.log(`Avg Results per Call:             ${(totalResultsCapacity / apiCalls.length).toFixed(0)}`);
console.log('─'.repeat(60));

// Save to CSV
const csvLines = [
  'ID,Origins,Destinations,Total Combos,Needed Routes,Total Results,Wasted Results,Utilization %'
];

apiCalls.forEach((call, index) => {
  const totalCombos = call.origins.length * call.destinations.length;
  const totalResults = calculateResults(call.origins, call.destinations, DAYS);
  
  let actualNeededResults = 0;
  for (const origin of call.origins) {
    for (const destination of call.destinations) {
      const route = `${origin}-${destination}`;
      if (routes.includes(route)) {
        const perDay = routeCountData.get(`${origin},${destination}`) || 5;
        actualNeededResults += perDay * DAYS;
      }
    }
  }
  
  const wastedResults = totalResults - actualNeededResults;
  const utilization = (totalResults / MAX_RESULTS * 100).toFixed(1);
  
  csvLines.push(
    `${index + 1},` +
    `"${call.origins.join(',')}",` +
    `"${call.destinations.join(',')}",` +
    `${totalCombos},` +
    `${call.neededRoutes},` +
    `${totalResults},` +
    `${wastedResults},` +
    `${utilization}`
  );
});

fs.writeFileSync('api-call-analysis-aggressive.csv', csvLines.join('\n'));
console.log('\n📄 Saved to: api-call-analysis-aggressive.csv');

