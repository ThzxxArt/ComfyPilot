import { describe, expect, it, afterEach } from 'vitest'
import {
  acquireEnvLock,
  envLockOwner,
  isEnvLocked,
  resetEnvLocksForTest
} from '../../src/main/services/envLock'

afterEach(() => resetEnvLocksForTest())

describe('EnvOperationLock (0.2.0)', () => {
  it('allows exactly one owner per instance', () => {
    const release = acquireEnvLock('i1', 'audit')
    expect(isEnvLocked('i1')).toBe(true)
    expect(envLockOwner('i1')).toBe('audit')
    expect(() => acquireEnvLock('i1', 'pip')).toThrow(/busy/i)
    try {
      acquireEnvLock('i1', 'pip')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ENV_BUSY')
    }
    release()
    expect(isEnvLocked('i1')).toBe(false)
    expect(() => acquireEnvLock('i1', 'pip')).not.toThrow()
  })

  it('is idempotent on release and independent per instance', () => {
    const a = acquireEnvLock('a', 'audit')
    const b = acquireEnvLock('b', 'pip')
    a()
    a()
    expect(isEnvLocked('a')).toBe(false)
    expect(isEnvLocked('b')).toBe(true)
    b()
  })
})
