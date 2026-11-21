// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'

const queue = {
  running: [{ promptId: 'p1', status: 'running' }],
  pending: [{ promptId: 'p2', status: 'pending' }],
  doneCount: 1,
  history: []
}
const system = {
  cpuUsage: 20,
  ramTotal: 100,
  ramUsed: 50,
  diskFree: 10,
  diskTotal: 100,
  gpus: [
    {
      index: 0,
      model: 'GPU',
      vramTotal: 100,
      vramUsed: 50,
      utilization: 70,
      sharedTotal: 10,
      sharedUsed: 1
    },
    { index: 1, model: 'GPU2', vramTotal: 0, vramUsed: 0 }
  ],
  timestamp: 1
}
const report = {
  instanceId: 'i1',
  durationMs: 1000,
  summary: { pass: 1, warn: 0, fail: 0 },
  checks: []
}

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
    case 'node.list':
      return [{ id: 'n1', name: 'pack' }]
    case 'model.list':
      return [{ id: 'm1', name: 'model', size: 100 }]
    case 'instance.getLogs':
      return [{ ts: 1, level: 'info', message: 'a' }]
    case 'instance.launch':
      return {
        id: 'i1',
        name: 'Main',
        path: '/tmp/comfy',
        port: 8188,
        status: 'running',
        url: 'http://127.0.0.1:8188'
      }
    case 'instance.stop':
      return true
    case 'doctor.run':
      return report
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

