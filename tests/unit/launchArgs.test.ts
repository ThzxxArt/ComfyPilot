/**
 * Shared launch-argument renderer + argparse-conflict validator (0.1.9).
 */
import { describe, expect, it } from 'vitest'
import {
  launchArgWarningKey,
  renderLaunchProfile,
  validateLaunchArgs,
  warnLaunchArgs
} from '../../src/shared/launchArgs'

describe('renderLaunchProfile', () => {
  it('renders every group in canonical order', () => {
    const args = renderLaunchProfile({
      vram: 'lowvram',
      reserveVram: 1.5,
      vramHeadroom: 0.5,
      cache: 'lru',
      cacheLru: 8,
      previewMethod: 'taesd',
      previewSize: 768,
      attention: 'pytorch',
      disableXformers: true,
      attentionUpcast: 'disable',
      unetPrecision: 'fp8_e4m3fn',
      vaePrecision: 'bf16',
      textEncoderPrecision: 'fp16',
      asyncOffload: 'on',
      fastDisk: true,
      disablePinnedMemory: true,
      mmapTorchFiles: true,
      disableCudaGraphs: true,
      disableSmartMemory: true,
      corsHeader: '*',
      maxUploadSize: 200,
      multiUser: true,
      offline: true,
      disableAutoLaunch: true,
      verbose: true
    })
    expect(args).toEqual([
      '--lowvram',
      '--reserve-vram',
      '1.5',
      '--vram-headroom',
      '0.5',
      '--cache-lru',
      '8',
      '--preview-method',
      'taesd',
      '--preview-size',
      '768',
      '--use-pytorch-cross-attention',
      '--disable-xformers',
      '--dont-upcast-attention',
      '--fp8_e4m3fn-unet',
      '--bf16-vae',
      '--fp16-text-enc',
      '--async-offload',
      '--fast-disk',
      '--disable-pinned-memory',
      '--mmap-torch-files',
      '--disable-cuda-graphs',
      '--disable-smart-memory',
      '--enable-cors-header',
      '--max-upload-size',
      '200',
      '--multi-user',
      '--offline',
      '--disable-auto-launch',
      '--verbose'
    ])
  })

  it('returns [] for undefined or default-only profiles', () => {
    expect(renderLaunchProfile(undefined)).toEqual([])
    expect(
      renderLaunchProfile({
        vram: 'default',
        attention: 'default',
        cache: 'default',
        previewMethod: 'none'
      })
    ).toEqual([])
  })

  it('emits the origin form of --enable-cors-header with a value', () => {
    expect(renderLaunchProfile({ corsHeader: 'http://example.test' })).toEqual([
      '--enable-cors-header',
      'http://example.test'
    ])
  })
})

describe('validateLaunchArgs', () => {
  it('accepts a clean argv', () => {
    expect(
      validateLaunchArgs(['--port', '8188', '--lowvram', '--preview-method', 'taesd'])
    ).toEqual([])
  })

  it('detects every mutually exclusive group', () => {
    const cases: Array<[string[], string]> = [
      [['--highvram', '--lowvram'], 'vram-conflict'],
      [['--cache-none', '--high-ram'], 'cache-conflict'],
      [['--cache-lru', '4', '--cache-none'], 'cache-conflict'],
      [['--cache-ram', '--cache-none'], 'cache-conflict'],
      [['--use-sage-attention', '--use-flash-attention'], 'attention-conflict'],
      [['--fp16-unet', '--bf16-unet'], 'unet-conflict'],
      [['--fp16-vae', '--fp32-vae'], 'vae-conflict'],
      [['--fp16-text-enc', '--fp32-text-enc'], 'text-enc-conflict'],
      [['--force-fp32', '--force-fp16'], 'fp-conflict'],
      [['--force-upcast-attention', '--dont-upcast-attention'], 'upcast-conflict'],
      [['--cuda-malloc', '--disable-cuda-malloc'], 'cuda-malloc-conflict']
    ]
    for (const [args, code] of cases) {
      expect(validateLaunchArgs(args).map((e) => e.code)).toContain(code)
    }
  })

  it('flags invalid or missing numeric values with the flag name', () => {
    const errors = validateLaunchArgs(['--reserve-vram', 'abc', '--preview-size', '0', '--port'])
    const flags = errors.filter((e) => e.code === 'invalid-number').map((e) => e.flag)
    expect(flags).toContain('--reserve-vram')
    expect(flags).toContain('--preview-size')
    expect(flags).toContain('--port')
  })

  it('validates EVERY occurrence of a numeric flag (late duplicate/bare flags)', () => {
    // A valid first --port must not mask a broken second one from extraArgs.
    expect(
      validateLaunchArgs(['--port', '8188', '--port', 'abc']).filter(
        (e) => e.code === 'invalid-number' && e.flag === '--port'
      )
    ).toHaveLength(1)
    expect(
      validateLaunchArgs(['--port', '8188', '--port']).filter(
        (e) => e.code === 'invalid-number' && e.flag === '--port'
      )
    ).toHaveLength(1)
  })

  it('validates --cuda-device form and --cache-ram value count', () => {
    expect(validateLaunchArgs(['--cuda-device', 'x']).map((e) => e.flag)).toContain('--cuda-device')
    expect(validateLaunchArgs(['--cuda-device', '0,1']).map((e) => e.flag)).not.toContain(
      '--cuda-device'
    )
    expect(validateLaunchArgs(['--cache-ram', '1', '2', '3']).map((e) => e.flag)).toContain(
      '--cache-ram'
    )
    expect(validateLaunchArgs(['--cache-ram', '1', '2']).map((e) => e.flag)).not.toContain(
      '--cache-ram'
    )
  })
})

describe('warnLaunchArgs', () => {
  it('stays silent for known stable flags', () => {
    expect(
      warnLaunchArgs(['--port', '8188', '--listen', '127.0.0.1', '--lowvram', '--cache-none'])
    ).toEqual([])
  })

  it('warns (never blocks) on unrecognized flags', () => {
    const warnings = warnLaunchArgs(['--totally-unknown-flag'])
    expect(warnings).toEqual([
      { code: 'unknown-flag', flag: '--totally-unknown-flag', level: 'warning' }
    ])
  })

  it('flags recent-version flags as informational', () => {
    const warnings = warnLaunchArgs(['--fast-disk', '--vram-headroom', '--lowvram'])
    expect(warnings.map((w) => w.flag)).toEqual(['--fast-disk', '--vram-headroom'])
    expect(warnings.every((w) => w.level === 'info')).toBe(true)
  })

  it('deduplicates repeated flags and ignores positional values', () => {
    const warnings = warnLaunchArgs(['--fast-disk', '--fast-disk', 'main.py', '8188'])
    expect(warnings).toHaveLength(1)
  })

  it('warns on duplicate --listen (last one wins)', () => {
    const warnings = warnLaunchArgs(['--listen', '127.0.0.1', '--listen', '0.0.0.0'])
    expect(warnings).toEqual([{ code: 'duplicate-listen', flag: '--listen', level: 'warning' }])
  })

  it('maps every warning code to an i18n key', () => {
    expect(launchArgWarningKey('unknown-flag')).toBe('launchArgs.warnUnknownFlag')
    expect(launchArgWarningKey('recent-flag')).toBe('launchArgs.warnRecentFlag')
    expect(launchArgWarningKey('duplicate-listen')).toBe('launchArgs.warnDuplicateListen')
  })
})
