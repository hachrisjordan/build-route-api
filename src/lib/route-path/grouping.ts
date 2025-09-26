/**
 * Group structure for route grouping operations
 */
export interface RouteGroup {
  keys: string[];
  dests: string[];
}

/**
 * Service for handling route grouping and merging operations
 */
export class RouteGroupingService {
  readonly serviceName = 'RouteGroupingService';
  readonly version = '1.0.0';

  /**
   * Merge groups by combining groups where destinations are subsets
   */
  mergeGroups(groups: RouteGroup[]): RouteGroup[] {
    let merged = [...groups];
    let changed = true;
    
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < merged.length; i++) {
        for (let j = 0; j < merged.length; j++) {
          if (i === j) continue;
          
          // If i's dests are a subset of j's dests
          const groupI = merged[i];
          const groupJ = merged[j];
          if (!groupI || !groupJ) continue;
          
          const setI = new Set(groupI.dests);
          const setJ = new Set(groupJ.dests);
          if ([...setI].every(d => setJ.has(d))) {
            // Check if merging would exceed the 60 limit
            const combinedKeys = new Set([...groupJ.keys, ...groupI.keys]);
            const combinedDests = new Set([...groupJ.dests, ...groupI.dests]);
            if (combinedKeys.size * combinedDests.size <= 60) {
              // Merge i into j
              groupJ.keys = Array.from(combinedKeys).sort();
              groupJ.dests = Array.from(combinedDests).sort();
              // Remove i
              merged.splice(i, 1);
              changed = true;
              break outer;
            }
          }
        }
      }
    }
    
    return merged;
  }

  /**
   * Check if a group exceeds the size limit
   */
  exceedsSizeLimit(keys: string[], dests: string[]): boolean {
    return false; // No size limit - allow unlimited destinations
  }

  /**
   * Advanced merging: merge groups where keys of one are a subset of another's, combining destinations
   */
  advancedMergeGroups(groups: RouteGroup[]): RouteGroup[] {
    let mergedGroups = this.mergeGroups(groups);
    let changed = true;
    
    while (changed) {
      changed = false;
      // Sort by keys length ascending (bottom-up)
      mergedGroups = mergedGroups.sort((a, b) => a.keys.length - b.keys.length);
      outer: for (let i = 0; i < mergedGroups.length; i++) {
        for (let j = 0; j < mergedGroups.length; j++) {
          if (i === j) continue;
          
          const groupI = mergedGroups[i];
          const groupJ = mergedGroups[j];
          if (!groupI || !groupJ) continue;
          
          const setI = new Set(groupI.keys);
          const setJ = new Set(groupJ.keys);
          // If i's keys are a subset of j's keys
          if ([...setI].every(k => setJ.has(k))) {
            // Check if merging would exceed the 60 limit
            const combinedKeys = new Set([...groupJ.keys, ...groupI.keys]);
            const combinedDests = new Set([...groupJ.dests, ...groupI.dests]);
            if (combinedKeys.size * combinedDests.size <= 60) {
              // Merge i's dests into j's dests (deduped)
              groupJ.dests = Array.from(combinedDests).sort();
              // The superset group (j) keeps its keys (origins)
              // Remove i (the subset group)
              mergedGroups.splice(i, 1);
              changed = true;
              break outer;
            }
          }
          // If j's keys are a subset of i's keys, merge j into i
          if ([...setJ].every(k => setI.has(k))) {
            // Check if merging would exceed the 60 limit
            const combinedKeys = new Set([...groupI.keys, ...groupJ.keys]);
            const combinedDests = new Set([...groupI.dests, ...groupJ.dests]);
            if (combinedKeys.size * combinedDests.size <= 60) {
              groupI.dests = Array.from(combinedDests).sort();
              // The superset group (i) keeps its keys (origins)
              // Remove j (the subset group)
              mergedGroups.splice(j, 1);
              changed = true;
              break outer;
            }
          }
        }
      }
    }

    return mergedGroups;
  }

  /**
   * Filter out groups that exceed the size limit
   */
  filterGroupsBySizeLimit(groups: RouteGroup[]): RouteGroup[] {
    return groups.filter(group => !this.exceedsSizeLimit(group.keys, group.dests));
  }

  /**
   * Generate query parameters from groups
   */
  generateQueryParams(groups: RouteGroup[]): string[] {
    return groups
      .sort((a, b) => b.dests.length - a.dests.length || a.keys.join('/').localeCompare(b.keys.join('/')))
      .map(g => `${g.keys.join('/')}-${g.dests.join('/')}`);
  }

  /**
   * Build initial groups from segment and destination maps
   */
  buildInitialGroups(
    segmentMap: Record<string, Set<string>>,
    destMap: Record<string, Set<string>>
  ): RouteGroup[] {
    const groups: RouteGroup[] = [];
    
    Object.entries(segmentMap).forEach(([from, tos]) => {
      groups.push({ keys: [from], dests: Array.from(tos).sort() });
    });
    Object.entries(destMap).forEach(([to, froms]) => {
      groups.push({ keys: Array.from(froms).sort(), dests: [to] });
    });

    return groups;
  }

  /**
   * Process route grouping with full merging logic
   */
  processRouteGrouping(
    segmentMap: Record<string, Set<string>>,
    destMap: Record<string, Set<string>>
  ): { groups: RouteGroup[]; queryParams: string[] } {
    // Build initial groups
    const initialGroups = this.buildInitialGroups(segmentMap, destMap);
    
    // Apply advanced merging
    const mergedGroups = this.advancedMergeGroups(initialGroups);
    
    // Filter by size limit
    const filteredGroups = this.filterGroupsBySizeLimit(mergedGroups);
    
    // Generate query parameters
    const queryParams = this.generateQueryParams(filteredGroups);
    
    return {
      groups: filteredGroups,
      queryParams
    };
  }
}
