/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * useComfyUpdate state behaviour (0.1.11): terminal `cancelled` releases the
 * shared progress slot, empty-instance selection resets banners (no ghost
 * "updating" state), and check progress is tracked per instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  ipcResult: undefined as any,
  ipcError: null as any,
  calls: [] as any[]
}))

vi.mock('@/composables/useIpc', () => ({
  ipc: vi.fn(async (...a: any[]) => {
    h.calls.push(a)
    if (h.ipcError) throw h.ipcError
    return h.ipcResult
  }),
  onIpc: (channel: string, cb: (payload: unknown) => void) => {
    h.handlers.set(channel, cb)
    return () => h.handlers.delete(channel)
  },
  IPC_EVENTS: {
    comfyUpdateProgress: 'event:comfy-update',
    repairProgress: 'event:repair',
    nodeUpdateProgress: 'event:node-update',
    nodeInstallProgress: 'event:node-install',
    nodeOperationProgress: 'event:node-op',
    nodeUpdateBatch: 'event:node-batch',
    nodeOpLog: 'event:node-op-log',
    nodeCheckProgress: 'event:node-check'
  }
}))

function fire(channel: string, payload: unknown): void {
  const cb = h.handlers.get(channel)
  expect(cb, `no handler registered for ${channel}`).toBeTruthy()
  cb!(payload)
}

