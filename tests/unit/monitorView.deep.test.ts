// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'

const queue = {
  running: [{ promptId: 'p1', nodeId: '1', progress: 0.5, status: 'running' }],
  pending: [
    { promptId: 'p2', status: 'pending' },
    { promptId: 'p3', status: 'pending' }
  ],
  doneCount: 1,
  history: [
    { promptId: 'p1', status: 'success', completedAt: 1000 },
    { promptId: 'p0', status: 'error', completedAt: 900 }
  ]
}
const jobs = [
  { id: 'p1', status: 'in_progress', workflowId: 'w1', createdAt: 1 },
  { id: 'p2', status: 'completed', workflowId: 'w2', createdAt: 2 }
]
const system = {
  cpuUsage: 20,
  ramTotal: 100,
  ramUsed: 50,
  diskFree: 10,
  diskTotal: 100,
  gpus: [{ index: 0, name: 'GPU', vramTotal: 100, vramUsed: 95, utilization: 80, temperature: 60 }],
  timestamp: 1
}
const failure = {
  id: 'f1',
  instanceId: 'i1',
  source: 'ws',
  at: 1,
  promptId: 'p1',
  nodeId: '1',
  nodeType: 'KSampler',
  errorType: 'RuntimeError',
  message: 'boom',
  missingModule: 'x',
  packFolder: 'pack',
  traceback: ['line']
}
const remoteFailure = { ...failure, id: 'f2', instanceId: 'remote:r1' }
const series = [
  { ts: 1, cpu: 10, ram: 20, vram: 30 },
  { ts: 2, cpu: 11, ram: 21, vram: 31 }
]

let failChannels = new Set<string>()
let failStrings = new Set<string>()
let overrides: Record<string, unknown> = {}
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
          enabled: true,
          url: 'http://127.0.0.1:8188'
        }
      ]
    case 'remote.list':
      return [{ id: 'r1', name: 'Remote', baseUrl: 'http://remote:8188', enabled: true }]
    case 'monitor.system':
      return system
    case 'monitor.queue':
      return queue
    case 'monitor.history':
      return queue
    case 'monitor.jobs':
      return jobs
    case 'monitor.series':
      return series
    case 'instance.execFailures':
      return [failure, remoteFailure]
    case 'monitor.clearQueue':
    case 'monitor.interrupt':
    case 'monitor.freeMemory':
      return { ok: true }
    case 'shell.writeClipboard':
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

