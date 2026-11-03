/**
 * 0.2.3: global task-center registry.
 *
 * The registry was previously unmeasured; it is the only place that tells the
 * user an operation is still running after a modal closes.
 */
import { describe, expect, it, vi } from 'vitest'
import { OperationRegistry } from '../../src/main/services/ops'

describe('OperationRegistry', () => {
  it('creates, updates and finishes an operation', () => {
    const reg = new OperationRegistry()
    const changed = vi.fn()
    reg.on('changed', changed)
    const op = reg.begin({ kind: 'install', target: 'i1', detail: 'start' })
    expect(reg.list()).toHaveLength(1)
    expect(reg.list()[0].status).toBe('running')
    op.update({ percent: 40, detail: 'working' })
    expect(reg.list()[0].percent).toBe(40)
    op.finish('done')
    expect(reg.list()[0].status).toBe('done')
    expect(reg.list()[0].percent).toBe(100)
    expect(changed).toHaveBeenCalled()
  })

  it('reuses a running operation but replaces a finished one', () => {
    const reg = new OperationRegistry()
    const a = reg.begin({ id: 'same', kind: 'batch', target: 'i1' }, { reuse: true })
    const b = reg.begin({ id: 'same', kind: 'batch', target: 'i1' }, { reuse: true })
    expect(a.id).toBe(b.id)
    a.finish('done')
    const c = reg.begin({ id: 'same', kind: 'batch', target: 'i1' }, { reuse: true })
    expect(reg.list()[0].status).toBe('running')
    expect(c.id).toBe('same')
  })

  it('cancels only a running cancellable op and reports failures honestly', async () => {
    const reg = new OperationRegistry()
    expect(await reg.cancel('missing')).toBe(false)
    const blocked = reg.begin({ kind: 'env-repair', target: 'i1' })
    expect(await reg.cancel(blocked.id)).toBe(false)
    const ok = reg.begin({
      kind: 'env-repair',
      target: 'i1',
      cancel: () => true
    })
    expect(await reg.cancel(ok.id)).toBe(true)
    const boom = reg.begin({
      kind: 'env-repair',
      target: 'i2',
      cancel: () => {
        throw new Error('no')
      }
    })
    expect(await reg.cancel(boom.id)).toBe(false)
  })

  it('run() marks success, cancellation and failure', async () => {
    const reg = new OperationRegistry()
    await expect(reg.run({ kind: 'output-scan', target: 'local' }, async () => 7)).resolves.toBe(7)
    expect(reg.list()[0].status).toBe('done')
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    await expect(
      reg.run({ kind: 'output-scan', target: 'local' }, async () => {
        throw abort
      })
    ).rejects.toThrow('cancelled')
    expect(reg.list()[0].status).toBe('cancelled')
    await expect(
      reg.run({ kind: 'output-scan', target: 'local' }, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(reg.list()[0].status).toBe('failed')
  })

  it('ignores updates after a terminal state', () => {
    const reg = new OperationRegistry()
    const op = reg.begin({ kind: 'install', target: 'i1', percent: 0 })
    op.finish('failed', 'nope')
    op.update({ percent: 99 })
    reg.update(op.id, { detail: 'late' })
    expect(reg.list()[0].percent).toBe(0)
    expect(reg.list()[0].detail).toBe('')
  })
})
