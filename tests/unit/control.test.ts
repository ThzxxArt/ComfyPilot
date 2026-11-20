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
    stopExited: true
  }
  const instanceService = {
    runtimes: state.runtimes,
    list: () => state.instances,
    stop: async (id: string) => {
      state.calls.push(`stop:${id}`)
      return { id, status: 'stopped', exited: state.stopExited }
    },
    forceKill: async (id: string) => {
      state.calls.push(`forceKill:${id}`)
      return { id, status: 'stopped', exited: true }
    },
    launch: async (id: string, opts?: unknown) => {
      state.calls.push(`launch:${id}:${JSON.stringify(opts || {})}`)
      return { id, status: 'running' }
    }
  }
  return { state, instanceService }
})

vi.mock('../../src/main/services/instance', () => ({ instanceService: h.instanceService }))
vi.mock('../../src/main/services/instance/health', () => ({
  instanceHealthService: {
    get: () => undefined,
    recoveryPolicy: () => ({
      enabled: false,
      action: 'restart',
      afterMs: 60_000,
      maxAttempts: 3,
      cooldownMs: 300_000,
      killRunningJobs: false
    })
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
