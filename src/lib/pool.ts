import { CONCURRENCY_CONFIG } from '@/lib/concurrency-config';

export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  if (tasks.length === 0) return [];
  if (tasks.length <= limit) {
    return Promise.all(tasks.map(task => task()));
  }

  const results: T[] = new Array(tasks.length);
  let completed = 0;
  let started = 0;

  return new Promise((resolve, reject) => {
    const startNext = () => {
      if (started >= tasks.length) return;
      const index = started++;
      const task = tasks[index];
      if (!task) return;
      task()
        .then(result => {
          results[index] = result;
          completed++;
          if (completed === tasks.length) {
            resolve(results);
          } else {
            startNext();
          }
        })
        .catch(reject);
    };

    for (let i = 0; i < Math.min(limit, tasks.length); i++) {
      startNext();
    }
  });
}

export function getPoolLimit(fallback: number): number {
  const configured = Number(CONCURRENCY_CONFIG.MAX_PARALLEL_REQUESTS || fallback);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

export default pool;


