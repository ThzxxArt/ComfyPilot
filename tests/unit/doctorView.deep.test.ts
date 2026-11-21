// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'

const report = {
  instanceId: 'i1',
  durationMs: 1500,
  summary: { pass: 2, warn: 1, fail: 1 },
  checks: [
    {
      id: 'python',
      title: 'Python',
      group: 'runtime',
      severity: 'pass',
      detail: 'python ok',
      fixable: false
    },
    {
      id: 'torch',
      title: 'Torch',
      group: 'runtime',
      severity: 'warn',
      detail: 'torch warn',
      suggestion: 'upgrade torch',
      fixable: true,
      fixId: 'fix-torch'
    },
    {
      id: 'custom',
      title: 'Custom',
      group: 'custom-group',
      severity: 'fail',
      detail: 'failed',
      suggestion: 'do something',
      fixable: true,
      fixId: 'fix-custom'
    },
    {
      id: 'info',
      title: 'Info',
      group: 'gpu',
      severity: 'info',
      detail: 'info detail',
      fixable: false
    }
  ]
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
          enabled: true
        }
      ]
    case 'remote.list':
      return []
    case 'monitor.system':
      return {
        cpuUsage: 1,
        ramTotal: 2,
        ramUsed: 1,
        diskFree: 1,
        diskTotal: 2,
        gpus: [],
        timestamp: 1
      }
    case 'doctor.run':
      return report
    case 'doctor.fix':
      return { ok: true, message: 'fixed' }
    case 'doctor.cancel':
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

describe('DoctorView deep coverage', () => {
  async function mountDoctor() {
    const { wrapper, state } = await mountView(
      '/doctor',
      () => import('../../src/renderer/src/views/doctor/DoctorView.vue')
    )
    state.store.instances = [
      {
        id: 'i1',
        name: 'Main',
        path: '/tmp/comfy',
        port: 8188,
        status: 'running',
        enabled: true
      }
    ]
    state.store.activeInstanceId = 'i1'
    await nextTick()
    return { wrapper, state }
  }

  it('exercises helpers, run, cancel and fix flows', async () => {
    const { wrapper, state } = await mountDoctor()
    try {
      for (const s of ['pass', 'warn', 'info', 'fail', 'other']) {
        expect(state.iconFor(s)).toBeTruthy()
        expect(state.toneFor(s)).toBeTruthy()
        expect(state.sevLabel(s)).toBeTruthy()
      }
      expect(state.groupLabel('runtime')).toBeTruthy()
      expect(state.groupLabel('unknown-group')).toBe('unknown-group')
      expect(
        state.checkTitle({ id: 'python', title: 'Raw', severity: 'pass', group: 'g', detail: '' })
      ).toBeTruthy()
      expect(
        state.checkTitle({ id: 'nope', title: 'Raw', severity: 'pass', group: 'g', detail: '' })
      ).toBe('Raw')
      expect(
        state.checkSuggestion({ id: 'torch', title: 'T', severity: 'warn', group: 'g', detail: '' })
      ).toBeUndefined()
      expect(
        state.checkSuggestion({
          id: 'torch',
          title: 'T',
          severity: 'warn',
          group: 'g',
          detail: '',
          suggestion: 'raw'
        })
      ).toBeTruthy()
      expect(
        state.checkSuggestion({
          id: 'custom',
          title: 'T',
          severity: 'warn',
          group: 'g',
          detail: '',
          suggestion: 'raw'
        })
      ).toBe('raw')

      await state.run()
      expect(state.report.summary.pass).toBe(2)
      expect(state.store.doctorReport).toBeTruthy()
      expect(state.reportIsCurrent).toBe(true)

      state.running = true
      await state.cancelRun()
      expect(state.running).toBe(false)
      expect(state.reportIsCurrent).toBe(true)

      await state.fix(report.checks[0])
      await state.fix(report.checks[1])
      state.fixingId = ''
      overrides['doctor.fix'] = { ok: false, message: 'failed fix' }
      await state.fix(report.checks[2])
      overrides = {}

      state.store.activeInstanceId = null
      await state.run()
      await state.fix(report.checks[1])
      state.store.activeInstanceId = 'i1'
      state.store.doctorReport = { ...report, instanceId: 'other' }
      state.report = { ...report, instanceId: 'other' }
      expect(state.reportIsCurrent).toBe(false)
      await state.fix(report.checks[1])
      state.report = report
      state.store.doctorReport = report

      state.store.instanceSwitchTick += 1
      await nextTick()
      expect(state.report).toBeNull()
      expect(state.store.doctorReport).toBeNull()

      for (const cb of ipcHandlers.get(IPC_EVENTS.doctorProgress) || []) {
        cb({ done: 3, title: 'checking' })
        cb({})
      }
      state.running = true
      state.report = report
      state.progress = { done: 3, title: 'checking' }
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

  it('covers failure and stale-run branches', async () => {
    const { wrapper, state } = await mountDoctor()
    try {
      failChannels = new Set(['doctor.run', 'doctor.fix', 'doctor.cancel'])
      await state.run()
      await state.fix(report.checks[1])
      await state.cancelRun()
      failChannels = new Set()

      failStrings = new Set(['doctor.run', 'doctor.fix', 'doctor.cancel'])
      await state.run()
      await state.fix(report.checks[1])
      await state.cancelRun()
      failStrings = new Set()

      const original = (window as any).comfyPilot.invoke
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'doctor.run') {
          state.store.activeInstanceId = null
        }
        return { ok: true, data: dataFor(channel) }
      }
      state.store.activeInstanceId = 'i1'
      await state.run()
      state.store.activeInstanceId = 'i1'
      ;(window as any).comfyPilot.invoke = original

      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'doctor.run') throw new Error('late')
        return { ok: true, data: dataFor(channel) }
      }
      state.store.activeInstanceId = 'i1'
      const p = state.run()
      state.store.activeInstanceId = null
      await p
      ;(window as any).comfyPilot.invoke = original
      state.store.activeInstanceId = 'i1'

      state.report = report
      state.running = false
      state.fixing = false
      await nextTick()
      for (const sel of ['button', '.n-button']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
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

  it('renders running, fixing and empty states', async () => {
    const { wrapper, state } = await mountDoctor()
    try {
      state.running = true
      state.progress = { title: 'working', done: 2 }
      await nextTick()
      state.progress = { done: 0 }
      await nextTick()
      state.report = report
      state.fixing = true
      state.fixingId = 'fix-torch'
      await nextTick()
      await nextTick()
      state.running = false
      state.fixing = false
      state.fixingId = ''
      state.report = null
      await nextTick()
      state.report = report
      await nextTick()
      state.report = null
      state.running = false
      await nextTick()
      const p = state.run()
      state.running = false
      await p
      state.report = null
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
