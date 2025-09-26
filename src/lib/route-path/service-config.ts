import { ServiceConfig } from './types';

/**
 * Service configuration manager for managing service settings
 */
export class ServiceConfigManager {
  private config: ServiceConfig;
  private configHistory: Array<{ timestamp: Date; config: ServiceConfig; reason?: string }> = [];
  private listeners: Array<(config: ServiceConfig) => void> = [];

  constructor(initialConfig?: Partial<ServiceConfig>) {
    this.config = {
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
      ...initialConfig,
    };
  }

  /**
   * Get the current configuration
   */
  getConfig(): ServiceConfig {
    return { ...this.config };
  }

  /**
   * Update the configuration
   */
  updateConfig(updates: Partial<ServiceConfig>, reason?: string): void {
    const previousConfig = { ...this.config };
    this.config = { ...this.config, ...updates };
    
    // Record the change in history
    this.configHistory.push({
      timestamp: new Date(),
      config: { ...this.config },
      reason,
    });

    // Notify listeners
    this.notifyListeners();

    console.log(`Service configuration updated${reason ? `: ${reason}` : ''}`, {
      previous: previousConfig,
      current: this.config,
    });
  }

  /**
   * Reset configuration to defaults
   */
  resetToDefaults(reason?: string): void {
    this.updateConfig({
      cache: {
        maxSize: 1000,
        ttl: 300000,
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
    }, reason || 'Reset to defaults');
  }

  /**
   * Get configuration for a specific service
   */
  getServiceConfig<K extends keyof ServiceConfig>(serviceName: K): ServiceConfig[K] {
    return this.config[serviceName];
  }

  /**
   * Update configuration for a specific service
   */
  updateServiceConfig<K extends keyof ServiceConfig>(
    serviceName: K,
    updates: Partial<ServiceConfig[K]>,
    reason?: string
  ): void {
    const serviceConfig = this.config[serviceName];
    this.updateConfig(
      {
        [serviceName]: { ...serviceConfig, ...updates },
      },
      reason || `Updated ${serviceName} configuration`
    );
  }

  /**
   * Validate configuration
   */
  validateConfig(config: Partial<ServiceConfig>): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate cache configuration
    if (config.cache) {
      if (config.cache.maxSize && config.cache.maxSize < 1) {
        errors.push('Cache maxSize must be at least 1');
      }
      if (config.cache.maxSize && config.cache.maxSize > 10000) {
        warnings.push('Cache maxSize is very large, consider reducing for memory efficiency');
      }
      if (config.cache.ttl && config.cache.ttl < 1000) {
        warnings.push('Cache TTL is very short, consider increasing for better performance');
      }
      if (config.cache.ttl && config.cache.ttl > 3600000) {
        warnings.push('Cache TTL is very long, consider reducing for data freshness');
      }
    }

    // Validate performance configuration
    if (config.performance) {
      if (typeof config.performance.enableLogging !== 'boolean') {
        errors.push('Performance enableLogging must be a boolean');
      }
      if (typeof config.performance.enableMetrics !== 'boolean') {
        errors.push('Performance enableMetrics must be a boolean');
      }
    }

    // Validate error handling configuration
    if (config.errorHandling) {
      if (typeof config.errorHandling.enableSentry !== 'boolean') {
        errors.push('Error handling enableSentry must be a boolean');
      }
      if (config.errorHandling.logLevel && !['debug', 'info', 'warn', 'error'].includes(config.errorHandling.logLevel)) {
        errors.push('Error handling logLevel must be one of: debug, info, warn, error');
      }
    }

    // Validate validation configuration
    if (config.validation) {
      if (config.validation.maxPairs && config.validation.maxPairs < 1) {
        errors.push('Validation maxPairs must be at least 1');
      }
      if (config.validation.maxPairs && config.validation.maxPairs > 1000) {
        warnings.push('Validation maxPairs is very large, consider reducing for performance');
      }
      if (typeof config.validation.strictMode !== 'boolean') {
        errors.push('Validation strictMode must be a boolean');
      }
    }

    // Validate batch processing configuration
    if (config.batchProcessing) {
      if (config.batchProcessing.maxBatchSize && config.batchProcessing.maxBatchSize < 1) {
        errors.push('Batch processing maxBatchSize must be at least 1');
      }
      if (config.batchProcessing.maxBatchSize && config.batchProcessing.maxBatchSize > 200) {
        warnings.push('Batch processing maxBatchSize is very large, consider reducing for memory efficiency');
      }
      if (typeof config.batchProcessing.enableOptimization !== 'boolean') {
        errors.push('Batch processing enableOptimization must be a boolean');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Get configuration history
   */
  getConfigHistory(): Array<{ timestamp: Date; config: ServiceConfig; reason?: string }> {
    return [...this.configHistory];
  }

  /**
   * Get configuration at a specific point in time
   */
  getConfigAtTime(timestamp: Date): ServiceConfig | null {
    const historyEntry = this.configHistory
      .filter(entry => entry.timestamp <= timestamp)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
    
    return historyEntry ? historyEntry.config : null;
  }

  /**
   * Add a configuration change listener
   */
  addConfigListener(listener: (config: ServiceConfig) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Remove a configuration change listener
   */
  removeConfigListener(listener: (config: ServiceConfig) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Notify all listeners of configuration changes
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.config);
      } catch (error) {
        console.error('Error in configuration listener:', error);
      }
    });
  }

