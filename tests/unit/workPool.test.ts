/**
 * 0.1.17 (WP7): the bounded pool used by the output grid.
 * Acceptance: never more than `limit` in flight; every item processed once;
 * results keep their input order.
 */
import { describe, it, expect } from 'vitest'
import { mapPool, poolWidth } from '../../src/main/services/workPool'

describe('mapPool', () => {
  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 40 }, (_, i) => i)
    const out = await mapPool(items, 8, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return n * 2
    })
    expect(peak).toBeLessThanOrEqual(8)
    expect(peak).toBeGreaterThan(1) // actually parallel
    expect(out).toHaveLength(40)
    expect(out[7]).toBe(14)
  })

  it('preserves input order and processes every item once', async () => {
    const seen: number[] = []
    const out = await mapPool([3, 1, 2], 2, async (n) => {
      seen.push(n)
      // Later items finish first — order must still follow the input.
      await new Promise((r) => setTimeout(r, n * 3))
      return n + 100
    })
    expect(out).toEqual([103, 101, 102])
    expect(seen.sort()).toEqual([1, 2, 3])
  })

  it('handles empty input and a larger width than items', async () => {
    expect(await mapPool([], 8, async () => 1)).toEqual([])
    expect(await mapPool([1, 2], 99, async (n) => n)).toEqual([1, 2])
    expect(poolWidth(0, 8)).toBe(0)
    expect(poolWidth(3, 8)).toBe(3)
    expect(poolWidth(200, 8)).toBe(8)
  })
})
