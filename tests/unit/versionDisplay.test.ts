/**
 * versionDisplay (0.1.11.1): install-stamp vs online-version comparison.
 * An instance whose install stamp is a commit sha / date / 'detected' must
 * NOT produce a false "版本不一致" against the server's `0.39.0`.
 */
import { describe, it, expect } from 'vitest'
import {
  isSemanticVersion,
  versionMismatch
} from '../../src/renderer/src/utils/versionDisplay'

describe('versionDisplay (0.1.11.1)', () => {
  it('isSemanticVersion accepts dotted versions and rejects stamps', () => {
    expect(isSemanticVersion('0.39.0')).toBe(true)
    expect(isSemanticVersion('v1.2')).toBe(true)
    expect(isSemanticVersion('0.39')).toBe(true)
    expect(isSemanticVersion('8010b48a1b2c')).toBe(false)
    expect(isSemanticVersion('2026-10-13')).toBe(false)
    expect(isSemanticVersion('detected')).toBe(false)
    expect(isSemanticVersion('')).toBe(false)
    expect(isSemanticVersion(undefined)).toBe(false)
  })

  it('versionMismatch only fires for comparable, actually different versions', () => {
    // Commit-sha install stamp vs the online semantic version → not a mismatch.
    expect(versionMismatch('8010b48a1b2c', '0.39.0')).toBe(false)
    expect(versionMismatch('2026-10-13', '0.39.0')).toBe(false)
    expect(versionMismatch('detected', '0.39.0')).toBe(false)
    expect(versionMismatch('0.39.0', '0.39.0')).toBe(false)
    expect(versionMismatch('v0.39.0', '0.39.0')).toBe(false)
    expect(versionMismatch('0.38.0', '0.39.0')).toBe(true)
    expect(versionMismatch('', '0.39.0')).toBe(false)
    expect(versionMismatch('0.39.0', undefined)).toBe(false)
  })
})
