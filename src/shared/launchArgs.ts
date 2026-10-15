/**
 * ComfyUI launch-argument rendering + validation (0.1.9).
 *
 * Single source of truth for turning a structured `LaunchProfile` into argv
 * and for catching argparse-fatal combinations (mutually exclusive groups in
 * `comfy/cli_args.py` make ComfyUI exit immediately when two flags of the same
 * group are passed). Shared by main (spawn + preview) and renderer (live
 * validation while editing).
 */
import type { LaunchProfile } from './types'

const UNET_FLAGS: Record<string, string> = {
  fp32: '--fp32-unet',
  fp64: '--fp64-unet',
  bf16: '--bf16-unet',
  fp16: '--fp16-unet',
  fp8_e4m3fn: '--fp8_e4m3fn-unet',
  fp8_e5m2: '--fp8_e5m2-unet',
  fp8_e8m0fnu: '--fp8_e8m0fnu-unet'
}

const VAE_FLAGS: Record<string, string> = {
  fp16: '--fp16-vae',
  fp32: '--fp32-vae',
  bf16: '--bf16-vae'
}

const TEXT_ENC_FLAGS: Record<string, string> = {
  fp8_e4m3fn: '--fp8_e4m3fn-text-enc',
  fp8_e5m2: '--fp8_e5m2-text-enc',
  fp16: '--fp16-text-enc',
  fp32: '--fp32-text-enc',
  bf16: '--bf16-text-enc'
}

const ATTENTION_FLAGS: Record<string, string> = {
  split: '--use-split-cross-attention',
  quad: '--use-quad-cross-attention',
  pytorch: '--use-pytorch-cross-attention',
  sage: '--use-sage-attention',
  flash: '--use-flash-attention',
  ck: '--use-ck-attention'
}

/** Render a structured profile into ComfyUI argv (canonical, stable order). */
export function renderLaunchProfile(profile?: LaunchProfile): string[] {
  if (!profile) return []
  const args: string[] = []
  const p = profile

  if (p.vram && p.vram !== 'default') args.push(`--${p.vram}`)
  if (typeof p.reserveVram === 'number' && p.reserveVram > 0) {
    args.push('--reserve-vram', String(p.reserveVram))
  }
  if (typeof p.vramHeadroom === 'number' && p.vramHeadroom > 0) {
    args.push('--vram-headroom', String(p.vramHeadroom))
  }

  if (p.cache === 'classic') args.push('--cache-classic')
  else if (p.cache === 'none') args.push('--cache-none')
  else if (p.cache === 'high-ram') args.push('--high-ram')
  else if (p.cache === 'lru') {
    args.push('--cache-lru', String(Math.max(1, Math.floor(p.cacheLru || 4))))
  }

  if (p.previewMethod && p.previewMethod !== 'none') {
    args.push('--preview-method', p.previewMethod)
    args.push('--preview-size', String(p.previewSize || 512))
  }

  if (p.attention && p.attention !== 'default') {
    const flag = ATTENTION_FLAGS[p.attention]
    if (flag) args.push(flag)
  }
  if (p.disableXformers) args.push('--disable-xformers')
  if (p.attentionUpcast === 'force') args.push('--force-upcast-attention')
  if (p.attentionUpcast === 'disable') args.push('--dont-upcast-attention')

  if (p.unetPrecision && p.unetPrecision !== 'default') {
    const flag = UNET_FLAGS[p.unetPrecision]
    if (flag) args.push(flag)
  }
  if (p.vaePrecision && p.vaePrecision !== 'default') {
    const flag = VAE_FLAGS[p.vaePrecision]
    if (flag) args.push(flag)
  }
  if (p.textEncoderPrecision && p.textEncoderPrecision !== 'default') {
    const flag = TEXT_ENC_FLAGS[p.textEncoderPrecision]
    if (flag) args.push(flag)
  }

  if (p.asyncOffload === 'on') args.push('--async-offload')
  else if (p.asyncOffload === 'off') args.push('--disable-async-offload')
  if (p.fastDisk) args.push('--fast-disk')
  if (p.disablePinnedMemory) args.push('--disable-pinned-memory')
  if (p.mmapTorchFiles) args.push('--mmap-torch-files')
  if (p.disableCudaGraphs) args.push('--disable-cuda-graphs')
  if (p.disableSmartMemory) args.push('--disable-smart-memory')
  if (p.disableNvmlPressure) args.push('--disable-nvml-pressure')
  if (p.tritonBackend === 'on') args.push('--enable-triton-backend')
  else if (p.tritonBackend === 'off') args.push('--disable-triton-backend')

  // 0.1.10: base directories (multi-instance isolation) + device selection.
  if (p.baseDirectory) args.push('--base-directory', p.baseDirectory)
  if (p.modelsDirectory) args.push('--models-directory', p.modelsDirectory)
  if (p.userDirectory) args.push('--user-directory', p.userDirectory)
  // 0.1.14: storage directories — output/input/temp (long-standing flags) and
  // previews (assets system, 0.40+). `resolveOutputDir` in the main process
  // reads the --output-directory value straight from argv, so structuring it
  // here keeps every consumer in sync.
  if (p.outputDirectory) args.push('--output-directory', p.outputDirectory)
  if (p.inputDirectory) args.push('--input-directory', p.inputDirectory)
  if (p.tempDirectory) args.push('--temp-directory', p.tempDirectory)
  if (p.previewsDirectory) args.push('--previews-directory', p.previewsDirectory)
  if (typeof p.defaultDevice === 'number' && p.defaultDevice >= 0) {
    args.push('--default-device', String(Math.floor(p.defaultDevice)))
  }

  if (p.corsHeader) {
    // Bare flag means '*'; the origin form takes a value.
    if (p.corsHeader === '*') args.push('--enable-cors-header')
    else args.push('--enable-cors-header', p.corsHeader)
  }
  if (typeof p.maxUploadSize === 'number' && p.maxUploadSize > 0) {
    args.push('--max-upload-size', String(p.maxUploadSize))
  }
  if (p.assets === true) args.push('--enable-assets')
  else if (p.assets === false) args.push('--disable-assets')
  if (p.assetHashing) args.push('--enable-asset-hashing')
  if (p.multiUser) args.push('--multi-user')
  if (p.offline) args.push('--offline')
  if (p.disableAutoLaunch) args.push('--disable-auto-launch')
  if (p.verbose) args.push('--verbose')

  return args
}

