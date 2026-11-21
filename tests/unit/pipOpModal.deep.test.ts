// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { installBridge, stubBrowser } from '../helpers/deepView'
import { i18n } from '../../src/renderer/src/i18n'

function dataFor(): unknown {
  return null
}

beforeAll(() => stubBrowser())
beforeEach(() => {
  installBridge(dataFor)
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.useRealTimers()
})

async function mountPip() {
  const { default: Comp } = await import('../../src/renderer/src/components/PipOpModal.vue')
  const wrapper = mount(Comp, {
    global: {
      plugins: [i18n],
      config: { errorHandler: () => undefined, warnHandler: () => undefined }
    },
    attachTo: document.body
  })
  const state = (wrapper.vm as any).$.setupState
  state.modalVisible = true
  await nextTick()
  return { wrapper, state }
}

describe('PipOpModal deep coverage', () => {
  it('renders every progress, status and step state', async () => {
    const { wrapper, state } = await mountPip()
    try {
      const steps = [
        { id: 's1', status: 'done', title: 'done', detail: 'd', percent: 100 },
        { id: 's2', status: 'running', title: 'run', detail: 'd', percent: 50 },
        { id: 's3', status: 'failed', title: 'fail', detail: 'd', percent: 10 },
        { id: 's4', status: 'cancelled', title: 'cancel', detail: 'd', percent: 0 },
        { id: 's5', status: 'skipped', title: 'skip', detail: 'd', percent: 0 },
        { id: 's6', status: 'pending', title: 'pending', detail: 'd', percent: undefined },
        { id: 's7', status: 'running', title: 'run2', detail: 'd', percent: null }
      ]
      for (const status of ['done', 'running', 'failed', 'cancelled', 'skipped', 'pending']) {
        for (const fn of ['statusIcon', 'statusClass']) {
          expect(state[fn](status)).toBeTruthy()
        }
      }
      for (const s of steps) {
        expect(state.detail(s)).toBeTypeOf('string')
        expect(state.stepTitle(s)).toBeTypeOf('string')
      }

      state.busy = true
      state.progress = {
        runId: 'r',
        instanceId: 'i1',
        status: 'running',
        percent: 0,
        message: 'working',
        steps
      }
      state.logs = [
        { line: 'one', ts: 1 },
        { line: 'two', ts: 2 }
      ]
      state.logSeq = 2
      await nextTick()
      await nextTick()
      expect(wrapper.html()).toBeTruthy()

      state.busy = false
      state.progress = { ...state.progress, status: 'failed', error: 'boom', steps }
      await nextTick()
      state.progress = { ...state.progress, status: 'cancelled' }
      await nextTick()
      state.progress = { ...state.progress, status: 'done', error: undefined }
      await nextTick()
      state.progress = { ...state.progress, status: 'running', percent: 200 }
      await nextTick()
      state.progress = null
      state.logs = []
      await nextTick()
      state.progress = {
        runId: 'r',
        instanceId: 'i1',
        status: 'failed',
        percent: 0,
        message: '',
        steps: [],
        error: 'no logs'
      }
      await nextTick()
      expect(document.body.textContent).toContain('no logs')
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('cancels, copies logs and handles watchers', async () => {
    vi.useFakeTimers()
    const { wrapper, state } = await mountPip()
    try {
      state.progress = {
        runId: 'r',
        instanceId: 'i1',
        status: 'running',
        percent: 10,
        message: 'm',
        steps: []
      }
      state.logs = [{ line: 'a', ts: 1 }]
      state.logSeq = 1
      state.autoscroll = true
      state.logBox = { scrollTop: 0, scrollHeight: 100 } as any
      await nextTick()
      await nextTick()
      state.autoscroll = false
      state.logSeq = 2
      state.modalVisible = false
      await nextTick()
      state.modalVisible = true
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
      expect(state.copyState).toBe('')

      state.viewedInstanceId = 'i2'
      await state.onCancel()
      state.viewedInstanceId = ''
      await state.onCancel()
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
})
