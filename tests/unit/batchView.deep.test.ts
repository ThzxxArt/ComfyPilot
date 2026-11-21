// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'

function makeJob(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Job ${id}`,
    instanceId: 'i1',
    status,
    count: 4,
    submitted: 2,
    completed: 1,
    failed: 1,
    submitFailed: 0,
    execFailed: 1,
    produced: 1,
    createdAt: 1,
    notes: 'note',
    params: { seedMode: 'fixed', baseSeed: 7, width: 512, height: 512, steps: 20, cfg: 7 },
    workflowPath: '/tmp/wf/base.json',
    items: [
      {
        workflowId: 'w1',
        workflowName: 'Base',
        workflowPath: '/tmp/wf/base.json',
        count: 4,
        submitted: 2,
        completed: 1,
        failed: 1,
        submitFailed: 0,
        execFailed: 1,
        promptIds: [],
        seeds: [],
        outputPaths: []
      },
      {
        workflowId: 'w2',
        workflowName: 'Second',
        workflowPath: '/tmp/wf/second.json',
        count: 2,
        submitted: 2,
        completed: 2,
        failed: 0,
        submitFailed: 0,
        execFailed: 0,
        promptIds: [],
        seeds: [],
        outputPaths: [],
        cancelled: true
      }
    ],
    ...extra
  }
}
const runningJob = makeJob('b1', 'running')
const doneJob = makeJob('b2', 'done', { produced: 4, failed: 0, errorSummary: 'summary' })
const interruptedJob = makeJob('b3', 'interrupted', { failed: 2 })
const queuedJob = makeJob('b4', 'queued', { failed: 0 })
const remoteJob = makeJob('b5', 'done', { instanceId: 'remote:r1', failed: 0 })
const workflow = {
  id: 'w1',
  name: 'Base',
  path: '/tmp/wf/base.json',
  format: 'json',
  nodeCount: 1,
  tags: [],
  updatedAt: 1,
  missingNodes: [],
  version: '1.0',
  params: {},
  origin: 'library',
  missing: false
}
const missingWorkflow = { ...workflow, id: 'w2', name: 'Missing', missing: true }
const modelMissing = {
  available: true,
  required: 1,
  present: 0,
  missing: [{ name: 'missing.safetensors', nodeType: 'CheckpointLoader', present: false }]
}
const accepted = makeJob('b1', 'submitting')
const finalDone = makeJob('b1', 'done', { produced: 4, failed: 0 })
const finalCancelled = makeJob('b1', 'cancelled')
const finalPartial = makeJob('b1', 'error', { failed: 2 })

let failChannels = new Set<string>()
let failStrings = new Set<string>()
let overrides: Record<string, unknown> = {}
let dialogChoice = 'positive'
let ipcHandlers = new Map<string, Set<(payload: unknown) => void>>()

function dataFor(channel: string): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, channel)) return overrides[channel]
  switch (channel) {
    case 'settings.get':
      return { locale: 'zh-CN', activeInstance: 'i1', modelScanRoots: [] }
    case 'instance.list':
      return [
        {
          id: 'i1',
          name: 'Main',
          path: '/tmp/comfy',
          port: 8188,
          status: 'running',
          enabled: true
        },
        {
          id: 'i2',
          name: 'Stopped',
          path: '/tmp/comfy2',
          port: 8189,
          status: 'stopped',
          enabled: true
        }
      ]
    case 'remote.list':
      return [{ id: 'r1', name: 'Remote', baseUrl: 'http://x', enabled: true }]
    case 'monitor.system':
      return { cpu: 1, memory: 1 }
    case 'batch.list':
      return [runningJob, doneJob, interruptedJob, queuedJob, remoteJob]
    case 'batch.create':
      return makeJob('b9', 'queued')
    case 'batch.start':
    case 'batch.resume':
    case 'batch.retryFailed':
      return accepted
    case 'batch.wait':
      return finalDone
    case 'batch.preflight':
      return { available: true, missingTypes: ['NodeX'], nodeTypes: 5 }
    case 'workflow.checkModels':
      return modelMissing
    case 'workflow.list':
      return [workflow, missingWorkflow]
    case 'instance.launch':
      return {
        id: 'i1',
        name: 'Main',
        path: '/tmp/comfy',
        port: 8188,
        status: 'running',
        url: 'http://127.0.0.1:8188'
      }
    case 'shell.reveal':
      return true
    default:
      return true
  }
}

beforeAll(() => stubBrowser())
beforeEach(() => {
  failChannels = new Set()
  failStrings = new Set()
  overrides = {}
  dialogChoice = 'positive'
  ipcHandlers = new Map()
  installBridge(dataFor)
  ;(window as any).comfyPilot.on = (
    channel: string,
    cb: (payload: unknown) => void
  ): (() => void) => {
    if (!ipcHandlers.has(channel)) ipcHandlers.set(channel, new Set())
    ipcHandlers.get(channel)!.add(cb)
    return () => ipcHandlers.get(channel)?.delete(cb)
  }
  ;(window as any).comfyPilot.invoke = async (channel: string) => {
    if (failChannels.has(channel)) throw new Error(`${channel} boom`)
    if (failStrings.has(channel)) throw channel
    return { ok: true, data: dataFor(channel) }
  }
  document.body.innerHTML = ''
})

describe('BatchView deep coverage', () => {
  async function mountBatch(path = '/batch') {
    const { wrapper, state } = await mountView(
      path,
      () => import('../../src/renderer/src/views/workflows/BatchView.vue')
    )
    const dialog = state.dialog
    if (dialog) {
      const auto = (opts: any): object => {
        try {
          if (typeof opts?.content === 'function') {
            opts.content()
          }
          const cb =
            dialogChoice === 'negative'
              ? opts?.onNegativeClick
              : dialogChoice === 'close'
                ? opts?.onClose
                : dialogChoice === 'mask'
                  ? opts?.onMaskClick
                  : opts?.onPositiveClick
          const r = cb?.()
          if (r && typeof r.catch === 'function') r.catch(() => undefined)
        } catch {
          /* ignore */
        }
        return {}
      }
      dialog.warning = auto
      dialog.info = auto
      dialog.error = auto
      dialog.success = auto
    }
    state.store.instances = [
      {
        id: 'i1',
        name: 'Main',
        path: '/tmp/comfy',
        port: 8188,
        status: 'running',
        enabled: true
      },
      {
        id: 'i2',
        name: 'Stopped',
        path: '/tmp/comfy2',
        port: 8189,
        status: 'stopped',
        enabled: true
      }
    ]
    state.store.activeInstanceId = 'i1'
    state.store.remotes = [{ id: 'r1', name: 'Remote', baseUrl: 'http://x', enabled: true }]
    await state.refresh()
    await nextTick()
    return { wrapper, state }
  }

  it('exercises create, start, settle, resume and retry flows', async () => {
    const { wrapper, state } = await mountBatch()
    try {
      expect(state.isBusy('running')).toBe(true)
      expect(state.isBusy('submitting')).toBe(true)
      expect(state.isBusy('done')).toBe(false)
      expect(state.canStartJob(runningJob)).toBe(true)
      expect(state.canStartJob(makeJob('x', 'queued', { instanceId: 'i2' }))).toBe(false)
      expect(state.canStartJob(remoteJob)).toBe(true)
      expect(state.instanceOptions.length).toBe(3)
      for (const s of [
        'done',
        'error',
        'running',
        'submitting',
        'cancelled',
        'interrupted',
        'queued'
      ]) {
        expect(state.statusType(s)).toBeTypeOf('string')
      }
      expect(state.statusLabel('done')).toBeTruthy()
      expect(state.statusLabel('not-a-status')).toBe('not-a-status')
      expect(state.jobTargetLabel(runningJob)).toBeTruthy()
      expect(state.jobTargetLabel(remoteJob)).toContain('Remote')
      expect(
        state.jobTargetLabel(makeJob('x', 'queued', { instanceId: 'remote:missing' }))
      ).toContain('missing')
      expect(state.jobTargetLabel(makeJob('x', 'queued', { instanceId: '' }))).toBe('—')
      expect(state.seedModeLabel('random')).toBeTruthy()
      expect(state.seedModeLabel('custom')).toBe('custom')
      expect(state.seedModeLabel()).toBe('')

      state.draft.instanceId = 'i2'
      expect(state.resolvedInstanceId()).toBe('i2')
      state.draft.instanceId = ''
      state.store.activeRemoteId = 'r1'
      expect(state.resolvedInstanceId()).toBe('remote:r1')
      state.store.activeRemoteId = null
      expect(state.resolvedInstanceId()).toBe('i1')

      await state.refreshJobs()
      expect(state.jobs.length).toBe(5)
      await state.loadWorkflows()
      expect(state.workflows.length).toBe(2)
      await state.openCreate()
      expect(state.showCreate).toBe(true)
      expect(state.draft.selected).toEqual([])

      await state.createJob()
      state.draft.selected = ['w1']
      state.draft.instanceId = ''
      state.store.activeInstanceId = null
      await state.createJob()
      state.store.activeInstanceId = 'i1'
      state.draft.instanceId = 'i1'
      state.creating = true
      await state.createJob()
      state.creating = false
      state.draft.selected = ['missing']
      await state.createJob()
      state.draft.selected = ['w1']
      state.draft.seedMode = 'fixed'
      state.draft.baseSeed = 9
      state.draft.width = 512
      state.draft.height = 512
      state.draft.steps = 20
      state.draft.cfg = 7
      await state.createJob()
      expect(state.showCreate).toBe(false)
      state.showCreate = true
      state.draft.seedMode = 'random'
      await state.createJob()

      state.jobs = [runningJob]
      expect((await state.settleJob('b1', runningJob)).id).toBe('b1')
      overrides['batch.wait'] = null
      expect((await state.settleJob('b1', runningJob)).id).toBe('b1')
      overrides = {}
      state.reportJobResult(finalDone)
      state.reportJobResult(finalCancelled)
      state.reportJobResult(finalPartial)
      state.settleInBackground('b1', accepted)
      state.settleInBackground('b1', accepted)
      await flushPromises()
      overrides['batch.wait'] = finalCancelled
      state.settleInBackground('b2', accepted)
      await flushPromises()
      overrides = {}
      failChannels = new Set(['batch.wait'])
      state.settleInBackground('b3', accepted)
      await flushPromises()
      failChannels = new Set()

      state.startingId = 'x'
      await state.start('b1')
      state.startingId = ''
      await state.start('b1')
      await state.start('b4')
      await state.start('b5')
      await state.start('missing')
      overrides['batch.start'] = accepted
      await state.start('b2')
      dialogChoice = 'negative'
      await state.start('b2')
      dialogChoice = 'close'
      await state.start('b2')
      dialogChoice = 'mask'
      await state.start('b2')
      dialogChoice = 'positive'
      await flushPromises()
      overrides['batch.preflight'] = { available: false, missingTypes: [], nodeTypes: 0 }
      await state.start('b2')
      overrides['batch.preflight'] = { available: true, missingTypes: [], nodeTypes: 1 }
      await state.start('b2')
      overrides['workflow.checkModels'] = { available: false, missing: [] }
      await state.start('b2')
      overrides['workflow.checkModels'] = { available: true, missing: [] }
      await state.start('b2')
      overrides = {}

      failChannels = new Set()
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'batch.start') throw new Error('instance is not running')
        return { ok: true, data: dataFor(channel) }
      }
      await state.start('b2')
      await flushPromises()
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'batch.start') throw new Error('boom')
        return { ok: true, data: dataFor(channel) }
      }
      await state.start('b2')
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (failChannels.has(channel)) throw new Error(`${channel} boom`)
        if (failStrings.has(channel)) throw channel
        return { ok: true, data: dataFor(channel) }
      }

      await state.resumeJob('b3')
      await state.retryFailedJob('b3')
      await state.cancelJob('b1')
      await state.cancelItem(runningJob, '/tmp/wf/base.json')
      await state.removeJob('b1')
      state.viewOutputs(doneJob)
      await state.safeReveal('/tmp/wf/base.json')
      await flushPromises()

      await state.refreshJobs()
      state.store.activeInstanceId = null
      await state.refreshJobs()
      state.store.activeInstanceId = 'i1'
      await flushPromises()
      await state.refresh()
      state.store.activeInstanceId = null
      await state.refresh()
      state.store.activeInstanceId = 'i1'

      state.highlightJob('b1')
      await nextTick()
      state.highlightJob('b2')
      await nextTick()

      for (const cb of ipcHandlers.get(IPC_EVENTS.batchProgress) || []) cb({})
      expect(wrapper.html()).toBeTruthy()
    } finally {
      try {
        state.message?.destroyAll?.()
      } catch {
        /* noop */
      }
      wrapper.unmount()
    }
  }, 120_000)

  it('covers failures for every action', async () => {
    const { wrapper, state } = await mountBatch()
    try {
      failChannels = new Set([
        'batch.list',
        'batch.create',
        'batch.start',
        'batch.resume',
        'batch.retryFailed',
        'batch.wait',
        'batch.cancel',
        'batch.cancelItem',
        'batch.remove',
        'batch.preflight',
        'workflow.list',
        'workflow.checkModels',
        'shell.reveal'
      ])
      await state.refreshJobs()
      expect(state.loadError).toBeTruthy()
      await state.refresh()
      expect(state.loadError).toBeTruthy()
      await state.loadWorkflows()
      state.draft.selected = ['w1']
      state.draft.instanceId = 'i1'
      await state.createJob()
      await state.start('b2')
      await state.resumeJob('b3')
      await state.retryFailedJob('b3')
      await state.cancelJob('b1')
      await state.cancelItem(runningJob, '/tmp/wf/base.json')
      await state.removeJob('b1')
      await state.safeReveal('/tmp/x')
      state.settleInBackground('b9', accepted)
      await flushPromises()
      failChannels = new Set()

      failStrings = new Set([
        'batch.list',
        'batch.create',
        'batch.start',
        'batch.resume',
        'batch.retryFailed',
        'batch.cancel',
        'batch.cancelItem',
        'batch.remove',
        'workflow.list',
        'shell.reveal'
      ])
      await state.refreshJobs()
      await state.refresh()
      await state.loadWorkflows()
      await state.createJob()
      await state.start('b2')
      await state.resumeJob('b3')
      await state.retryFailedJob('b3')
      await state.cancelJob('b1')
      await state.cancelItem(runningJob, '/tmp/wf/base.json')
      await state.removeJob('b1')
      await state.safeReveal('/tmp/x')
      failStrings = new Set()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      try {
        state.message?.destroyAll?.()
      } catch {
        /* noop */
      }
      wrapper.unmount()
    }
  }, 120_000)

  it('renders every job, item and modal state', async () => {
    const { wrapper, state } = await mountBatch()
    try {
      state.loading = false
      state.jobs = [
        makeJob('s1', 'done', { failed: 0, produced: 4, params: { seedMode: 'random' } }),
        makeJob('s2', 'error', { instanceId: 'remote:r1' }),
        makeJob('s3', 'interrupted'),
        makeJob('s4', 'queued', { failed: 0 }),
        makeJob('s5', 'cancelled', { failed: 0, params: {} }),
        makeJob('s6', 'running', {
          items: [
            {
              workflowName: 'Pending',
              workflowPath: '/tmp/p.json',
              count: 3,
              submitted: 2,
              completed: 0,
              failed: 0,
              promptIds: [],
              seeds: [],
              outputPaths: []
            }
          ]
        })
      ]
      state.highlightId = 's1'
      state.startingId = 's2'
      state.showCreate = true
      state.draft.selected = ['w1']
      await nextTick()
      await nextTick()
      for (const sel of ['button', '.n-button', '.n-tag', '.n-switch']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
      state.showCreate = false
      state.loading = true
      state.jobs = []
      await nextTick()
      state.loading = false
      state.loadError = 'failed'
      await nextTick()
      state.loadError = ''
      state.jobs = [runningJob]
      state.loadError = 'partial'
      await nextTick()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      try {
        state.message?.destroyAll?.()
      } catch {
        /* noop */
      }
      wrapper.unmount()
    }
  }, 120_000)

  it('highlights the deep-linked job and expires the highlight', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper, state } = await mountBatch('/batch?jobId=b1')
      await nextTick()
      expect(state.highlightId).toBe('b1')
      vi.advanceTimersByTime(4001)
      await nextTick()
      expect(state.highlightId).toBe('')
      await state.router.push('/batch?jobId=b2')
      await nextTick()
      expect(state.highlightId).toBe('b2')
      await state.router.push('/batch?jobId=')
      await nextTick()
      state.jobs = []
      await nextTick()
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  }, 120_000)
})
