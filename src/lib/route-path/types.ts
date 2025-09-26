import { NextRequest, NextResponse } from 'next/server';
import { SupabaseClient } from '@/lib/route-helpers';
import { FullRoutePathResult, Airport, Path, IntraRoute } from '@/types/route';

/**
 * Custom error class for route-related errors
 */
export class RouteError extends Error {
  public type: RouteErrorType;
  public context?: Record<string, any>;

  constructor(message: string, type: RouteErrorType, context?: Record<string, any>) {
    super(message);
    this.name = 'RouteError';
    this.type = type;
    this.context = context;
    Object.setPrototypeOf(this, RouteError.prototype);
  }
}

/**
 * Base service interface that all services should implement
 */
export interface BaseService {
  readonly serviceName: string;
  readonly version: string;
}

/**
 * Cache service interfaces
 */
export interface RoutePathCache {
  airport: Map<string, Airport | null>;
  intraRoute: Map<string, IntraRoute[]>;
  path: Map<string, Path[]>;
  sharedPaths: Map<string, Path[]>;
  globalIntraRoutes: Map<string, IntraRoute[]>;
}

export interface ICacheService extends BaseService {
  cache: RoutePathCache;
  fetchAirportCached(supabase: SupabaseClient, iata: string): Promise<Airport | null>;
  fetchIntraRoutesCached(supabase: SupabaseClient, origin: string, destination: string): Promise<IntraRoute[]>;
  fetchPathsCached(
    supabase: SupabaseClient,
    originRegion: string,
    destinationRegion: string,
    maxDistance: number,
    origin: string,
    destination: string,
    maxStop: number
  ): Promise<Path[]>;
  batchFetchIntraRoutesCached(
    supabase: SupabaseClient,
    intraRoutePairs: { origin: string; destination: string }[]
  ): Promise<Record<string, IntraRoute[]>>;
  preFetchAirports(supabase: SupabaseClient, originList: string[], destinationList: string[]): Promise<void>;
  preAnalyzeIntraRoutePairs(
    supabase: SupabaseClient,
    originList: string[],
    destinationList: string[],
    maxStop: number
  ): Promise<{ origin: string; destination: string }[]>;
  hasSharedPaths(key: string): boolean;
  getSharedPaths(key: string): Path[] | undefined;
  setSharedPaths(key: string, paths: Path[]): void;
  setGlobalIntraRoutes(key: string, routes: IntraRoute[]): void;
}

/**
 * Route calculation service interfaces
 */
export interface RouteCalculationInput {
  origin: string;
  destination: string;
  maxStop: number;
  supabase: SupabaseClient;
  cacheService: ICacheService;
  sharedPathsKey?: string;
}

export interface RouteCalculationResult {
  routes: FullRoutePathResult[];
  queryParamsArr: string[];
  cached: boolean;
}

export interface ICalculatorService extends BaseService {
  calculateFullRoutePath(input: RouteCalculationInput): Promise<RouteCalculationResult>;
}

/**
 * Grouping service interfaces
 */
export interface RouteGroup {
  keys: string[];
  dests: string[];
}

export interface GroupingResult {
  groups: RouteGroup[];
  queryParams: string[];
}

export interface IGroupingService extends BaseService {
  mergeGroups(groups: RouteGroup[]): RouteGroup[];
  exceedsSizeLimit(keys: string[], dests: string[]): boolean;
  processRouteGrouping(
    segmentMap: Record<string, Set<string>>,
    destMap: Record<string, Set<string>>
  ): GroupingResult;
}

/**
 * Performance monitoring service interfaces
 */
export interface PerformanceEntry {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, any>;
}

export interface IPerformanceMonitor extends BaseService {
  start(operationName: string, metadata?: Record<string, any>): void;
  end(operationName: string, metadata?: Record<string, any>): void;
  getDuration(operationName: string): number | undefined;
  getTotalTime(): number;
  getEntries(): PerformanceEntry[];
  getTimings(): Record<string, { duration?: number }>;
  logSummary(): void;
}

