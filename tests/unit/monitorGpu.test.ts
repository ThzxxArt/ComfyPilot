/**
 * Monitor GPU memory merging + base-URL guard + snapshot fallback (0.1.10).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('ws', () => ({
  default: class FakeWS {
    static OPEN = 1
    on(): void {
      /* noop */
    }
    close(): void {
      /* noop */
    }
  }
}))

vi.mock('systeminformation', () => ({
  default: {
    graphics: async () => ({ controllers: [] }),
    currentLoad: async () => ({ currentLoad: 10 }),
    mem: async () => ({ total: 100, used: 40 }),
    fsSize: async () => [{ available: 1, size: 2 }]
  }
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => [],
  listRemotes: () => []
}))

const MB = 1024 * 1024

describe('monitor helpers (0.1.10)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('mergeGpuMemory prefers explicit systeminformation values', async () => {
    const { mergeGpuMemory } = await import('../../src/main/services/monitor')
    const merged = mergeGpuMemory(
      [{ vram: 8192, memoryUsed: 1024, memoryTotal: 8192 }],
      [{ used: 500 * MB, total: 8192 * MB }]
    )
    expect(merged).toEqual([{ vramTotal: 8192 * MB, vramUsed: 1024 * MB }])
  })

  it('mergeGpuMemory matches perf-counter adapters by closest dedicated limit', async () => {
    const { mergeGpuMemory } = await import('../../src/main/services/monitor')
    const merged = mergeGpuMemory(
      [{ vram: 8192, memoryUsed: 0, memoryTotal: 0 }],
      [
        { used: 100 * MB, total: 2048 * MB },
        { used: 700 * MB, total: 8192 * MB }
      ]
    )
    expect(merged[0].vramTotal).toBe(8192 * MB)
    expect(merged[0].vramUsed).toBe(700 * MB)
  })

  it('mergeGpuMemory falls back to the first unused adapter, then to vram only', async () => {
    const { mergeGpuMemory } = await import('../../src/main/services/monitor')
    // No plausible total match (vram 0) → first adapter with totals.
    const first = mergeGpuMemory(
      [{ vram: 0, memoryUsed: 0, memoryTotal: 0 }],
      [{ used: 50 * MB, total: 100 * MB }]
    )
    expect(first[0]).toEqual({ vramTotal: 100 * MB, vramUsed: 50 * MB })

    // No adapters at all → vram bytes with zero usage.
    const bare = mergeGpuMemory([{ vram: 4096, memoryUsed: 0, memoryTotal: 0 }], [])
    expect(bare[0]).toEqual({ vramTotal: 4096 * MB, vramUsed: 0 })
  })

  it('mergeGpuMemory clamps used to total and never reuses an adapter twice', async () => {
    const { mergeGpuMemory } = await import('../../src/main/services/monitor')
    const merged = mergeGpuMemory(
      [
        { vram: 8192, memoryUsed: 0, memoryTotal: 0 },
        { vram: 8192, memoryUsed: 0, memoryTotal: 0 }
      ],
      [
        { used: 9999 * MB, total: 8192 * MB },
        { used: 10 * MB, total: 8192 * MB }
      ]
    )
    expect(merged[0].vramUsed).toBe(8192 * MB) // clamped
    expect(merged[1].vramUsed).toBe(10 * MB) // second adapter, not the first again
  })

  it('sampleWindowsGpuMemory returns [] off Windows', async () => {
    const { sampleWindowsGpuMemory } = await import('../../src/main/services/monitor')
    if (process.platform !== 'win32') {
      await expect(sampleWindowsGpuMemory()).resolves.toEqual([])
    } else {
      expect(Array.isArray(await sampleWindowsGpuMemory())).toBe(true)
    }
  })

  it('assertMonitorBaseUrl allows localhost but rejects arbitrary origins', async () => {
    const { assertMonitorBaseUrl } = await import('../../src/main/services/monitor')
    expect(() => assertMonitorBaseUrl('http://127.0.0.1:8188')).not.toThrow()
    expect(() => assertMonitorBaseUrl('http://localhost:8188')).not.toThrow()
    expect(() => assertMonitorBaseUrl('http://192.168.1.50:8188')).toThrow(/not allowed/)
    expect(() => assertMonitorBaseUrl('ftp://127.0.0.1')).toThrow(/unsupported protocol/)
    expect(() => assertMonitorBaseUrl('')).toThrow(/required/)
  })

  it('systemSnapshot degrades gracefully when systeminformation fails', async () => {
    vi.doMock('systeminformation', () => ({
      default: {
        currentLoad: async () => {
          throw new Error('nope')
        },
        mem: async () => {
          throw new Error('nope')
        },
        fsSize: async () => {
          throw new Error('nope')
        },
        graphics: async () => {
          throw new Error('nope')
        }
      }
    }))
    vi.resetModules()
    const { monitorService } = await import('../../src/main/services/monitor')
    const snap = await monitorService.systemSnapshot()
    expect(snap.gpus).toEqual([])
    expect(typeof snap.timestamp).toBe('number')
  })

  it('jobsSnapshot: null without baseUrl, parsed list with /api/jobs (0.1.10)', async () => {
    const { monitorService } = await import('../../src/main/services/monitor')
    expect(await monitorService.jobsSnapshot()).toBeNull()

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).includes('/api/jobs')) {
          return new Response(
            JSON.stringify({ jobs: [{ id: 'j1', status: 'completed', workflow_id: 'wf' }] }),
            { status: 200 }
          )
        }
        return new Response('nope', { status: 404 })
      })
    )
    try {
      const jobs = await monitorService.jobsSnapshot('http://127.0.0.1:8188')
      expect(jobs).toEqual([
        { id: 'j1', status: 'completed', workflowId: 'wf', createdAt: undefined }
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('jobsSnapshot: unsupported endpoint yields null (legacy queue view stays)', async () => {
    const { monitorService } = await import('../../src/main/services/monitor')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    )
    try {
      expect(await monitorService.jobsSnapshot('http://127.0.0.1:8188')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
