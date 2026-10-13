/**
 * Behavioral tests for the per-instance node-op stream tracking (0.1.9).
 *
 * Two instances can run ops simultaneously; the modal must show exactly one
 * stream (the viewed instance), keep the other's state for later, and never
 * let a late terminal event from instance A clobber instance B's UI.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

type Handler = (payload: unknown) => void
const handlers = new Map<string, Handler>()

vi.mock('../../src/renderer/src/composables/useIpc', () => ({
  ipc: vi.fn(async () => true),
  IPC_EVENTS: {
    comfyUpdateProgress: 'ev:comfy',
    repairProgress: 'ev:repair',
    nodeUpdateProgress: 'ev:node',
    nodeInstallProgress: 'ev:install',
    nodeOperationProgress: 'ev:op',
    nodeUpdateBatch: 'ev:batch',
    nodeOpLog: 'ev:log',
    nodeCheckProgress: 'ev:check'
  },
  onIpc: (channel: string, cb: Handler): (() => void) => {
    handlers.set(channel, cb)
    return () => handlers.delete(channel)
  }
}))

function emit(channel: string, payload: unknown): void {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  handler(payload)
}

function progress(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    step: 'clone',
    status: 'running',
    steps: [],
    message: '',
    percent: 0,
    ...partial
  }
}

type Api = ReturnType<
  (typeof import('../../src/renderer/src/composables/useComfyUpdate'))['useComfyUpdate']
>

async function freshApi(): Promise<{ api: Api; ipcMock: ReturnType<typeof vi.fn> }> {
  const mod = await import('../../src/renderer/src/composables/useComfyUpdate')
  const api = mod.useComfyUpdate()
  const ipcMod = await import('../../src/renderer/src/composables/useIpc')
  return { api, ipcMock: ipcMod.ipc as unknown as ReturnType<typeof vi.fn> }
}

describe('per-instance node-op streams (0.1.9)', () => {
  beforeEach(() => {
    handlers.clear()
    vi.resetModules()
  })

  it('shows the viewed instance, keeps others, and ignores cross-instance terminals', async () => {
    const { api } = await freshApi()
    emit('ev:op', progress({ runId: 'rA', instanceId: 'A', message: 'A running', percent: 10 }))
    emit('ev:log', { runId: 'rA', packName: 'PA', line: 'lineA', instanceId: 'A', ts: 1 })
    expect(api.progress.value?.instanceId).toBe('A')
    expect(api.nodeOpLogs.value.map((l) => l.line)).toEqual(['lineA'])

    // Switch to B (no stream yet) — nothing stale may remain on screen.
    api.selectNodeOpInstance('B')
    expect(api.progress.value).toBeNull()
    expect(api.nodeOpLogs.value).toEqual([])

    emit('ev:op', progress({ runId: 'rB', instanceId: 'B', message: 'B running', percent: 5 }))
    expect(api.progress.value?.instanceId).toBe('B')

    // A finishes late — B's display must not be replaced.
    emit(
      'ev:op',
      progress({
        runId: 'rA',
        instanceId: 'A',
        step: 'done',
        status: 'done',
        message: 'A done',
        percent: 100
      })
    )
    expect(api.progress.value?.instanceId).toBe('B')
    expect(api.progress.value?.status).toBe('running')

    // Switching back restores A's terminal state + its logs.
    api.selectNodeOpInstance('A')
    expect(api.progress.value?.status).toBe('done')
    expect(api.nodeOpLogs.value.map((l) => l.line)).toEqual(['lineA'])
  })

  it('keeps batch queues per instance, including events that arrive while away', async () => {
    const { api } = await freshApi()
    emit('ev:batch', {
      batchId: 'bA',
      phase: 'checking',
      index: 0,
      total: 0,
      instanceId: 'A',
      ts: 0
    })
    emit('ev:batch', { batchId: 'bA', phase: 'start', index: 0, total: 2, instanceId: 'A', ts: 1 })
    emit('ev:batch', {
      batchId: 'bA',
      phase: 'pack-start',
      index: 1,
      total: 2,
      packName: 'PA',
      instanceId: 'A',
      ts: 2
    })
    expect(api.nodeBatch.value?.batchId).toBe('bA')

    // View a THIRD instance that never had a stream: display clears…
    api.selectNodeOpInstance('C')
    expect(api.nodeBatch.value).toBeNull()
    expect(api.nodeBatchActive.value).toBe(false)

    // …A's batch keeps progressing in the background (events not dropped)…
    emit('ev:batch', {
      batchId: 'bA',
      phase: 'pack-done',
      index: 1,
      total: 2,
      packName: 'PA',
      ok: true,
      instanceId: 'A',
      ts: 3
    })

    // …and switching back restores the FULL queue state.
    api.selectNodeOpInstance('A')
    expect(api.nodeBatch.value?.batchId).toBe('bA')
    expect(api.nodeBatchActive.value).toBe(true)
    expect(api.nodeBatchEntries.value[0]).toMatchObject({ name: 'PA', status: 'done' })

    emit('ev:batch', {
      batchId: 'bA',
      phase: 'batch-done',
      index: 1,
      total: 2,
      ok: true,
      summary: { ok: 1, fail: 0, skip: 1 },
      instanceId: 'A',
      ts: 4
    })
    expect(api.nodeBatchActive.value).toBe(false)
  })

  it('runs two instances concurrently without cross-contamination', async () => {
    const { api } = await freshApi()
    // A: single op; B: batch.
    emit('ev:op', progress({ runId: 'rA', instanceId: 'A', message: 'A op', percent: 30 }))
    api.selectNodeOpInstance('B')
    emit('ev:batch', { batchId: 'bB', phase: 'start', index: 0, total: 1, instanceId: 'B', ts: 1 })
    emit('ev:batch', {
      batchId: 'bB',
      phase: 'pack-start',
      index: 1,
      total: 1,
      packName: 'PB',
      instanceId: 'B',
      ts: 2
    })
    emit('ev:op', progress({ runId: 'rB', instanceId: 'B', message: 'B pack', percent: 10 }))
    expect(api.nodeBatch.value?.batchId).toBe('bB')
    expect(api.progress.value?.instanceId).toBe('B')
    // A's stream stays intact and untouched by B's activity.
    api.selectNodeOpInstance('A')
    expect(api.nodeBatch.value).toBeNull()
    expect(api.progress.value?.message).toBe('A op')
    expect(api.progress.value?.percent).toBe(30)
  })

  it('buckets op-log lines that arrive before any progress event', async () => {
    const { api } = await freshApi()
    emit('ev:log', { runId: 'rC', packName: 'PC', line: 'early', instanceId: 'C', ts: 1 })
    api.selectNodeOpInstance('C')
    expect(api.nodeOpLogs.value.map((l) => l.line)).toEqual(['early'])
  })

  it('a new single run clears that instance log/batch display, not other instances', async () => {
    const { api } = await freshApi()
    emit('ev:batch', {
      batchId: 'bA',
      phase: 'start',
      index: 0,
      total: 1,
      instanceId: 'A',
      ts: 1
    })
    emit('ev:batch', {
      batchId: 'bA',
      phase: 'batch-done',
      index: 1,
      total: 1,
      ok: true,
      summary: { ok: 1, fail: 0, skip: 0 },
      instanceId: 'A',
      ts: 2
    })
    emit('ev:log', { runId: 'rbatch', packName: 'PA', line: 'batch-line', instanceId: 'A', ts: 3 })
    // A brand-new single op on A starts → its batch display/log resets.
    emit('ev:op', progress({ runId: 'rNew', instanceId: 'A', message: 'new op', percent: 0 }))
    expect(api.nodeBatch.value).toBeNull()
    expect(api.nodeOpLogs.value).toEqual([])
  })

  it('cancel helpers target the instanceId they are given', async () => {
    const { api, ipcMock } = await freshApi()
    ipcMock.mockClear()
    await api.cancelNodeBatch('B')
    expect(ipcMock).toHaveBeenCalledWith('node.cancelBatch', 'B')
    await api.cancelNodeOp('B')
    expect(ipcMock).toHaveBeenCalledWith('node.cancelOp', 'B')
  })
})
