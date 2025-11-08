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

// Build bipartite graph
function buildGraph(routes) {
  const originMap = new Map();
  const destinationMap = new Map();
  
  for (const route of routes) {
    const [origin, destination] = route.split('-');
    
    if (!originMap.has(origin)) originMap.set(origin, []);
    originMap.get(origin).push(destination);
    
    if (!destinationMap.has(destination)) destinationMap.set(destination, []);
    destinationMap.get(destination).push(origin);
  }
  
  return { originMap, destinationMap };
}

// Star decomposition
function decomposeIntoStars(routes) {
  const { originMap, destinationMap } = buildGraph(routes);
  const remaining = new Set(routes);
  const stars = [];
  
  while (remaining.size > 0) {
    let maxVertex = null;
    let maxDegree = 0;
    let isOriginCenter = true;
    
    for (const [origin, destinations] of originMap.entries()) {
      const degree = destinations.filter(d => remaining.has(`${origin}-${d}`)).length;
      if (degree > maxDegree) {
        maxDegree = degree;
        maxVertex = origin;
        isOriginCenter = true;
      }
    }
    
    for (const [destination, origins] of destinationMap.entries()) {
      const degree = origins.filter(o => remaining.has(`${o}-${destination}`)).length;
      if (degree > maxDegree) {
        maxDegree = degree;
        maxVertex = destination;
        isOriginCenter = false;
      }
    }
    
    if (!maxVertex) break;
    
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

// Calculate results
function calculateResults(origins, destinations, days) {
  let total = 0;
  let breakdown = [];
  
  for (const origin of origins) {
    for (const destination of destinations) {
      const key = `${origin},${destination}`;
      const perDay = routeCountData.get(key) || 5;
      const routeTotal = perDay * days;
      total += routeTotal;
      breakdown.push({ origin, destination, perDay, total: routeTotal });
    }
  }
  
  return { total, breakdown };
}

// Split star
function splitStar(star, days, maxResults) {
  const bins = [];
  const { center, isOriginCenter, origins, destinations } = star;
  
  if (isOriginCenter) {
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

// Pack stars
function packStarsIntoBins(stars, days, maxResults) {
  const apiCalls = [];
  
  for (const star of stars) {
    const { total } = calculateResults(star.origins, star.destinations, days);
    
    if (total <= maxResults) {
      apiCalls.push({
        origins: star.origins,
        destinations: star.destinations,
        estimatedResults: total,
        neededRoutes: star.edges.length
      });
    } else {
      const splitBins = splitStar(star, days, maxResults);
      apiCalls.push(...splitBins.map(bin => ({
        ...bin,
        neededRoutes: bin.origins.length * bin.destinations.length
      })));
    }
  }
  
  return apiCalls;
}

// Phase 3: ULTRA AGGRESSIVE - Consolidate ALL bins (no waste threshold)
function consolidateSmallBins(bins, days, maxResults, wasteThreshold = 0.3) {
  // Sort ALL bins by size (descending) - pack large first for better results
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
    
    // Try to pack MORE bins - keep going until we hit 1000 limit
    for (let j = i + 1; j < sortedBins.length; j++) {
      if (used.has(j)) continue;
      
      const newOrigins = new Set([...currentOrigins, ...sortedBins[j].origins]);
      const newDestinations = new Set([...currentDestinations, ...sortedBins[j].destinations]);
      
      const totalCombos = newOrigins.size * newDestinations.size;
      const neededRoutes = currentNeeded + sortedBins[j].neededRoutes;
      
      // Estimate results for all combinations
      const { total: estimate } = calculateResults(
        Array.from(newOrigins), 
        Array.from(newDestinations), 
        days
      );
      
      // Pack if under limit (ignore waste ratio entirely)
      if (estimate <= maxResults) {
        currentOrigins = Array.from(newOrigins);
        currentDestinations = Array.from(newDestinations);
        currentNeeded = neededRoutes;
        currentEstimate = estimate;
        packed.push(j);
      }
    }
    
    // Mark as used
    packed.forEach(idx => used.add(idx));
    
    // Add consolidated bin
    consolidatedBins.push({
      origins: currentOrigins,
      destinations: currentDestinations,
      neededRoutes: currentNeeded,
      estimatedResults: currentEstimate,
      consolidatedFrom: packed.length
    });
  }
  
  return consolidatedBins;
}

// Main
const stars = decomposeIntoStars(routes);
const apiCallsBeforeConsolidation = packStarsIntoBins(stars, DAYS, MAX_RESULTS);
const apiCalls = consolidateSmallBins(apiCallsBeforeConsolidation, DAYS, MAX_RESULTS, 999); // NO WASTE LIMIT

console.log(`\n🔄 Phase 3: ULTRA AGGRESSIVE Consolidation ${apiCallsBeforeConsolidation.length} bins → ${apiCalls.length} bins`);

// Generate detailed output
const output = {
  metadata: {
    totalRoutes: routes.length,
    totalApiCalls: apiCalls.length,
    reduction: `${((1 - apiCalls.length / routes.length) * 100).toFixed(1)}%`,
    dateRange: DAYS,
    maxResultsPerCall: MAX_RESULTS
  },
  apiCalls: apiCalls.map((call, index) => {
    const { total: totalResults, breakdown } = calculateResults(call.origins, call.destinations, DAYS);
    const totalCombos = call.origins.length * call.destinations.length;
    const wastedCombos = totalCombos - call.neededRoutes;
    
    // Calculate actual needed results (only from real routes)
    const neededBreakdown = breakdown.filter(b => {
      const route = `${b.origin}-${b.destination}`;
      return routes.includes(route);
    });
    const neededResults = neededBreakdown.reduce((sum, b) => sum + b.total, 0);
    const wastedResults = totalResults - neededResults;
    
    return {
      id: index + 1,
      params: {
        origins: call.origins.join(','),
        destinations: call.destinations.join(','),
      },
      stats: {
        originCount: call.origins.length,
        destinationCount: call.destinations.length,
        totalCombinations: totalCombos,
        neededRoutes: call.neededRoutes,
        wastedCombinations: wastedCombos,
        neededResults: neededResults,
        wastedResults: wastedResults,
        utilizationPercent: ((totalResults / MAX_RESULTS) * 100).toFixed(1)
      },
      breakdown: neededBreakdown
    };
  })
};

// Write to file
fs.writeFileSync('api-call-analysis.json', JSON.stringify(output, null, 2));

// Create CSV for easy viewing
const csvLines = [
  'ID,Origins,Destinations,Total Combos,Needed Routes,Needed Results,Wasted Results,Utilization %'
];

output.apiCalls.forEach(call => {
  csvLines.push(
    `${call.id},` +
    `"${call.params.origins}",` +
    `"${call.params.destinations}",` +
    `${call.stats.totalCombinations},` +
    `${call.stats.neededRoutes},` +
    `${call.stats.neededResults},` +
    `${call.stats.wastedResults},` +
    `${call.stats.utilizationPercent}`
  );
});

fs.writeFileSync('api-call-analysis.csv', csvLines.join('\n'));

console.log('✅ Analysis complete!');
console.log('📄 Detailed JSON output: api-call-analysis.json');
console.log('📊 CSV summary: api-call-analysis.csv');
console.log(`\n📈 Summary: ${routes.length} routes → ${apiCalls.length} API calls (${output.metadata.reduction} reduction)`);

