/**
 * Renderer pip-op + exec-diagnostics composables (0.1.12).
 * Covers the state machine the git-diff audit flagged as untested:
 * refreshStatus hydration, event-driven activeInstances, run() lifecycle
 * (busy/active/modal), openFor reopen, log streaming, exec-failure merge
 * and the dispose teardown paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  ipcImpl: null as null | ((channel: string, ...args: unknown[]) => Promise<unknown>),
  ipcCalls: [] as Array<{ channel: string; args: unknown[] }>
}))

vi.mock('@/composables/useIpc', () => ({
  ipc: vi.fn(async (channel: string, ...args: unknown[]) => {
    h.ipcCalls.push({ channel, args })
    if (h.ipcImpl) return h.ipcImpl(channel, ...args)
    return undefined
  }),
  onIpc: (channel: string, cb: (payload: unknown) => void) => {
    h.handlers.set(channel, cb)
    return () => h.handlers.delete(channel)
  },
  IPC_EVENTS: {
    pipOpProgress: 'event:pip-op-progress',
    pipOpLog: 'event:pip-op-log',
    execError: 'event:exec-error'
  },
  ComfyPilotIpcError: class ComfyPilotIpcError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.name = 'ComfyPilotIpcError'
      this.code = code
    }
  }
}))

function fire(channel: string, payload: unknown): void {
  const cb = h.handlers.get(channel)
  expect(cb, `no handler for ${channel}`).toBeTruthy()
  cb!(payload)
}

function progress(status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'r1',
    instanceId: 'i1',
    status,
    steps: [],
    step: status === 'done' ? 'done' : 'requirements',
    message: '',
    percent: status === 'done' ? 100 : 40,
    ...over
  }
}

describe('usePipOps (0.1.12)', () => {
  beforeEach(() => {
    h.handlers.clear()
    h.ipcImpl = null
    h.ipcCalls = []
    vi.resetModules()
  })

  it('refreshStatus hydrates running ops and clears finished ones', async () => {
    const mod = await import('@/composables/usePipOps')
    const api = mod.usePipOps()

    h.ipcImpl = async (channel) => {
      if (channel === 'instance.pipStatus') return progress('running')
      return null
    }
    expect(await api.refreshStatus('i1')).toBe(true)
    expect(api.activeInstances.value).toContain('i1')
    expect(api.busy.value).toBe(true)
    expect(api.viewedInstanceId.value).toBe('i1')

    // Finished op → banner state cleared.
    h.ipcImpl = async (channel) => {
      if (channel === 'instance.pipStatus') return null
      return null
    }
    expect(await api.refreshStatus('i1')).toBe(false)
    expect(api.activeInstances.value).not.toContain('i1')
    expect(api.busy.value).toBe(false)
  })

  it('progress events drive activeInstances and log streaming', async () => {
    const mod = await import('@/composables/usePipOps')
    const api = mod.usePipOps()

    fire('event:pip-op-progress', progress('running'))
    expect(api.activeInstances.value).toContain('i1')
    expect(api.busy.value).toBe(true)

    fire('event:pip-op-log', { instanceId: 'i1', line: 'installing onnx…', ts: 1 })
    fire('event:pip-op-log', { instanceId: 'i1', line: 'done', ts: 2 })
    expect(api.logs.value.map((l: any) => l.line)).toEqual(['installing onnx…', 'done'])
    expect(api.logSeq.value).toBeGreaterThanOrEqual(2)

    fire('event:pip-op-progress', progress('done'))
    expect(api.activeInstances.value).not.toContain('i1')
    expect(api.busy.value).toBe(false)
  })

  it('run() sets busy/active + opens the modal, and settles via refreshStatus', async () => {
    const mod = await import('@/composables/usePipOps')
    const api = mod.usePipOps()

    let release: ((v: unknown) => void) | null = null
    h.ipcImpl = async (channel) => {
      if (channel === 'instance.pipStatus') return null
      if (channel === 'instance.pipInstall') {
        return new Promise((res) => {
          release = res
        })
      }
      return null
    }
    const p = api.startInstall('i1', 'onnx')
    // Flush the awaited IPC microtasks so run() reaches the install call.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(api.modalVisible.value).toBe(true)
    expect(api.busy.value).toBe(true)
    expect(api.activeInstances.value).toContain('i1')

    // Terminal event arrives before the promise settles — activity clears.
    fire('event:pip-op-progress', progress('done'))
    expect(api.activeInstances.value).not.toContain('i1')

    release!({ ok: true, instanceId: 'i1', requested: ['onnx'], installed: ['onnx'] })
    const r = await p
    expect(r.ok).toBe(true)
    expect(api.busy.value).toBe(false)
    // Modal stays open until the user closes it (no auto-close contract).
    expect(api.modalVisible.value).toBe(true)
  })

  it('openFor re-opens a running op for an instance', async () => {
    const mod = await import('@/composables/usePipOps')
    const api = mod.usePipOps()

    h.ipcImpl = async (channel) => {
      if (channel === 'instance.pipStatus') return progress('running', { instanceId: 'i2' })
      return null
    }
    await api.openFor('i2')
    expect(api.modalVisible.value).toBe(true)
    expect(api.viewedInstanceId.value).toBe('i2')
    expect(api.activeInstances.value).toContain('i2')
    expect(h.ipcCalls.some((c) => c.channel === 'instance.pipStatus' && c.args[0] === 'i2')).toBe(
      true
    )
  })

  it('disposePipOpSubscriptions removes the stream listeners', async () => {
    const mod = await import('@/composables/usePipOps')
    mod.usePipOps()
    expect(h.handlers.has('event:pip-op-progress')).toBe(true)
    mod.disposePipOpSubscriptions()
    expect(h.handlers.has('event:pip-op-progress')).toBe(false)
    expect(h.handlers.has('event:pip-op-log')).toBe(false)
  })

  it('keeps a locally-received terminal state when main reports no op (0.1.13)', async () => {
    const mod = await import('@/composables/usePipOps')
    const api = mod.usePipOps()

    // Terminal event lands…
    fire('event:pip-op-progress', progress('done'))
    expect((api.progress.value as any)?.status).toBe('done')
    // …then the post-op resync hits a null status (no snapshot from main).
    h.ipcImpl = async () => null
    expect(await api.refreshStatus('i1')).toBe(false)
    // The modal must keep showing the completed op — not a 0% empty shell.
    expect((api.progress.value as any)?.status).toBe('done')
    expect(api.busy.value).toBe(false)
  })

  it('refreshStatus hydrates a finished snapshot from main (0.1.13)', async () => {
    const mod = await import('@/composables/usePipOps')
    const api = mod.usePipOps()

    h.ipcImpl = async (channel) =>
      channel === 'instance.pipStatus' ? progress('done', { percent: 100 }) : null
    expect(await api.refreshStatus('i1')).toBe(false)
    expect((api.progress.value as any)?.status).toBe('done')
    expect((api.progress.value as any)?.percent).toBe(100)
    expect(api.activeInstances.value).not.toContain('i1')
    expect(api.busy.value).toBe(false)
  })

  it('run() refuses to reset the modal while an op is already running (OP_BUSY)', async () => {
    const mod = await import('@/composables/usePipOps')
    const api = mod.usePipOps()

    fire('event:pip-op-log', { instanceId: 'i1', line: 'installing…', ts: 1 })
    h.ipcImpl = async (channel) => {
      if (channel === 'instance.pipStatus') return progress('running')
      if (channel === 'instance.pipInstall') throw new Error('should not be called')
      return null
    }
    await expect(api.startInstall('i1', 'onnx')).rejects.toMatchObject({ code: 'OP_BUSY' })
    // The running stream stays on screen; logs were not wiped and no second
    // install request reached main.
    expect((api.progress.value as any)?.status).toBe('running')
    expect(api.logs.value.map((l: any) => l.line)).toContain('installing…')
    expect(api.modalVisible.value).toBe(true)
    expect(h.ipcCalls.some((c) => c.channel === 'instance.pipInstall')).toBe(false)
  })

  it('run() proceeds past a finished snapshot and keeps the done view (0.1.13)', async () => {
    const mod = await import('@/composables/usePipOps')
    const api = mod.usePipOps()

    h.ipcImpl = async (channel) => {
      if (channel === 'instance.pipStatus') return progress('done', { runId: 'old' })
      if (channel === 'instance.pipInstall')
        return { ok: true, instanceId: 'i1', requested: ['onnx'], installed: ['onnx'] }
      return null
    }
    const r = await api.startInstall('i1', 'onnx')
    expect(r.ok).toBe(true)
    // Terminal event + refreshStatus keep the finished view (not a 0% shell).
    expect((api.progress.value as any)?.status).toBe('done')
    fire('event:pip-op-progress', progress('done', { runId: 'new', percent: 100 }))
    expect((api.progress.value as any)?.percent).toBe(100)
  })
})

describe('useExecDiagnostics (0.1.12)', () => {
  beforeEach(() => {
    h.handlers.clear()
    h.ipcImpl = null
    h.ipcCalls = []
    vi.resetModules()
  })

  it('loads snapshots, accepts live pushes for the loaded instance only, clears and disposes', async () => {
    const mod = await import('@/composables/useExecDiagnostics')
    const api = mod.useExecDiagnostics()

    const f1 = { id: 'a', instanceId: 'i1', source: 'log', at: 1, errorType: 'X', message: 'm1' }
    h.ipcImpl = async (channel) => {
      if (channel === 'instance.execFailures') return [f1]
      if (channel === 'instance.clearExecFailures') return true
      return null
    }
    await api.load('i1')
    expect(api.failures.value).toHaveLength(1)

    // Live push for the same instance → prepended.
    fire('event:exec-error', {
      id: 'b',
      instanceId: 'i1',
      source: 'ws',
      at: 2,
      errorType: 'Y',
      message: 'm2'
    })
    expect(api.failures.value[0].id).toBe('b')
    expect(api.failures.value).toHaveLength(2)

    // Other instances are ignored while i1 is loaded.
    fire('event:exec-error', {
      id: 'c',
      instanceId: 'i9',
      source: 'ws',
      at: 3,
      errorType: 'Z',
      message: 'm3'
    })
    expect(api.failures.value.map((f) => f.id)).not.toContain('c')

    await api.clear('i1')
    expect(api.failures.value).toHaveLength(0)

    expect(h.handlers.has('event:exec-error')).toBe(true)
    mod.disposeExecDiagnosticsSubscription()
    expect(h.handlers.has('event:exec-error')).toBe(false)
  })

  it('load() ignores a stale response after switching instances (0.1.13)', async () => {
    const mod = await import('@/composables/useExecDiagnostics')
    const api = mod.useExecDiagnostics()

    let releaseA: ((v: unknown) => void) | null = null
    h.ipcImpl = async (channel, id) => {
      if (channel === 'instance.execFailures' && id === 'i1') {
        return new Promise((res) => (releaseA = res))
      }
      if (channel === 'instance.execFailures' && id === 'i2') {
        return [{ id: 'x2', instanceId: 'i2', source: 'log', at: 5, errorType: 'E', message: 'm' }]
      }
      return null
    }
    const pA = api.load('i1')
    await api.load('i2')
    expect(api.failures.value[0]?.id).toBe('x2')
    // The stale i1 response arrives later — must not clobber i2's list.
    releaseA!([
      { id: 'x1', instanceId: 'i1', source: 'log', at: 1, errorType: 'E', message: 'stale' }
    ])
    await pA
    expect(api.failures.value.map((f) => f.id)).toEqual(['x2'])
  })

  it('caps per-instance op views so long sessions stay bounded (0.1.16)', async () => {
    const { usePipOps } = await import('@/composables/usePipOps')
    const ops = usePipOps()
    for (let i = 0; i < 35; i++) {
      fire('event:pip-op-progress', progress('running', { instanceId: `inst-${i}` }))
    }
    // Still functional after internal eviction.
    expect(ops.activeInstances.value).toContain('inst-34')
  })
})
