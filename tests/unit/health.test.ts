import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  instances: [] as Array<Record<string, unknown>>,
  settings: {
    healthCheckEnabled: true,
    healthCheckIntervalMs: 60_000,
    healthCheckTimeoutMs: 250,
    healthStaleMs: 60_000
  } as Record<string, unknown>
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.root },
  session: { defaultSession: { fetch: (...a: unknown[]) => fetch(...(a as [string])) } }
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => h.settings,
  loadInstanceConfigs: () => h.instances,
  listRemotes: () => [],
  logsDir: () => join(h.root, 'logs')
}))

import { decideHealth, instanceHealthService } from '../../src/main/services/instance/health'
import { monitorService } from '../../src/main/services/monitor'
import { startFakeComfy, type FakeComfyServer } from '../helpers/fakeComfyServer'

const baseFacts = {
  now: 1_000_000,
  httpOk: false,
  portListening: true,
  processAlive: true,
  lastLogAt: 990_000,
  queueRunning: 0,
  queuePending: 0,
  staleMs: 180_000
}

describe('health state machine (0.2.5 WP2)', () => {
  it('healthy on HTTP success; busy while a queue item makes progress', () => {
    expect(decideHealth(undefined, { ...baseFacts, httpOk: true }, 0).state).toBe('healthy')
    const busy = decideHealth(
      undefined,
      { ...baseFacts, httpOk: true, queueRunning: 1, lastProgressAt: 995_000 },
      0
    )
    expect(busy.state).toBe('busy')
  })

  it('one transient failure does not turn a healthy instance red', () => {
    const prev = {
      instanceId: 'i',
      state: 'healthy' as const,
      checkedAt: 1,
      since: 1,
      consecutiveFailures: 0,
      queueRunning: 0,
      queuePending: 0,
      portListening: true,
      processAlive: true,
      evidence: []
    }
    expect(decideHealth(prev, baseFacts, 0).state).toBe('healthy')
    expect(decideHealth(prev, baseFacts, 2).state).toBe('suspect')
  })

  it('becomes unresponsive only with 6 failures + port + process + stale log', () => {
    const stale = { ...baseFacts, lastLogAt: 1_000_000 - 300_000 }
    expect(decideHealth(undefined, stale, 5).state).toBe('unresponsive')
    expect(decideHealth(undefined, { ...stale, lastLogAt: 999_000 }, 5).state).toBe('suspect')
    expect(decideHealth(undefined, { ...stale, portListening: false }, 5).state).not.toBe(
      'unresponsive'
    )
  })

  it('port down + live process for >10s is crashed, not unresponsive', () => {
    const d = decideHealth(
      undefined,
      { ...baseFacts, portListening: false, startedAt: 1_000_000 - 20_000 },
      5
    )
    expect(d.state).toBe('crashed')
  })

  it('does not kill a busy instance during a transient HTTP timeout', () => {
    const d = decideHealth(undefined, { ...baseFacts, queueRunning: 1, lastProgressAt: 999_000 }, 5)
    expect(d.state).toBe('busy')
  })

  it('process gone is stopped', () => {
    expect(decideHealth(undefined, { ...baseFacts, processAlive: false }, 5).state).toBe('stopped')
  })
})

describe('health service against real HTTP fixtures (0.2.5 WP2)', () => {
  let server: FakeComfyServer
  let root = ''

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cp-health-'))
    h.root = root
    server = await startFakeComfy()
    h.instances = [
      {
        id: 'i1',
        name: 'H',
        path: join(root, 'ComfyUI'),
        pythonPath: '',
        venvPath: '',
        port: server.port,
        listen: '127.0.0.1',
        extraArgs: [],
        argTemplateId: 'default',
        enabled: true,
        notes: '',
        autoStart: false,
        frontendVersion: '',
        pinned: false
      }
    ]
  })

  afterEach(async () => {
    instanceHealthService.stop()
    await server.close()
    rmSync(root, { recursive: true, force: true })
  })

  function ctx(): Parameters<typeof instanceHealthService.start>[0] {
    const rt = {
      config: h.instances[0],
      status: 'running',
      logs: [],
      generation: 1,
      intentionalStop: false,
      ready: true,
      managed: true,
      readyWaiters: [],
      process: { exitCode: null },
      pid: process.pid,
      startedAt: Date.now() - 300_000,
      lastLogAt: Date.now() - 300_000
    }
    return {
      runtimes: new Map([['i1', rt]])
    } as unknown as Parameters<typeof instanceHealthService.start>[0]
  }

  it('reports healthy / busy from a real server', async () => {
    instanceHealthService.start(ctx())
    const healthy = await instanceHealthService.check('i1')
    expect(healthy.state).toBe('healthy')
    expect(healthy.portListening).toBe(true)
    expect(healthy.processAlive).toBe(true)

    server.setQueue(1, 0)
    ;(monitorService as unknown as { progressAtByBase: Map<string, number> }).progressAtByBase.set(
      server.url,
      Date.now()
    )
    const busy = await instanceHealthService.check('i1')
    expect(busy.state).toBe('busy')
  })

  it('reports an adopted external instance as healthy without a child PID', async () => {
    const c = ctx()
    const rt = c.runtimes.get('i1')!
    rt.process = undefined
    rt.pid = undefined
    rt.managed = false
    instanceHealthService.start(c)
    const health = await instanceHealthService.check('i1')
    expect(health.processAlive).toBe(true)
    expect(health.state).toBe('healthy')
  })

  it('walks suspect → unresponsive when the event loop hangs', async () => {
    instanceHealthService.start(ctx())
    server.setMode('hang')
    let health = await instanceHealthService.check('i1')
    for (let i = 0; i < 5; i++) health = await instanceHealthService.check('i1')
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(6)
    expect(health.state).toBe('unresponsive')
    expect(health.evidence).toContain('port-listening')
    expect(health.evidence).toContain('log-stale')
  })

  it('recovers to healthy as soon as HTTP answers again', async () => {
    instanceHealthService.start(ctx())
    server.setMode('hang')
    for (let i = 0; i < 3; i++) await instanceHealthService.check('i1')
    server.setMode('normal')
    const health = await instanceHealthService.check('i1')
    expect(health.state).toBe('healthy')
    expect(health.consecutiveFailures).toBe(0)
  })

  it('reports stopped when the process handle is gone', async () => {
    const c = ctx()
    c.runtimes.get('i1')!.process = undefined
    c.runtimes.get('i1')!.pid = undefined
    instanceHealthService.start(c)
    const health = await instanceHealthService.check('i1')
    expect(health.state).toBe('stopped')
  })
})
