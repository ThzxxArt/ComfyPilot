import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdirSync,
  rmSync,
  renameSync,
  cpSync
} from 'fs'
import { join, resolve, sep } from 'path'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { resolveInstancePythonPath, resolveRuntimesPythonSync } from '../instance'
import { findInRuntimes } from '../bootstrap'
import { resolveReadTarget } from '../target'

export const execFileAsync = promisify(execFile)

/** Error with a machine-readable code so the renderer can localize it. */
export function codedError(code: string, fallback: string): Error {
  const e = new Error(fallback)
  ;(e as Error & { code?: string }).code = code
  return e
}

export function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as Error & { code?: string }).code
  return e.name === 'AbortError' || code === 'ABORT_ERR' || code === 'OP_CANCELLED'
}

/** Combine a timeout with a caller-supplied abort signal. */
export function withAbort(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([t, signal]) : t
}

/**
 * PEP 503 distribution names from a requirements.txt body.
 * Drops comments / options / URLs / VCS lines and strips version specifiers,
 * extras and environment markers so the list is uninstallable package names.
 */
export function parseRequirementNames(text: string): string[] {
  const names: string[] = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('-')) continue
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash).trim()
    if (!line || line.includes('://') || line.startsWith('.') || line.startsWith('/')) continue
    // drop environment marker
    line = line.split(';')[0].trim()
    // drop extras: name[extra]
    line = line.replace(/\[[^\]]*\]/g, '')
    // name is everything before the first version specifier / whitespace / @
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)
    if (m) names.push(m[1].toLowerCase())
  }
  return [...new Set(names)]
}

