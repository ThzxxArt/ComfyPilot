/**
 * env.runStreaming line buffering (0.1.11): a line split across chunks must
 * be emitted whole, bare-`\r` progress rewrites count as line breaks, and a
 * successful exit folds stderr into the resolved text (pip can exit 0 while
 * printing `ERROR:` on stderr).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const h = vi.hoisted(() => ({
  spawned: [] as Array<{
    stdout: EventEmitter
    stderr: EventEmitter
    handlers: Record<string, Array<(...a: unknown[]) => void>>
  }>
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cp-rs' },
  session: { defaultSession: { fetch: async () => new Response('') } }
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(() => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
    const child = {
      stdout,
      stderr,
      on(ev: string, cb: (...a: unknown[]) => void) {
        ;(handlers[ev] ||= []).push(cb)
        return child
      },
      kill: () => undefined
    }
    h.spawned.push({ stdout, stderr, handlers })
    return child
  })
}))

async function importEnv() {
  vi.resetModules()
  return import('../../src/main/services/env')
}

describe('runStreaming line buffering (0.1.11)', () => {
  beforeEach(() => {
    h.spawned.length = 0
  })

  it('reassembles lines split across chunks and treats bare \\r as breaks', async () => {
    const { runStreaming } = await importEnv()
    const lines: string[] = []
    const p = runStreaming(
      'git',
      ['pull'],
      { onLine: (l) => lines.push(l) },
      async () => 'fallback'
    )
    const child = h.spawned[0]
    child.stdout.emit('data', Buffer.from('Receiv'))
    child.stdout.emit('data', Buffer.from('ing objects: 50%\nnext line\n'))
    // Progress rewrites arrive with bare \r inside one chunk.
    child.stdout.emit('data', Buffer.from('Receiving objects: 90%\rRece'))
    child.stdout.emit('data', Buffer.from('iving objects: 100%\n'))
    child.handlers['close']?.[0]?.(0)
    await expect(p).resolves.toContain('Receiving objects: 100%')
    expect(lines).toEqual([
      'Receiving objects: 50%',
      'next line',
      'Receiving objects: 90%',
      'Receiving objects: 100%'
    ])
  })

  it('flushes a trailing unterminated line on close', async () => {
    const { runStreaming } = await importEnv()
    const lines: string[] = []
    const p = runStreaming('pip', ['list'], { onLine: (l) => lines.push(l) }, async () => '')
    const child = h.spawned[0]
    child.stdout.emit('data', Buffer.from('no trailing newline'))
    child.handlers['close']?.[0]?.(0)
    await p
    expect(lines).toEqual(['no trailing newline'])
  })

  it('folds stderr into the resolved text on success (exit-0 ERROR case)', async () => {
    const { runStreaming } = await importEnv()
    const lines: string[] = []
    const p = runStreaming('pip', ['install'], { onLine: (l) => lines.push(l) }, async () => '')
    const child = h.spawned[0]
    child.stdout.emit('data', Buffer.from('ok\n'))
    child.stderr.emit('data', Buffer.from('ERROR: dependency conflict\n'))
    child.handlers['close']?.[0]?.(0)
    await expect(p).resolves.toContain('ERROR: dependency conflict')
    expect(lines).toEqual(['ok', 'ERROR: dependency conflict'])
  })

  it('rejects with stderr text on a non-zero exit', async () => {
    const { runStreaming } = await importEnv()
    const p = runStreaming('git', ['pull'], { onLine: () => undefined }, async () => '')
    const child = h.spawned[0]
    child.stderr.emit('data', Buffer.from('fatal: no upstream\n'))
    child.handlers['close']?.[0]?.(1)
    await expect(p).rejects.toThrow('fatal: no upstream')
  })
})
