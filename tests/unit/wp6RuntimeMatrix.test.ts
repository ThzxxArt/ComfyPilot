import { describe, expect, it } from 'vitest'
import {
  TORCH_INDEX,
  expectedAcceleratorForChannel,
  officialTorchIndex
} from '../../src/main/services/installer'
import { TORCH_DISK_GB } from '@shared/constants'
import {
  renderLaunchProfile,
  validateLaunchArgs,
  warnLaunchArgs
} from '@shared/launchArgs'
import { buildArgs } from '../../src/main/services/instance/launchArgs'
import type { ComfyInstanceConfig } from '@shared/types'

function cfg(patch: Partial<ComfyInstanceConfig> = {}): ComfyInstanceConfig {
  return {
    id: 'i1',
    name: 'T',
    path: '/tmp/ComfyUI',
    pythonPath: '',
    venvPath: '',
    port: 8188,
    listen: '127.0.0.1',
    extraArgs: [],
    argTemplateId: 'default',
    enabled: true,
    notes: '',
    autoStart: false,
    frontendVersion: '',
    pinned: false,
    ...patch
  }
}

describe('torch runtime matrix (0.2.5 WP6)', () => {
  it('maps CUDA 13, ROCm 7.2/10.0, XPU, MPS and CPU indexes', () => {
    expect(officialTorchIndex('cu130')).toContain('/cu130/')
    expect(officialTorchIndex('cu126')).toContain('/cu126/')
    expect(officialTorchIndex('rocm7.2')).toContain('/rocm7.2/')
    expect(officialTorchIndex('rocm10.0')).toContain('/rocm10.0/')
    expect(officialTorchIndex('xpu')).toContain('/xpu/')
    for (const ch of ['cu130', 'cu126', 'rocm7.2', 'rocm10.0', 'xpu', 'mps', 'cpu'] as const) {
      expect(TORCH_DISK_GB[ch]).toBeGreaterThan(0)
      expect(TORCH_INDEX[ch]).toMatch(/\/$/)
    }
  })

  it('requires the accelerator proof for every non-CPU channel', () => {
    expect(expectedAcceleratorForChannel('cu130')).toBe('cuda')
    expect(expectedAcceleratorForChannel('rocm7.2')).toBe('hip')
    expect(expectedAcceleratorForChannel('rocm10.0')).toBe('hip')
    expect(expectedAcceleratorForChannel('xpu')).toBe('xpu')
    expect(expectedAcceleratorForChannel('mps')).toBe('mps')
    expect(expectedAcceleratorForChannel('cpu')).toBe('cpu')
  })

  it('renders new runtime flags and keeps cache/cuda validation', () => {
    const args = renderLaunchProfile({
      cacheRam: 4,
      cudaDevice: '0,1',
      disableDynamicVram: true,
      disableFastDisk: true,
      disableComfyCompiler: true,
      forceNonBlocking: true
    })
    expect(args).toEqual(
      expect.arrayContaining([
        '--cache-ram',
        '4',
        '--cuda-device',
        '0,1',
        '--disable-dynamic-vram',
        '--disable-fast-disk',
        '--disable-comfy-compiler',
        '--force-non-blocking'
      ])
    )
    expect(validateLaunchArgs(['--cuda-device', '0,1'])).toEqual([])
    expect(validateLaunchArgs(['--cuda-device', 'gpu0'])).not.toEqual([])
    expect(validateLaunchArgs(['--cache-ram', '-1'])).not.toEqual([])
    expect(validateLaunchArgs(['--disable-manager-ui', '--enable-manager-legacy-ui'])).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'manager-conflict' })])
    )
  })

  it('warns that --directml is obsolete instead of accepting it silently', () => {
    const warnings = warnLaunchArgs(['--directml'])
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'deprecated-flag', flag: '--directml', level: 'warning' })
      ])
    )
  })

  it('renders frontendVersion as --front-end-version exactly once', () => {
    const args = buildArgs(cfg({ frontendVersion: '1.59.6' }))
    expect(args.filter((a) => a === '--front-end-version')).toHaveLength(1)
    expect(args[args.indexOf('--front-end-version') + 1]).toBe('1.59.6')
    const overridden = buildArgs(
      cfg({ frontendVersion: '1.59.6', extraArgs: ['--front-end-version', 'latest'] })
    )
    expect(overridden.filter((a) => a === '--front-end-version')).toHaveLength(2)
    expect(overridden[overridden.length - 1]).toBe('latest')
  })
})