describe('DashboardView deep coverage', () => {
  async function mountDashboard(status = 'running') {
    const { wrapper, state } = await mountView(
      '/dashboard',
      () => import('../../src/renderer/src/views/dashboard/DashboardView.vue')
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
        status,
        enabled: true,
        url: 'http://127.0.0.1:8188'
      }
    ]
    state.store.activeInstanceId = 'i1'
    state.store.remotes = [
      { id: 'r1', name: 'Remote', baseUrl: 'http://remote:8188', enabled: true }
    ]
    await state.refreshStats()
    await state.refreshQueue()
    await nextTick()
    return { wrapper, state }
  }

  it('exercises stats, queue, launch, stop, logs and doctor', async () => {
    const { wrapper, state } = await mountDashboard()
    try {
      expect(state.hasInstances).toBe(true)
      expect(state.needsModels).toBe(false)
      expect(state.stats.instances).toBe(1)
      expect(state.storageBytes).toBeGreaterThan(0)
      expect(state.statusLabel(undefined)).toBeTruthy()
      for (const s of ['running', 'error', 'starting', 'stopped']) {
        expect(state.statusLabel(s)).toBeTruthy()
        expect(state.statusTagType(s)).toBeTypeOf('string')
      }
      expect(state.vramPercent({ vramUsed: 50, vramTotal: 100 })).toBe(50)
      expect(state.vramPercent({ vramUsed: 50, vramTotal: 0, utilization: 70 })).toBe(70)
      expect(state.vramPercent({ vramUsed: 0, vramTotal: 0 })).toBe(0)
      expect(state.targetRunning).toBe(true)
      state.store.activeRemoteId = 'r1'
      expect(state.targetRunning).toBe(true)
      state.store.activeRemoteId = null

      await state.refreshStats()
      expect(state.nodePacks).toHaveLength(1)
      await state.refreshQueue()
      expect(state.queue).toBeTruthy()

      await state.refreshTailLogs()
      expect(state.tailLogs).toHaveLength(1)
      state.store.activeInstanceId = null
      await state.refreshTailLogs()
      expect(state.tailLogs).toHaveLength(0)
      state.store.activeInstanceId = 'i1'

      await state.launchActive()
      state.store.activeInstanceId = null
      state.store.remotes = []
      await state.launchActive()
      state.store.activeInstanceId = 'i1'
      state.store.remotes = [
        { id: 'r1', name: 'Remote', baseUrl: 'http://remote:8188', enabled: true }
      ]

      await state.stopActive()
      overrides['monitor.queue'] = { ...queue, running: [], pending: [] }
      await state.stopActive()
      overrides['monitor.queue'] = queue
      failChannels = new Set(['monitor.queue'])
      state.queue = queue
      await state.stopActive()
      failChannels = new Set()
      state.store.instances = [{ ...state.store.instances[0], url: '' }]
      await state.stopActive()
      state.store.instances = [{ ...state.store.instances[0], url: 'http://127.0.0.1:8188' }]
      state.store.activeInstanceId = null
      await state.stopActive()
      state.store.activeInstanceId = 'i1'

      await state.runDoctor()
      expect(state.store.doctorReport).toBeTruthy()
      state.store.activeInstanceId = null
      await state.runDoctor()
      state.store.activeInstanceId = 'i1'

      state.onVisibility()
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      state.onVisibility()
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      state.onVisibility()
      state.onVisibility()
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      state.onVisibility()
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })

      for (const cb of ipcHandlers.get(IPC_EVENTS.instanceLogBatch) || []) {
        cb({ id: 'i1', lines: [{ ts: 1, level: 'info', message: 'x' }] })
        cb({ id: 'other', lines: [] })
        cb(null)
      }
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

  it('covers failures and the starting timer', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper, state } = await mountDashboard('starting')
      failChannels = new Set([
        'node.list',
        'model.list',
        'monitor.queue',
        'instance.getLogs',
        'doctor.run'
      ])
      state.store.instances = [{ ...state.store.instances[0], status: 'running' }]
      await state.refreshStats()
      expect(state.statsError).toBeTruthy()
      await state.refreshQueue()
      expect(state.queueError).toBe(true)
      await state.refreshTailLogs()
      expect(state.tailLogs).toHaveLength(0)
      await state.runDoctor()
      failChannels = new Set()

      failStrings = new Set([
        'node.list',
        'model.list',
        'monitor.queue',
        'instance.getLogs',
        'doctor.run'
      ])
      await state.refreshStats()
      await state.refreshQueue()
      await state.refreshTailLogs()
      await state.runDoctor()
      failStrings = new Set()

      state.store.instances = [{ ...state.store.instances[0], status: 'starting' }]
      await nextTick()
      expect(state.activeStatus).toBe('starting')
      const before = state.startElapsed
      vi.advanceTimersByTime(2100)
      await nextTick()
      expect(state.startElapsed).toBeGreaterThan(before)
      state.store.instances = [{ ...state.store.instances[0], status: 'running' }]
      await nextTick()
      vi.advanceTimersByTime(1100)
      state.store.instances = [{ ...state.store.instances[0], status: 'error' }]
      await nextTick()
      state.store.instances = [{ ...state.store.instances[0], status: 'starting' }]
      await nextTick()
      state.store.activeInstanceId = null
      await nextTick()
      state.store.activeInstanceId = 'i1'
      await nextTick()
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  }, 120_000)

  it('renders onboarding, remote, hero and resource truth tables', async () => {
    const { wrapper, state } = await mountDashboard()
    try {
      state.loading = false
      state.store.instances = []
      await nextTick()
      for (const sel of ['button', '.n-button']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
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
      state.store.activeRemoteId = 'r1'
      state.store.system = system
      await nextTick()
      state.store.activeRemoteId = null
      for (const status of ['running', 'starting', 'error', 'stopped']) {
        state.store.instances = [{ ...state.store.instances[0], status }]
        await nextTick()
      }
      state.store.instances = [
        { ...state.store.instances[0], status: 'running', lastError: 'boom' }
      ]
      state.queue = null
      state.queueError = true
      state.tailLogs = [{ ts: 1, level: 'info', message: 'log' }]
      state.startElapsed = 2
      state.statsError = 'stats failed'
      state.models = []
      state.store.system = { ...system, gpus: [] }
      await nextTick()
      await nextTick()
      state.store.system = { ...system, ramTotal: 0 }
      await nextTick()
      state.store.system = system
      for (const sel of ['button', '.n-button', '.quick']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
      state.store.system = null
      state.queue = queue
      state.queueError = false
      state.statsError = ''
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
