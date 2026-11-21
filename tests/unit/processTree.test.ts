/**
 * 0.1.17 (WP1-5): one tree-kill owner.
 * Windows always goes through `taskkill /T /F`; POSIX keeps the graceful
 * SIGTERM → SIGKILL escalation when a grace period is requested.
 */
import { describe, it, expect, vi } from 'vitest'

const h = vi.hoisted(() => ({
  execCalls: [] as Array<{ cmd: string; args: string[] }>
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (cmd: string, args: string[], _opts: unknown, cb?: () => void) => {
      h.execCalls.push({ cmd, args })
      queueMicrotask(() => cb?.())
      return { pid: 1 }
    }
  }
})

import { killProcessTree } from '../../src/main/services/processTree'

function fakeChild(pid = 42) {
  const kills: string[] = []
  const listeners: Array<() => void> = []
  return {
    pid,
    exitCode: null as number | null,
    kills,
    listeners,
    kill(sig: string) {
      kills.push(sig)
    },
    once(_ev: string, fn: () => void) {
      listeners.push(fn)
    },
    emitExit() {
      for (const fn of listeners) fn()
    }
  }
}

describe('killProcessTree', () => {
  it('escalates SIGTERM → SIGKILL when the child ignores the grace period', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const child = fakeChild()
      await killProcessTree(child as never, { graceMs: 20, waitMs: 0 })
      expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('stops escalating once the child exits during the grace period', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const child = fakeChild()
      const p = killProcessTree(child as never, { graceMs: 500, waitMs: 0 })
      child.exitCode = 0
      child.emitExit()
      await p
      expect(child.kills).toEqual(['SIGTERM'])
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('kills immediately when no grace is requested', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const child = fakeChild()
      await killProcessTree(child as never, { waitMs: 0 })
      expect(child.kills).toEqual(['SIGKILL'])
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('tolerates a child without a pid', async () => {
    const child = fakeChild(0)
    await expect(killProcessTree(child as never)).resolves.toBeUndefined()
  })

  it('uses default wait windows and exits early for an already-dead child', async () => {
    const real = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const dead = fakeChild(4243)
      dead.exitCode = 0
      await killProcessTree(dead as never)
      expect(dead.kills).toEqual([])

      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      const posixDead = fakeChild(4244)
      posixDead.exitCode = 0
      await killProcessTree(posixDead as never)
      expect(posixDead.kills).toEqual(['SIGKILL'])
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('uses the darwin descendant shortcut', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const child = fakeChild()
      await killProcessTree(child as never, { waitMs: 0 })
      expect(child.kills).toEqual(['SIGKILL'])
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('does not signal a child that already exited during a graceful kill', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const child = fakeChild()
      child.exitCode = 0
      await killProcessTree(child as never, { graceMs: 10, waitMs: 0 })
      expect(child.kills).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })
  it('uses taskkill on Windows and still signals the child handle', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    h.execCalls = []
    try {
      const child = fakeChild(4242)
      await expect(killTreeWithWindows(child as never)).resolves.toBeUndefined()
      expect(h.execCalls[0]).toMatchObject({
        cmd: 'taskkill',
        args: ['/PID', '4242', '/T', '/F']
      })
      expect(child.kills).toEqual(['SIGKILL'])
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  async function killTreeWithWindows(child: never): Promise<void> {
    await killProcessTree(child, { waitMs: 0, timeoutMs: 2000 })
  }

  it('does not resolve before the child has actually exited (0.1.18 review)', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      // A live pid (our own) forces the poll path; only the exit event can
      // satisfy it. The old implementation resolved as soon as it signalled.
      const child = fakeChild(process.pid)
      const started = Date.now()
      const p = killProcessTree(child as never, { waitMs: 500 })
      setTimeout(() => {
        child.exitCode = 0
        child.emitExit()
      }, 60)
      await p
      expect(Date.now() - started).toBeGreaterThanOrEqual(40)
      expect(child.kills).toEqual(['SIGKILL'])
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })
})