/**
 * Minimal dotted-version comparator shared by capability gates and launch-arg
 * warnings (both main and renderer need it).
 */
export function versionAtLeast(version: string | undefined, min: string): boolean {
  if (!version || !min) return false
  const parse = (v: string): number[] | null => {
    const m = String(v)
      .trim()
      .match(/^v?(\d+(?:\.\d+)*)/)
    if (!m) return null
    return m[1].split('.').map((n) => Number(n) || 0)
  }
  const a = parse(version)
  const b = parse(min)
  if (!a || !b) return false
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/**
 * VRAM-based launch profile recommendation (0.1.10).
 * ComfyUI 0.39+ enables DynamicVRAM by default, so the useful knobs are a
 * reserved floor + fast-disk offload; tighter VRAM additionally caps the cache.
 * Returns undefined when the GPU has ample VRAM (no change recommended) or
 * when no GPU facts are available.
 */
export function recommendLaunchProfile(
  gpus?: Array<{ vramTotal?: number }>
): LaunchProfile | undefined {
  if (!gpus?.length) return undefined
  const vramBytes = Math.max(0, ...gpus.map((g) => Number(g.vramTotal) || 0))
  const gb = vramBytes / 1024 ** 3
  if (gb <= 0) return undefined
  if (gb >= 16) return undefined
  if (gb >= 8) return { reserveVram: 0.8, fastDisk: true }
  if (gb >= 6) return { reserveVram: 1, fastDisk: true, cache: 'lru', cacheLru: 6 }
  return { reserveVram: 2, fastDisk: true, cache: 'none' }
}

const VRAM_FLAGS = ['--gpu-only', '--highvram', '--lowvram', '--novram', '--cpu']
const CACHE_VALUE_FLAGS = ['--cache-lru', '--cache-ram']
const CACHE_BOOL_FLAGS = ['--cache-classic', '--cache-none', '--high-ram']

export interface LaunchArgValidationError {
  /** Machine code — map to i18n via the renderer's `launchArgs.err*` keys. */
  code: string
  /** Flag involved (for `invalid-number` style errors). */
  flag?: string
}

/**
 * Known ComfyUI flags (comfy/cli_args.py). Used to WARN — never block — on
 * unrecognized free-text flags and on flags that only recent ComfyUI builds
 * understand. Exact min versions are intentionally NOT pinned here (the CLI
 * changes between releases); the warning text tells the user what to do.
 */
export interface LaunchArgWarning {
  code: 'unknown-flag' | 'recent-flag' | 'duplicate-listen'
  flag: string
  level: 'info' | 'warning'
}

/** i18n key for each validation code (shared by editor + preview surfaces). */
export const LAUNCH_ARG_ERROR_KEYS: Record<string, string> = {
  'vram-conflict': 'launchArgs.errVramConflict',
  'cache-conflict': 'launchArgs.errCacheConflict',
  'attention-conflict': 'launchArgs.errAttentionConflict',
  'unet-conflict': 'launchArgs.errUnetConflict',
  'vae-conflict': 'launchArgs.errVaeConflict',
  'text-enc-conflict': 'launchArgs.errTextEncConflict',
  'fp-conflict': 'launchArgs.errFpConflict',
  'upcast-conflict': 'launchArgs.errUpcastConflict',
  'cuda-malloc-conflict': 'launchArgs.errCudaMallocConflict'
}

/** i18n key for a warning code (single mapping shared by every consumer). */
export function launchArgWarningKey(code: string): string {
  switch (code) {
    case 'unknown-flag':
      return 'launchArgs.warnUnknownFlag'
    case 'duplicate-listen':
      return 'launchArgs.warnDuplicateListen'
    default:
      return 'launchArgs.warnRecentFlag'
  }
}

interface CatalogEntry {
  flag: string
  /** Only exists in recent ComfyUI builds. */
  recent?: boolean
}

const CATALOG: CatalogEntry[] = [
  { flag: '--listen' },
  { flag: '--port' },
  { flag: '--tls-keyfile' },
  { flag: '--tls-certfile' },
  { flag: '--enable-cors-header' },
  { flag: '--max-upload-size' },
  { flag: '--base-directory' },
  { flag: '--extra-model-paths-config' },
  { flag: '--output-directory' },
  { flag: '--temp-directory' },
  { flag: '--input-directory' },
  { flag: '--previews-directory', recent: true },
  { flag: '--auto-launch' },
  { flag: '--disable-auto-launch' },
  { flag: '--cuda-device' },
  { flag: '--default-device' },
  { flag: '--cuda-malloc' },
  { flag: '--disable-cuda-malloc' },
  { flag: '--force-fp32' },
  { flag: '--force-fp16' },
  { flag: '--fp32-unet' },
  { flag: '--fp64-unet' },
  { flag: '--bf16-unet' },
  { flag: '--fp16-unet' },
  { flag: '--fp8_e4m3fn-unet' },
  { flag: '--fp8_e5m2-unet' },
  { flag: '--fp8_e8m0fnu-unet', recent: true },
  { flag: '--fp16-vae' },
  { flag: '--fp32-vae' },
  { flag: '--bf16-vae' },
  { flag: '--cpu-vae' },
  { flag: '--fp8_e4m3fn-text-enc' },
  { flag: '--fp8_e5m2-text-enc' },
  { flag: '--fp16-text-enc' },
  { flag: '--fp32-text-enc' },
  { flag: '--bf16-text-enc' },
  { flag: '--fp16-intermediates' },
  { flag: '--force-channels-last' },
  { flag: '--directml' },
  { flag: '--oneapi-device-selector' },
  { flag: '--supports-fp8-compute' },
  { flag: '--preview-method' },
  { flag: '--preview-size' },
  { flag: '--cache-ram', recent: true },
  { flag: '--cache-classic' },
  { flag: '--cache-lru' },
  { flag: '--cache-none' },
  { flag: '--high-ram' },
  { flag: '--use-split-cross-attention' },
  { flag: '--use-quad-cross-attention' },
  { flag: '--use-pytorch-cross-attention' },
  { flag: '--use-sage-attention' },
  { flag: '--use-flash-attention' },
  { flag: '--use-ck-attention', recent: true },
  { flag: '--disable-xformers' },
  { flag: '--force-upcast-attention' },
  { flag: '--dont-upcast-attention' },
  { flag: '--gpu-only' },
  { flag: '--highvram' },
  { flag: '--lowvram' },
  { flag: '--novram' },
  { flag: '--cpu' },
  { flag: '--reserve-vram' },
  { flag: '--vram-headroom', recent: true },
  { flag: '--disable-nvml-pressure', recent: true },
  { flag: '--async-offload', recent: true },
  { flag: '--disable-async-offload', recent: true },
  { flag: '--disable-dynamic-vram', recent: true },
  { flag: '--enable-dynamic-vram', recent: true },
  { flag: '--fast-disk', recent: true },
  { flag: '--disable-fast-disk', recent: true },
  { flag: '--disable-cuda-graphs' },
  { flag: '--disable-comfy-compiler', recent: true },
  { flag: '--assert-graph-breaks', recent: true },
  { flag: '--force-non-blocking' },
  { flag: '--default-hashing-function' },
  { flag: '--disable-smart-memory' },
  { flag: '--deterministic' },
  { flag: '--fast', recent: true },
  { flag: '--debug-hang' },
  { flag: '--disable-pinned-memory' },
  { flag: '--mmap-torch-files' },
  { flag: '--disable-mmap' },
  { flag: '--dont-print-server' },
  { flag: '--quick-test-for-ci' },
  { flag: '--windows-standalone-build' },
  { flag: '--disable-api-nodes' },
  { flag: '--disable-metadata' },
  { flag: '--disable-all-custom-nodes' },
  { flag: '--whitelist-custom-nodes' },
  { flag: '--disabled-nodes-config', recent: true },
  { flag: '--disable-partner-nodes' },
  { flag: '--offline' },
  { flag: '--multi-user' },
  { flag: '--verbose' },
  { flag: '--log-stdout' },
  { flag: '--front-end-version' },
  { flag: '--front-end-root' },
  { flag: '--user-directory' },
  { flag: '--models-directory' },
  { flag: '--enable-compress-response-body', recent: true },
  { flag: '--database-url', recent: true },
  { flag: '--enable-assets', recent: true },
  { flag: '--disable-assets', recent: true },
  { flag: '--feature-flag', recent: true },
  { flag: '--comfy-api-base', recent: true },
  { flag: '--enable-manager', recent: true },
  { flag: '--disable-manager-ui', recent: true },
  { flag: '--enable-manager-legacy-ui', recent: true },
  { flag: '--enable-asset-hashing', recent: true },
  { flag: '--enable-triton-backend', recent: true },
  { flag: '--disable-triton-backend', recent: true },
  { flag: '--list-feature-flags', recent: true }
]

const CATALOG_MAP = new Map(CATALOG.map((e) => [e.flag, e]))

/**
 * Version confirmed to understand every `recent: true` catalog entry (ComfyUI
 * 0.39.0, verified against source during 0.1.10 development). Used ONLY to
 * tighten wording when the running version is known:
 *  - version >= SINCE  → no warning at all (flag is confirmed supported)
 *  - version <  SINCE  → explicit warning level (it may still work — we do not
 *    claim those flags were absent before; only that we have not verified them)
 *  - unknown           → informational warning (default behaviour)
 */
export const RECENT_FLAGS_SINCE = '0.39.0'

export interface WarnLaunchArgsOptions {
  /** Running instance version (from capability probing), when known. */
  version?: string
}

/**
 * Non-blocking advisories for the FINAL argv: unrecognized flags (typos or
 * version drift) and flags that only newer ComfyUI builds accept. Unknown
 * flags are WARNINGS, never errors — the free-text escape hatch stays open.
 */
export function warnLaunchArgs(args: string[], opts?: WarnLaunchArgsOptions): LaunchArgWarning[] {
  const out: LaunchArgWarning[] = []
  const seen = new Set<string>()
  const version = String(opts?.version || '').trim()
  // true: confirmed supported here; false: confirmed older; undefined: unknown.
  const recentSupported = version ? versionAtLeast(version, RECENT_FLAGS_SINCE) : undefined
  for (const a of args) {
    if (!a.startsWith('--') || seen.has(a)) continue
    seen.add(a)
    const entry = CATALOG_MAP.get(a)
    if (!entry) {
      out.push({ code: 'unknown-flag', flag: a, level: 'warning' })
      continue
    }
    if (entry.recent) {
      // Confirmed-supported version: silence the advisory entirely.
      if (recentSupported === true) continue
      out.push({
        code: 'recent-flag',
        flag: a,
        level: recentSupported === false ? 'warning' : 'info'
      })
    }
  }
  // Duplicate --listen is legal (last wins) but almost always a mistake when
  // it comes from free text on top of the template/config value.
  const listenCount = args.filter((a) => a === '--listen').length
  if (listenCount > 1) {
    out.push({ code: 'duplicate-listen', flag: '--listen', level: 'warning' })
  }
  return out
}

/**
 * Validate FINAL argv (structured + template + free text). Returns every
 * argparse-fatal problem instead of letting ComfyUI fail at launch time.
 */
export function validateLaunchArgs(args: string[]): LaunchArgValidationError[] {
  const errors: LaunchArgValidationError[] = []
  const has = (flag: string): boolean => args.includes(flag)
  const countFlags = (flags: string[]): number => flags.filter((f) => has(f)).length

  if (countFlags(VRAM_FLAGS) > 1) errors.push({ code: 'vram-conflict' })

  const cacheGroups = countFlags(CACHE_BOOL_FLAGS) + CACHE_VALUE_FLAGS.filter((f) => has(f)).length
  if (cacheGroups > 1) errors.push({ code: 'cache-conflict' })

  if (countFlags(Object.values(ATTENTION_FLAGS)) > 1) {
    errors.push({ code: 'attention-conflict' })
  }
  if (countFlags(Object.values(UNET_FLAGS)) > 1) errors.push({ code: 'unet-conflict' })
  if (countFlags(Object.values(VAE_FLAGS)) > 1) errors.push({ code: 'vae-conflict' })
  if (countFlags(Object.values(TEXT_ENC_FLAGS)) > 1) {
    errors.push({ code: 'text-enc-conflict' })
  }
  if (has('--force-fp32') && has('--force-fp16')) errors.push({ code: 'fp-conflict' })
  if (has('--force-upcast-attention') && has('--dont-upcast-attention')) {
    errors.push({ code: 'upcast-conflict' })
  }
  if (has('--cuda-malloc') && has('--disable-cuda-malloc')) {
    errors.push({ code: 'cuda-malloc-conflict' })
  }

  const numeric: Array<[string, number, number]> = [
    // Bounds intentionally loose — match ComfyUI's types (int/float) instead of
    // inventing policy limits that would hard-block legitimate values.
    ['--reserve-vram', 0, 4096],
    ['--vram-headroom', 0, 4096],
    ['--max-upload-size', 0.01, 1000000],
    ['--preview-size', 1, 8192],
    ['--cache-lru', 0, 1000000],
    ['--port', 1, 65535],
    ['--default-device', 0, 31]
  ]
  // Check EVERY occurrence: a user can append a second (possibly bare) flag in
  // extraArgs, and indexOf-only let the first valid value mask it.
  for (const [flag, min, max] of numeric) {
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== flag) continue
      const raw = args[i + 1]
      const value = Number(raw)
      if (
        raw == null ||
        raw === '' ||
        raw.startsWith('--') ||
        !Number.isFinite(value) ||
        value < min ||
        value > max
      ) {
        errors.push({ code: 'invalid-number', flag })
      }
    }
  }
  // --cuda-device takes 'all' or a comma-separated id list.
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--cuda-device') continue
    const raw = args[i + 1]
    if (!raw || !/^(all|\d+(,\d+)*)$/i.test(raw)) {
      errors.push({ code: 'invalid-number', flag: '--cuda-device' })
    }
  }
  // --cache-ram accepts zero to two GB values (nargs='*').
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--cache-ram') continue
    let j = i + 1
    let count = 0
    while (j < args.length && !args[j].startsWith('--') && count < 3) {
      const v = Number(args[j])
      if (!Number.isFinite(v) || v < 0) {
        errors.push({ code: 'invalid-number', flag: '--cache-ram' })
        break
      }
      count += 1
      j += 1
    }
    if (count > 2) errors.push({ code: 'invalid-number', flag: '--cache-ram' })
  }

  return errors
}
