/**
 * One async action with a per-key busy flag (0.2.0).
 *
 * Prevents double-clicks from launching the same destructive operation twice
 * and exposes the last error without every view writing its own try/catch.
 */
import { ref } from 'vue'

export function useAsyncAction() {
  const busy = ref('')
  const error = ref('')

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (busy.value) return undefined
    busy.value = key
    error.value = ''
    try {
      return await fn()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return undefined
    } finally {
      if (busy.value === key) busy.value = ''
    }
  }

  return { busy, error, run }
}
