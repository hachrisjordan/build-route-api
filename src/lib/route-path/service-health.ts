import { ServiceHealth, ServiceDependency, ServiceMetrics, ServiceRegistry } from './types';

/**
 * Service health monitor for tracking service status and dependencies
 */
export class ServiceHealthMonitor {
  private healthChecks: Map<string, () => Promise<ServiceHealth>> = new Map();
  private metrics: Map<string, ServiceMetrics> = new Map();
  private startTime: number = Date.now();

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Register a health check for a service
   */
  registerHealthCheck(serviceName: string, healthCheck: () => Promise<ServiceHealth>): void {
    this.healthChecks.set(serviceName, healthCheck);
  }

  /**
   * Check the health of a specific service
   */
  async checkServiceHealth(serviceName: string): Promise<ServiceHealth | null> {
    const healthCheck = this.healthChecks.get(serviceName);
    if (!healthCheck) {
      return null;
    }

    try {
      return await healthCheck();
    } catch (error) {
      return {
        serviceName,
        status: 'unhealthy',
        version: 'unknown',
        uptime: Date.now() - this.startTime,
        lastCheck: new Date(),
        dependencies: [],
        metrics: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Check the health of all registered services
   */
  async checkAllServicesHealth(): Promise<Map<string, ServiceHealth>> {
    const results = new Map<string, ServiceHealth>();
    
    for (const [serviceName, healthCheck] of this.healthChecks) {
      try {
        const health = await healthCheck();
        results.set(serviceName, health);
      } catch (error) {
        results.set(serviceName, {
          serviceName,
          status: 'unhealthy',
          version: 'unknown',
          uptime: Date.now() - this.startTime,
          lastCheck: new Date(),
          dependencies: [],
          metrics: {
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }

    return results;
  }

  /**
   * Record metrics for a service
   */
  recordMetrics(serviceName: string, metrics: Partial<ServiceMetrics>): void {
    const existingMetrics = this.metrics.get(serviceName) || {
      serviceName,
      timestamp: new Date(),
      requestCount: 0,
      errorCount: 0,
      averageResponseTime: 0,
      cacheHitRate: 0,
      memoryUsage: 0,
      customMetrics: {},
    };

    const updatedMetrics: ServiceMetrics = {
      ...existingMetrics,
      ...metrics,
      timestamp: new Date(),
    };

    this.metrics.set(serviceName, updatedMetrics);
  }

  /**
   * Get metrics for a specific service
   */
  getServiceMetrics(serviceName: string): ServiceMetrics | null {
    return this.metrics.get(serviceName) || null;
  }

  /**
   * Get all service metrics
   */
  getAllMetrics(): Map<string, ServiceMetrics> {
    return new Map(this.metrics);
  }

  /**
   * Get overall system health status
   */
  async getSystemHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    services: Map<string, ServiceHealth>;
    summary: {
      totalServices: number;
      healthyServices: number;
      degradedServices: number;
      unhealthyServices: number;
      uptime: number;
    };
  }> {
    const services = await this.checkAllServicesHealth();
    
    let healthyCount = 0;
    let degradedCount = 0;
    let unhealthyCount = 0;

    for (const health of services.values()) {
      switch (health.status) {
        case 'healthy':
          healthyCount++;
          break;
        case 'degraded':
          degradedCount++;
          break;
        case 'unhealthy':
          unhealthyCount++;
          break;
      }
    }

    let systemStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (unhealthyCount > 0) {
      systemStatus = 'unhealthy';
    } else if (degradedCount > 0) {
      systemStatus = 'degraded';
    } else {
      systemStatus = 'healthy';
    }

    return {
      status: systemStatus,
      services,
      summary: {
        totalServices: services.size,
        healthyServices: healthyCount,
        degradedServices: degradedCount,
        unhealthyServices: unhealthyCount,
        uptime: Date.now() - this.startTime,
      },
    };
  }

  /**
   * Create a health check for a service registry
   */
  createRegistryHealthCheck(registry: ServiceRegistry): () => Promise<ServiceHealth> {
    return async (): Promise<ServiceHealth> => {
      const dependencies: ServiceDependency[] = [];
      let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

      // Check each service in the registry
      const serviceNames = Object.keys(registry) as Array<keyof ServiceRegistry>;
      
      for (const serviceName of serviceNames) {
        const service = registry[serviceName];
        const startTime = Date.now();
        
        try {
          // Basic health check - ensure service exists and has required methods
          if (!service) {
            dependencies.push({
              name: serviceName,
              status: 'unhealthy',
              lastCheck: new Date(),
            });
            overallStatus = 'unhealthy';
            continue;
          }

          // Check if service has a health check method
          if ('getHealth' in service && typeof service.getHealth === 'function') {
            const health = await (service as any).getHealth();
            dependencies.push({
              name: serviceName,
              status: health.status || 'healthy',
              responseTime: Date.now() - startTime,
              lastCheck: new Date(),
            });
            
            if (health.status === 'unhealthy') {
              overallStatus = 'unhealthy';
            } else if (health.status === 'degraded' && overallStatus !== 'unhealthy') {
              overallStatus = 'degraded';
            }
          } else {
            // Basic existence check
            dependencies.push({
              name: serviceName,
              status: 'healthy',
              responseTime: Date.now() - startTime,
              lastCheck: new Date(),
            });
          }
        } catch (error) {
          dependencies.push({
            name: serviceName,
            status: 'unhealthy',
            lastCheck: new Date(),
          });
          overallStatus = 'unhealthy';
        }
      }

      return {
        serviceName: 'ServiceRegistry',
        status: overallStatus,
        version: '1.0.0',
        uptime: Date.now() - this.startTime,
        lastCheck: new Date(),
        dependencies,
        metrics: {
          totalServices: serviceNames.length,
          healthyDependencies: dependencies.filter(d => d.status === 'healthy').length,
          degradedDependencies: dependencies.filter(d => d.status === 'degraded').length,
          unhealthyDependencies: dependencies.filter(d => d.status === 'unhealthy').length,
        },
      };
    };
  }

  /**
   * Register health checks for all services in a registry
   */
  registerRegistryHealthChecks(registry: ServiceRegistry): void {
    // Register individual service health checks
    Object.entries(registry).forEach(([serviceName, service]) => {
      this.registerHealthCheck(serviceName, async () => {
        const startTime = Date.now();
        
        try {
          if (!service) {
            return {
              serviceName,
              status: 'unhealthy',
              version: 'unknown',
              uptime: Date.now() - this.startTime,
              lastCheck: new Date(),
              dependencies: [],
            };
          }

          // Check if service has health check method
          if ('getHealth' in service && typeof service.getHealth === 'function') {
            return await (service as any).getHealth();
          }

          // Basic health check
          return {
            serviceName,
            status: 'healthy',
            version: '1.0.0',
            uptime: Date.now() - this.startTime,
            lastCheck: new Date(),
            dependencies: [],
            metrics: {
              responseTime: Date.now() - startTime,
            },
          };
        } catch (error) {
          return {
            serviceName,
            status: 'unhealthy',
            version: 'unknown',
            uptime: Date.now() - this.startTime,
            lastCheck: new Date(),
            dependencies: [],
            metrics: {
              error: error instanceof Error ? error.message : 'Unknown error',
              responseTime: Date.now() - startTime,
            },
          };
        }
      });
    });

    // Register registry health check
    this.registerHealthCheck('ServiceRegistry', this.createRegistryHealthCheck(registry));
  }

  /**
   * Get a health summary for monitoring dashboards
   */
  async getHealthSummary(): Promise<{
    timestamp: string;
    systemStatus: 'healthy' | 'degraded' | 'unhealthy';
    services: Array<{
      name: string;
      status: 'healthy' | 'degraded' | 'unhealthy';
      uptime: number;
      lastCheck: string;
    }>;
    metrics: Array<{
      serviceName: string;
      requestCount: number;
      errorCount: number;
      averageResponseTime: number;
      cacheHitRate: number;
    }>;
  }> {
    const systemHealth = await this.getSystemHealth();
    const allMetrics = this.getAllMetrics();

    return {
      timestamp: new Date().toISOString(),
      systemStatus: systemHealth.status,
      services: Array.from(systemHealth.services.values()).map(health => ({
        name: health.serviceName,
        status: health.status,
        uptime: health.uptime,
        lastCheck: health.lastCheck.toISOString(),
      })),
      metrics: Array.from(allMetrics.values()).map(metrics => ({
        serviceName: metrics.serviceName,
        requestCount: metrics.requestCount,
        errorCount: metrics.errorCount,
        averageResponseTime: metrics.averageResponseTime,
        cacheHitRate: metrics.cacheHitRate,
      })),
    };
  }
}

/**
 * Default service health monitor instance
 */
export const defaultHealthMonitor = new ServiceHealthMonitor();

/**
 * Create a new service health monitor
 */
export function createServiceHealthMonitor(): ServiceHealthMonitor {
  return new ServiceHealthMonitor();
}

/**
 * Get the default service health monitor
 */
export function getServiceHealthMonitor(): ServiceHealthMonitor {
  return defaultHealthMonitor;
}
