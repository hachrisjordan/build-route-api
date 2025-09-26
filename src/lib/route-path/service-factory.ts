import { 
  ServiceConfig
} from './types';
import { RoutePathCacheService, createRoutePathCache } from './cache';
import { RouteCalculatorService } from './calculator';
import { RouteGroupingService } from './grouping';
import { APIPerformanceMonitor, RoutePerformanceMonitor, PerformanceMonitor } from './performance';
import { ErrorHandlerService } from './error-handler';
import { ValidationService } from './validation';
import { ResponseFormatterService } from './response-formatter';
import { BatchProcessorService } from './batch-processor';
import { RouteOrchestratorService } from './route-orchestrator';

/**
 * Default service configuration
 */
const DEFAULT_CONFIG: ServiceConfig = {
  cache: {
    maxSize: 1000,
    ttl: 300000, // 5 minutes
  },
  performance: {
    enableLogging: true,
    enableMetrics: true,
  },
  errorHandling: {
    enableSentry: true,
    logLevel: 'info',
  },
  validation: {
    maxPairs: 100,
    strictMode: true,
  },
  batchProcessing: {
    maxBatchSize: 50,
    enableOptimization: true,
  },
};

/**
 * Service factory implementation for creating and managing service instances
 */
export class ServiceFactory {
  private config: ServiceConfig;
  private instances: any = {};

  constructor(config: Partial<ServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create a new cache service instance
   */
  createCacheService() {
    if (!this.instances.cacheService) {
      this.instances.cacheService = new RoutePathCacheService(createRoutePathCache());
    }
    return this.instances.cacheService;
  }

  /**
   * Create a new calculator service instance
   */
  createCalculatorService() {
    if (!this.instances.calculatorService) {
      this.instances.calculatorService = new RouteCalculatorService();
    }
    return this.instances.calculatorService;
  }

  /**
   * Create a new grouping service instance
   */
  createGroupingService() {
    if (!this.instances.groupingService) {
      this.instances.groupingService = new RouteGroupingService();
    }
    return this.instances.groupingService;
  }

  /**
   * Create a new performance monitor instance
   */
  createPerformanceMonitor(prefix?: string) {
    return new PerformanceMonitor();
  }

  /**
   * Create a new route performance monitor instance
   */
  createRoutePerformanceMonitor(routeIdentifier: string) {
    return new RoutePerformanceMonitor(routeIdentifier);
  }

  /**
   * Create a new API performance monitor instance
   */
  createAPIPerformanceMonitor() {
    if (!this.instances.performanceMonitor) {
      this.instances.performanceMonitor = new APIPerformanceMonitor();
    }
    return this.instances.performanceMonitor;
  }

  /**
   * Create a new error handler service instance
   */
  createErrorHandlerService() {
    if (!this.instances.errorHandler) {
      this.instances.errorHandler = new ErrorHandlerService();
    }
    return this.instances.errorHandler;
  }

  /**
   * Create a new validation service instance
   */
  createValidationService() {
    if (!this.instances.validationService) {
      this.instances.validationService = new ValidationService();
    }
    return this.instances.validationService;
  }

  /**
   * Create a new response formatter service instance
   */
  createResponseFormatterService() {
    if (!this.instances.responseFormatter) {
      this.instances.responseFormatter = new ResponseFormatterService();
    }
    return this.instances.responseFormatter;
  }

  /**
   * Create a new batch processor service instance
   */
  createBatchProcessorService() {
    if (!this.instances.batchProcessor) {
      this.instances.batchProcessor = new BatchProcessorService();
    }
    return this.instances.batchProcessor;
  }

  /**
   * Create a new orchestrator service instance
   */
  createOrchestratorService() {
    if (!this.instances.orchestrator) {
      this.instances.orchestrator = new RouteOrchestratorService();
    }
    return this.instances.orchestrator;
  }

  /**
   * Create a complete service registry with all services
   */
  createServiceRegistry() {
    return {
      cacheService: this.createCacheService(),
      calculatorService: this.createCalculatorService(),
      groupingService: this.createGroupingService(),
      performanceMonitor: this.createAPIPerformanceMonitor(),
      errorHandler: this.createErrorHandlerService(),
      validationService: this.createValidationService(),
      responseFormatter: this.createResponseFormatterService(),
      batchProcessor: this.createBatchProcessorService(),
      orchestrator: this.createOrchestratorService(),
    };
  }

  /**
   * Get the current service configuration
   */
  getConfig(): ServiceConfig {
    return { ...this.config };
  }

  /**
   * Update the service configuration
   */
  updateConfig(newConfig: Partial<ServiceConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get a specific service instance
   */
  getService(serviceName: string): any {
    return this.instances[serviceName];
  }

  /**
   * Check if a service instance exists
   */
  hasService(serviceName: string): boolean {
    return serviceName in this.instances;
  }

  /**
   * Clear all service instances (useful for testing)
   */
  clearInstances(): void {
    this.instances = {};
  }

  /**
   * Get all instantiated services
   */
  getAllInstances(): any {
    return { ...this.instances };
  }

  /**
   * Create a new factory instance with the same configuration
   */
  clone(): ServiceFactory {
    return new ServiceFactory(this.config);
  }
}

/**
 * Default service factory instance
 */
export const defaultServiceFactory = new ServiceFactory();

/**
 * Create a service factory with custom configuration
 */
export function createServiceFactory(config: Partial<ServiceConfig> = {}): ServiceFactory {
  return new ServiceFactory(config);
}

/**
 * Get the default service factory
 */
export function getServiceFactory(): ServiceFactory {
  return defaultServiceFactory;
}
