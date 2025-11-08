const fs = require('fs');
const path = require('path');

// Load dataset
const routes = JSON.parse(fs.readFileSync('dataset.json', 'utf-8'));

// Load route count data
const routeCountData = new Map();
const csvData = fs.readFileSync('csv-output/route_count.csv', 'utf-8');
const lines = csvData.split('\n').slice(1); // Skip header

for (const line of lines) {
  const [origin, destination, count] = line.trim().split(',');
  if (origin && destination && count) {
    routeCountData.set(`${origin},${destination}`, parseInt(count, 10));
  }
}

const DAYS = 7;
const MAX_RESULTS = 1000;

// Build bipartite graph
function buildGraph(routes) {
  const originMap = new Map(); // origin -> [destinations]
  const destinationMap = new Map(); // destination -> [origins]
  
  for (const route of routes) {
    const [origin, destination] = route.split('-');
    
    if (!originMap.has(origin)) originMap.set(origin, []);
    originMap.get(origin).push(destination);
    
    if (!destinationMap.has(destination)) destinationMap.set(destination, []);
    destinationMap.get(destination).push(origin);
  }
  
  return { originMap, destinationMap };
}

// Star decomposition algorithm
function decomposeIntoStars(routes) {
  const { originMap, destinationMap } = buildGraph(routes);
  const remaining = new Set(routes);
  const stars = [];
  
  while (remaining.size > 0) {
    // Find highest degree vertex
    let maxVertex = null;
    let maxDegree = 0;
    let isOriginCenter = true;
    
    // Check origins
    for (const [origin, destinations] of originMap.entries()) {
      const degree = destinations.filter(d => 
        remaining.has(`${origin}-${d}`)
      ).length;
      
      if (degree > maxDegree) {
        maxDegree = degree;
        maxVertex = origin;
        isOriginCenter = true;
      }
    }
    
    // Check destinations
    for (const [destination, origins] of destinationMap.entries()) {
      const degree = origins.filter(o => 
        remaining.has(`${o}-${destination}`)
      ).length;
      
      if (degree > maxDegree) {
        maxDegree = degree;
        maxVertex = destination;
        isOriginCenter = false;
      }
    }
    
    if (!maxVertex) break;
    
    // Extract star
    const edges = [];
    const origins = new Set();
    const destinations = new Set();
    
    if (isOriginCenter) {
      origins.add(maxVertex);
      const dests = originMap.get(maxVertex) || [];
      for (const dest of dests) {
        const route = `${maxVertex}-${dest}`;
        if (remaining.has(route)) {
          edges.push(route);
          destinations.add(dest);
          remaining.delete(route);
        }
      }
    } else {
      destinations.add(maxVertex);
      const origs = destinationMap.get(maxVertex) || [];
      for (const orig of origs) {
        const route = `${orig}-${maxVertex}`;
        if (remaining.has(route)) {
          edges.push(route);
          origins.add(orig);
          remaining.delete(route);
        }
      }
    }
    
    if (edges.length > 0) {
      stars.push({
        center: maxVertex,
        isOriginCenter,
        edges,
        origins: Array.from(origins),
        destinations: Array.from(destinations)
      });
    }
  }
  
  return stars;
}

// Calculate results for a set of routes
function calculateResults(origins, destinations, days) {
  let total = 0;
  for (const origin of origins) {
    for (const destination of destinations) {
      const key = `${origin},${destination}`;
      const perDay = routeCountData.get(key) || 5; // Default to 5 if not found
      total += perDay * days;
    }
  }
  return total;
}

