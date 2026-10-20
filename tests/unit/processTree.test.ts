/**
 * 0.1.17 (WP1-5): one tree-kill owner.
 * Windows always goes through `taskkill /T /F`; POSIX keeps the graceful
 * SIGTERM → SIGKILL escalation when a grace period is requested.
 */
import { describe, it, expect } from 'vitest'
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
      await killProcessTree(child as never, { graceMs: 20 })
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
      const p = killProcessTree(child as never, { graceMs: 500 })
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
      await killProcessTree(child as never)
      expect(child.kills).toEqual(['SIGKILL'])
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('tolerates a child without a pid', async () => {
    const child = fakeChild(0)
    await expect(killProcessTree(child as never)).resolves.toBeUndefined()
  })
})
