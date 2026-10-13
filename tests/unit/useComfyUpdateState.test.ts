/**
 * useComfyUpdate state behaviour (0.1.11): terminal `cancelled` releases the
 * shared progress slot, empty-instance selection resets banners (no ghost
 * "updating" state), and check progress is tracked per instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>()
}))

vi.mock('@/composables/useIpc', () => ({
  ipc: vi.fn(async () => undefined),
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
})
