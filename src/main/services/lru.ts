/**
 * Tiny LRU cache (0.1.16).
 *
 * Several main-process caches (workflow analysis, fingerprint hashes,
 * safetensors headers, pack metadata, output prev-map) keyed by absolute path
 * but never evicted anything, so memory grew with every file ever touched
 * during a long session. This bounds all of them with one implementation.
 *
 * `get` refreshes recency (Map iteration order = insertion order; delete+set
 * moves the key to the end). `set` evicts the least-recently-used entry past
 * the capacity.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error('LruCache capacity must be >= 1')
    }
  }

  get size(): number {
    return this.map.size
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    // Refresh recency.
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  /** Peek without refreshing recency. */
  peek(key: K): V | undefined {
    return this.map.get(key)
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K | undefined
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}
