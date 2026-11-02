/**
 * Scoped async resource (0.2.0).
 *
 * Every view that loads data for the selected instance used to hand-roll a
 * `let seq` guard. This centralizes the rule: a response for a scope that is
 * no longer current is discarded, and unloading invalidates in-flight work.
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue'

export interface ScopedResourceOptions {
  /** Keep the previous data visible while the next load runs. */
  keepPrevious?: boolean
}

export function useScopedResource<T>(
  loader: (scope: string) => Promise<T>,
  scope: Ref<string | null | undefined>,
  options: ScopedResourceOptions = {}
) {
  const data = ref<T | null>(null)
  const loading = ref(false)
  const error = ref('')
  let seq = 0
  let disposed = false

  async function reload(): Promise<void> {
    const current = String(scope.value || '')
    if (!current) {
      data.value = null
      loading.value = false
      error.value = ''
      return
    }
    const my = ++seq
    loading.value = true
    error.value = ''
    if (!options.keepPrevious) data.value = null
    try {
      const result = await loader(current)
      if (disposed || my !== seq || String(scope.value || '') !== current) return
      data.value = result
    } catch (err) {
      if (disposed || my !== seq || String(scope.value || '') !== current) return
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      if (!disposed && my === seq) loading.value = false
    }
  }

  watch(scope, () => void reload(), { immediate: true })
  onScopeDispose(() => {
    disposed = true
    seq += 1
  })

  return { data, loading, error, reload }
}