  /**
   * Export configuration to JSON
   */
  exportConfig(): string {
    return JSON.stringify({
      config: this.config,
      history: this.configHistory,
      exportedAt: new Date().toISOString(),
    }, null, 2);
  }

  /**
   * Import configuration from JSON
   */
  importConfig(jsonString: string, reason?: string): {
    success: boolean;
    errors: string[];
  } {
    try {
      const data = JSON.parse(jsonString);
      
      if (!data.config) {
        return {
          success: false,
          errors: ['Invalid configuration format: missing config property'],
        };
      }

      const validation = this.validateConfig(data.config);
      if (!validation.isValid) {
        return {
          success: false,
          errors: validation.errors,
        };
      }

      this.updateConfig(data.config, reason || 'Imported from JSON');
      
      return {
        success: true,
        errors: [],
      };
    } catch (error) {
      return {
        success: false,
        errors: [`Failed to parse configuration: ${error instanceof Error ? error.message : 'Unknown error'}`],
      };
    }
  }

  /**
   * Get configuration summary for monitoring
   */
  getConfigSummary(): {
    totalServices: number;
    configuredServices: number;
    lastUpdated: Date | null;
    hasWarnings: boolean;
    services: Array<{
      name: string;
      configured: boolean;
      warnings: string[];
    }>;
  } {
    const serviceNames: Array<keyof ServiceConfig> = [
      'cache',
      'performance',
      'errorHandling',
      'validation',
      'batchProcessing',
    ];

    const services = serviceNames.map(serviceName => {
      const serviceConfig = this.config[serviceName];
      const validation = this.validateConfig({ [serviceName]: serviceConfig });
      
      return {
        name: serviceName,
        configured: serviceConfig !== undefined,
        warnings: validation.warnings,
      };
    });

    const hasWarnings = services.some(service => service.warnings.length > 0);
    const lastUpdated = this.configHistory.length > 0 
      ? this.configHistory[this.configHistory.length - 1].timestamp 
      : null;

    return {
      totalServices: serviceNames.length,
      configuredServices: services.filter(service => service.configured).length,
      lastUpdated,
      hasWarnings,
      services,
    };
  }
}

/**
 * Default service configuration manager instance
 */
export const defaultConfigManager = new ServiceConfigManager();

/**
 * Create a new service configuration manager
 */
export function createServiceConfigManager(initialConfig?: Partial<ServiceConfig>): ServiceConfigManager {
  return new ServiceConfigManager(initialConfig);
}

/**
 * Get the default service configuration manager
 */
export function getServiceConfigManager(): ServiceConfigManager {
  return defaultConfigManager;
}
