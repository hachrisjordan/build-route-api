import { ChildProcess } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Performance metrics for a process
 */
export interface ProcessMetrics {
  cpuUsage: {
    user: number; // microseconds
    system: number; // microseconds
    percentage?: number; // CPU percentage (if available)
  };
  memoryUsage: {
    rss: number; // Resident Set Size in bytes
    heapTotal: number; // Total heap size in bytes
    heapUsed: number; // Used heap size in bytes
    external: number; // External memory in bytes
  };
  timestamp: number; // Unix timestamp in milliseconds
}

/**
 * Performance monitoring result
 */
export interface PerformanceResult {
  nodeProcess: {
    start: ProcessMetrics;
    end: ProcessMetrics;
    delta: {
      cpuUser: number; // microseconds
      cpuSystem: number; // microseconds
      memoryRss: number; // bytes
      memoryHeapUsed: number; // bytes
    };
  };
  pythonProcess?: {
    peakMemory?: number; // bytes
    averageCpu?: number; // percentage
    pid?: number;
  };
  duration: number; // milliseconds
}

/**
 * Start performance monitoring for the current Node.js process
 */
export function startMonitoring(): ProcessMetrics {
  const cpuUsage = process.cpuUsage();
  const memoryUsage = process.memoryUsage();
  
  return {
    cpuUsage: {
      user: cpuUsage.user,
      system: cpuUsage.system,
    },
    memoryUsage: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
    },
    timestamp: Date.now(),
  };
}

/**
 * End performance monitoring and calculate deltas
 */
export function endMonitoring(startMetrics: ProcessMetrics): ProcessMetrics {
  const cpuUsage = process.cpuUsage(startMetrics.cpuUsage);
  const memoryUsage = process.memoryUsage();
  
  return {
    cpuUsage: {
      user: cpuUsage.user,
      system: cpuUsage.system,
    },
    memoryUsage: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
    },
    timestamp: Date.now(),
  };
}

/**
 * Monitor a child process (Python process) on Unix-like systems
 * Starts monitoring immediately and continues until process exits or duration expires
 * Returns undefined on Windows or if monitoring fails
 */
export async function monitorChildProcess(
  childProcess: ChildProcess,
  estimatedDurationMs: number
): Promise<{ peakMemory?: number; averageCpu?: number; pid?: number } | undefined> {
  if (!childProcess.pid) {
    return undefined;
  }

  const pid = childProcess.pid;
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    // On Windows, we can try using tasklist or wmic, but it's more complex
    // For now, just return the PID
    return { pid };
  }

  return new Promise((resolve) => {
    const samples: Array<{ cpu: number; memory: number }> = [];
    const sampleInterval = 500;
    let isMonitoring = true;
    
    const monitor = async () => {
      while (isMonitoring && childProcess.exitCode === null) {
        try {
          const { stdout } = await execAsync(`ps -p ${pid} -o %cpu,rss --no-headers`);
          const parts = stdout.trim().split(/\s+/);
          if (parts.length >= 2) {
            const cpu = parseFloat(parts[0] || '0');
            const memory = parseInt(parts[1] || '0', 10) * 1024; // Convert KB to bytes
            samples.push({ cpu, memory });
          }
        } catch (error) {
          // Process may have exited, stop monitoring
          break;
        }
        
        // Wait before next sample
        await new Promise(resolve => setTimeout(resolve, sampleInterval));
      }
      
      // Process finished, calculate results
      if (samples.length === 0) {
        resolve({ pid });
        return;
      }

      const peakMemory = Math.max(...samples.map(s => s.memory));
      const averageCpu = samples.reduce((sum, s) => sum + s.cpu, 0) / samples.length;

      resolve({
        pid,
        peakMemory,
        averageCpu: Math.round(averageCpu * 100) / 100,
      });
    };
    
    // Start monitoring
    monitor();
    
    // Also listen for process exit
    childProcess.on('close', () => {
      isMonitoring = false;
    });
    
    // Set a maximum monitoring duration (estimated duration + 10s buffer)
    setTimeout(() => {
      isMonitoring = false;
    }, estimatedDurationMs + 10000);
  });
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const absBytes = Math.abs(bytes);
  const i = Math.floor(Math.log(absBytes) / Math.log(k));
  const sign = bytes < 0 ? '-' : '';
  return `${sign}${Math.round((absBytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
}

/**
 * Format microseconds to human-readable string
 */
export function formatMicroseconds(microseconds: number): string {
  if (microseconds < 1000) return `${microseconds} μs`;
  if (microseconds < 1000000) return `${Math.round(microseconds / 1000)} ms`;
  return `${Math.round(microseconds / 1000000 * 100) / 100} s`;
}

/**
 * Log performance metrics in a readable format
 */
export function logPerformanceMetrics(result: PerformanceResult): void {
  const { nodeProcess, pythonProcess, duration } = result;
  
  console.log('\n=== Performance Metrics ===');
  console.log(`Total Duration: ${Math.round(duration)} ms`);
  
  console.log('\n--- Node.js Process ---');
  console.log(`CPU Usage:`);
  console.log(`  User: ${formatMicroseconds(nodeProcess.delta.cpuUser)}`);
  console.log(`  System: ${formatMicroseconds(nodeProcess.delta.cpuSystem)}`);
  console.log(`Memory Usage:`);
  console.log(`  RSS Delta: ${formatBytes(nodeProcess.delta.memoryRss)}`);
  console.log(`  Heap Used Delta: ${formatBytes(nodeProcess.delta.memoryHeapUsed)}`);
  console.log(`  Peak RSS: ${formatBytes(nodeProcess.end.memoryUsage.rss)}`);
  console.log(`  Peak Heap Used: ${formatBytes(nodeProcess.end.memoryUsage.heapUsed)}`);
  
  if (pythonProcess) {
    console.log('\n--- Python Process ---');
    if (pythonProcess.pid) {
      console.log(`PID: ${pythonProcess.pid}`);
    }
    if (pythonProcess.peakMemory !== undefined) {
      console.log(`Peak Memory: ${formatBytes(pythonProcess.peakMemory)}`);
    }
    if (pythonProcess.averageCpu !== undefined) {
      console.log(`Average CPU: ${pythonProcess.averageCpu}%`);
    }
  }
  
  console.log('========================\n');
}
