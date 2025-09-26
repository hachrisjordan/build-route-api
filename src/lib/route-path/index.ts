/**
 * Route Path Services - Main Export File
 * 
 * This file exports all service interfaces, types, and implementations
 * for the route path calculation system.
 */

// Service Interfaces and Types
export * from './types';

// Service Implementations
export { RoutePathCacheService, createRoutePathCache } from './cache';
export { RouteCalculatorService } from './calculator';
export { RouteGroupingService } from './grouping';
export { 
  PerformanceMonitor, 
  RoutePerformanceMonitor, 
  APIPerformanceMonitor 
} from './performance';
export { ErrorHandlerService, RouteError, RouteErrorType } from './error-handler';
export { ValidationService } from './validation';
export { ResponseFormatterService } from './response-formatter';
export { BatchProcessorService } from './batch-processor';
export { RouteOrchestratorService } from './route-orchestrator';

// Service Factory and Management
export { 
  ServiceFactory, 
  defaultServiceFactory, 
  createServiceFactory, 
  getServiceFactory 
} from './service-factory';

// Service Health Monitoring
export { 
  ServiceHealthMonitor, 
  defaultHealthMonitor, 
  createServiceHealthMonitor, 
  getServiceHealthMonitor 
} from './service-health';

// Service Configuration Management
export { 
  ServiceConfigManager, 
  defaultConfigManager, 
  createServiceConfigManager, 
  getServiceConfigManager 
} from './service-config';

// Re-export commonly used types for convenience
export type {
  ServiceRegistry,
  ServiceConfig,
  ServiceHealth,
  ServiceMetrics,
  RoutePathCache,
  RouteCalculationInput,
  RouteCalculationResult,
  RouteOrchestrationResult,
  RouteOrchestrationContext,
  ValidationResult,
  ValidatedRouteInput,
  ResponseMetadata,
  CacheStats,
  PerformanceStats,
  BatchProcessingResult,
  GroupingResult,
  RouteGroup,
} from './types';

// Re-export error types for convenience
export { RouteErrorType } from './error-handler';
