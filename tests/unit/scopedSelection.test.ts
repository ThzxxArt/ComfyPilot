/**
 * 0.1.17 (WP9): the selection rule that protects user data.
 * Batch operations must only ever act on rows the user can currently see.
 */
import { describe, it, expect } from 'vitest'
import {
  partitionSelection,
  useScopedSelection
} from '../../src/renderer/src/composables/useScopedSelection'
import { ref, nextTick } from 'vue'

describe('partitionSelection', () => {
  it('splits checked ids into visible and hidden', () => {
    const { inScope, outOfScope } = partitionSelection(['a', 'b', 'c'], ['a', 'c', 'd'])
    expect(inScope).toEqual(['a', 'c'])
    expect(outOfScope).toEqual(['b'])
  })

  it('keeps order and tolerates unknown ids', () => {
    const { inScope, outOfScope } = partitionSelection(['x'], [])
    expect(inScope).toEqual([])
    expect(outOfScope).toEqual(['x'])
  })

  it('is empty-safe', () => {
    expect(partitionSelection([], ['a'])).toEqual({ inScope: [], outOfScope: [] })
  })
})

describe('useScopedSelection', () => {
  interface Row {
    id: string
    name: string
  }

  it('intersects the selection with the visible rows reactively', async () => {
    const rows = ref<Row[]>([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' }
    ])
    const sel = useScopedSelection<Row>(rows, (r) => r.id)
    sel.setChecked(['a', 'b'])
    expect(sel.selectedItems.value.map((r) => r.id)).toEqual(['a', 'b'])
    expect(sel.hiddenCount.value).toBe(0)

    // A search filter hides 'b' — it must no longer be part of a batch op.
    rows.value = rows.value.filter((r) => r.id !== 'b')
    await nextTick()
    expect(sel.selectedItems.value.map((r) => r.id)).toEqual(['a'])
    expect(sel.hiddenCount.value).toBe(1)
    // The id is still checked, so un-filtering restores it.
    rows.value = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' }
    ]
    await nextTick()
    expect(sel.selectedItems.value.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('keeps only failed ids selected after a batch op', async () => {
    const rows = ref<Row[]>([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' }
    ])
    const sel = useScopedSelection<Row>(rows, (r) => r.id)
    sel.setChecked(['a', 'b'])
    sel.keepFailed(['b'])
    expect(sel.checked.value).toEqual(['b'])
    expect(sel.selectedItems.value.map((r) => r.id)).toEqual(['b'])
    sel.clear()
    expect(sel.selectedItems.value).toEqual([])
  })
})

describe('filtered batch delete (WP9 acceptance)', () => {
  it('only touches checked rows that are visible under the filter', async () => {
    const { runBatchOps } = await import('../../src/renderer/src/utils/batchOps')
    const rows = [
      { id: 'a', name: 'portrait-a' },
      { id: 'b', name: 'portrait-b' },
      { id: 'c', name: 'landscape-c' },
      { id: 'd', name: 'landscape-d' }
    ]
    const checked = ['a', 'b', 'c', 'd']
    const visible = rows.filter((r) => r.name.includes('portrait'))
    const { inScope, outOfScope } = partitionSelection(
      checked,
      visible.map((r) => r.id)
    )
    const touched: string[] = []
    const outcome = await runBatchOps(
      inScope.map((id) => ({ id, label: id })),
      async (item) => {
        touched.push(item.id)
      }
    )
    expect(outcome.ok).toBe(2)
    expect(touched.sort()).toEqual(['a', 'b'])
    expect(outOfScope.sort()).toEqual(['c', 'd'])
  })
})

describe('doctor report binding (WP9)', () => {
  it('only matches when the report belongs to the active instance', async () => {
    const { reportMatchesInstance } =
      await import('../../src/renderer/src/composables/useInstanceScope')
    expect(reportMatchesInstance('a', 'a')).toBe(true)
    expect(reportMatchesInstance('a', 'b')).toBe(false)
    expect(reportMatchesInstance(null, 'a')).toBe(false)
    expect(reportMatchesInstance('a', null)).toBe(false)
    expect(reportMatchesInstance(undefined, undefined)).toBe(false)
  })
})
