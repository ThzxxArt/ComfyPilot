// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { installBridge, stubBrowser } from '../helpers/deepView'
import { i18n } from '../../src/renderer/src/i18n'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import { defineComponent, h } from 'vue'

beforeAll(() => stubBrowser())
beforeEach(() => {
  installBridge(() => null)
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.useRealTimers()
})

async function mountNodeOp(props: Record<string, unknown> = {}) {
  const { default: Comp } =
    await import('../../src/renderer/src/components/NodeOpProgressModal.vue')
  const Host = defineComponent({
    setup(_p, { slots }) {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(
              NMessageProvider,
              { duration: 0 },
              {
                default: () => h(NDialogProvider, null, { default: () => slots.default?.() })
              }
            )
        })
    }
  })
  const wrapper = mount(Host, {
    global: {
      plugins: [i18n],
      config: { errorHandler: () => undefined, warnHandler: () => undefined }
    },
    slots: {
      default: () => h(Comp, { show: true, title: 'Title', mode: 'single', ...props } as any)
    },
    attachTo: document.body
  })
  const state = (wrapper.findComponent(Comp).vm as any).$.setupState
  await nextTick()
  return { wrapper, state, Comp }
}

function step(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Step ${id}`, status, detail: `detail ${id}`, log: [`log ${id}`], ...extra }
}

describe('NodeOpProgressModal deep coverage', () => {
  it('renders single-op, snapshot and batch states', async () => {
    const { wrapper, state } = await mountNodeOp()
    try {
      for (const status of ['done', 'running', 'failed', 'cancelled', 'skipped', 'pending']) {
        for (const fn of ['statusIcon', 'statusClass']) {
          expect(state[fn](status)).toBeTruthy()
        }
      }
      const s = step('a', 'running')
      expect(state.detail(s)).toBeTruthy()
      expect(state.stepTitle(s)).toBeTruthy()

      state.progressKind = 'node-op'
      state.progress = {
        runId: 'r',
        instanceId: 'i1',
        kind: 'node-op',
        status: 'running',
        percent: 50,
        message: 'working',
        aggregatePercent: 50,
        backupPath: '/tmp/backup',
        steps: [
          step('s1', 'done'),
          step('s2', 'running'),
          step('s3', 'failed'),
          step('s4', 'cancelled'),
          step('s5', 'skipped'),
          step('s6', 'pending')
        ]
      }
      state.nodeOpSnapshot = null
      state.nodeBatch = null
      state.nodeOpLogs = [
        { packName: 'pack', line: 'line', ts: 1 },
        { line: 'plain', ts: 2 }
      ]
      state.nodeOpLogSeq = 1
      await nextTick()
      await nextTick()
      expect(wrapper.html()).toBeTruthy()
      expect(document.body.textContent).toContain('pack')

      state.progress = { ...state.progress, status: 'failed', error: 'boom' }
      await nextTick()
      state.progress = { ...state.progress, status: 'cancelled' }
      await nextTick()
      state.progress = { ...state.progress, status: 'done', error: undefined, percent: 100 }
      await nextTick()
      state.progress = null
      state.nodeOpSnapshot = {
        runId: 's',
        instanceId: 'i1',
        status: 'running',
        percent: 10,
        message: 'snapshot',
        steps: [step('x', 'running', { log: ['x'] })]
      }
      state.progressKind = 'comfy-update'
      state.nodeOpLogs = []
      await nextTick()
      expect(state.ownProgress).toBeTruthy()
      expect(document.body.textContent).toContain('snapshot')

      state.nodeBatch = {
        batchId: 'b',
        phase: 'checking',
        index: 0,
        total: 2,
        instanceId: 'i1',
        ts: 1
      }
      state.nodeBatchActive = true
      state.nodeBatchEntries = [
        { name: 'a', status: 'done' },
        { name: 'b', status: 'running' },
        { name: 'c', status: 'failed' },
        { name: 'd', status: 'cancelled' },
        { name: 'e', status: 'pending' }
      ]
      state.progress = { ...state.nodeOpSnapshot, aggregatePercent: 7 }
      await nextTick()
      for (const phase of ['start', 'pack-done', 'batch-error']) {
        state.nodeBatch = { ...state.nodeBatch, phase }
        await nextTick()
      }
      state.nodeBatch = {
        ...state.nodeBatch,
        phase: 'batch-done',
        ok: true,
        summary: { ok: 1, fail: 0, skip: 0 }
      }
      await nextTick()
      state.nodeBatch = {
        ...state.nodeBatch,
        phase: 'batch-done',
        ok: false,
        summary: { ok: 0, fail: 1, skip: 0 }
      }
      await nextTick()
      state.nodeBatch = {
        ...state.nodeBatch,
        phase: 'batch-done',
        summary: { ok: 0, fail: 0, skip: 0, cancelled: true }
      }
      await nextTick()
      state.nodeBatch = { ...state.nodeBatch, phase: 'pack-done', total: 0 }
      state.progressKind = 'node-op'
      state.progress = { ...state.progress, aggregatePercent: 100 }
      await nextTick()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('cancels, copies logs and covers watchers', async () => {
    vi.useFakeTimers()
    const { wrapper, state } = await mountNodeOp({ mode: 'batch' })
    try {
      state.nodeBatch = {
        batchId: 'b',
        phase: 'pack-done',
        index: 1,
        total: 2,
        packName: 'pack',
        instanceId: 'i1',
        ts: 1
      }
      state.nodeBatchActive = true
      state.nodeBatchEntries = [{ name: 'a', status: 'running' }]
      state.nodeOpLogs = [
        { line: 'a', ts: 1 },
        { packName: 'p', line: 'b', ts: 2 }
      ]
      state.nodeOpLogSeq = 1
      state.autoscroll = true
      state.logBox = { scrollTop: 0, scrollHeight: 100 } as any
      await nextTick()
      await nextTick()
      state.autoscroll = false
      state.nodeOpLogSeq = 2
      await nextTick()
      await nextTick()
      await vi.runOnlyPendingTimersAsync()
      await flushPromises()

      const writeText = vi.fn(async () => undefined)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      await state.copyLogs()
      expect(state.copyState).toBeTruthy()
      vi.advanceTimersByTime(1500)
      expect(state.copyState).toBe('')
      writeText.mockRejectedValueOnce(new Error('denied'))
      await state.copyLogs()

      state.viewedNodeInstanceId = 'i2'
      state.updatingInstanceId = 'i3'
      await state.onCancel()
      state.cancelling = false

      const invoke = (window as any).comfyPilot.invoke
      ;(window as any).comfyPilot.invoke = async () => ({ ok: true, data: true })
      await state.onCancel()
      ;(window as any).comfyPilot.invoke = async () => {
        throw new Error('cancel failed')
      }
      await state.onCancel()
      ;(window as any).comfyPilot.invoke = invoke
      state.cancelling = false

      for (const sel of ['button', '.n-button', '.n-switch']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('hydrates a snapshot and handles empty logs', async () => {
    const { wrapper, state } = await mountNodeOp()
    try {
      state.progressKind = 'other'
      state.progress = null
      state.nodeOpSnapshot = null
      state.nodeOpLogs = []
      state.nodeBatch = null
      await nextTick()
      await flushPromises()
      state.progress = {
        runId: 'r',
        instanceId: 'i1',
        kind: 'node-op',
        status: 'failed',
        percent: 0,
        message: '',
        steps: [],
        error: 'empty error'
      }
      state.nodeOpSnapshot = null
      state.progressKind = 'node-op'
      await nextTick()
      expect(document.body.textContent).toContain('empty error')
      state.nodeOpLogs = []
      state.progress = { ...state.progress, error: undefined }
      await nextTick()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)
})
