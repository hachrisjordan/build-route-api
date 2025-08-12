export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let i = 0;
  const executing: Promise<void>[] = [];
  async function run(task: () => Promise<T>) {
    const result = await task();
    results.push(result);
  }
  while (i < tasks.length) {
    while (executing.length < limit && i < tasks.length) {
      const task = tasks[i++];
      if (!task) continue;
      const p = run(task).finally(() => {
        const idx = executing.indexOf(p);
        if (idx > -1) executing.splice(idx, 1);
      });
      executing.push(p);
    }
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}