import { CONCURRENCY_CONFIG } from '@/lib/concurrency-config';

export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  if (tasks.length === 0) return [];
  
  const poolStartTime = Date.now();
  const taskStartTimes = new Map<number, number>();
  
  console.log(`[POOL] Starting pool with ${tasks.length} tasks, concurrency limit=${limit}`);
  
  if (tasks.length <= limit) {
    const results = await Promise.all(tasks.map((task, idx) => {
      taskStartTimes.set(idx, Date.now());
      return task();
    }));
    const totalDuration = Date.now() - poolStartTime;
    console.log(`[POOL] All ${tasks.length} tasks completed in ${totalDuration}ms`);
    return results;
  }

  const results: T[] = new Array(tasks.length);
  let completed = 0;
  let started = 0;
  const initialBatch = Math.min(limit, tasks.length);
  const logInterval = Math.max(1, Math.floor(tasks.length / 10)); // Log every 10%
  let lastLoggedProgress = 0;

  return new Promise((resolve, reject) => {
    const startNext = () => {
      if (started >= tasks.length) return;
      const index = started++;
      const task = tasks[index];
      if (!task) return;
      
      const taskStartTime = Date.now();
      taskStartTimes.set(index, taskStartTime);
      
      task()
        .then(result => {
          results[index] = result;
          completed++;
          
          // Log progress every 10% or on completion
          if (completed % logInterval === 0 || completed === tasks.length) {
            const progress = Math.floor((completed / tasks.length) * 100);
            if (progress !== lastLoggedProgress) {
              const elapsed = Date.now() - poolStartTime;
              const avgTime = elapsed / completed;
              const remaining = tasks.length - completed;
              const eta = Math.round(remaining * avgTime);
              console.log(`[POOL] Progress: ${completed}/${tasks.length} (${progress}%) | Elapsed: ${elapsed}ms | ETA: ${eta}ms`);
              lastLoggedProgress = progress;
            }
          }
          
          if (completed === tasks.length) {
            const totalDuration = Date.now() - poolStartTime;
            console.log(`[POOL] All ${tasks.length} tasks completed in ${totalDuration}ms`);
            resolve(results);
          } else {
            startNext();
          }
        })
        .catch(err => {
          console.error(`[POOL] Task ${index + 1}/${tasks.length} failed:`, err);
          reject(err);
        });
    };

    for (let i = 0; i < initialBatch; i++) {
      startNext();
    }
  });
}

export function getPoolLimit(fallback: number): number {
  const configured = Number(CONCURRENCY_CONFIG.MAX_PARALLEL_REQUESTS || fallback);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

export default pool;