describe('MonitorView deep coverage', () => {
  async function mountMonitor() {
    const { wrapper, state } = await mountView(
      '/monitor',
      () => import('../../src/renderer/src/views/monitor/MonitorView.vue')
    )
    const dialog = state.dialog
    if (dialog) {
      const auto = (opts: any): object => {
        try {
          if (typeof opts?.content === 'function') opts.content()
          opts?.onPositiveClick?.()
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
        enabled: true,
        url: 'http://127.0.0.1:8188'
      }
    ]
    state.store.activeInstanceId = 'i1'
    state.store.remotes = [
      { id: 'r1', name: 'Remote', baseUrl: 'http://remote:8188', enabled: true }
    ]
    await state.refreshQueue()
    await nextTick()
    return { wrapper, state }
  }

  it('exercises queue ops, jobs, history, failures and events', async () => {
    const { wrapper, state } = await mountMonitor()
    try {
      state.openFrontend()
      state.store.activeRemoteId = 'r1'
      state.openFrontend()
      state.store.activeRemoteId = null

      expect(state.pct(0, 0)).toBe(0)
      expect(state.pct(50, 100)).toBe(50)
      expect(state.pct(200, 100)).toBe(100)

      await state.refreshQueue()
      expect(state.queue).toBeTruthy()
      expect(state.pendingCount).toBe(2)
      expect(state.runningPromptId).toBe('p1')
      expect(state.canInterrupt).toBe(true)
      expect(state.opBlocked).toBe(false)
      state.opBusy = 'interrupt'
      expect(state.opBlocked).toBe(true)
      state.opBusy = null
      state.store.activeInstanceId = null
      state.queue = queue
      await state.refreshQueue()
      expect(state.queue).toBeNull()
      state.store.activeInstanceId = 'i1'

      await state.runOp('clearQueue', async () => ({ ok: true }), 'monitor.clearQueueDone')
      await state.runOp(
        'interrupt',
        async () => ({ ok: false, error: 'nope' }),
        'monitor.interruptDone'
      )
      await state.runOp(
        'interrupt',
        async () => {
          throw new Error('thrown')
        },
        'monitor.interruptDone'
      )
      state.confirmClearQueue()
      state.confirmInterrupt()
      state.confirmFreeMemory()
      state.store.activeInstanceId = null
      state.confirmClearQueue()
      state.confirmInterrupt()
      state.confirmFreeMemory()
      state.store.activeInstanceId = 'i1'

      await state.refreshJobs()
      expect(state.jobs.length).toBe(2)
      for (const s of [
        'completed',
        'success',
        'done',
        'failed',
        'error',
        'cancelled',
        'in_progress',
        'running',
        'other'
      ]) {
        expect(state.jobChip(s)).toBeTruthy()
      }
      expect(state.jobStatusLabel('completed')).toBeTruthy()
      expect(state.jobStatusLabel('unknown')).toBe('unknown')

      expect(state.failureFor()).toBeUndefined()
      expect(state.failureFor('missing')).toBeUndefined()
      expect(state.failureFor('p1')).toBeTruthy()
      state.openFailure(undefined)
      state.openFailure(state.failureFor('p1'))
      expect(state.showFailureDetail).toBe(true)
      await state.copyFailureReportM(failure)
      state.goInstanceLogs(failure)
      state.goInstanceLogs(remoteFailure)
      expect(state.showFailureDetail).toBe(false)
      await state.refreshFailures()
      state.store.activeRemoteId = 'r1'
      await state.refreshFailures()
      state.store.activeRemoteId = null
      state.store.activeInstanceId = null
      await state.refreshFailures()
      state.store.activeInstanceId = 'i1'

      for (const s of ['success', 'done', 'completed', 'error', 'other']) {
        expect(state.historyStatusLabel(s)).toBeTruthy()
        expect(state.historyStatusType(s)).toBeTypeOf('string')
      }
      expect(state.formatHistoryTime()).toBeTruthy()
      expect(state.formatHistoryTime(1000)).toBeTruthy()
      await state.refreshHistory()
      expect(state.historySnapshot).toBeTruthy()
      await state.refreshSeries()
      expect(state.series).toHaveLength(2)

      expect(state.gpuHigh).toBe(true)
      state.store.system = null
      expect(state.gpuHigh).toBe(false)
      state.store.system = { ...system, gpus: [{ index: 0, name: 'x', vramTotal: 0, vramUsed: 0 }] }
      expect(state.gpuHigh).toBe(false)
      state.store.system = { ...system, gpus: [] }
      expect(state.gpuHigh).toBe(false)
      state.store.system = system

      state.onWsEvent(null)
      state.onWsEvent({ type: 'preview', image: 'data:image/png;base64,x' })
      expect(state.lastPreview).toBeTruthy()
      state.onWsEvent({
        type: 'progress_state',
        nodes: { 1: { nodeId: '1', value: 1, max: 2, state: 'running' } }
      })
      expect(state.runningNodes).toHaveLength(1)
      state.onWsEvent({
        type: 'progress_state',
        nodes: {
          1: { nodeId: '1', value: 1, max: 2, state: 'running' },
          2: { nodeId: '2', value: 2, max: 2, state: 'finished' }
        },
        nodeId: '2'
      })
      expect(state.finishedNodeCount).toBe(1)
      state.onWsEvent({ type: 'executing', nodeId: '1' })
      expect(state.currentNodeId).toBe('1')
      state.onWsEvent({ type: 'executing' })
      expect(state.currentNodeId).toBe('')
      state.onWsEvent({ type: 'execution_start' })
      expect(state.currentNodeId).toBe('')
      state.onWsEvent({ type: 'other' })

      for (const cb of ipcHandlers.get(IPC_EVENTS.monitorTick) || [])
        cb({ ...system, cpuUsage: 30 })
      for (const cb of ipcHandlers.get(IPC_EVENTS.monitorWs) || []) {
        cb({ type: 'executing', nodeId: '9' })
        cb({ type: 'execution_start' })
      }

      state.onVisibility()
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      state.onVisibility()
      await nextTick()
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      state.onVisibility()
      state.onVisibility()
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      state.onVisibility()
      state.onVisibility()
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })

      state.store.instanceSwitchTick += 1
      await nextTick()
      await flushPromises()
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

  it('covers failure branches', async () => {
    const { wrapper, state } = await mountMonitor()
    try {
      failChannels = new Set([
        'monitor.queue',
        'monitor.jobs',
        'monitor.history',
        'monitor.series',
        'instance.execFailures',
        'monitor.clearQueue',
        'monitor.interrupt',
        'monitor.freeMemory',
        'shell.writeClipboard'
      ])
      await state.refreshQueue()
      expect(state.queueError).toBe(true)
      await state.refreshJobs()
      expect(state.jobs).toBeNull()
      await state.refreshHistory()
      expect(state.historySnapshot).toBeNull()
      await state.refreshSeries()
      await state.refreshFailures()
      await state.copyFailureReportM(failure)
      state.confirmClearQueue()
      state.confirmInterrupt()
      state.confirmFreeMemory()
      await state.runOp(
        'clearQueue',
        () => (window as any).comfyPilot.invoke('monitor.clearQueue'),
        'x'
      )
      failChannels = new Set()

      failStrings = new Set([
        'monitor.queue',
        'monitor.jobs',
        'monitor.history',
        'monitor.series',
        'instance.execFailures',
        'monitor.clearQueue',
        'monitor.interrupt',
        'monitor.freeMemory',
        'shell.writeClipboard'
      ])
      await state.refreshQueue()
      await state.refreshJobs()
      await state.refreshHistory()
      await state.refreshSeries()
      await state.copyFailureReportM(failure)
      state.confirmClearQueue()
      state.confirmInterrupt()
      state.confirmFreeMemory()
      await flushPromises()
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

  it('renders queue, history, failures and preview states', async () => {
    const { wrapper, state } = await mountMonitor()
    try {
      state.queue = queue
      state.jobs = jobs
      state.history = [10, 20]
      state.series = series
      state.lastPreview = 'data:image/png;base64,x'
      state.nodeProgress = {
        1: { nodeId: '1', value: 1, max: 2, state: 'running' },
        2: { nodeId: '2', value: 2, max: 2, state: 'finished' },
        3: { nodeId: '3', value: 0, max: 2, state: 'error' }
      }
      state.currentNodeId = '1'
      state.queueError = true
      state.queueTab = 'history'
      state.historySnapshot = queue
      state.historyLoading = false
      state.execFailures = [failure, remoteFailure]
      state.selectedFailure = failure
      state.showFailureDetail = true
      state.opBusy = 'freeMemory'
      state.store.activeRemoteId = 'r1'
      await nextTick()
      await nextTick()
      for (const sel of ['button', '.n-button', '.n-tag', '.n-tabs-tab']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
      state.queueTab = 'queue'
      state.queueError = false
      state.historySnapshot = null
      state.execFailures = []
      state.showFailureDetail = false
      state.opBusy = null
      state.store.activeRemoteId = null
      state.queue = { running: [], pending: [], doneCount: 0, history: [] }
      state.jobs = []
      await nextTick()
      state.queue = null
      state.jobs = null
      state.historySnapshot = null
      await nextTick()
      state.store.system = system
      state.history = []
      state.series = []
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
})
