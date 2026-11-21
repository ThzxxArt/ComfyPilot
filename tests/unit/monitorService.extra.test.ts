/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  configs: [] as any[],
  remotes: [] as any[],
  fetchResult: null as any,
  fetchError: null as any,
  history: [] as any[],
  jobs: null as any,
  opResult: true as boolean,
  opError: null as any,
  notifications: [] as any[]
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => h.configs,
  listRemotes: () => h.remotes
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyFetch: async () => {
    if (h.fetchError) throw h.fetchError
    return h.fetchResult
  }
}))

vi.mock('../../src/main/services/comfyApi', () => ({
  ComfyApiClient: class {
    constructor(
      public baseUrl: string,
      public opts?: any
    ) {}
    async history() {
      if (h.opError) throw h.opError
      return h.history
    }
    async jobsList() {
      if (h.opError) throw h.opError
      return h.jobs
    }
    async clearQueue() {
      if (h.opError) throw h.opError
      return h.opResult
    }
    async interrupt() {
      if (h.opError) throw h.opError
      return h.opResult
    }
    async freeMemory() {
      if (h.opError) throw h.opError
      return h.opResult
    }
  }
}))

vi.mock('../../src/main/ipc/handlers', () => ({
  broadcastNotification: (n: any) => h.notifications.push(n)
}))

vi.mock('ws', () => ({
  default: class {
    readyState = 1
    on() {}
    once() {}
    close() {}
    send() {}
    removeAllListeners() {}
  }
}))

import { MonitorService } from '../../src/main/services/monitor'

beforeEach(() => {
  h.configs = []
  h.remotes = []
  h.fetchResult = { ok: true, json: async () => ({}) }
  h.fetchError = null
  h.history = []
  h.jobs = null
  h.opResult = true
  h.opError = null
  h.notifications = []
})

const snapshot = (extra: Record<string, unknown> = {}): any => ({
  cpuUsage: 10,
  ramTotal: 100,
  ramUsed: 50,
  diskFree: 1,
  diskTotal: 2,
  gpus: [],
  timestamp: 1,
  ...extra
})

describe('MonitorService extra branches', () => {
  it('tracks progress, series and threshold alerts', async () => {
    const svc = new MonitorService()
    expect(svc.lastProgressAt()).toBeUndefined()
    expect(svc.lastProgressAt('http://x/')).toBeUndefined()
    ;(svc as any).progressAtByBase.set('http://x', 5)
    expect(svc.lastProgressAt('http://x/')).toBe(5)
    expect(svc.seriesSnapshot()).toEqual([])
    ;(svc as any).recordSeries(snapshot({ ramTotal: 0, gpus: [] }))
    expect(svc.seriesSnapshot()).toHaveLength(1)
    ;(svc as any).recordSeries(snapshot({ ramUsed: 99, gpus: [{ vramTotal: 100, vramUsed: 99 }] }))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.notifications.length).toBeGreaterThan(0)
    const before = h.notifications.length
    ;(svc as any).recordSeries(snapshot({ ramUsed: 99, gpus: [{ vramTotal: 100, vramUsed: 99 }] }))
    await new Promise((r) => setTimeout(r, 0))
    expect(h.notifications.length).toBe(before)
    for (let i = 0; i < 310; i++) (svc as any).recordSeries(snapshot())
    expect(svc.seriesSnapshot().length).toBeLessThanOrEqual(300)
  })

  it('reads queue/history/jobs defensively', async () => {
    const svc = new MonitorService()
    expect(await svc.queueSnapshot()).toMatchObject({ running: [] })
    await expect(svc.queueSnapshot('http://evil:8188')).rejects.toThrow(/not allowed/)
    h.fetchResult = { ok: false, json: async () => ({}) }
    expect(await svc.queueSnapshot('http://localhost:8188')).toMatchObject({ doneCount: 0 })
    h.fetchResult = {
      ok: true,
      json: async () => ({
        queue_running: [[0, 'p1'], 'p2'],
        queue_pending: [[1, '', 'x']]
      })
    }
    h.history = [{ promptId: 'p1', status: 'success', completedAt: 1 }]
    const q = await svc.queueSnapshot('http://localhost:8188')
    expect(q.running).toHaveLength(2)
    expect(q.pending[0].promptId).toBe('')
    expect(q.doneCount).toBe(1)
    h.fetchError = new Error('offline')
    expect(await svc.queueSnapshot('http://localhost:8188')).toMatchObject({ doneCount: 0 })
    h.fetchError = null
    await expect(svc.history('http://evil:8188')).rejects.toThrow(/not allowed/)
    expect(await svc.history()).toMatchObject({ doneCount: 0 })
    expect(await svc.jobsSnapshot()).toBeNull()
    await expect(svc.jobsSnapshot('http://evil:8188')).rejects.toThrow(/not allowed/)
    h.jobs = [{ id: 'j1' }]
    expect(await svc.jobsSnapshot('http://localhost:8188')).toEqual([{ id: 'j1' }])
    h.opError = new Error('jobs failed')
    await expect(svc.jobsSnapshot('http://localhost:8188')).rejects.toThrow(/jobs failed/)
  })

  it('reports queue operations honestly', async () => {
    const svc = new MonitorService()
    expect(await svc.clearQueue('http://localhost:8188')).toEqual({ ok: true })
    expect(await svc.interrupt('http://localhost:8188', 'p1')).toEqual({ ok: true })
    expect(await svc.interrupt('http://localhost:8188')).toEqual({ ok: true })
    expect(await svc.freeMemory('http://localhost:8188')).toEqual({ ok: true })
    h.opResult = false
    expect((await svc.clearQueue('http://localhost:8188')).ok).toBe(false)
    expect((await svc.interrupt('http://localhost:8188')).ok).toBe(false)
    expect((await svc.freeMemory('http://localhost:8188')).ok).toBe(false)
    h.opError = new Error('boom')
    expect((await svc.clearQueue('http://localhost:8188')).error).toContain('boom')
    h.opError = 'plain'
    expect((await svc.freeMemory('http://localhost:8188')).error).toContain('plain')
    h.opError = null
    await expect(svc.clearQueue('http://evil:8188')).resolves.toMatchObject({ ok: false })
  })

  it('caches system snapshots and degrades on sampling failure', async () => {
    const svc = new MonitorService()
    const first = await svc.systemSnapshot()
    expect(Array.isArray(first.gpus)).toBe(true)
    const cached = await svc.systemSnapshot()
    expect(cached).toBe(first)
    const forced = await svc.systemSnapshot({ force: true })
    expect(forced).toBeTruthy()
    const inflight = svc.systemSnapshot({ force: true })
    expect(await svc.systemSnapshot({ force: true })).toBeTruthy()
    expect(await inflight).toBeTruthy()
  })
})
