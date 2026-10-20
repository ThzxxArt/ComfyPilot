/**
 * 0.1.17 (WP7): a bounded work pool for per-item async work.
 *
 * The output grid used to start one thumbnail decode per item — 200 concurrent
 * image decodes when the page was full. `mapPool` keeps at most `limit` tasks
 * in flight and preserves the input order in its result.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1))
  let cursor = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, run))
  return out
}

/** Peak number of tasks `mapPool` may run at once for `count` items. */
export function poolWidth(count: number, limit: number): number {
  if (count <= 0) return 0
  return Math.max(1, Math.min(Math.floor(limit) || 1, count))
}