// Split star if it exceeds capacity
function splitStar(star, days, maxResults) {
  const bins = [];
  const { center, isOriginCenter, origins, destinations } = star;
  
  if (isOriginCenter) {
    // Split destinations
    let currentDestinations = [];
    let currentEstimate = 0;
    
    for (const dest of destinations) {
      const perDay = routeCountData.get(`${center},${dest}`) || 5;
      const routeTotal = perDay * days;
      
      if (currentEstimate + routeTotal <= maxResults) {
        currentDestinations.push(dest);
        currentEstimate += routeTotal;
      } else {
        if (currentDestinations.length > 0) {
          bins.push({
            origins: [center],
            destinations: currentDestinations,
            estimatedResults: currentEstimate
          });
        }
        currentDestinations = [dest];
        currentEstimate = routeTotal;
      }
    }
    
    if (currentDestinations.length > 0) {
      bins.push({
        origins: [center],
        destinations: currentDestinations,
        estimatedResults: currentEstimate
      });
    }
  } else {
    // Split origins
    let currentOrigins = [];
    let currentEstimate = 0;
    
    for (const orig of origins) {
      const perDay = routeCountData.get(`${orig},${center}`) || 5;
      const routeTotal = perDay * days;
      
      if (currentEstimate + routeTotal <= maxResults) {
        currentOrigins.push(orig);
        currentEstimate += routeTotal;
      } else {
        if (currentOrigins.length > 0) {
          bins.push({
            origins: currentOrigins,
            destinations: [center],
            estimatedResults: currentEstimate
          });
        }
        currentOrigins = [orig];
        currentEstimate = routeTotal;
      }
    }
    
    if (currentOrigins.length > 0) {
      bins.push({
        origins: currentOrigins,
        destinations: [center],
        estimatedResults: currentEstimate
      });
    }
  }
  
  return bins;
}

// Pack stars into API calls
function packStarsIntoBins(stars, days, maxResults) {
  const apiCalls = [];
  
  for (const star of stars) {
    const totalEstimate = calculateResults(star.origins, star.destinations, days);
    
    if (totalEstimate <= maxResults) {
      // Fits in one call
      apiCalls.push({
        origins: star.origins,
        destinations: star.destinations,
        estimatedResults: totalEstimate,
        neededRoutes: star.edges.length
      });
    } else {
      // Need to split
      const splitBins = splitStar(star, days, maxResults);
      apiCalls.push(...splitBins.map(bin => ({
        ...bin,
        neededRoutes: bin.origins.length * bin.destinations.length // After split, all combinations are needed
      })));
    }
  }
  
  return apiCalls;
}

// Phase 3: ULTRA AGGRESSIVE Consolidation (no waste threshold)
function consolidateSmallBins(bins, days, maxResults, wasteThreshold = 0.3) {
  const sortedBins = [...bins].sort((a, b) => b.estimatedResults - a.estimatedResults);
  
  const consolidatedBins = [];
  const used = new Set();
  
  for (let i = 0; i < sortedBins.length; i++) {
    if (used.has(i)) continue;
    
    let currentOrigins = [...sortedBins[i].origins];
    let currentDestinations = [...sortedBins[i].destinations];
    let currentNeeded = sortedBins[i].neededRoutes;
    let currentEstimate = sortedBins[i].estimatedResults;
    let packed = [i];
    
    for (let j = i + 1; j < sortedBins.length; j++) {
      if (used.has(j)) continue;
      
      const newOrigins = new Set([...currentOrigins, ...sortedBins[j].origins]);
      const newDestinations = new Set([...currentDestinations, ...sortedBins[j].destinations]);
      
      const estimate = calculateResults(Array.from(newOrigins), Array.from(newDestinations), days);
      
      if (estimate <= maxResults) {
        currentOrigins = Array.from(newOrigins);
        currentDestinations = Array.from(newDestinations);
        currentNeeded = currentNeeded + sortedBins[j].neededRoutes;
        currentEstimate = estimate;
        packed.push(j);
      }
    }
    
    packed.forEach(idx => used.add(idx));
    
    consolidatedBins.push({
      origins: currentOrigins,
      destinations: currentDestinations,
      neededRoutes: currentNeeded,
      estimatedResults: currentEstimate
    });
  }
  
  return consolidatedBins;
}

// Main analysis
console.log('🔍 Analyzing API Call Optimization Strategy\n');
console.log(`Dataset: ${routes.length} routes`);
console.log(`Date range: ${DAYS} days`);
console.log(`Max results per call: ${MAX_RESULTS}\n`);

// Decompose into stars
console.log('📊 Phase 1: Star Decomposition...');
const stars = decomposeIntoStars(routes);
console.log(`✓ Decomposed into ${stars.length} star groups\n`);

