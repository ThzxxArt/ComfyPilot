/**
 * Frontend-package status + one-click align spec (0.1.15): the mismatch badge
 * facts and the `comfyui-frontend-package==X` spec construction, including the
 * silent cases (equal / missing / malformed version).
 */
import { describe, expect, it } from 'vitest'
import { frontendAlignSpec, frontendPkgStatus } from '../../src/renderer/src/utils/frontendAlign'

describe('frontendPkgStatus (0.1.15)', () => {
  const pkg = (installed: string, required: string) => ({
    name: 'comfyui-frontend-package',
    installed,
    required
  })

  it('flags a mismatch only when both sides are real and differ', () => {
    expect(frontendPkgStatus([pkg('1.55.14', '1.55.17')])).toEqual({
      installed: '1.55.14',
      required: '1.55.17',
      mismatch: true
    })
    expect(frontendPkgStatus([pkg('1.55.17', '1.55.17')])).toEqual({
      installed: '1.55.17',
      required: '1.55.17',
      mismatch: false
    })
  })

  it('falls back to requiredFrontendVersion and keeps mismatch honest', () => {
    const s = frontendPkgStatus([pkg('1.55.14', '')], '1.55.17')
    expect(s).toEqual({ installed: '1.55.14', required: '1.55.17', mismatch: true })
  })

  it('never claims a mismatch with a missing side', () => {
    expect(frontendPkgStatus([pkg('', '1.55.17')])!.mismatch).toBe(false)
    expect(frontendPkgStatus([pkg('1.55.17', '')])!.mismatch).toBe(false)
  })

  it('returns null when neither side reports (old servers)', () => {
    expect(frontendPkgStatus([])).toBeNull()
    expect(frontendPkgStatus([{ name: 'other', installed: 'x', required: 'y' }])).toBeNull()
  })
})

describe('frontendAlignSpec (0.1.15)', () => {
  it('builds the pip spec for a real mismatch', () => {
    expect(frontendAlignSpec('1.55.14', '1.55.17')).toBe('comfyui-frontend-package==1.55.17')
    // build-metadata suffixes survive
    expect(frontendAlignSpec('1.55.14', '1.55.17+abc.1')).toBe(
      'comfyui-frontend-package==1.55.17+abc.1'
    )
  })

  it('returns null when there is nothing to align', () => {
    expect(frontendAlignSpec('1.55.17', '1.55.17')).toBeNull()
    expect(frontendAlignSpec('', '1.55.17')).toBeNull()
    expect(frontendAlignSpec('1.55.14', '')).toBeNull()
  })

  it('refuses malformed required tokens (never builds a suspicious spec)', () => {
    expect(frontendAlignSpec('1.0', ' 1.2')).not.toBeNull() // trimmed first
    expect(frontendAlignSpec('1.0', '>=1.2')).toBeNull()
    expect(frontendAlignSpec('1.0', '1.2 ; evil')).toBeNull()
    expect(frontendAlignSpec('1.0', '-1.2')).toBeNull()
  })
})
