/**
 * Slow-IPC attribution (0.1.17 / WP6).
 *
 * Behavioural coverage for the module that turns a bare "eventLoopMax=12382ms"
 * into "output.list 12382ms {root,limit}". Values must never be logged.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => h.dir,
    getVersion: () => '0.1.17'
  }
}))

const root = mkdtempSync(join(tmpdir(), 'cp-slowops-'))
h.dir = root

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

async function load() {
  return import('../../src/main/services/slowOps')
}

beforeEach(async () => {
  const m = await load()
  m.resetSlowOpsForTest()
})

describe('slowOps digest', () => {
  it('keeps top-level keys and counts but never values', async () => {
    const { digestArgs } = await load()
    const out = digestArgs([
      { instanceId: 'secret-instance', limit: 60, nested: { token: 'abc' } },
      '/home/user/private/path',
      42,
      null,
      [1, 2, 3]
    ])
    expect(out).toContain('instanceId')
    expect(out).toContain('limit')
    expect(out).not.toContain('secret-instance')
    expect(out).not.toContain('/home/user/private/path')
    expect(out).toContain('str(')
    expect(out).toContain('arr(3)')
    expect(out).toContain('null')
  })

  it('caps the digest at 200 characters', async () => {
    const { digestArgs, ARGS_DIGEST_MAX } = await load()
    const wide = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`veryLongParameterNameNumber${i}`, i])
    )
    expect(digestArgs([wide]).length).toBeLessThanOrEqual(ARGS_DIGEST_MAX)
  })

  it('only lists the first eight keys of a wide object', async () => {
    const { digestArgs } = await load()
    const out = digestArgs([{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 }])
    expect(out).toContain('a,b,c,d,e,f,g,h')
    expect(out).not.toContain('i,j')
    expect(out).toContain('…')
  })
})

describe('slowOps recording', () => {
  it('ignores calls below the threshold', async () => {
    const m = await load()
    expect(m.recordSlowOp('fast.one', 12, [])).toBeNull()
    expect(m.getRecentSlowOps()).toEqual([])
  })

  it('records an entry and persists one line to slow-ops.log', async () => {
    const m = await load()
    const entry = m.recordSlowOp(
      'output.list',
      1234,
      [{ root: '/x', limit: 60 }],
      1_700_000_000_000
    )
    expect(entry?.ms).toBe(1234)
    expect(entry?.freeze).toBe(false)
    const lines = m.readSlowOpsLog(10)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('slow: output.list 1234ms')
    expect(lines[0]).toContain('root')
    expect(lines[0]).not.toContain('/x')
  })

  it('marks >=5 s entries as FREEZE', async () => {
    const m = await load()
    const entry = m.recordSlowOp('output.list', 12_382, [], 1)
    expect(entry?.freeze).toBe(true)
    expect(m.readSlowOpsLog(1)[0]).toContain('FREEZE: output.list 12382ms')
    expect(m.describeRecentSlowOps(3)).toBe('output.list/12382ms')
  })

  it('caps the ring buffer at 50 entries', async () => {
    const m = await load()
    for (let i = 0; i < 70; i++) m.recordSlowOp(`ch.${i}`, 1000 + i, [], i)
    const recent = m.getRecentSlowOps(100)
    expect(recent).toHaveLength(50)
    expect(recent[0].channel).toBe('ch.20')
    expect(recent[49].channel).toBe('ch.69')
  })

  it('notifies the registered listener without letting it break recording', async () => {
    const m = await load()
    const seen: string[] = []
    m.setSlowOpListener((e) => {
      seen.push(e.channel)
      throw new Error('listener exploded')
    })
    expect(m.recordSlowOp('x', 2000, [])?.channel).toBe('x')
    expect(seen).toEqual(['x'])
  })

  it('honours the configurable threshold', async () => {
    const m = await load()
    expect(m.getSlowOpThreshold()).toBe(m.DEFAULT_SLOW_OP_MS)
    m.setSlowOpThreshold(0)
    expect(m.recordSlowOp('any', 1, [])?.ms).toBe(1)
  })
})

describe('instrumentIpcHandle', () => {
  function fakeIpc() {
    const listeners = new Map<string, (...a: unknown[]) => unknown>()
    return {
      listeners,
      handle: (channel: string, fn: (...a: never[]) => unknown) => {
        listeners.set(channel, fn as unknown as (...a: unknown[]) => unknown)
      }
    }
  }

  it('times registered handlers and records their channel', async () => {
    const m = await load()
    m.setSlowOpThreshold(0)
    const ipc = fakeIpc()
    expect(m.instrumentIpcHandle(ipc)).toBe(true)
    ipc.handle('settings.get', async () => ({ ok: true }))
    const listener = ipc.listeners.get('settings.get')!
    await expect(listener({}, { instanceId: 'abc' })).resolves.toEqual({ ok: true })
    const entry = m.getRecentSlowOps(1)[0]
    expect(entry.channel).toBe('settings.get')
    expect(entry.args).toContain('instanceId')
  })

  it('is idempotent per ipc object', async () => {
    const m = await load()
    const ipc = fakeIpc()
    expect(m.instrumentIpcHandle(ipc)).toBe(true)
    const wrapped = ipc.handle
    expect(m.instrumentIpcHandle(ipc)).toBe(false)
    expect(ipc.handle).toBe(wrapped)
  })

  it('preserves thrown errors and still records the call', async () => {
    const m = await load()
    m.setSlowOpThreshold(0)
    const ipc = fakeIpc()
    m.instrumentIpcHandle(ipc)
    ipc.handle('boom', async () => {
      throw new Error('handler failed')
    })
    await expect(ipc.listeners.get('boom')!({})).rejects.toThrow('handler failed')
    expect(m.getRecentSlowOps(1)[0].channel).toBe('boom')
  })

  it('returns false for an unusable ipc object instead of throwing', async () => {
    const m = await load()
    expect(m.instrumentIpcHandle({} as never)).toBe(false)
  })
})

describe('session diagnostics bundle', () => {
  it('includes slow-ops.log when present', async () => {
    const m = await load()
    m.recordSlowOp('output.list', 2000, [])
    const s = await import('../../src/main/services/session')
    const dir = s.exportAppDiagnostics(1_700_000_000_001)
    const copied = readFileSync(join(dir, 'slow-ops.log'), 'utf-8')
    expect(copied).toContain('slow: output.list 2000ms')
  })
})

describe('paused attribution (review fix)', () => {
  function fakeIpc() {
    const listeners = new Map<string, (...a: unknown[]) => unknown>()
    return {
      listeners,
      handle: (channel: string, fn: (...a: never[]) => unknown) => {
        listeners.set(channel, fn as unknown as (...a: unknown[]) => unknown)
      }
    }
  }

  it('does not record a handler that was explicitly waiting', async () => {
    const m = await load()
    m.setSlowOpThreshold(0)
    const ipc = fakeIpc()
    m.instrumentIpcHandle(ipc)
    ipc.handle('batch.wait', async () => {
      await m.withPausedSlowOp(async () => {
        await new Promise((r) => setTimeout(r, 20))
      })
      return 'ok'
    })
    await expect(ipc.listeners.get('batch.wait')!({})).resolves.toBe('ok')
    expect(m.getRecentSlowOps(10)).toHaveLength(0)
  })

  it('still records a normal slow call', async () => {
    const m = await load()
    m.setSlowOpThreshold(0)
    const ipc = fakeIpc()
    m.instrumentIpcHandle(ipc)
    ipc.handle('output.scan', async () => 'slow')
    await ipc.listeners.get('output.scan')!({})
    expect(m.getRecentSlowOps(10)[0].channel).toBe('output.scan')
  })
})
