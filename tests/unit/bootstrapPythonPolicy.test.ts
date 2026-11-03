/**
 * 0.2.2: the bootstrap probe must enforce the single supported runtime.
 * A system Python 3.14 used to be reported as installed and passed Doctor.
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'cp-bootstrap-policy') },
  session: { defaultSession: { fetch: vi.fn() } }
}))
vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => ({})
}))

import { isSupportedPythonVersion } from '../../src/main/services/bootstrap'

describe('isSupportedPythonVersion (0.2.2)', () => {
  it('accepts every 3.13 spelling emitted by python --version', () => {
    expect(isSupportedPythonVersion('Python 3.13.18')).toBe(true)
    expect(isSupportedPythonVersion('3.13.18')).toBe(true)
    expect(isSupportedPythonVersion('Python 3.13')).toBe(true)
  })

  it('rejects 3.12, 3.14, missing and malformed versions', () => {
    expect(isSupportedPythonVersion('Python 3.12.10')).toBe(false)
    expect(isSupportedPythonVersion('Python 3.14.5')).toBe(false)
    expect(isSupportedPythonVersion('Python 3.130.1')).toBe(false)
    expect(isSupportedPythonVersion(undefined)).toBe(false)
    expect(isSupportedPythonVersion('')).toBe(false)
  })
})
