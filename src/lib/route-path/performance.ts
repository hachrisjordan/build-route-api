/**
 * Performance timing entry
 */
export interface PerformanceEntry {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, any>;
}

/**
 * Performance monitoring service for route path operations
 */
export class PerformanceMonitor {
  readonly serviceName = 'PerformanceMonitor';
  readonly version = '1.0.0';
  
  private entries: Map<string, PerformanceEntry> = new Map();
  private startTime: number;

  constructor() {
    this.startTime = performance.now();
  }

  /**
   * Start timing a performance entry
   */
  start(name: string, metadata?: Record<string, any>): void {
    this.entries.set(name, {
      name,
      startTime: performance.now(),
      metadata
    });
  }

  /**
   * End timing a performance entry and log the result
   */
  end(name: string, logMessage?: string): number {
    const entry = this.entries.get(name);
    if (!entry) {
      console.warn(`Performance entry '${name}' not found`);
      return 0;
    }

    const endTime = performance.now();
    const duration = endTime - entry.startTime;
    
    entry.endTime = endTime;
    entry.duration = duration;

    // Log the performance entry
    if (logMessage) {
      console.log(logMessage.replace('{duration}', duration.toFixed(2)));
    }

    return duration;
  }

  /**
   * Get duration of a performance entry
   */
  getDuration(name: string): number {
    const entry = this.entries.get(name);
    return entry?.duration || 0;
  }

  /**
   * Get all performance entries
   */
  getEntries(): PerformanceEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get timings as a record for response formatting
   */
  getTimings(): Record<string, { duration?: number }> {
    const timings: Record<string, { duration?: number }> = {};
    this.entries.forEach((entry, name) => {
      timings[name] = { duration: entry.duration };
    });
    return timings;
  }

  /**
   * Get total execution time
   */
  getTotalTime(): number {
    return performance.now() - this.startTime;
  }

  /**
   * Log a performance summary
   */
  logSummary(): void {
    const totalTime = this.getTotalTime();
    console.log(`Total execution time: ${totalTime.toFixed(2)}ms`);
    
    const entries = this.getEntries()
      .filter(entry => entry.duration !== undefined)
      .sort((a, b) => (b.duration || 0) - (a.duration || 0));
    
    if (entries.length > 0) {
      console.log('Performance breakdown:');
      entries.forEach(entry => {
        const percentage = ((entry.duration || 0) / totalTime * 100).toFixed(1);
        console.log(`  ${entry.name}: ${entry.duration?.toFixed(2)}ms (${percentage}%)`);
      });
    }
  }

  /**
   * Create a scoped performance monitor for a specific operation
   */
  static createScoped(operationName: string): PerformanceMonitor {
    const monitor = new PerformanceMonitor();
    monitor.start(operationName);
    return monitor;
  }

  /**
   * Time a function execution
   */
  static async timeFunction<T>(
    name: string, 
    fn: () => Promise<T>, 
    logMessage?: string
  ): Promise<T> {
    const monitor = new PerformanceMonitor();
    monitor.start(name);
    
    try {
      const result = await fn();
      monitor.end(name, logMessage);
      return result;
    } catch (error) {
      monitor.end(name, logMessage);
      throw error;
    }
  }

  /**
   * Time a synchronous function execution
   */
  static timeFunctionSync<T>(
    name: string, 
    fn: () => T, 
    logMessage?: string
  ): T {
    const monitor = new PerformanceMonitor();
    monitor.start(name);
    
    try {
      const result = fn();
      monitor.end(name, logMessage);
      return result;
    } catch (error) {
      monitor.end(name, logMessage);
      throw error;
    }
  }
}

/**
 * Route-specific performance monitoring utilities
 */
export class RoutePerformanceMonitor extends PerformanceMonitor {
  private routeId: string;

  constructor(routeId: string) {
    super();
    this.routeId = routeId;
  }

  /**
   * Log route-specific performance with context
   */
  logRoutePerformance(operation: string, duration: number, metadata?: Record<string, any>): void {
    const context = `[${this.routeId}]`;
    const message = `${context} ${operation}: ${duration.toFixed(2)}ms`;
    
    if (metadata) {
      const metadataStr = Object.entries(metadata)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      console.log(`${message} (${metadataStr})`);
    } else {
      console.log(message);
    }
  }

  /**
   * Start timing with route context
   */
  startRoute(operation: string, metadata?: Record<string, any>): void {
    this.start(`${this.routeId}-${operation}`, metadata);
  }

  /**
   * End timing with route context and logging
   */
  endRoute(operation: string, metadata?: Record<string, any>): number {
    const duration = this.end(`${this.routeId}-${operation}`);
    this.logRoutePerformance(operation, duration, metadata);
    return duration;
  }

  /**
   * Log route processing summary
   */
  logRouteSummary(): void {
    const totalTime = this.getTotalTime();
    // Route processing completed
  }
}

/**
 * Global performance monitoring for API operations
 */
export class APIPerformanceMonitor extends PerformanceMonitor {
  /**
   * Log API performance with context
   */
  logAPIPerformance(operation: string, duration: number, metadata?: Record<string, any>): void {
    const message = `${operation}: ${duration.toFixed(2)}ms`;
    
    if (metadata) {
      const metadataStr = Object.entries(metadata)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ');
      console.log(`${message} (${metadataStr})`);
    } else {
      console.log(message);
    }
  }

  /**
   * Start API operation timing
   */
  startAPI(operation: string, metadata?: Record<string, any>): void {
    this.start(`api-${operation}`, metadata);
  }

  /**
   * End API operation timing with logging
   */
  endAPI(operation: string, metadata?: Record<string, any>): number {
    const duration = this.end(`api-${operation}`);
    this.logAPIPerformance(operation, duration, metadata);
    return duration;
  }

  /**
   * Log API execution summary
   */
  logAPISummary(): void {
    const totalTime = this.getTotalTime();
    console.log(`Total API execution time: ${totalTime.toFixed(2)}ms`);
  }
}