export interface IRoutePerformanceMonitor extends IPerformanceMonitor {
  startRoute(operationName: string): void;
  endRoute(operationName: string, metadata?: Record<string, any>): void;
  logRouteSummary(): void;
}

export interface IAPIPerformanceMonitor extends IPerformanceMonitor {
  startAPI(operationName: string): void;
  endAPI(operationName: string, metadata?: Record<string, any>): void;
  logAPISummary(): void;
}

/**
 * Error handling service interfaces
 */
export enum RouteErrorType {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AIRPORT_NOT_FOUND = 'AIRPORT_NOT_FOUND',
  NO_ROUTES_FOUND = 'NO_ROUTES_FOUND',
  DATABASE_ERROR = 'DATABASE_ERROR',
  CACHE_ERROR = 'CACHE_ERROR',
  CALCULATION_ERROR = 'CALCULATION_ERROR',
  GROUPING_ERROR = 'GROUPING_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  EXTERNAL_API_ERROR = 'EXTERNAL_API_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR'
}

export interface ErrorContext {
  requestUrl?: string;
  userAgent?: string;
  requestId?: string;
  processingTime?: number;
  routeId?: string;
  origin?: string;
  destination?: string;
  maxStop?: number;
  cacheSize?: number;
  routesCount?: number;
  [key: string]: any;
}

export interface IErrorHandlerService extends BaseService {
  createValidationError(message: string, details?: any): RouteError;
  createAirportNotFoundError(airportCode: string): RouteError;
  createNoRoutesFoundError(origin: string, destination: string, maxStop: number): RouteError;
  createDatabaseError(message: string, context?: Record<string, any>): RouteError;
  createCacheError(message: string, context?: Record<string, any>): RouteError;
  createCalculationError(message: string, context?: Record<string, any>): RouteError;
  createGroupingError(message: string, context?: Record<string, any>): RouteError;
  createInternalError(message: string, context?: Record<string, any>): RouteError;
  handleError(error: Error | RouteError, context: ErrorContext, request?: NextRequest): void;
  createErrorResponse(error: Error | RouteError, request?: NextRequest, context?: ErrorContext): NextResponse;
  wrapWithErrorHandling<T>(fn: () => Promise<T>, context: ErrorContext, request?: NextRequest): Promise<T>;
  wrapWithErrorHandlingSync<T>(fn: () => T, context: ErrorContext, request?: NextRequest): T;
  handleValidationError(validationError: any, request?: NextRequest): NextResponse;
  handleMissingEnvVars(missingVars: string[], request?: NextRequest): NextResponse;
  handleEmptyInputError(field: string, request?: NextRequest): NextResponse;
  handleNoRoutesFoundForPairs(anyError: Error | null, request?: NextRequest, context?: ErrorContext): NextResponse;
}

/**
 * Validation service interfaces
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  error?: any;
}

export interface ValidatedRouteInput {
  origin: string;
  destination: string;
  maxStop: number;
  originList: string[];
  destinationList: string[];
  pairsCount: number;
}

export interface IValidationService extends BaseService {
  validateRequest(request: NextRequest): Promise<ValidationResult<any>>;
  processInputData(parsedData: any): ValidationResult<ValidatedRouteInput>;
  validateEnvironment(): ValidationResult<{ supabaseUrl: string; supabaseKey: string }>;
  validateRouteCalculationParams(params: {
    origin: string;
    destination: string;
    maxStop: number;
  }): ValidationResult<boolean>;
  validateRoutePathRequest(request: NextRequest): Promise<{
    success: boolean;
    data?: ValidatedRouteInput;
    errorResponse?: Response;
  }>;
}

/**
 * Response formatting service interfaces
 */
export interface RoutePathResponse {
  routes: FullRoutePathResult[];
  queryParamsArr: string[];
  metadata?: ResponseMetadata;
}

export interface ResponseMetadata {
  totalRoutes: number;
  queryParamsCount: number;
  processingTime?: number;
  cacheStats?: CacheStats;
  performanceStats?: PerformanceStats;
}

export interface CacheStats {
  airportCacheSize: number;
  intraRouteCacheSize: number;
  pathCacheSize: number;
  sharedPathsCacheSize: number;
  globalIntraRoutesCacheSize: number;
}

