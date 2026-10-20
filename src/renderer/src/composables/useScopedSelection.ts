/**
 * 0.1.17 (WP9): one owner for "what does the user actually have selected".
 *
 * The 0.1.16 batch delete/move acted on the FULL selection set, while the table
 * only showed the filtered subset — rows hidden by a search/category filter were
 * deleted (files included) without ever being visible. Every batch surface now
 * intersects the checked ids with the currently visible rows.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

export interface ScopedSelection<T> {
  /** Ids the user checked, in check order. */
  checked: Ref<string[]>
  /** Rows currently rendered (after search / category / tab filters). */
  visible: ComputedRef<T[]>
  /** checked ∩ visible — the ONLY set batch operations may act on. */
  selectedItems: ComputedRef<T[]>
  /** Checked but hidden by the current filter (shown to the user as a warning). */
  hiddenCount: ComputedRef<number>
  toggle(id: string, on: boolean): void
  setChecked(ids: string[]): void
  clear(): void
  /** After a batch op: keep exactly the failed ids selected. */
  keepFailed(failedIds: string[]): void
}

/**
 * Pure core so the containment rule is unit-testable without a DOM.
 */
export function partitionSelection(
  checked: string[],
  visibleIds: Iterable<string>
): { inScope: string[]; outOfScope: string[] } {
  const visible = new Set(visibleIds)
  const inScope: string[] = []
  const outOfScope: string[] = []
  for (const id of checked) {
    if (visible.has(id)) inScope.push(id)
    else outOfScope.push(id)
  }
  return { inScope, outOfScope }
}

export function useScopedSelection<T>(
  visible: Ref<T[]> | ComputedRef<T[]>,
  getId: (item: T) => string
): ScopedSelection<T> {
  const checked = ref<string[]>([])

  const visibleIds = computed(() => visible.value.map((item) => getId(item)))
  const inScopeIds = computed(() => partitionSelection(checked.value, visibleIds.value).inScope)
  const selectedItems = computed(() => {
    const wanted = new Set(inScopeIds.value)
    return visible.value.filter((item) => wanted.has(getId(item)))
  })
  const hiddenCount = computed(
    () => partitionSelection(checked.value, visibleIds.value).outOfScope.length
  )

  return {
    checked,
    visible: computed(() => visible.value),
    selectedItems,
    hiddenCount,
    toggle(id, on) {
      if (on) {
        if (!checked.value.includes(id)) checked.value = [...checked.value, id]
      } else {
        checked.value = checked.value.filter((x) => x !== id)
      }
    },
    setChecked(ids) {
      checked.value = [...ids]
    },
    clear() {
      checked.value = []
    },
    keepFailed(failedIds) {
      checked.value = [...failedIds]
    }
  }
}
