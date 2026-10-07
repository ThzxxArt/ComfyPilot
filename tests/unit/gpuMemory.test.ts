import { describe, it, expect } from 'vitest'
import { mergeGpuMemory } from '../../src/main/services/monitor'

const MB = 1024 * 1024

describe('mergeGpuMemory', () => {
  it('prefers systeminformation memoryUsed/memoryTotal when present', () => {
    const out = mergeGpuMemory(
      [{ vram: 16376, memoryUsed: 4096, memoryTotal: 16376 }],
      [{ used: 1, total: 1 }]
    )
    expect(out[0].vramTotal).toBe(16376 * MB)
    expect(out[0].vramUsed).toBe(4096 * MB)
  })

  it('falls back to Windows dedicated counters when si omits usage', () => {
    const out = mergeGpuMemory(
      [{ vram: 16376 }],
      [
        { used: 2 * 1024 * 1024 * 1024, total: 16376 * MB },
        { used: 0, total: 0 }
      ]
    )
    expect(out[0].vramTotal).toBe(16376 * MB)
    expect(out[0].vramUsed).toBe(2 * 1024 * 1024 * 1024)
  })

  it('clamps used to total', () => {
    const out = mergeGpuMemory(
      [{ vram: 8192 }],
      [{ used: 99999 * MB, total: 8192 * MB }]
    )
    expect(out[0].vramUsed).toBe(8192 * MB)
    expect(out[0].vramTotal).toBe(8192 * MB)
  })

  it('matches adapter by closest dedicated limit, not first entry', () => {
    const out = mergeGpuMemory(
      [{ vram: 16376 }, { vram: 512 }],
      [
        { used: 10, total: 512 * MB },
        { used: 20, total: 16376 * MB }
      ]
    )
    expect(out[0].vramUsed).toBe(20)
    expect(out[1].vramUsed).toBe(10)
  })

  it('uses si.vram as total when Windows Dedicated Limit reports 0', () => {
    // Live machine shape: Dedicated Usage in bytes, Dedicated Limit missing/zero
    const out = mergeGpuMemory(
      [{ vram: 16376 }],
      [
        { used: 2469163008, total: 0 },
        { used: 0, total: 0 }
      ]
    )
    expect(out[0].vramTotal).toBe(16376 * MB)
    expect(out[0].vramUsed).toBe(2469163008)
    const pct = Math.round((out[0].vramUsed / out[0].vramTotal) * 100)
    expect(pct).toBeGreaterThan(0)
    expect(pct).toBeLessThan(100)
  })

  it('returns zeros when nothing is available', () => {
    const out = mergeGpuMemory([{ vram: 0 }], [])
    expect(out[0]).toEqual({ vramTotal: 0, vramUsed: 0 })
  })
})