export interface PerformanceStats {
  totalTime: number;
  validationTime?: number;
  dataFetchTime?: number;
  processingTime?: number;
  groupingTime?: number;
}

export interface ErrorResponse {
  error: string;
  details?: any;
  code?: string;
  timestamp?: string;
}

export interface IResponseFormatterService extends BaseService {
  formatSuccessResponse(
    routes: FullRoutePathResult[],
    queryParamsArr: string[],
    metadata?: ResponseMetadata
  ): NextResponse<RoutePathResponse>;
  formatErrorResponse(
    error: string,
    statusCode?: number,
    details?: any,
    code?: string
  ): NextResponse<ErrorResponse>;
  formatValidationErrorResponse(message: string, validationErrors: any[]): NextResponse<ErrorResponse>;
  formatNotFoundErrorResponse(message: string, context?: Record<string, any>): NextResponse<ErrorResponse>;
  formatInternalErrorResponse(message: string, context?: Record<string, any>): NextResponse<ErrorResponse>;
  formatNoRoutesFoundResponse(
    origin: string,
    destination: string,
    maxStop: number,
    context?: Record<string, any>
  ): NextResponse<ErrorResponse>;
  formatMissingEnvVarsResponse(missingVars: string[]): NextResponse<ErrorResponse>;
  formatEmptyInputResponse(field: string): NextResponse<ErrorResponse>;
  createMetadata(data: {
    totalRoutes: number;
    queryParamsCount: number;
    processingTime?: number;
    cacheStats?: CacheStats;
    performanceStats?: PerformanceStats;
  }): ResponseMetadata;
  createCacheStats(cache: RoutePathCache): CacheStats;
  createPerformanceStats(timings: Record<string, { duration?: number }>): PerformanceStats;
  formatQueryParams(groups: RouteGroup[]): string[];
  addResponseHeaders(response: NextResponse, additionalHeaders?: Record<string, string>): NextResponse;
  processRoutes(routes: FullRoutePathResult[]): FullRoutePathResult[];
  validateResponseData(data: {
    routes: FullRoutePathResult[];
    queryParamsArr: string[];
  }): { isValid: boolean; errors: string[] };
}

/**
 * Batch processing service interfaces
 */
export interface RegionCombination {
  originRegion: string;
  destinationRegion: string;
  maxDistance: number;
  pairs: Array<{ origin: string; destination: string; maxStop: number }>;
}

export interface BatchProcessingResult {
  airportsFetched: number;
  regionCombinations: Map<string, RegionCombination>;
  sharedPathsData: Record<string, Path[]>;
  intraRoutePairs: Array<{ origin: string; destination: string }>;
  globalIntraRoutesData: Record<string, IntraRoute[]>;
  processingStats: {
    airportsTime: number;
    regionAnalysisTime: number;
    pathsFetchTime: number;
    intraRoutesAnalysisTime: number;
    intraRoutesFetchTime: number;
  };
}

export interface IBatchProcessorService extends BaseService {
  preFetchAirports(
    supabase: SupabaseClient,
    cacheService: ICacheService,
    originList: string[],
    destinationList: string[],
    performanceMonitor: IAPIPerformanceMonitor
  ): Promise<number>;
  analyzeRegionCombinations(
    originList: string[],
    destinationList: string[],
    maxStop: number,
    cacheService: ICacheService,
    performanceMonitor: IAPIPerformanceMonitor
  ): Map<string, RegionCombination>;
  batchFetchPaths(
    supabase: SupabaseClient,
    regionCombinations: Map<string, RegionCombination>,
    cacheService: ICacheService,
    performanceMonitor: IAPIPerformanceMonitor
  ): Promise<Record<string, Path[]>>;
  batchFetchIntraRoutes(
    supabase: SupabaseClient,
    originList: string[],
    destinationList: string[],
    maxStop: number,
    cacheService: ICacheService,
    performanceMonitor: IAPIPerformanceMonitor
  ): Promise<{
    intraRoutePairs: Array<{ origin: string; destination: string }>;
    globalIntraRoutesData: Record<string, IntraRoute[]>;
  }>;
  processBatchData(
    supabase: SupabaseClient,
    originList: string[],
    destinationList: string[],
    maxStop: number,
    cacheService: ICacheService,
    performanceMonitor: IAPIPerformanceMonitor
  ): Promise<BatchProcessingResult>;
  calculateSharedPathKey(
    origin: string,
    destination: string,
    cacheService: ICacheService
  ): string | undefined;
  getBatchProcessingStats(result: BatchProcessingResult): {
    totalAirports: number;
    regionCombinationsCount: number;
    sharedPathsCount: number;
    intraRoutePairsCount: number;
    globalIntraRoutesCount: number;
    totalProcessingTime: number;
    efficiency: {
      airportsPerMs: number;
      pathsPerMs: number;
      intraRoutesPerMs: number;
    };
  };
  validateBatchProcessingResult(result: BatchProcessingResult): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  };
}