// Pack into bins
console.log('📦 Phase 2: Bin Packing...');
const apiCallsBeforeConsolidation = packStarsIntoBins(stars, DAYS, MAX_RESULTS);
console.log(`✓ Packed into ${apiCallsBeforeConsolidation.length} API calls\n`);

// Consolidate small bins
console.log('🔄 Phase 3: ULTRA AGGRESSIVE Bin Consolidation...');
const apiCalls = consolidateSmallBins(apiCallsBeforeConsolidation, DAYS, MAX_RESULTS, 999);
console.log(`✓ Consolidated ${apiCallsBeforeConsolidation.length} → ${apiCalls.length} API calls\n`);

// Display results
console.log('═'.repeat(120));
console.log('ANALYSIS RESULTS');
console.log('═'.repeat(120));
console.log(
  'ID'.padEnd(5) +
  'Origins'.padEnd(8) +
  'Destinations'.padEnd(15) +
  'Total Combos'.padEnd(15) +
  'Needed Routes'.padEnd(15) +
  'Needed Results'.padEnd(16) +
  'Wasted Results'.padEnd(16) +
  'Utilization'
);
console.log('─'.repeat(120));

let totalNeededResults = 0;
let totalWastedResults = 0;
let totalNeededRoutes = 0;

apiCalls.forEach((call, index) => {
  const totalCombos = call.origins.length * call.destinations.length;
  const neededRoutes = call.neededRoutes || totalCombos;
  const totalResults = calculateResults(call.origins, call.destinations, DAYS);
  
  // Calculate wasted results by checking which routes are actually needed
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
  totalNeededRoutes += neededRoutes;
  
  console.log(
    `${(index + 1).toString().padEnd(5)}` +
    `${call.origins.length.toString().padEnd(8)}` +
    `${call.destinations.length.toString().padEnd(15)}` +
    `${totalCombos.toString().padEnd(15)}` +
    `${neededRoutes.toString().padEnd(15)}` +
    `${actualNeededResults.toString().padEnd(16)}` +
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
  `${totalNeededRoutes.toString().padEnd(15)}` +
  `${totalNeededResults.toString().padEnd(16)}` +
  `${totalWastedResults.toString().padEnd(16)}` +
  `${(totalNeededResults / (apiCalls.length * MAX_RESULTS) * 100).toFixed(1)}%`
);
console.log('═'.repeat(120));

// Summary statistics
console.log('\n📈 SUMMARY STATISTICS');
console.log('─'.repeat(60));
console.log(`Total Routes:                ${routes.length}`);
console.log(`Total API Calls:             ${apiCalls.length}`);
console.log(`Reduction:                   ${((1 - apiCalls.length / routes.length) * 100).toFixed(1)}%`);
console.log(`Total Needed Results:        ${totalNeededResults.toLocaleString()}`);
console.log(`Total Wasted Results:        ${totalWastedResults.toLocaleString()}`);
console.log(`Waste Ratio:                 ${(totalWastedResults / totalNeededResults * 100).toFixed(2)}%`);
console.log(`Avg Utilization per Call:    ${(totalNeededResults / (apiCalls.length * MAX_RESULTS) * 100).toFixed(1)}%`);
console.log('─'.repeat(60));

// Top 10 API calls by parameters
console.log('\n🏆 TOP 10 LARGEST API CALLS');
console.log('─'.repeat(100));
const sortedBySize = [...apiCalls].sort((a, b) => 
  (b.origins.length * b.destinations.length) - (a.origins.length * a.destinations.length)
);

sortedBySize.slice(0, 10).forEach((call, index) => {
  const originsStr = call.origins.length > 5 
    ? `${call.origins.slice(0, 5).join(', ')}... (${call.origins.length} total)`
    : call.origins.join(', ');
  const destsStr = call.destinations.length > 5
    ? `${call.destinations.slice(0, 5).join(', ')}... (${call.destinations.length} total)`
    : call.destinations.join(', ');
  
  console.log(`\n${index + 1}. Origins: ${originsStr}`);
  console.log(`   Destinations: ${destsStr}`);
  console.log(`   Needed Results: ${call.estimatedResults}, Utilization: ${(call.estimatedResults / MAX_RESULTS * 100).toFixed(1)}%`);
});
console.log('─'.repeat(100));

