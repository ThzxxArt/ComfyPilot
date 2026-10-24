/**
 * 0.1.18 (WP8): table-driven tests for the extracted IPC trust decisions.
 *
 * These rules are the only thing standing between a compromised renderer and
 * path/remote confusion, and they used to be untestable closures in handlers.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  isRemoteTarget,
  remoteIdOf,
  requireLocalInstanceId,
  requireLocalTarget,
  safeInstanceId,
  safeInstanceTarget
} from '../../src/main/ipc/trust'

describe('safeInstanceId', () => {
  const accepted: Array<[unknown, string | undefined]> = [
    [undefined, undefined],
    [null, undefined],
    ['', undefined],
    ['inst-1', 'inst-1'],
    ['a_b.c', 'a_b.c'],
    ['inst 1', 'inst_1']
  ]
  for (const [input, expected] of accepted) {
    it(`accepts ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(safeInstanceId(input as string)).toBe(expected)
    })
  }

  const rejected = ['../etc', 'a/b', 'a\\b', 'a\0b', '..', 'x/../y', '   ']
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => safeInstanceId(input)).toThrow(/Invalid instance id/)
    })
  }
})

describe('safeInstanceTarget / isRemoteTarget / remoteIdOf', () => {
  it('keeps and sanitizes the remote prefix', () => {
    expect(safeInstanceTarget('remote:r-1')).toBe('remote:r-1')
    expect(safeInstanceTarget('remote:r 1')).toBe('remote:r_1')
    expect(safeInstanceTarget('local-1')).toBe('local-1')
    expect(safeInstanceTarget(undefined)).toBeUndefined()
  })

  it('rejects traversal inside a remote id', () => {
    expect(() => safeInstanceTarget('remote:../../x')).toThrow(/Invalid instance id/)
  })

  it('classifies and extracts remote ids', () => {
    expect(isRemoteTarget('remote:r1')).toBe(true)
    expect(isRemoteTarget('r1')).toBe(false)
    expect(isRemoteTarget(undefined)).toBe(false)
    expect(remoteIdOf('remote:r1')).toBe('r1')
    expect(remoteIdOf('r1')).toBeNull()
    expect(remoteIdOf('remote:')).toBeNull()
  })
})

describe('requireLocalInstanceId / requireLocalTarget', () => {
  it('passes local ids through (including undefined)', () => {
    expect(requireLocalInstanceId('inst-1')).toBe('inst-1')
    expect(requireLocalInstanceId(undefined)).toBeUndefined()
  })

  it('refuses remote targets with a coded error', () => {
    try {
      requireLocalInstanceId('remote:r1')
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('REMOTE_NOT_SUPPORTED')
    }
  })

  it('requires an explicit target for destructive local work', () => {
    expect(requireLocalTarget('inst-1')).toBe('inst-1')
    try {
      requireLocalTarget(undefined)
      expect.unreachable('should throw')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('TARGET_REQUIRED')
    }
  })
})
