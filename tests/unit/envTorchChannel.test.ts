/**
 * 0.2.1: repair must preserve a working CUDA/ROCm/XPU/MPS torch build and only
 * auto-select a GPU channel when torch is missing or is a CPU wheel.
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'cp-torch-channel-electron') }
}))
vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => ({})
}))

import { torchChannelFromProbe, chooseTorchChannel } from '../../src/main/services/env'

describe('torchChannelFromProbe (0.2.1)', () => {
  it('maps CUDA 13 / 12 / older to their channels', () => {
    expect(torchChannelFromProbe({ cudaVersion: '13.0', torchVersion: '2.14.1+cu130' })).toBe(
      'cu130'
    )
    expect(torchChannelFromProbe({ cudaVersion: '12.8', torchVersion: '2.14.1+cu128' })).toBe(
      'cu126'
    )
    expect(torchChannelFromProbe({ cudaVersion: '11.8', torchVersion: '2.7.1+cu118' })).toBe('cpu')
  })

  it('maps ROCm, XPU and MPS builds', () => {
    expect(torchChannelFromProbe({ rocmVersion: '7.0', torchVersion: '2.14.1+rocm7.0' })).toBe(
      'rocm'
    )
    expect(torchChannelFromProbe({ npuAvailable: true, torchVersion: '2.14.1+xpu' })).toBe('xpu')
    expect(torchChannelFromProbe({ mpsAvailable: true, torchVersion: '2.14.1' })).toBe('mps')
  })

  it('distinguishes CPU torch from missing torch', () => {
    expect(torchChannelFromProbe({ torchVersion: '2.15.0+cpu' })).toBe('cpu')
    expect(torchChannelFromProbe({ torchVersion: '2.15.0' })).toBe('cpu')
    expect(torchChannelFromProbe({})).toBe('')
    expect(torchChannelFromProbe(null)).toBe('')
    expect(torchChannelFromProbe(undefined)).toBe('')
  })
})

describe('chooseTorchChannel (0.2.1)', () => {
  it('lets an explicit request win even when a GPU build exists', () => {
    expect(
      chooseTorchChannel({
        requested: 'cpu',
        probe: { cudaVersion: '13.0', torchVersion: '2.14.1+cu130' },
        recommendations: ['cu130']
      })
    ).toBe('cpu')
  })

  it('preserves a working GPU build when no channel was requested', () => {
    expect(
      chooseTorchChannel({
        probe: { cudaVersion: '13.0', torchVersion: '2.14.1+cu130' },
        recommendations: ['cu130']
      })
    ).toBe('')
    expect(
      chooseTorchChannel({
        probe: { rocmVersion: '7.0', torchVersion: '2.14.1+rocm7.0' },
        recommendations: ['rocm']
      })
    ).toBe('')
    expect(
      chooseTorchChannel({
        probe: { mpsAvailable: true, torchVersion: '2.14.1' },
        recommendations: ['mps']
      })
    ).toBe('')
  })

  it('replaces CPU torch with the detected GPU channel', () => {
    expect(
      chooseTorchChannel({
        probe: { torchVersion: '2.15.0+cpu' },
        recommendations: ['cpu', 'cu130']
      })
    ).toBe('cu130')
  })

  it('preserves CPU torch when no GPU is available', () => {
    expect(
      chooseTorchChannel({ probe: { torchVersion: '2.15.0+cpu' }, recommendations: ['cpu'] })
    ).toBe('')
    expect(chooseTorchChannel({ probe: { torchVersion: '2.15.0+cpu' } })).toBe('')
  })

  it('installs a detected GPU channel when torch is missing', () => {
    expect(chooseTorchChannel({ probe: {}, recommendations: ['cu130'] })).toBe('cu130')
    expect(chooseTorchChannel({ probe: null, recommendations: ['cu126'] })).toBe('cu126')
  })

  it('falls back to CPU torch only when torch is missing and no GPU exists', () => {
    expect(chooseTorchChannel({ probe: {}, recommendations: ['cpu'] })).toBe('cpu')
    expect(chooseTorchChannel({ probe: null })).toBe('cpu')
  })
})
