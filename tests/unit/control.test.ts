/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => {
  const state = {
    root: '',
    instances: [] as Array<Record<string, unknown>>,
    runtimes: new Map<string, Record<string, unknown>>(),
    calls: [] as string[],
    stopExited: true,
    launchDelay: 0,
    throwString: false,
    healthNow: undefined as Record<string, unknown> | undefined,
    recovery: {
      enabled: false,
      action: 'restart',
      afterMs: 60_000,
      maxAttempts: 3,
      cooldownMs: 300_000,
      killRunningJobs: false
    } as Record<string, unknown>
  }
  const instanceService = {
    runtimes: state.runtimes,
    list: () => state.instances,
    stop: async (id: string) => {
      state.calls.push(`stop:${id}`)
      if (state.throwString) throw 'stop exploded'
      return { id, status: 'stopped', exited: state.stopExited }
    },
    forceKill: async (id: string) => {
      state.calls.push(`forceKill:${id}`)
      return { id, status: 'stopped', exited: true }
    },
    launch: async (id: string, opts?: unknown) => {
      state.calls.push(`launch:${id}:${JSON.stringify(opts || {})}`)
      if (state.launchDelay) await new Promise((r) => setTimeout(r, state.launchDelay))
      return { id, status: 'running' }
    }
  }
  return { state, instanceService }
})

vi.mock('../../src/main/services/instance', () => ({ instanceService: h.instanceService }))
vi.mock('../../src/main/services/instance/health', () => ({
  instanceHealthService: {
    get: () => h.state.healthNow,
    recoveryPolicy: () => h.state.recovery
  }
}))
vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => h.state.instances,
  logsDir: () => join(h.state.root, 'logs'),
  userDataDir: () => h.state.root,
  loadSettings: () => ({})
}))

import {
  executeControlCommand,
  exportRescueScript,
  noteHealthForRecovery,
  parseControlArgv,
  resetRecoveryStateForTest
} from '../../src/main/control'

beforeEach(() => {
  if (h.state.root) rmSync(h.state.root, { recursive: true, force: true })
  h.state.root = mkdtempSync(join(tmpdir(), 'cp-control-'))
  h.state.instances = [{ id: 'i1', name: 'Alpha', status: 'running' }]
  h.state.runtimes.clear()
  h.state.runtimes.set('i1', { managed: true, ready: true, process: {} })
  h.state.calls = []
  h.state.stopExited = true
  h.state.launchDelay = 0
  h.state.throwString = false
  h.state.healthNow = undefined
  h.state.recovery = {
    enabled: false,
    action: 'restart',
    afterMs: 60_000,
    maxAttempts: 3,
    cooldownMs: 300_000,
    killRunningJobs: false
  }
  resetRecoveryStateForTest()
})

describe('control argv (0.2.5 WP3)', () => {
  it('parses the documented flags and nothing else', () => {
    expect(parseControlArgv(['exe', '--rescue', 'i1'])).toEqual({
      action: 'rescue',
      instanceId: 'i1'
    })
    expect(parseControlArgv(['exe', '--safe-rescue=i1'])).toEqual({
      action: 'safe-rescue',
      instanceId: 'i1'
    })
    expect(parseControlArgv(['exe', '--stop', 'i1'])).toEqual({ action: 'stop', instanceId: 'i1' })
    expect(parseControlArgv(['exe', '--status'])).toEqual({ action: 'status' })
    expect(parseControlArgv(['exe', '--rescue'])).toEqual({
      action: 'rescue',
      instanceId: undefined
    })
    expect(parseControlArgv(['exe', '--some-other-flag'])).toBeNull()
    expect(parseControlArgv(['exe'])).toBeNull()
  })
})

