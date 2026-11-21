/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const make = () => {
    const listeners = new Map<string, Array<(...a: any[]) => void>>()
    const e: any = {
      on(event: string, cb: (...a: any[]) => void) {
        listeners.set(event, [...(listeners.get(event) || []), cb])
        return e
      },
      emit(event: string, ...a: any[]) {
        for (const cb of listeners.get(event) || []) cb(...a)
        return true
      },
      removeAllListeners() {
        listeners.clear()
      }
    }
    e.cancel = vi.fn(async () => true)
    e.cancelRepair = vi.fn(() => true)
    e.cancelOp = vi.fn(() => true)
    e.cancelUpdateBatch = vi.fn(() => true)
    e.cancelBuild = vi.fn(() => true)
    e.wasCancelledByUser = vi.fn(() => false)
    return e
  }
  return {
    installer: make(),
    updater: make(),
    env: make(),
    node: make(),
    batch: make(),
    registry: make(),
    failWire: false
  }
})

vi.mock('../../src/main/services/installer', () => ({ installerService: h.installer }))
vi.mock('../../src/main/services/updater', () => ({ comfyUpdaterService: h.updater }))
vi.mock('../../src/main/services/env', () => ({ envService: h.env }))
vi.mock('../../src/main/services/nodePack', () => ({ nodePackService: h.node }))
vi.mock('../../src/main/services/p1p2', () => ({ batchService: h.batch }))
vi.mock('../../src/main/services/registryIndex', () => {
  if (h.failWire) throw new Error('wire import failed')
  return { registryIndex: h.registry }
})

import { OperationRegistry } from '../../src/main/services/ops'

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useRealTimers()
  for (const key of ['installer', 'updater', 'env', 'node', 'batch', 'registry'] as const) {
    h[key].removeAllListeners()
    h[key].cancel.mockClear()
    h[key].cancelRepair.mockClear()
    h[key].cancelOp.mockClear()
    h[key].cancelUpdateBatch.mockClear()
    h[key].cancelBuild.mockClear()
    h[key].wasCancelledByUser.mockClear()
  }
  h.failWire = false
})