/** Best-effort git HEAD sha for a pack directory. */
export function gitRevOf(dir: string): string | undefined {
  try {
    if (!dir || !existsSync(join(dir, '.git'))) return undefined
    const gitBin = resolveGitBinary()
    const out = execFileSync(gitBin, ['-C', dir, 'rev-parse', 'HEAD'], {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8'
    })
    return String(out).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve a usable git binary.
 * System git (PATH) is ALWAYS preferred — portable MinGit must never shadow
 * a working system git. Falls back to portable only when PATH git is absent.
 * Result is cached after the first probe.
 */
let gitBinCache: string | null = null
export function resolveGitBinary(): string {
  if (gitBinCache) return gitBinCache
  try {
    const { execSync } = require('child_process') as typeof import('child_process')
    execSync('git --version', { timeout: 3000, windowsHide: true, stdio: 'ignore' })
    gitBinCache = 'git'
  } catch {
    gitBinCache = findInRuntimes('git') || 'git'
  }
  return gitBinCache
}

/** True when a usable git binary answers --version. */
export async function gitAvailable(): Promise<boolean> {
  try {
    const gitBin = resolveGitBinary()
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const run = promisify(execFile)
    await run(gitBin, ['--version'], { timeout: 5000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Best working git binary (async probe — same preference as resolveGitBinary). */
export async function resolveGitBinaryAsync(): Promise<string> {
  return resolveGitBinary()
}

/**
 * Resolve the git repository URL for a registry pack.
 * Priority: explicit repository field → derived from GitHub archive download
 * URL → looked up in the local registry index. Returns '' when unknown.
 */
export async function resolveRepoUrl(
  repository: string | undefined,
  downloadUrl: string,
  packId: string
): Promise<string> {
  // 1) Explicit field from the install endpoint.
  const direct = String(repository || '').trim()
  if (direct) return direct
  // 2) GitHub archive download URLs embed the repo path:
  //    https://github.com/{owner}/{repo}/archive/refs/...  →  https://github.com/{owner}/{repo}.git
  const gh = downloadUrl.match(/^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)\/archive\//)
  if (gh?.[1]) return `${gh[1]}.git`
  // 3) codeload.github.com zip URLs
  const cl = downloadUrl.match(/^(https?:\/\/codeload\.github\.com\/[^/]+\/[^/]+)\/zip\//)
  if (cl?.[1]) return `${cl[1]}.git`
  // 4) Local registry index carries `repository` for every catalog entry.
  //    This is the most common source — the install endpoint often omits it.
  try {
    const { registryIndex } = await import('../registryIndex')
    await registryIndex.ensure({ allowBuild: false })
    const hits = registryIndex.searchPacks(packId, 5)
    const exact = hits.find((h) => h.id === packId || h.name === packId)
    const repo = String(exact?.repository || '').trim()
    if (repo) return repo
  } catch {
    /* index not ready — fine */
  }
  return ''
}

export function sanitizeInstallName(name: string): string {
  const cleaned = String(name)
    .replace(/[^\w.-]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+$/, '') // '.', '..', '...' → empty
    .replace(/^[._-]+/, '') // leading dots/dashes are never valid pack dirs
    .slice(0, 80)
    .trim()
  // A sanitize that collapses to empty (URL ended in '/.', '?', etc.) must not
  // become `join(root, '') === root` — that would let cleanup wipe custom_nodes.
  return cleaned || `pack-${Date.now()}`
}

/** True when `child` is a real descendant of `parent` (NOT equal to it). */
export function isStrictInside(child: string, parent: string): boolean {
  try {
    const c = resolve(child)
    const p = resolve(parent)
    return c !== p && c.startsWith(p + (p.endsWith(sep) ? '' : sep))
  } catch {
    return false
  }
}

/**
 * 0.2.0: install scratch space lives under the app cache, NOT custom_nodes.
 * A crash during install used to leave `._clone_tmp_*` / `._unzip_tmp_*` where
 * ComfyUI scans and reports IMPORT FAILED on every boot.
 */
export async function nodeTempPath(prefix: string, fallbackRoot: string): Promise<string> {
  try {
    const { cacheDir } = await import('../db')
    const dir = join(cacheDir(), 'node-tmp')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  } catch {
    return join(fallbackRoot, `._${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  }
}

/** Rename when possible; copy+delete across drives (cache vs instance root). */
export function moveDirIntoPlace(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch {
    cpSync(from, to, { recursive: true, force: true })
    rmSync(from, { recursive: true, force: true })
  }
}

/** Exported for regression tests. */
export function sanitizeInstallNameForTest(name: string): string {
  return sanitizeInstallName(name)
}

/**
 * Junk / cache entries that must never be listed as node packs.
 * Shared by the custom_nodes root scan and the `.disabled/` holding dir.
 */
export function isJunkPackName(name: string): boolean {
  return (
    name.startsWith('.') ||
    name === '__pycache__' ||
    name === '__MACOSX' ||
    name === 'node_modules' ||
    name.endsWith('.egg-info') ||
    name.endsWith('.dist-info') ||
    name.endsWith('.trash') ||
    name.includes('.trash-') ||
    name.includes('.bak-')
  )
}

/** `.git` present (real dir or worktree/submodule pointer file) = git checkout. */
export function hasGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/**
 * Best-effort origin URL from a real `.git/config` so manually copied git
 * checkouts still show their repository (and match registry/market entries).
 */
export function readGitOriginUrl(dir: string): string | undefined {
  try {
    const cfg = join(dir, '.git', 'config')
    if (!existsSync(cfg)) return undefined
    const text = readFileSync(cfg, 'utf-8')
    const section = text.match(/\[remote "origin"\]([\s\S]*?)(?=\r?\n\[|$)/)
    const url = section?.[1].match(/^\s*url\s*=\s*(.+)$/m)
    return url?.[1]?.trim() || undefined
  } catch {
    return undefined
  }
}

/** Registry zips often nest a single top-level folder — descend if needed. */
export function resolveNestedPackDir(dest: string): string {
  try {
    const entries = readdirSync(dest).filter((n) => !n.startsWith('.') && n !== '__MACOSX')
    if (entries.length === 1) {
      const nested = join(dest, entries[0])
      if (statSync(nested).isDirectory()) {
        const hasMeta =
          existsSync(join(nested, '__init__.py')) ||
          existsSync(join(nested, 'pyproject.toml')) ||
          existsSync(join(nested, 'requirements.txt'))
        if (hasMeta) return nested
      }
    }
  } catch {
    /* ignore */
  }
  return dest
}

/**
 * Flatten `dest/ComfyUI-Xxx-main/` → `dest/` so the pack lives at the top
 * level of its install directory (GitHub archive naming convention).
 * Only fires when there is exactly one subdirectory and no sibling files.
 */
export function flattenSingleNestedDir(dest: string): void {
  try {
    const entries = readdirSync(dest).filter((n) => !n.startsWith('.') && n !== '__MACOSX')
    if (entries.length !== 1) return
    const nested = join(dest, entries[0])
    if (!statSync(nested).isDirectory()) return
    // Move every child of the nested dir up to dest.
    for (const child of readdirSync(nested)) {
      renameSync(join(nested, child), join(dest, child))
    }
    // Remove the now-empty nested directory.
    rmSync(nested, { recursive: true, force: true })
  } catch {
    /* best-effort — the nested layout still works via resolveNestedPackDir */
  }
}

/** Best-effort python for the targeted instance (same rules as instance launch). */
export function resolveInstancePython(instanceId?: string): string {
  const inst = resolveInstanceConfig(instanceId)
  try {
    if (inst) {
      // Shared resolver so pip installs and the launched interpreter never diverge
      // (venv → pythonPath → embeds incl. AKI sibling python/ → managed runtime).
      return resolveInstancePythonPath(inst)
    }
    // No instance resolved at all — fall back to the managed runtime, then PATH.
    const runtimePy = resolveRuntimesPythonSync()
    if (runtimePy) return runtimePy
  } catch {
    /* runtime probe failed — fall through to bare python */
  }
  return 'python'
}

/**
 * Resolve the instance that node-pack operations should target.
 * - no id → first enabled instance
 * - id found → that instance
 * - id provided but NOT found → undefined (never silently fall back to another instance)
 */
export function resolveInstanceConfig(
  instanceId?: string
): import('@shared/types').ComfyInstanceConfig | undefined {
  // 0.1.18 (WP2): the fallback policy lives in services/target.ts only.
  return resolveReadTarget(instanceId)
}

export function detectCustomNodesRoot(instanceIdOrPath?: string): string {
  // 0.1.18 (regression): an explicit but unresolvable target must NEVER fall
  // back to $COMFYUI_PATH — that installed/toggled/deleted packs in a
  // different ComfyUI than the one the user selected.
  if (instanceIdOrPath) {
    // Path form takes precedence — never resolve a filesystem path as an instance id.
    const instancePath =
      instanceIdOrPath.includes('/') || instanceIdOrPath.includes('\\')
        ? instanceIdOrPath
        : resolveInstanceConfig(instanceIdOrPath)?.path
    if (!instancePath) return ''
    return join(instancePath, 'custom_nodes')
  }
  const envPath = process.env.COMFYUI_PATH && join(process.env.COMFYUI_PATH, 'custom_nodes')
  return envPath && existsSync(envPath) ? envPath : ''
}