describe('control execution (0.2.5 WP3)', () => {
  it('rejects unknown, remote and starting instances', async () => {
    expect((await executeControlCommand({ action: 'rescue', instanceId: 'nope' })).ok).toBe(false)
    expect((await executeControlCommand({ action: 'rescue', instanceId: 'remote:r1' })).ok).toBe(
      false
    )
    h.state.instances = [{ id: 'i1', name: 'A', status: 'starting' }]
    const starting = await executeControlCommand({ action: 'rescue', instanceId: 'i1' })
    expect(starting.ok).toBe(false)
    expect(starting.error).toMatch(/starting/i)
    expect(h.state.calls).toEqual([])
  })

  it('never kills an adopted external instance', async () => {
    h.state.runtimes.set('i1', { managed: false, ready: true, process: undefined })
    const result = await executeControlCommand({ action: 'rescue', instanceId: 'i1' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/adopted/i)
    expect(h.state.calls).toEqual([])
  })

  it('stop with exited:false is not reported as success and never launches', async () => {
    h.state.stopExited = false
    const result = await executeControlCommand({ action: 'stop', instanceId: 'i1' })
    expect(result.ok).toBe(false)
    expect(result.exited).toBe(false)
    expect(h.state.calls).toEqual(['stop:i1'])
  })

  it('safe rescue force-kills then launches with safeMode only for this run', async () => {
    const result = await executeControlCommand({ action: 'safe-rescue', instanceId: 'i1' })
    expect(result.ok).toBe(true)
    expect(h.state.calls).toEqual(['forceKill:i1', 'launch:i1:{"safeMode":true}'])
  })

  it('coalesces repeated rescue commands within the 30s cooldown', async () => {
    await executeControlCommand({ action: 'rescue', instanceId: 'i1' })
    const second = await executeControlCommand({ action: 'rescue', instanceId: 'i1' })
    expect(second.merged).toBe(true)
    expect(h.state.calls.filter((c) => c.startsWith('forceKill:')).length).toBe(1)
  })

  it('writes a rescue .bat that never interpolates an arbitrary command', () => {
    const { path } = exportRescueScript('i1')
    expect(existsSync(path)).toBe(true)
    const body = readFileSync(path, 'utf-8')
    expect(body).toContain('--rescue "i1"')
    expect(body).not.toContain('&')
  })
})

describe('control parsing/status/recovery edge branches', () => {
  it('ignores empty/inline-dash values and unknown flags between actions', () => {
    expect(parseControlArgv(['exe', '--foo', '--rescue=--bar'])).toEqual({
      action: 'rescue',
      instanceId: undefined
    })
    expect(parseControlArgv(['exe', '--rescue=', 'i1'])).toEqual({
      action: 'rescue',
      instanceId: undefined
    })
    expect(parseControlArgv(['exe', '--=x', '--status'])).toEqual({ action: 'status' })
  })

  it('writes a status file with instance health and handles missing ids', async () => {
    h.state.healthNow = { instanceId: 'i1', state: 'healthy' } as never
    const status = await executeControlCommand({ action: 'status' })
    expect(status.ok).toBe(true)
    expect(status.statuses?.[0].health).toBeTruthy()
    expect(existsSync(join(h.state.root, 'logs', 'control-status.json'))).toBe(true)

    h.state.instances = []
    const empty = await executeControlCommand({ action: 'status' })
    expect(empty.statuses).toEqual([])

    expect((await executeControlCommand({ action: 'stop' })).error).toMatch(/Missing instance id/)
    expect((await executeControlCommand({ action: 'stop', instanceId: 'bad id!' })).error).toMatch(
      /Invalid instance id/
    )
    expect(() => exportRescueScript('missing')).toThrow(/Unknown instance/)
  })

  it('reports stop/start success, already-running and non-Error throws', async () => {
    const stopped = await executeControlCommand({ action: 'stop', instanceId: 'i1' })
    expect(stopped).toMatchObject({ ok: true, exited: true })

    h.state.instances = [{ id: 'i1', name: 'A', status: 'stopped' }]
    const started = await executeControlCommand({ action: 'start', instanceId: 'i1' })
    expect(started.ok).toBe(true)
    h.state.instances = [{ id: 'i1', name: 'A', status: 'running' }]
    expect((await executeControlCommand({ action: 'start', instanceId: 'i1' })).error).toMatch(
      /already running/
    )

    h.state.throwString = true
    const thrown = await executeControlCommand({ action: 'stop', instanceId: 'i1' })
    expect(thrown.ok).toBe(false)
    expect(thrown.error).toBe('stop exploded')
  })

  it('refuses to launch when forceKill reports the process still alive', async () => {
    const original = h.instanceService.forceKill
    ;(h.instanceService as any).forceKill = async (id: string) => {
      h.state.calls.push(`forceKill:${id}`)
      return { id, status: 'error', exited: false }
    }
    try {
      const result = await executeControlCommand({ action: 'rescue', instanceId: 'i1' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/still alive|did not exit/)
      expect(h.state.calls.some((c) => c.startsWith('launch:'))).toBe(false)
    } finally {
      ;(h.instanceService as any).forceKill = original
    }
  })

  it('coalesces concurrent control commands by key', async () => {
    h.state.instances = [{ id: 'i1', name: 'A', status: 'stopped' }]
    h.state.launchDelay = 20
    const first = executeControlCommand({ action: 'start', instanceId: 'i1' })
    const second = executeControlCommand({ action: 'start', instanceId: 'i1' })
    const [a, b] = await Promise.all([first, second])
    expect(a.ok).toBe(true)
    expect(b.merged).toBe(true)
  })

  it('handles recovery policy disable, circuit-break, running jobs and timer firing', async () => {
    vi.useFakeTimers()
    try {
      const health = (over: Record<string, unknown> = {}): never =>
        ({
          instanceId: 'i1',
          state: 'unresponsive',
          since: Date.now() - 10_000,
          queueRunning: 0,
          ...over
        }) as never

      h.state.recovery.enabled = false
      noteHealthForRecovery(health())
      expect(vi.getTimerCount()).toBe(0)

      h.state.recovery.enabled = true
      h.state.recovery.afterMs = 0
      h.state.healthNow = health()
      noteHealthForRecovery(health())
      expect(vi.getTimerCount()).toBe(1)
      // A second note while the timer is pending is a no-op.
      noteHealthForRecovery(health())
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(h.state.calls.some((c) => c.startsWith('forceKill:'))).toBe(true)

      resetRecoveryStateForTest()
      h.state.calls = []
      noteHealthForRecovery(health({ queueRunning: 2 }))
      expect(vi.getTimerCount()).toBe(0)
      h.state.recovery.killRunningJobs = true
      h.state.healthNow = health()
      noteHealthForRecovery(health({ queueRunning: 2 }))
      expect(vi.getTimerCount()).toBe(1)
      resetRecoveryStateForTest()

      h.state.recovery.maxAttempts = 0
      noteHealthForRecovery(health())
      expect(vi.getTimerCount()).toBe(0)

      resetRecoveryStateForTest()
      h.state.recovery.maxAttempts = 10
      h.state.healthNow = health({ state: 'healthy' })
      noteHealthForRecovery(health({ since: Date.now(), state: 'unresponsive' }))
      await vi.advanceTimersByTimeAsync(1)
      // The latest health is healthy, so the timer must not rescue.
      expect(h.state.calls.length).toBe(0)
    } finally {
      vi.useRealTimers()
      resetRecoveryStateForTest()
    }
  })
})
