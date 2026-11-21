// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'

const now = Date.now()
const running = {
  id: 'op1',
  kind: 'install',
  status: 'running',
  title: 'Install A',
  startedAt: now - 125000,
  percent: 25,
  detail: 'working',
  target: 'inst-1',
  cancellable: true
}
const finished = {
  id: 'op2',
  kind: 'comfy-update',
  status: 'done',
  title: 'Update B',
  startedAt: now - 5000,
  finishedAt: now - 1000,
  percent: null,
  detail: 'done',
  target: 'inst-2',
  cancellable: false
}
let ops: any[] = []
let cancelResult: any = true
let cancelThrows = false

beforeAll(() => stubBrowser())

beforeEach(() => {
  ops = [running, finished]
  cancelResult = true
  cancelThrows = false
  installBridge((channel) => {
    if (channel === 'ops.list') return ops
    if (channel === 'ops.cancel') {
      if (cancelThrows) throw new Error('cancel boom')
      return cancelResult
    }
    return null
  })
})

async function mountTask() {
  const { wrapper, state } = await mountView(
    '/',
    () => import('../../src/renderer/src/components/TaskCenter.vue')
  )
  await flushPromises()
  await nextTick()
  return { wrapper, state }
}

describe('TaskCenter deep branches', () => {
  it('upserts, prunes, sorts and formats every op kind/status', async () => {
    const { wrapper, state } = await mountTask()
    try {
      state.ops = []
      state.upsert(null)
      state.upsert({})
      state.upsert(running)
      expect(state.ops).toHaveLength(1)
      state.upsert({ ...running, percent: 50 })
      expect(state.ops[0].percent).toBe(50)
      state.upsert(finished)
      expect(state.ops[0].id).toBe('op1')
      state.upsert({
        ...finished,
        id: 'old',
        status: 'done',
        startedAt: now - 20 * 60 * 1000,
        finishedAt: now - 20 * 60 * 1000
      })
      expect(state.ops.some((o: any) => o.id === 'old')).toBe(false)
      state.upsert({
        ...running,
        id: 'old-running',
        startedAt: now - 20 * 60 * 1000
      })
      expect(state.ops.some((o: any) => o.id === 'old-running')).toBe(true)

      for (const kind of [
        'install',
        'comfy-update',
        'env-repair',
        'node-op',
        'node-batch',
        'batch',
        'output-scan',
        'registry-index'
      ]) {
        expect(state.kindLabel(kind)).toBeTruthy()
      }
      for (const status of ['running', 'done', 'failed', 'cancelled', 'interrupted']) {
        expect(state.statusLabel({ ...running, status })).toBeTruthy()
        expect(state.statusType({ ...running, status })).toBeTruthy()
      }
      expect(state.elapsed({ ...running, startedAt: now - 1000, finishedAt: now })).toBe('1s')
      expect(state.elapsed({ ...running, startedAt: now - 125000, finishedAt: now })).toMatch(/2m/)
      expect(state.runningCount).toBeGreaterThan(0)

      state.show = true
      await nextTick()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 60_000)

  it('cancels ops and reports finished/failed cancel attempts', async () => {
    const { wrapper, state } = await mountTask()
    try {
      await state.cancelOp({ ...finished, cancellable: false })
      await state.cancelOp(running)
      expect(state.cancelling).toBe('')
      cancelResult = false
      await state.cancelOp(running)
      expect(state.cancelling).toBe('')
      cancelThrows = true
      await state.cancelOp(running)
      expect(state.cancelling).toBe('')
      state.ops = []
      state.sortOps()
      state.pruneFinished()
      expect(state.ops).toEqual([])
      state.show = true
      await flushPromises()
    } finally {
      wrapper.unmount()
    }
  }, 60_000)
})
