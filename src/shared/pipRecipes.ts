/**
 * Curated dependency-fix recipes (0.1.12, WP7) — verified install sequences
 * for the most common "ModuleNotFoundError" cases on Windows GPU rigs.
 *
 * Design rules:
 * - Small and verifiable: every URL was resolved + hashed at authoring time;
 *   `sizeBytes`/`sha256` are pinned so the download can be verified before pip
 *   touches it. A recipe with a wrong hash must fail loudly, not install junk.
 * - Honest defaults: recipes are EXPERIMENTAL accelerators/optional deps; the
 *   UI must always offer the plain-pip path as fallback.
 * - No arbitrary URLs from user input ever reach this table.
 */

export interface PipRecipeStep {
  kind: 'pip' | 'wheel'
  /** pip spec for kind='pip' (name or name==version). */
  spec?: string
  /** https URL for kind='wheel' (downloaded, hash-verified, then pip-installed). */
  url?: string
  sha256?: string
  sizeBytes?: number
}

export interface PipRecipe {
  id: string
  /** i18n keys (zh/en locales) shown in the UI. */
  titleKey: string
  descKey: string
  /** Modules whose `No module named 'x'` failure triggers this recipe. */
  matchModules: string[]
  /** Platforms the recipe was verified on (process.platform values). */
  platform?: string[]
  steps: PipRecipeStep[]
  /** Upstream source for manual inspection. */
  sourceUrl: string
  experimental: true
}

const SAGEATTENTION_WHEEL =
  'https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0-windows.post4/sageattention-2.2.0+cu130torch2.9.0andhigher.post4-cp39-abi3-win_amd64.whl'

export const PIP_RECIPES: PipRecipe[] = [
  {
    id: 'triton',
    titleKey: 'deps.recipe.triton.title',
    descKey: 'deps.recipe.triton.desc',
    matchModules: ['triton'],
    steps: [{ kind: 'pip', spec: 'triton-windows' }],
    sourceUrl: 'https://pypi.org/project/triton-windows/',
    experimental: true
  },
  {
    id: 'sageattention',
    titleKey: 'deps.recipe.sageattention.title',
    descKey: 'deps.recipe.sageattention.desc',
    matchModules: ['sageattention', 'sageattn3', 'sageattn'],
    // Verified Windows wheel (abi3, torch 2.9+ / cu130). triton-windows is
    // required first — sageattention imports triton kernels at runtime.
    platform: ['win32'],
    steps: [
      { kind: 'pip', spec: 'triton-windows' },
      {
        kind: 'wheel',
        url: SAGEATTENTION_WHEEL,
        sha256: 'f7261c53a1d46202059daff6b8feac5ee806274d47e3e7fb7abf8c5f6d410c92',
        sizeBytes: 12321863
      }
    ],
    sourceUrl: 'https://github.com/woct0rdho/SageAttention/releases',
    experimental: true
  },
  {
    id: 'onnx',
    titleKey: 'deps.recipe.onnx.title',
    descKey: 'deps.recipe.onnx.desc',
    matchModules: ['onnx'],
    steps: [{ kind: 'pip', spec: 'onnx' }],
    sourceUrl: 'https://pypi.org/project/onnx/',
    experimental: true
  }
]

/** Best recipe for a missing module name (exact match on the module id). */
export function recipeForModule(moduleName: string): PipRecipe | undefined {
  const name = String(moduleName || '')
    .trim()
    .toLowerCase()
  if (!name) return undefined
  return PIP_RECIPES.find((r) => r.matchModules.some((m) => m.toLowerCase() === name))
}

export function recipeById(id: string): PipRecipe | undefined {
  return PIP_RECIPES.find((r) => r.id === id)
}

/**
 * Renderer-safe platform detection: isolated renderers have no Node `process`
 * global — fall back to the user agent. (Reading a possibly-undefined global
 * via globalThis keeps this module importable in every world.)
 */
export function currentPlatform(): string {
  const proc = (globalThis as { process?: { platform?: unknown } }).process
  if (proc && typeof proc.platform === 'string' && proc.platform) return proc.platform
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator
  const ua = nav?.userAgent || ''
  if (/windows/i.test(ua)) return 'win32'
  if (/macintosh|mac os/i.test(ua)) return 'darwin'
  if (/linux/i.test(ua)) return 'linux'
  return 'unknown'
}

/** True when the recipe may run on this platform (no platform list = any). */
export function recipeSupportsPlatform(
  recipe: PipRecipe,
  platform: string = currentPlatform()
): boolean {
  return !recipe.platform?.length || recipe.platform.includes(platform)
}