/**
 * Route orchestration service interfaces
 */
export interface RouteOrchestrationResult {
  routes: FullRoutePathResult[];
  queryParamsArr: string[];
  metadata: ResponseMetadata;
  processingTime: number;
}

export interface RouteOrchestrationContext {
  supabase: SupabaseClient;
  cacheService: ICacheService;
  performanceMonitor: IAPIPerformanceMonitor;
  validatedData: ValidatedRouteInput;
}

export interface IOrchestratorService extends BaseService {
  createFullRoutePaths(req: NextRequest): Promise<NextResponse>;
  getOrchestrationStats(context: RouteOrchestrationContext): {
    totalPairs: number;
    cacheStats: CacheStats;
    performanceStats: PerformanceStats;
  };
  validateContext(context: RouteOrchestrationContext): {
    isValid: boolean;
    errors: string[];
  };
}

/**
 * Service registry for dependency injection
 */
export interface ServiceRegistry {
  cacheService: ICacheService;
  calculatorService: ICalculatorService;
  groupingService: IGroupingService;
  performanceMonitor: IAPIPerformanceMonitor;
  errorHandler: IErrorHandlerService;
  validationService: IValidationService;
  responseFormatter: IResponseFormatterService;
  batchProcessor: IBatchProcessorService;
  orchestrator: IOrchestratorService;
}

/**
 * Service factory interface
 */
export interface IServiceFactory {
  createCacheService(): ICacheService;
  createCalculatorService(): ICalculatorService;
  createGroupingService(): IGroupingService;
  createPerformanceMonitor(prefix?: string): IPerformanceMonitor;
  createRoutePerformanceMonitor(routeIdentifier: string): IRoutePerformanceMonitor;
  createAPIPerformanceMonitor(): IAPIPerformanceMonitor;
  createErrorHandlerService(): IErrorHandlerService;
  createValidationService(): IValidationService;
  createResponseFormatterService(): IResponseFormatterService;
  createBatchProcessorService(): IBatchProcessorService;
  createOrchestratorService(): IOrchestratorService;
  createServiceRegistry(): ServiceRegistry;
}

/**
 * Service configuration interface
 */
export interface ServiceConfig {
  cache: {
    maxSize: number;
    ttl: number;
  };
  performance: {
    enableLogging: boolean;
    enableMetrics: boolean;
  };
  errorHandling: {
    enableSentry: boolean;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
  validation: {
    maxPairs: number;
    strictMode: boolean;
  };
  batchProcessing: {
    maxBatchSize: number;
    enableOptimization: boolean;
  };
}

/**
 * Service health check interface
 */
export interface ServiceHealth {
  serviceName: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  lastCheck: Date;
  dependencies: ServiceDependency[];
  metrics?: Record<string, any>;
}

export interface ServiceDependency {
  name: string;
  status: 'healthy' | 'unhealthy';
  responseTime?: number;
  lastCheck: Date;
}

/**
 * Service metrics interface
 */
export interface ServiceMetrics {
  serviceName: string;
  timestamp: Date;
  requestCount: number;
  errorCount: number;
  averageResponseTime: number;
  cacheHitRate: number;
  memoryUsage: number;
  customMetrics: Record<string, number>;
}