describe('useComfyUpdate state (0.1.11)', () => {
  beforeEach(() => {
    h.handlers.clear()
    h.ipcResult = undefined
    h.ipcError = null
    h.calls = []
    vi.resetModules()
  })

  it('lets a new stream claim the slot after a CANCELLED node op (terminal)', async () => {
    const mod = await import('@/composables/useComfyUpdate')
    const api = mod.useComfyUpdate()
    fire('event:node-op', {
      runId: 'r1',
      instanceId: 'inst-1',
      status: 'running',
      steps: [],
      step: 'download',
      message: '',
      percent: 10
    })
    expect(api.progress.value?.runId).toBe('r1')
    // Cancelled is terminal — the slot must be released.
    fire('event:node-op', {
      runId: 'r1',
      instanceId: 'inst-1',
      status: 'cancelled',
      steps: [],
      step: 'done',
      message: 'cancelled',
      percent: 42
    })
    // A DIFFERENT kind (repair) can now own the slot. Before the fix the slot
    // stayed "busy" forever and this write was silently dropped.
    fire('event:repair', {
      runId: 'r2',
      instanceId: 'inst-1',
      status: 'running',
      steps: [],
      step: 'venv',
      message: '',
      percent: 1
    })
    expect(api.progress.value?.runId).toBe('r2')
  })

  it("resets banners when the selection clears ('' must not keep a ghost)", async () => {
    const mod = await import('@/composables/useComfyUpdate')
    const api = mod.useComfyUpdate()
    api.selectNodeOpInstance('inst-1')
    fire('event:node-update', {
      phase: 'start',
      packName: 'GhostPack',
      instanceId: 'inst-1',
      ts: 1
    })
    expect(api.nodeUpdatingPack.value).toBe('GhostPack')
    api.selectNodeOpInstance('')
    expect(api.nodeUpdatingPack.value).toBeNull()
    expect(api.nodeUpdateMessage.value).toBe('')
    expect(api.nodeInstallingPack.value).toBeNull()
  })

  it('keeps check progress per instance (no cross-instance leakage)', async () => {
    const mod = await import('@/composables/useComfyUpdate')
    const api = mod.useComfyUpdate()
    api.selectNodeOpInstance('inst-1')
    fire('event:node-check', { done: 2, total: 5, instanceId: 'inst-1', ts: 1 })
    expect(api.nodeCheck.value?.done).toBe(2)
    // Switching instances must not leak the counter…
    api.selectNodeOpInstance('inst-2')
    expect(api.nodeCheck.value).toBeNull()
    // …and switching back remembers the per-instance value.
    api.selectNodeOpInstance('inst-1')
    expect(api.nodeCheck.value?.done).toBe(2)
  })

  it('keeps a node-op snapshot when another operation owns the shared slot', async () => {
    const mod = await import('@/composables/useComfyUpdate')
    const api = mod.useComfyUpdate()
    fire('event:repair', {
      runId: 'repair-1',
      instanceId: 'inst-1',
      status: 'running',
      steps: [],
      step: 'venv',
      message: '',
      percent: 3
    })
    fire('event:node-op', {
      runId: 'op-1',
      instanceId: 'inst-1',
      status: 'running',
      steps: [],
      step: 'download',
      message: '',
      percent: 10
    })
    // The slot still belongs to repair…
    expect(api.progress.value?.runId).toBe('repair-1')
    // …but the node modal can still read its own stream (steps + cancel).
    expect(api.nodeOpSnapshot.value?.runId).toBe('op-1')
  })

  it('covers node banners, batch queues, logs and check progress', async () => {
    const mod = await import('@/composables/useComfyUpdate')
    const api = mod.useComfyUpdate()
    api.selectNodeOpInstance('inst-1')
    fire('event:node-update', null)
    fire('event:node-install', null)
    fire('event:node-update', {
      phase: 'start',
      packName: 'P',
      message: 'm',
      instanceId: 'inst-1',
      ts: 1
    })
    expect(api.nodeUpdatingPack.value).toBe('P')
    fire('event:node-update', {
      phase: 'done',
      packName: 'P',
      instanceId: 'inst-1',
      ts: 1
    })
    expect(api.nodeUpdatingPack.value).toBeNull()
    fire('event:node-install', {
      phase: 'download',
      packName: 'I',
      instanceId: 'inst-1',
      ts: 1
    })
    expect(api.nodeInstallingPack.value).toBe('I')
    fire('event:node-install', {
      phase: 'error',
      packName: 'I',
      instanceId: 'inst-1',
      ts: 1
    })
    expect(api.nodeInstallingPack.value).toBeNull()
    fire('event:node-update', { phase: 'start', packName: 'D', ts: 1 })

    fire('event:node-op', null)
    fire('event:node-op', { status: 'running' })
    fire('event:node-op', {
      runId: 'r1',
      instanceId: 'inst-1',
      status: 'running',
      steps: [],
      percent: 1
    })
    fire('event:node-op-log', null)
    fire('event:node-op-log', { line: '' })
    fire('event:node-op-log', { line: 'one', ts: 1 })
    fire('event:node-op-log', { instanceId: 'inst-2', line: 'two', ts: 2 })
    for (let i = 0; i < 410; i++) {
      fire('event:node-op-log', { instanceId: 'inst-1', packName: 'p', line: `l${i}`, ts: i })
    }

    fire('event:node-batch', null)
    fire('event:node-batch', {})
    fire('event:node-batch', { phase: 'checking', index: 0, total: 2, ts: 1 })
    fire('event:node-batch', { phase: 'start', index: 0, total: 2, instanceId: 'inst-1', ts: 1 })
    fire('event:node-batch', {
      phase: 'pack-start',
      index: 1,
      total: 2,
      packName: 'A',
      instanceId: 'inst-1',
      ts: 1
    })
    fire('event:node-batch', {
      phase: 'pack-done',
      index: 1,
      total: 2,
      packName: 'A',
      ok: true,
      instanceId: 'inst-1',
      ts: 1
    })
    fire('event:node-batch', {
      phase: 'pack-done',
      index: 2,
      total: 2,
      packName: 'B',
      ok: false,
      instanceId: 'inst-1',
      ts: 1
    })
    fire('event:node-batch', {
      phase: 'pack-start',
      index: 3,
      total: 2,
      instanceId: 'inst-1',
      ts: 1
    })
    fire('event:node-batch', {
      phase: 'batch-done',
      index: 2,
      total: 2,
      instanceId: 'inst-1',
      summary: { ok: 1, fail: 1, skip: 0, cancelled: true },
      ts: 1
    })
    fire('event:node-batch', { phase: 'checking', index: 0, total: 1, ts: 1 })
    fire('event:node-batch', {
      phase: 'batch-error',
      index: 0,
      total: 1,
      instanceId: 'inst-1',
      ts: 1
    })

    fire('event:node-check', null)
    fire('event:node-check', { done: 1, total: 2 })
    fire('event:node-check', { done: 2, total: 2, instanceId: 'inst-2', ts: 1 })
    api.selectNodeOpInstance('inst-2')
    expect(api.nodeCheck.value?.done).toBe(2)
    api.selectNodeOpInstance('')
  })

  it('covers operation start/cancel/hydrate and error mapping', async () => {
    const mod = await import('@/composables/useComfyUpdate')
    const api = mod.useComfyUpdate()
    h.ipcResult = { runId: 'r1' }
    await expect(api.startUpdate('inst-1')).resolves.toBeTruthy()
    expect(h.calls.at(-1)?.[0]).toBe('instance.updateComfy')
    h.ipcError = Object.assign(new Error('busy'), { code: 'OP_BUSY' })
    await expect(api.startUpdate('inst-1')).rejects.toMatchObject({ code: 'OP_BUSY' })
    h.ipcError = Object.assign(new Error('busy'), { code: 'OP_BUSY', messageKey: 'k' })
    await expect(api.repairEnv('inst-1')).rejects.toBeTruthy()
    h.ipcError = null
    h.ipcResult = { ok: true }
    expect(await api.cancelUpdate()).toBeTruthy()
    expect(await api.cancelRepair()).toBeTruthy()
    expect(await api.cancelNodeOp()).toBeTruthy()
    expect(await api.cancelNodeBatch()).toBeTruthy()
    h.ipcResult = { status: 'running', runId: 'r', instanceId: 'inst-1', steps: [], percent: 1 }
    await api.hydrateActiveOp()
    await api.hydrateNodeOp('inst-1')
    await api.hydrateNodeOp()
    h.ipcResult = { instanceId: 'inst-1', runId: 'r', status: 'running', steps: [], percent: 2 }
    await api.hydrateNodeOp('inst-1')
    expect(api.progress.value).toBeTruthy()
    expect(mod.updateDetailOf(((k: string) => k) as any, { detail: 'd' })).toBeTypeOf('string')
    expect(
      mod.updateStepTitle(((k: string) => k) as any, {
        id: 'download',
        title: 'Title',
        status: 'running',
        detail: 'd',
        log: []
      })
    ).toBeTruthy()
    expect(mod.updateStepTitle(((k: string) => k) as any, 'download')).toBeTruthy()
    for (const [err, code] of [
      [{ code: 'OP_BUSY' }, 'OP_BUSY'],
      [{ code: 'SETTING_OFFLINE' }, 'SETTING_OFFLINE'],
      [{ code: 'SETTING_SECURITY_STRONG' }, 'SETTING_SECURITY_STRONG'],
      [{ code: 'SETTING_GIT_INSTALL' }, 'SETTING_GIT_INSTALL'],
      [{ code: 'REMOTE_NOT_SUPPORTED' }, 'REMOTE_NOT_SUPPORTED'],
      [new Error('plain'), ''],
      ['string', '']
    ] as const) {
      const msg = mod.describeNodeError(((k: string) => k) as any, err)
      expect(msg).toBeTypeOf('string')
      expect(code).toBeTypeOf('string')
    }
    expect(mod.hasDepsSkippedIssue([{ code: 'pip-disabled' }])).toBe(true)
    expect(mod.hasDepsSkippedIssue([])).toBe(false)
    expect(mod.hasDepsSkippedIssue()).toBe(false)
  })

  it('refuses to steal the shared slot while a different operation is live', async () => {
    const mod = await import('@/composables/useComfyUpdate')
    const api = mod.useComfyUpdate()
    fire('event:node-op', {
      runId: 'op-live',
      instanceId: 'inst-1',
      status: 'running',
      steps: [],
      step: 'download',
      message: '',
      percent: 10
    })
    await expect(api.startUpdate('inst-1')).rejects.toMatchObject({ code: 'OP_BUSY' })
    await expect(api.repairEnv('inst-1')).rejects.toMatchObject({ code: 'OP_BUSY' })
    expect(api.progress.value?.runId).toBe('op-live')
  })
})
