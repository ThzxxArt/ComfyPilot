import { describe, expect, it } from 'vitest'
import { attentionOverview } from '../../src/shared/attention'
import type { EnvProbe } from '../../src/shared/types'

function probe(over: Partial<EnvProbe> = {}): EnvProbe {
  return {
    pythonPath: 'C:/env/python.exe',
    pythonVersion: '3.13.18',
    torchVersion: '2.14.1+cu130',
    cudaVersion: '13.0',
    packages: [],
    ok: true,
    errors: [],
    ...over
  }
}

function pkg(name: string, version: string): { name: string; version: string } {
  return { name, version }
}

describe('attentionOverview (0.2.6)', () => {
  it('reports installable SageAttention/xFormers on Windows cu130 + torch 2.10+', () => {
    const out = attentionOverview(probe(), undefined, 'win32')
    expect(out.sageattention.status).toBe('not-installed')
    expect(out.sageattention.canInstall).toBe(true)
    expect(out.xformers.status).toBe('not-installed')
    expect(out.xformers.canInstall).toBe(true)
    expect(out.sageActive).toBe(false)
    expect(out.xformersDisabled).toBe(false)
  })

  it('marks SageAttention 1.0.6 as outdated and 2.2.0 as installed', () => {
    const old = attentionOverview(
      probe({ packages: [pkg('sageattention', '1.0.6'), pkg('xformers', '0.0.36')] }),
      undefined,
      'win32'
    )
    expect(old.sageattention.status).toBe('outdated')
    expect(old.sageattention.version).toBe('1.0.6')
    expect(old.sageattention.canInstall).toBe(true)
    expect(old.xformers.status).toBe('installed')
    expect(old.xformers.version).toBe('0.0.36')

    const current = attentionOverview(
      probe({
        packages: [pkg('SageAttention', '2.2.0+cu130torch2.10.0andhigher.post6')]
      }),
      undefined,
      'win32'
    )
    expect(current.sageattention.status).toBe('installed')
    expect(current.sageattention.version).toContain('2.2.0')
  })

  it('gates automatic installs on the platform, CUDA and torch version', () => {
    const oldTorch = attentionOverview(probe({ torchVersion: '2.9.1+cu130' }), undefined, 'win32')
    expect(oldTorch.sageattention.status).toBe('unsupported')
    expect(oldTorch.sageattention.canInstall).toBe(false)
    expect(oldTorch.xformers.status).toBe('unsupported')

    const cu12 = attentionOverview(probe({ cudaVersion: '12.8' }), undefined, 'win32')
    expect(cu12.sageattention.status).toBe('unsupported')
    expect(cu12.xformers.canInstall).toBe(true)

    const linux = attentionOverview(probe(), undefined, 'linux')
    expect(linux.sageattention.status).toBe('unsupported')
    expect(linux.xformers.canInstall).toBe(true)

    const mac = attentionOverview(probe(), undefined, 'darwin')
    expect(mac.xformers.status).toBe('unsupported')
    expect(mac.xformers.canInstall).toBe(false)
  })

  it('handles malformed versions and missing CUDA metadata honestly', () => {
    const malformed = attentionOverview(
      probe({
        torchVersion: '',
        cudaVersion: undefined,
        packages: [
          { name: 'sageattention', version: '' },
          { name: 'xformers', version: '' }
        ]
      }),
      undefined,
      'win32'
    )
    expect(malformed.sageattention.status).toBe('outdated')
    expect(malformed.sageattention.version).toBeUndefined()
    expect(malformed.sageattention.canInstall).toBe(false)
    expect(malformed.xformers.version).toBeUndefined()
    expect(malformed.xformers.canInstall).toBe(false)

    const futureTorch = attentionOverview(probe({ torchVersion: '3.0.0' }), undefined, 'win32')
    expect(futureTorch.sageattention.canInstall).toBe(true)
  })

  it('does not invent package state before the environment probe', () => {
    const out = attentionOverview(null, undefined, 'win32')
    expect(out.sageattention.status).toBe('unknown')
    expect(out.xformers.status).toBe('unknown')
    expect(out.sageattention.canInstall).toBe(false)

    const noList = attentionOverview(
      { ...probe(), packages: undefined } as unknown as EnvProbe,
      undefined,
      'win32',
      undefined as unknown as string[]
    )
    expect(noList.sageattention.status).toBe('not-installed')
    expect(noList.xformers.status).toBe('not-installed')
  })

  it('reads the active backend from the launch profile and extra argv', () => {
    const profile = attentionOverview(
      probe({ packages: [pkg('sageattention', '2.2.0'), pkg('xformers', '0.0.36')] }),
      { attention: 'sage', disableXformers: true },
      'win32'
    )
    expect(profile.backend).toBe('sage')
    expect(profile.sageActive).toBe(true)
    expect(profile.xformersDisabled).toBe(true)

    const argv = attentionOverview(
      probe({ packages: [pkg('sageattention', '2.2.0')] }),
      { attention: 'flash' },
      'win32',
      ['--use-sage-attention', '--disable-xformers']
    )
    expect(argv.sageActive).toBe(true)
    expect(argv.xformersDisabled).toBe(true)
  })
})