describe('OperationRegistry', () => {
  it('begins, reuses, updates, finishes and prunes operations', async () => {
    const reg = new OperationRegistry()
    const changes: any[] = []
    reg.on('changed', (op) => changes.push(op))
    const op = reg.begin({ kind: 'install', target: 'i1', title: 'T', detail: 'd' })
    expect(op.id).toBe('install:i1')
    expect(changes).toHaveLength(1)
    expect(reg.get(op.id)?.status).toBe('running')
    op.update({ percent: 50, detail: 'half' })
    expect(reg.get(op.id)?.percent).toBe(50)
    const reused = reg.begin(
      {
        id: op.id,
        kind: 'install',
        target: 'i1',
        cancel: async () => false
      },
      { reuse: true }
    )
    expect(reused.id).toBe(op.id)
    expect(await reg.cancel(op.id)).toBe(false)
    op.finish('done')
    expect(reg.get(op.id)?.status).toBe('done')
    expect(reg.get(op.id)?.percent).toBe(100)
    op.update({ percent: 10 })
    expect(reg.get(op.id)?.percent).toBe(100)
    reg.finish(op.id, 'failed', 'bad')
    expect(reg.get(op.id)?.error).toBe('bad')
    expect(reg.get('missing')).toBeUndefined()
    reg.finish('missing', 'done')
    reg.update('missing', { percent: 1 })
    expect(await reg.cancel('missing')).toBe(false)
    expect(await reg.cancel(op.id)).toBe(false)

    const replaced = reg.begin({ id: op.id, kind: 'install', target: 'i1' }, { reuse: true })
    expect(replaced.id).toBe(op.id)
    expect(reg.get(op.id)?.status).toBe('running')

    const noCancel = reg.begin({ kind: 'output-scan', target: 'x' })
    expect(reg.get(noCancel.id)?.cancellable).toBe(false)
    expect(await reg.cancel(noCancel.id)).toBe(false)
    const cancelTrue = reg.begin({
      kind: 'output-scan',
      target: 'y',
      cancel: () => true
    })
    expect(await reg.cancel(cancelTrue.id)).toBe(true)
    const cancelThrow = reg.begin({
      kind: 'output-scan',
      target: 'z',
      cancel: () => {
        throw new Error('no')
      }
    })
    expect(await reg.cancel(cancelThrow.id)).toBe(false)
    const cancelPromise = reg.begin({
      kind: 'output-scan',
      target: 'p',
      cancel: async () => true
    })
    expect(await reg.cancel(cancelPromise.id)).toBe(true)

    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const old = reg.begin({ kind: 'output-scan', target: 'old' })
    old.finish('done')
    vi.setSystemTime(1_000_000 + 6 * 60 * 1000)
    expect(reg.list().some((o) => o.id === old.id)).toBe(false)

    const many = new OperationRegistry()
    for (let i = 0; i < 55; i++) {
      const o = many.begin({ kind: 'output-scan', target: `t${i}` })
      o.finish('done')
    }
    expect(many.list().length).toBeLessThanOrEqual(50)
  })

  it('wires every progress stream', async () => {
    const reg = new OperationRegistry()
    await reg.init()
    await reg.init()
    expect(reg.list()).toEqual([])

    h.installer.emit('progress', {
      status: 'running',
      percent: 10,
      message: 'installing',
      instanceId: 'i1'
    })
    expect(reg.get('install')?.detail).toBe('installing')
    h.installer.emit('progress', { status: 'running', percent: 20 })
    h.installer.emit('progress', { status: 'done' })
    expect(reg.get('install')?.status).toBe('done')
    h.installer.emit('progress', null)
    h.installer.emit('progress', { status: 'running' })
    h.installer.emit('progress', { status: 'failed', error: 'err' })
    expect(reg.get('install')?.status).toBe('failed')
    h.installer.emit('progress', { status: 'running' })
    h.installer.emit('progress', { status: 'cancelled' })

    h.updater.emit('progress', { status: 'running', instanceId: 'i1', percent: 1, message: 'u' })
    expect(await reg.cancel('comfy-update:i1')).toBe(true)
    h.updater.emit('progress', { status: 'running', instanceId: 'i1' })
    h.updater.emit('progress', { status: 'running', instanceId: 'i1', percent: 2 })
    h.updater.emit('progress', { status: 'done', instanceId: 'i1' })
    h.updater.emit('progress', { status: 'running', instanceId: 'i1' })
    h.updater.emit('progress', { status: 'failed', instanceId: 'i1', message: 'm' })
    h.updater.emit('progress', { status: 'running', instanceId: 'i1' })
    h.updater.emit('progress', { status: 'cancelled', instanceId: 'i1' })

    h.env.emit('progress', { status: 'running', instanceId: 'i1', percent: 1 })
    expect(await reg.cancel('env-repair:i1')).toBe(true)
    h.env.emit('progress', { status: 'running', instanceId: 'i1' })
    h.env.emit('progress', { status: 'running' })
    h.env.emit('progress', { status: 'done' })
    h.env.emit('progress', { status: 'failed', error: 'e' })
    h.env.emit('progress', { status: 'cancelled' })

    h.node.emit('op-progress', {
      status: 'running',
      instanceId: 'i1',
      percent: 5,
      message: 'node',
      packName: 'pack'
    })
    expect(await reg.cancel('node-op:i1')).toBe(true)
    h.node.emit('op-progress', { status: 'running', instanceId: 'i1' })
    h.node.emit('op-progress', { status: 'running', instanceId: 'i1', percent: 6 })
    h.node.emit('op-progress', { status: 'done', instanceId: 'i1' })
    h.node.emit('op-progress', { status: 'running' })
    h.node.emit('op-progress', { status: 'failed', error: 'nf' })
    h.node.emit('op-progress', { status: 'running' })
    h.node.emit('op-progress', { status: 'cancelled' })

    h.node.emit('update-batch', {
      instanceId: 'i1',
      phase: 'checking',
      index: 0,
      total: 10
    })
    expect(await reg.cancel('node-batch:i1')).toBe(true)
    h.node.emit('update-batch', {
      instanceId: 'i1',
      phase: 'update',
      index: 5,
      total: 10,
      packName: 'pack'
    })
    h.node.emit('update-batch', { instanceId: 'i1', phase: 'update', index: 0, total: 0 })
    h.node.emit('update-batch', { instanceId: 'i1', phase: 'start', index: 0, total: 10 })
    h.node.emit('update-batch', { instanceId: 'i1', phase: 'update', index: 0, total: 10 })
    h.node.emit('update-batch', {
      instanceId: 'i1',
      phase: 'batch-done',
      summary: { cancelled: true, fail: 1 }
    })
    h.node.emit('update-batch', {
      instanceId: 'i1',
      phase: 'update',
      index: 1,
      total: 2
    })
    h.node.emit('update-batch', {
      instanceId: 'i1',
      phase: 'batch-done',
      summary: { fail: 2 }
    })
    h.node.emit('update-batch', {
      instanceId: 'i1',
      phase: 'update',
      index: 1,
      total: 2
    })
    h.node.emit('update-batch', {
      instanceId: 'i1',
      phase: 'batch-done',
      ok: false,
      summary: { fail: 1 }
    })
    h.node.emit('update-batch', {
      instanceId: 'i1',
      phase: 'update',
      index: 1,
      total: 2
    })
    h.node.emit('update-batch', { instanceId: 'i1', phase: 'batch-done' })
    h.node.emit('update-batch', { instanceId: 'i1', phase: 'update', index: 1, total: 2 })
    h.node.emit('update-batch', { instanceId: 'i1', phase: 'batch-error', error: 'e' })
    h.node.emit('update-batch', { instanceId: 'i1', phase: 'update', index: 1, total: 2 })
    h.node.emit('update-batch', { instanceId: 'i1', phase: 'batch-error' })

    h.batch.emit('progress', {})
    h.batch.emit('progress', { id: 'b1', status: 'running', count: 10, completed: 5 })
    expect(await reg.cancel('batch:b1')).toBe(true)
    h.batch.emit('progress', {
      id: 'b1',
      status: 'running',
      instanceId: 'i1',
      name: 'B',
      count: 0,
      completed: 0
    })
    h.batch.emit('progress', { id: 'b1', status: 'submitting', count: 10, completed: 1 })
    h.batch.emit('progress', { id: 'b1', status: 'cancelled' })
    h.batch.emit('progress', { id: 'b1', status: 'running', count: 1, completed: 0 })
    h.batch.emit('progress', { id: 'b1', status: 'interrupted' })
    h.batch.emit('progress', { id: 'b1', status: 'running', count: 1, completed: 0 })
    h.batch.emit('progress', { id: 'b1', status: 'error', errorSummary: 'err' })
    h.batch.emit('progress', { id: 'b1', status: 'running', count: 1, completed: 0 })
    h.batch.emit('progress', { id: 'b1', status: 'done' })
    h.batch.emit('progress', { id: 'b2', status: 'done' })

    h.registry.emit('progress', { done: 1, total: 2, count: 1 })
    expect(await reg.cancel('registry-index')).toBe(true)
    h.registry.emit('progress', { done: 0, total: 0, count: 0 })
    h.registry.emit('ready', {})
    h.registry.emit('idle', {})
    h.registry.emit('progress', { done: 1, total: 2, count: 1 })
    expect(await reg.cancel('registry-index')).toBe(true)
    h.registry.wasCancelledByUser.mockReturnValueOnce(true)
    h.registry.emit('idle', {})
    h.registry.emit('progress', { done: 1, total: 2, count: 1 })
    expect(await reg.cancel('registry-index')).toBe(true)
    h.registry.emit('idle', {})

    expect(reg.list().length).toBeGreaterThan(0)
  })

  it('runs request/response operations and maps failures', async () => {
    const reg = new OperationRegistry()
    expect(await reg.run({ kind: 'output-scan', target: 'x' }, async () => 1)).toBe(1)
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    await expect(
      reg.run({ kind: 'output-scan', target: 'x' }, async () => Promise.reject(abort))
    ).rejects.toBe(abort)
    await expect(
      reg.run({ kind: 'output-scan', target: 'x' }, async () => Promise.reject(new Error('bad')))
    ).rejects.toThrow(/bad/)
    await expect(
      reg.run({ kind: 'output-scan', target: 'x' }, async () => Promise.reject('plain'))
    ).rejects.toBe('plain')
  })
})
