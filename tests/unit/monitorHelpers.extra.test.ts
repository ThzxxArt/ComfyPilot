/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  configs: [] as any[],
  remotes: [] as any[]
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => h.configs,
  listRemotes: () => h.remotes
}))

vi.mock('../../src/main/services/p1p2', () => ({
  listRemotes: () => h.remotes
}))

import {
  assertMonitorBaseUrl,
  mergeGpuMemory,
  sampleWindowsGpuMemory
} from '../../src/main/services/monitor'

beforeEach(() => {
  h.configs = [
    {
      id: 'i1',
      name: 'Main',
      path: '/tmp/comfy',
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true
    }
  ]
  h.remotes = [{ id: 'r1', baseUrl: 'http://remote:8188', apiKey: 'k' }]
})

describe('monitor helpers', () => {
  it('validates monitor base URLs', () => {
    expect(() => assertMonitorBaseUrl('')).toThrow(/required/)
    expect(() => assertMonitorBaseUrl('not a url')).toThrow(/invalid URL/)
    expect(() => assertMonitorBaseUrl('ftp://localhost')).toThrow(/protocol/)
    expect(() => assertMonitorBaseUrl('http://localhost:8188')).not.toThrow()
    expect(() => assertMonitorBaseUrl('http://127.0.0.1:8188')).not.toThrow()
    expect(() => assertMonitorBaseUrl('http://127.0.0.1:8188')).not.toThrow()
    expect(() => assertMonitorBaseUrl('http://remote:8188')).not.toThrow()
    expect(() => assertMonitorBaseUrl('http://evil:8188')).toThrow(/not allowed/)
    h.remotes = [{ id: 'bad', baseUrl: 'not a url' }]
    expect(() => assertMonitorBaseUrl('http://evil:8188')).toThrow(/not allowed/)
  })

  it('merges GPU controller and adapter memory', () => {
    expect(mergeGpuMemory([], [])).toEqual([])
    expect(
      mergeGpuMemory(
        [{ memoryTotal: 100, memoryUsed: 50 }],
        [{ used: 1, total: 1, sharedUsed: 2, sharedTotal: 3 }]
      )[0]
    ).toMatchObject({ vramTotal: 100 * 1024 * 1024, sharedUsed: 2, sharedTotal: 3 })
    expect(mergeGpuMemory([{ memoryTotal: 100, memoryUsed: 0, vram: 100 }], [])[0]).toMatchObject({
      vramTotal: 100 * 1024 * 1024,
      vramUsed: 0
    })
    expect(
      mergeGpuMemory(
        [{ vram: 100 }],
        [
          { used: 10, total: 100 * 1024 * 1024 },
          { used: 20, total: 200 * 1024 * 1024 }
        ]
      )[0]
    ).toMatchObject({ vramUsed: 10 })
    expect(
      mergeGpuMemory(
        [{ vram: 0 }],
        [
          { used: 0, total: 0 },
          { used: 5, total: 0 }
        ]
      )[0]
    ).toMatchObject({ vramUsed: 5 })
    expect(mergeGpuMemory([{}], [{ used: 0, total: 0 }])[0]).toMatchObject({ vramUsed: 0 })
    expect(
      mergeGpuMemory([{ vram: 10 }], [{ used: -5, total: 10 * 1024 * 1024 }])[0]
    ).toMatchObject({ vramUsed: 0 })
    expect(
      mergeGpuMemory([{ vram: 10 }], [{ used: 100, total: 10 * 1024 * 1024 }])[0]
    ).toMatchObject({ vramUsed: 100 })
  })

  it('returns no Windows adapters on non-Windows platforms', async () => {
    expect(await sampleWindowsGpuMemory()).toEqual([])
  })
})
