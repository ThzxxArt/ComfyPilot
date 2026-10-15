/**
 * runBatchOps (0.1.15): the sequential "act on each, report exactly" contract
 * behind the output batch delete and model batch delete / move.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  runBatchOps,
  viewersCloseAfterRemoval
} from '../../src/renderer/src/utils/batchOps'

describe('runBatchOps (0.1.15)', () => {
  it('counts successes and keeps processing after a failure', async () => {
    const ran: string[] = []
    const outcome = await runBatchOps(
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' }
      ],
      async (item) => {
        ran.push(item.id)
        if (item.id === 'b') throw new Error('disk error')
      }
    )
    expect(ran).toEqual(['a', 'b', 'c']) // b failure did NOT abort c
    expect(outcome.ok).toBe(2)
    expect(outcome.failed).toEqual([{ id: 'b', label: 'B', error: 'disk error' }])
  })

  it('collects every failure with its label and message', async () => {
    const outcome = await runBatchOps(
      [
        { id: '1', label: 'one' },
        { id: '2', label: 'two' }
      ],
      async (item) => {
        throw new Error(`fail-${item.id}`)
      }
    )
    expect(outcome.ok).toBe(0)
    expect(outcome.failed.map((f) => [f.label, f.error])).toEqual([
      ['one', 'fail-1'],
      ['two', 'fail-2']
    ])
  })

  it('returns an empty outcome for an empty selection', async () => {
    const op = vi.fn()
    const outcome = await runBatchOps([], op)
    expect(outcome).toEqual({ ok: 0, failed: [] })
    expect(op).not.toHaveBeenCalled()
  })

  it('runs strictly sequentially (each op awaited before the next starts)', async () => {
    const log: string[] = []
    await runBatchOps(
      [
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' }
      ],
      async (item) => {
        log.push(`start-${item.id}`)
        await new Promise((r) => setTimeout(r, 1))
        log.push(`end-${item.id}`)
      }
    )
    expect(log).toEqual(['start-x', 'end-x', 'start-y', 'end-y'])
  })

  it('stringifies non-Error rejections honestly', async () => {
    const outcome = await runBatchOps([{ id: 'z', label: 'Z' }], async () => {
      throw 'plain string failure'
    })
    expect(outcome.failed[0].error).toBe('plain string failure')
  })
})

describe('viewersCloseAfterRemoval (0.1.15)', () => {
  it('closes only the viewers whose asset id is inside the removed set', () => {
    expect(viewersCloseAfterRemoval(['a', 'b'], 'b', 'c')).toEqual({
      closeDetail: true,
      closeLightbox: false
    })
    expect(viewersCloseAfterRemoval(['a'], 'x', 'a')).toEqual({
      closeDetail: false,
      closeLightbox: true
    })
    expect(viewersCloseAfterRemoval(['a'], 'a', 'a')).toEqual({
      closeDetail: true,
      closeLightbox: true
    })
  })

  it('keeps viewers open for unrelated removals and handles empty viewers', () => {
    expect(viewersCloseAfterRemoval(['a'], 'z', 'y')).toEqual({
      closeDetail: false,
      closeLightbox: false
    })
    expect(viewersCloseAfterRemoval(['a'], null, undefined)).toEqual({
      closeDetail: false,
      closeLightbox: false
    })
    expect(viewersCloseAfterRemoval([], 'a', 'a')).toEqual({
      closeDetail: false,
      closeLightbox: false
    })
  })
})
