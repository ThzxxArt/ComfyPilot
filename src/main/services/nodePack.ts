import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmSync,
  renameSync
} from 'fs'
import { join, dirname, resolve, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { EventEmitter } from 'events'
import type {
  NodeNameConflict,
  NodePackIssue,
  NodePackRecord,
  NodeSnapshot,
  NodeUpdateAllResult,
  NodeUpdateCheckResult,
  RegistryNodePack,
  UpdateProgress,
  UpdateStep,
  UpdateStepId
} from '@shared/types'
import {
  deleteNodePack,
  listNodePacks,
  listSnapshots,
  insertSnapshot,
  deleteSnapshot as dbDeleteSnapshot,
  getSnapshot,
  loadSettings,
  loadInstanceConfigs,
  snapshotDir,
  upsertNodePack
} from './db'
import { REGISTRY_API } from '@shared/constants'
import { proxyEnv } from './proxy'
import { sanitizeId, isPathInside, normalizePathEverySegment } from './security'
import { assertSafeGitUrl, applyGithubMirror, assertSafeBranch } from './installer'
import { resolveRuntimesPythonSync } from './instance'
import { findInRuntimes } from './bootstrap'

const execFileAsync = promisify(execFile)

/** Error with a machine-readable code so the renderer can localize it. */
function codedError(code: string, fallback: string): Error {
  const e = new Error(fallback)
  ;(e as Error & { code?: string }).code = code
  return e
}

function isAbortError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as Error & { code?: string }).code
  return e.name === 'AbortError' || code === 'ABORT_ERR' || code === 'OP_CANCELLED'
}

/** Combine a timeout with a caller-supplied abort signal. */
function withAbort(timeoutMs: number, signal?: AbortSignal): AbortSignal {
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
function gitRevOf(dir: string): string | undefined {
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
  const gh = downloadUrl.match(
    /^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)\/archive\//
  )
  if (gh?.[1]) return `${gh[1]}.git`
  // 3) codeload.github.com zip URLs
  const cl = downloadUrl.match(
    /^(https?:\/\/codeload\.github\.com\/[^/]+\/[^/]+)\/zip\//
  )
  if (cl?.[1]) return `${cl[1]}.git`
  // 4) Local registry index carries `repository` for every catalog entry.
  //    This is the most common source — the install endpoint often omits it.
  try {
    const { registryIndex } = await import('./registryIndex')
    await registryIndex.ensure()
    const hits = registryIndex.searchPacks(packId, 5)
    const exact = hits.find(
      (h) => h.id === packId || h.name === packId
    )
    const repo = String(exact?.repository || '').trim()
    if (repo) return repo
  } catch {
    /* index not ready — fine */
  }
  return ''
}

/**
 * Minimal version comparator for node packs.
 * - numeric dotted versions (1.2.3, 1.2.3.4) compare segment-wise
 * - pre-release suffix (1.2.3-beta) sorts before plain 1.2.3
 * - non-semver strings fall back to localeCompare (equality still works)
 * Returns >0 when a > b, <0 when a < b, 0 when equal/incomparable-as-equal.
 */
export function compareVersions(a: string, b: string): number {
  const na = String(a || '').trim()
  const nb = String(b || '').trim()
  if (!na && !nb) return 0
  if (!na) return -1
  if (!nb) return 1
  if (na === nb) return 0

  const parse = (v: string): { nums: number[]; pre: string } => {
    const m = v.match(/^v?(\d+(?:\.\d+)*)(?:[-+.]?(.*))?$/i)
    if (!m) return { nums: [], pre: v.toLowerCase() }
    const nums = m[1].split('.').map((s) => Number(s) || 0)
    return { nums, pre: (m[2] || '').toLowerCase() }
  }
  const A = parse(na)
  const B = parse(nb)
  if (A.nums.length && B.nums.length) {
    const len = Math.max(A.nums.length, B.nums.length)
    for (let i = 0; i < len; i++) {
      const x = A.nums[i] ?? 0
      const y = B.nums[i] ?? 0
      if (x !== y) return x - y
    }
    // same numeric core: a release (no pre) > a pre-release
    if (A.pre && !B.pre) return -1
    if (!A.pre && B.pre) return 1
    return A.pre.localeCompare(B.pre)
  }
  return na.localeCompare(nb)
}

/** True when `latest` is strictly newer than `current`. */
export function isUpdateAvailable(current: string, latest: string): boolean {
  if (!current || !latest) return false
  // Non-comparable free-form strings: treat any difference as "unknown", not an update.
  const looksNumeric = (v: string): boolean => /^v?\d/i.test(v.trim())
  if (!looksNumeric(current) || !looksNumeric(latest)) {
    // commit shas: different means "maybe", but we only flag when latest is a
    // clearly longer/different git describe — keep conservative (no update flag).
    return false
  }
  return compareVersions(latest, current) > 0
}

function sanitizeInstallName(name: string): string {
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

/** Exported for regression tests. */
export function sanitizeInstallNameForTest(name: string): string {
  return sanitizeInstallName(name)
}

/** Registry zips often nest a single top-level folder — descend if needed. */
function resolveNestedPackDir(dest: string): string {
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
function flattenSingleNestedDir(dest: string): void {
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

/** Best-effort python for the targeted instance (venv preferred, then runtimes). */
function resolveInstancePython(instanceId?: string): string {
  const inst = resolveInstanceConfig(instanceId)
  if (inst?.venvPath) {
    const win = join(inst.venvPath, 'Scripts', 'python.exe')
    const unix = join(inst.venvPath, 'bin', 'python')
    if (existsSync(win)) return win
    if (existsSync(unix)) return unix
  }
  if (inst?.pythonPath) return inst.pythonPath
  // Zero-prereq: portable Python downloaded by bootstrap
  try {
    const runtimePy = resolveRuntimesPythonSync()
    if (runtimePy) return runtimePy
  } catch {
    /* ignore */
  }
  return 'python'
}

/**
 * Resolve the instance that node-pack operations should target.
 * - no id → first enabled instance
 * - id found → that instance
 * - id provided but NOT found → undefined (never silently fall back to another instance)
 */
export function resolveInstanceConfig(instanceId?: string): import('@shared/types').ComfyInstanceConfig | undefined {
  const configs = loadInstanceConfigs()
  if (instanceId) {
    return configs.find((c) => c.id === instanceId)
  }
  return configs.find((c) => c.enabled !== false) || configs[0]
}

function detectCustomNodesRoot(instanceIdOrPath?: string): string {
  let instancePath: string | undefined
  if (instanceIdOrPath) {
    // Path form takes precedence — never resolve a filesystem path as an instance id.
    if (instanceIdOrPath.includes('/') || instanceIdOrPath.includes('\\')) {
      instancePath = instanceIdOrPath
    } else {
      instancePath = resolveInstanceConfig(instanceIdOrPath)?.path
    }
  }
  const candidates = [
    instancePath && join(instancePath, 'custom_nodes'),
    process.env.COMFYUI_PATH && join(process.env.COMFYUI_PATH, 'custom_nodes')
  ].filter(Boolean) as string[]
  return candidates.find((p) => existsSync(p)) || candidates[0] || ''
}

/**
 * Fingerprint of every file readPackMeta looks at. Cheap stat calls replace
 * re-reading pyproject/package.json and re-scanning all .py files for
 * NODE_CLASS_MAPPINGS on every list().
 */
function packMetaSignature(dir: string): string {
  const parts: string[] = []
  for (const f of ['pyproject.toml', 'package.json', 'node_list.json']) {
    const p = join(dir, f)
    try {
      const st = statSync(p)
      parts.push(`${f}:${st.size}:${st.mtimeMs}`)
    } catch {
      parts.push(`${f}:-`)
    }
  }
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.py')) continue
      try {
        const st = statSync(join(dir, f))
        parts.push(`${f}:${st.size}:${st.mtimeMs}`)
      } catch {
        parts.push(`${f}:!`)
      }
    }
  } catch {
    /* unreadable dir — signature still distinguishes the error case */
  }
  return parts.join('|')
}

type PackMeta = Partial<NodePackRecord> & { nodeList?: string[] }

/** dir + input signature → parsed meta. */
const packMetaCache = new Map<string, { sig: string; meta: PackMeta }>()

function readPackMeta(dir: string): PackMeta {
  const sig = packMetaSignature(dir)
  const hit = packMetaCache.get(dir)
  if (hit && hit.sig === sig) return hit.meta

  const pyproject = join(dir, 'pyproject.toml')
  const pkgJson = join(dir, 'package.json')
  let name = dir.split(/[\\/]/).pop() || 'unknown'
  let version = '0.0.0'
  let description = ''
  let repository: string | undefined
  let license: string | undefined
  let pythonCompatible: string | undefined

  if (existsSync(pyproject)) {
    const text = readFileSync(pyproject, 'utf-8')
    const n = text.match(/name\s*=\s*["']([^"']+)["']/)
    const v = text.match(/version\s*=\s*["']([^"']+)["']/)
    const d = text.match(/description\s*=\s*["']([^"']+)["']/)
    // Match both flat `repository = "..."` and `[project.urls]` table formats.
    const r =
      text.match(/(?:repository|homepage)\s*=\s*["']([^"']+)["']/) ||
      text.match(/\[project\.urls\][\s\S]*?(?:Repository|Homepage|Source)\s*=\s*["']([^"']+)["']/i)
    const l = text.match(/license\s*=\s*["']([^"']+)["']/)
    const py = text.match(/requires-python\s*=\s*["']([^"']+)["']/)
    if (n) name = n[1]
    if (v) version = v[1]
    if (d) description = d[1]
    if (r) repository = r[1]
    if (l) license = l[1]
    if (py) pythonCompatible = py[1]
  } else if (existsSync(pkgJson)) {
    try {
      const json = JSON.parse(readFileSync(pkgJson, 'utf-8'))
      name = json.name || name
      version = json.version || version
      description = json.description || ''
      repository = json.repository?.url || json.homepage
      license = json.license
    } catch {
      /* ignore */
    }
  }

  let nodeList: string[] = []
  const nodeListFile = join(dir, 'node_list.json')
  if (existsSync(nodeListFile)) {
    try {
      const json = JSON.parse(readFileSync(nodeListFile, 'utf-8'))
      if (Array.isArray(json)) nodeList = json.map(String)
      else if (json.nodes) nodeList = Object.keys(json.nodes)
    } catch {
      /* ignore */
    }
  } else {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.py')) continue
      try {
        const text = readFileSync(join(dir, f), 'utf-8')
        const block = text.match(/NODE_CLASS_MAPPINGS\s*[:=][\s\S]{0,2000}/)
        if (block) {
          const re = /["']([A-Za-z0-9_]{3,})["']\s*:/g
          let m: RegExpExecArray | null
          while ((m = re.exec(block[0]))) nodeList.push(m[1])
        }
      } catch {
        /* ignore */
      }
    }
    nodeList = [...new Set(nodeList)].slice(0, 200)
  }

  const result: PackMeta = {
    name,
    displayName: name,
    version,
    description,
    repository,
    license,
    pythonCompatible,
    nodeList
  }
  packMetaCache.set(dir, { sig, meta: result })
  return result
}

function collectIssues(dir: string, meta: Partial<NodePackRecord>): NodePackIssue[] {
  const issues: NodePackIssue[] = []
  const req = join(dir, 'requirements.txt')
  const pyproject = join(dir, 'pyproject.toml')
  const hasInit = existsSync(join(dir, '__init__.py'))

  if (!hasInit && !existsSync(pyproject)) {
    issues.push({
      severity: 'warning',
      code: 'NO_ENTRY',
      message: 'Missing __init__.py or pyproject.toml — package may not load.',
      suggestion: 'Confirm the pack is a valid custom node package.',
      fixable: false
    })
  }
  if (existsSync(req)) {
    const text = readFileSync(req, 'utf-8')
    if (/torch\s*==/i.test(text)) {
      issues.push({
        severity: 'warning',
        code: 'TORCH_PIN',
        message: 'requirements.txt pins torch — may conflict with instance CUDA build.',
        suggestion: 'Prefer torch>= without exact pin, or manage via dedicated venv.',
        fixable: true,
        fixId: 'unpin-torch'
      })
    }
    if (/opencv-python\s*==/i.test(text)) {
      issues.push({
        severity: 'info',
        code: 'CV_PIN',
        message: 'opencv-python is pinned; GUI builds sometimes conflict on headless hosts.',
        fixable: false
      })
    }
  }
  if (!meta.repository) {
    issues.push({
      severity: 'info',
      code: 'NO_REPO',
      message: 'No repository metadata found.',
      suggestion: 'Add repository field in pyproject.toml for update checks.',
      fixable: false
    })
  }
  return issues
}

export class NodePackService extends EventEmitter {
  /** Emit node install lifecycle for UI progress (IPC_EVENTS.nodeInstallProgress). */
  private emitInstallProgress(payload: {
    phase: 'start' | 'download' | 'unzip' | 'pip' | 'done' | 'error'
    packName: string
    message?: string
    /** What kind of operation this is — the UI labels install vs update differently. */
    op?: 'install' | 'update' | 'uninstall'
  }): void {
    this.emit('install-progress', { ...payload, op: payload.op || 'install', ts: Date.now() })
  }

  // ---- UpdateProgress-shaped stream (feeds the shared progress modal) ----
  /**
   * Per-instance progress streams. A single shared object made concurrent
   * installs/updates on different instances overwrite each other's steps.
   */
  private opProgressMap = new Map<string, UpdateProgress>()

  /**
   * Active install/update abort controllers, keyed by instance (or 'default').
   * cancelOp() aborts the in-flight clone/pip/download for that instance.
   */
  private opAborts = new Map<string, AbortController>()

  /** Arm an AbortController for a new install/update run. */
  private beginOpAbort(instanceId?: string): AbortSignal {
    const key = instanceId || 'default'
    // A new run supersedes any stale controller for the same instance.
    this.opAborts.get(key)?.abort()
    const ac = new AbortController()
    this.opAborts.set(key, ac)
    return ac.signal
  }

  private endOpAbort(instanceId?: string): void {
    this.opAborts.delete(instanceId || 'default')
  }

  /** Cancel the in-flight install/update for an instance. True when something was aborted. */
  cancelOp(instanceId?: string): boolean {
    const key = instanceId || 'default'
    const ac = this.opAborts.get(key)
    if (!ac) return false
    ac.abort()
    this.opAborts.delete(key)
    return true
  }

  /**
   * Emit an UpdateProgress-shaped snapshot so the renderer can reuse
   * ComfyUpdateProgressModal for node installs — the same step list + live
   * pip/uv log the ComfyUI update flow has.
   */
  private emitOpProgress(opts: {
    instanceId: string
    step: UpdateStepId
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'
    message: string
    logLine?: string
    detailKey?: string
  }): void {
    const key = opts.instanceId || 'default'
    let p = this.opProgressMap.get(key)
    if (!p) {
      p = {
        runId: randomUUID(),
        instanceId: key,
        step: 'download',
        status: 'running',
        steps: [
          { id: 'download', title: 'Download', status: 'pending', detail: '', log: [] },
          { id: 'clone', title: 'Git clone', status: 'pending', detail: '', log: [] },
          { id: 'unpack', title: 'Unpack', status: 'pending', detail: '', log: [] },
          { id: 'requirements', title: 'Dependencies', status: 'pending', detail: '', log: [] },
          { id: 'verify', title: 'Finalize', status: 'pending', detail: '', log: [] },
          { id: 'done', title: 'Done', status: 'pending', detail: '', log: [] }
        ] as UpdateStep[],
        message: opts.message,
        percent: 0
      }
      this.opProgressMap.set(key, p)
    }
    const s = p.steps.find((x) => x.id === opts.step)
    if (s) {
      s.status = opts.status
      if (opts.message) s.detail = opts.message
      if (opts.detailKey) s.detailKey = opts.detailKey
      if (opts.logLine) {
        s.log.push(opts.logLine)
        if (s.log.length > 400) s.log.splice(0, s.log.length - 400)
      }
    }
    p.step = opts.step
    p.message = opts.message
    p.status =
      opts.status === 'failed' || opts.status === 'cancelled'
        ? opts.status
        : opts.step === 'done' && opts.status === 'done'
          ? 'done'
          : 'running'
    // Surface the failure text on the progress object so the shared modal's
    // error block actually renders something.
    if (p.status === 'failed' || p.status === 'cancelled') p.error = opts.message
    // On terminal success every remaining pending step is closed out so the
    // bar actually reaches 100% instead of stalling on an untouched "verify".
    if (p.status === 'done') {
      for (const x of p.steps) {
        if (x.status === 'pending') x.status = 'skipped'
      }
      p.percent = 100
      p.error = undefined
    } else if (p.status === 'failed') {
      const doneCount = p.steps.filter((x) => x.status === 'done' || x.status === 'skipped').length
      p.percent = Math.round((doneCount / p.steps.length) * 100)
    } else {
      const doneCount = p.steps.filter((x) => x.status === 'done' || x.status === 'skipped').length
      p.percent = Math.round((doneCount / p.steps.length) * 100)
    }
    this.emit('op-progress', { ...p })
  }

  private opLog(line: string, instanceId?: string): void {
    const key = instanceId || 'default'
    const p = this.opProgressMap.get(key)
    if (!p) return
    const s = p.steps.find((x) => x.id === p.step)
    if (s) {
      s.log.push(line)
      if (s.log.length > 400) s.log.splice(0, s.log.length - 400)
    }
    this.emit('op-progress', { ...p })
  }

  getOpProgress(instanceId?: string): UpdateProgress | null {
    if (instanceId) return this.opProgressMap.get(instanceId) || null
    // Latest active stream (for status polling without an id).
    let latest: UpdateProgress | null = null
    for (const p of this.opProgressMap.values()) {
      if (!latest || p.runId > latest.runId) latest = p
    }
    return latest
  }

  list(instancePathOrId?: string): NodePackRecord[] {
    const root = detectCustomNodesRoot(instancePathOrId)
    if (!root || !existsSync(root)) return []
    const known = new Map(listNodePacks().map((p) => [p.name, p]))
    const packs: NodePackRecord[] = []
    for (const name of readdirSync(root)) {
      // Junk / cache dirs that live beside real packs — never list as node packs.
      if (
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
        continue
      const dir = join(root, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      // Registry zips nest a single top-level folder — descend so that
      // collectIssues/readPackMeta see __init__.py / pyproject.toml.
      const packed = resolveNestedPackDir(dir)
      const meta = readPackMeta(packed)
      const issues = collectIssues(packed, meta)
      const disabledMarker = join(dir, '.disabled')
      const disabled = existsSync(disabledMarker) || name.endsWith('.disabled')
      const id = createHash('sha1').update(dir).digest('hex').slice(0, 16)
      const prev = known.get(meta.name || name)
      const latest = prev?.latestVersion
      const effectiveVersion = prev?.pinnedVersion || meta.version || '0.0.0'
      const hasUpdate =
        !disabled &&
        Boolean(latest) &&
        Boolean(effectiveVersion) &&
        isUpdateAvailable(effectiveVersion, latest || '')
      packs.push({
        id,
        name: meta.name || name,
        displayName: meta.displayName || name,
        description: meta.description || '',
        author: prev?.author || '',
        // An explicit install-time pin wins over on-disk meta across list()
        // refreshes too — otherwise the requested version is lost immediately.
        version: prev?.pinnedVersion || meta.version || '0.0.0',
        latestVersion: latest,
        status: disabled
          ? 'disabled'
          : issues.some((i) => i.severity === 'error')
            ? 'error'
            : hasUpdate
              ? 'update-available'
              : 'installed',
        path: dir,
        repository: meta.repository,
        registryId: prev?.registryId,
        nodeCount: meta.nodeList?.length || 0,
        tags: prev?.tags || [],
        installSource: prev?.installSource || 'local',
        lastCheckedAt: Date.now(),
        issues,
        locked: prev?.locked || false,
        nodeList: meta.nodeList || [],
        license: meta.license,
        pythonCompatible: meta.pythonCompatible,
        notes: prev?.notes,
        pipRequirements: prev?.pipRequirements,
        pinnedVersion: prev?.pinnedVersion,
        gitRev: prev?.gitRev
      })
    }
    return packs
  }

  async refresh(instancePathOrId?: string): Promise<NodePackRecord[]> {
    const packs = this.list(instancePathOrId)
    const known = new Map(listNodePacks().map((p) => [p.id, p]))
    for (const p of packs) {
      const prev = known.get(p.id)
      if (prev?.locked) p.locked = true
      upsertNodePack(p)
    }
    return packs
  }

  /** Manager channel list (PLAN: Registry + Manager channel + 本地) */
  async managerChannelList(): Promise<RegistryNodePack[]> {
    const settings = loadSettings()
    // Multiple sources — ComfyUI-Manager's repo has been restructured several
    // times; try known locations. All GitHub raw URLs go through the mirror.
    const rawEndpoints = [
      'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/custom-node-list.json',
      'https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/manager-v4/custom-node-list.json',
      'https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/custom-node-list.json',
      // extension-node-map is the other commonly published list
      'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/extension-node-map.json'
    ]
    const endpoints = rawEndpoints.map((u) => applyGithubMirror(u))
    const out: RegistryNodePack[] = []
    const seen = new Set<string>()
    let lastError: string | undefined
    for (const url of endpoints) {
      try {
        // session.fetch honors the app proxy — bare fetch() times out behind it.
        const { session } = await import('electron')
        const res = await session.defaultSession.fetch(url, {
          signal: AbortSignal.timeout(15000),
          headers: { 'User-Agent': 'ComfyPilot/0.1' }
        })
        if (!res.ok) {
          lastError = `HTTP ${res.status} from ${url.slice(0, 60)}`
          continue
        }
        const raw = await res.json() as Array<Record<string, unknown>> | Record<string, unknown>
        // custom-node-list.json is an Array; extension-node-map.json is an
        // object mapping node-class names → [ {name, ...}, ... ].
        let data: Array<Record<string, unknown>>
        if (Array.isArray(raw)) {
          data = raw
        } else if (raw && typeof raw === 'object') {
          data = []
          for (const [nodeClass, entries] of Object.entries(raw)) {
            if (!Array.isArray(entries)) continue
            for (const e of entries) {
              if (e && typeof e === 'object') {
                data.push({ ...e, id: (e as Record<string, unknown>).id || nodeClass, nodeClass })
              }
            }
          }
        } else {
          continue
        }
        // No hard truncation — take every entry the channel publishes.
        for (const n of data) {
          const id = String(n.id || n.title || n.name)
          if (!id || seen.has(id)) continue
          seen.add(id)
          out.push({
            id,
            name: String(n.name || n.title || ''),
            displayName: String(n.title || n.name || ''),
            description: String(n.description || ''),
            author: String(n.author || ''),
            latestVersion: String(n.version || ''),
            repository: String(n.repository || ''),
            tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
            downloads: Number(n.downloads || 0),
            score: 0,
            status: 'active'
          })
        }
        if (out.length) break
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        if (settings.networkMode === 'offline') break
      }
    }
    if (!out.length && lastError) {
      // Do NOT throw — callers (installInner fallback) expect a graceful empty list.
      this.opLog?.(`Manager channel unavailable: ${lastError}`, undefined)
    }
    return out
  }

  async registrySearch(opts?: {
    query?: string
    limit?: number
    page?: number
  }): Promise<import('@shared/types').RegistryPageResult<RegistryNodePack>> {
    const settings = loadSettings()
    try {
      const { searchRegistry, toPageResult, mapRegistryPack } = await import('./registry')
      const result = await searchRegistry({
        query: opts?.query,
        limit: opts?.limit,
        page: opts?.page
      })
      return toPageResult(result, mapRegistryPack)
    } catch (err) {
      if (settings.networkMode === 'offline') {
        return { items: [], total: 0, page: 1, pageSize: opts?.limit || 50, totalPages: 0, scanned: 0, clientFiltered: Boolean(opts?.query) }
      }
      throw err
    }
  }

  /**
   * Gate remote installs against the user's security / network settings.
   * Throws an Error with a machine-readable `code` so the renderer can show a
   * localized, actionable prompt ("go to Settings → X and turn it on") instead
   * of a silent skip or a raw English stack line.
   */
  private assertInstallAllowed(source: 'registry' | 'git' | 'manager'): void {
    const settings = loadSettings()
    const blocked = (code: string, fallback: string): Error => {
      const e = new Error(fallback)
      ;(e as Error & { code?: string }).code = code
      return e
    }
    if (settings.networkMode === 'offline') {
      throw blocked('SETTING_OFFLINE', 'Offline mode forbids remote installs')
    }
    const level = settings.securityLevel
    // strong: forbid ALL remote node installs (git + registry + manager)
    if (level === 'strong') {
      throw blocked(
        'SETTING_SECURITY_STRONG',
        `security_level=strong forbids ${source} node installs`
      )
    }
    if (source === 'git') {
      // normal: git requires the explicit allowGitUrlInstall opt-in
      // normal-/weak: git is allowed without the extra gate
      if (level === 'normal' && !settings.allowGitUrlInstall) {
        throw blocked(
          'SETTING_GIT_INSTALL',
          'Git URL install is disabled (allow_git_url_install=false)'
        )
      }
    }
    // registry/manager allowed at normal / normal- / weak
  }

  async install(opts: {
    id: string
    version?: string
    source: 'registry' | 'git' | 'manager'
    url?: string
    branch?: string
    instanceId?: string
    /** Known repository URL from search results — fallback when /install API returns 401. */
    repository?: string
  }): Promise<NodePackRecord> {
    this.assertInstallAllowed(opts.source)
    this.emitInstallProgress({
      phase: 'start',
      packName: opts.id,
      op: 'install',
      message: `Installing ${opts.id}…`
    })
    // Fresh op-progress stream for the shared modal.
    this.opProgressMap.delete(opts.instanceId || 'default')
    // Pick the first step by source so the modal never shows "Download"
    // when the user actually asked for a git install.
    const firstStep: UpdateStepId = opts.source === 'git' || opts.source === 'manager' ? 'clone' : 'download'
    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: firstStep,
      status: 'running',
      message:
        firstStep === 'clone' ? `Cloning ${opts.id}…` : `Downloading ${opts.id}…`
    })
    const signal = this.beginOpAbort(opts.instanceId)
    try {
      const rec = await this.installInner({ ...opts, signal })
      // Must emit 'done' — the UI hangs on the spinner/banner until it arrives.
      this.emitInstallProgress({
        phase: 'done',
        packName: rec.name || opts.id,
        op: 'install',
        message: `Installed ${rec.name || opts.id}`
      })
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'done',
        status: 'done',
        message: `Installed ${rec.name || opts.id}`
      })
      return rec
    } catch (e) {
      // Only treat as cancelled when the error itself is an AbortError —
      // a timeout must not mask the real error.
      const cancelled = isAbortError(e)
      this.emitInstallProgress({
        phase: 'error',
        packName: opts.id,
        op: 'install',
        message: e instanceof Error ? e.message : String(e)
      })
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'done',
        status: cancelled ? 'cancelled' : 'failed',
        message: e instanceof Error ? e.message : String(e)
      })
      throw cancelled ? codedError('OP_CANCELLED', 'Install cancelled') : e
    } finally {
      this.endOpAbort(opts.instanceId)
    }
  }

  private async installInner(opts: {
    id: string
    version?: string
    source: 'registry' | 'git' | 'manager'
    url?: string
    branch?: string
    instanceId?: string
    /** Registry/manager catalog id — preserved as record.registryId even on the git transport. */
    registryId?: string
    /** Known repository URL from search results — fallback when /install API returns 401. */
    repository?: string
    signal?: AbortSignal
  }): Promise<NodePackRecord> {
    // PLAN: 安装前自动快照
    try {
      this.createSnapshot(`auto-pre-install-${sanitizeInstallName(opts.id)}`, opts.instanceId)
    } catch {
      /* snapshot is best-effort */
    }
    const root = detectCustomNodesRoot(opts.instanceId)
    if (!root) throw new Error('custom_nodes root not found — add a ComfyUI instance first')
    mkdirSync(root, { recursive: true })

    if (opts.source === 'git' || opts.source === 'manager') {
      let url = (opts.url || '').trim()
      if (!url && opts.source === 'manager') {
        // Fallback: look up the pack in the Manager channel list.
        try {
          const list = await this.managerChannelList()
          const hit = list.find((n) => n.id === opts.id || n.name === opts.id || n.displayName === opts.id)
          url = (hit?.repository || '').trim()
        } catch {
          /* managerChannelList is best-effort — fall through to error below */
        }
      }
      if (!url) {
        if (opts.source === 'manager') throw new Error('Manager pack has no repository URL')
        url = opts.id
      }
      const safeUrl = assertSafeGitUrl(applyGithubMirror(url))
      const destName = sanitizeInstallName(safeUrl.split('/').pop()?.replace(/\.git$/, '') || `pack-${Date.now()}`)
      const dest = join(root, normalizePathEverySegment(destName))
      // Hard guard: dest must be a real descendant of root — never root itself.
      if (!isStrictInside(dest, root)) {
        throw new Error(`Refusing to install into unsafe destination: ${dest}`)
      }
      const gitBin = resolveGitBinary()
      // Clone into a throwaway sibling, then rename — a failed clone can only
      // ever remove OUR temp dir, never a pre-existing user directory.
      const tmpDest = join(root, `._clone_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
      if (!isStrictInside(tmpDest, root)) throw new Error('Refusing unsafe temp clone path')
      // Version pin: clone the default branch shallow first, then check out the
      // requested tag/ref inside the temp dir so a failed checkout never touches
      // `dest`. Shallow clone hides most tags, so fetch the ref explicitly.
      const pinned = (opts.version || '').trim()
      const args = ['clone', '--depth', '1']
      const safeBranch = assertSafeBranch(opts.branch || '')
      if (safeBranch) args.push('--branch', safeBranch)
      args.push(safeUrl, tmpDest)
      try {
        await execFileAsync(gitBin, args, {
          timeout: 120000,
          maxBuffer: 20 * 1024 * 1024,
          env: proxyEnv(loadSettings().proxy)
        })
        if (pinned) {
          const safeRef = assertSafeBranch(pinned)
          // Shallow clone hides tags — fetch the tag ref explicitly first.
          await execFileAsync(
            gitBin,
            ['-C', tmpDest, 'fetch', '--depth', '1', 'origin', `refs/tags/${safeRef}:refs/tags/${safeRef}`],
            { timeout: 60000, env: proxyEnv(loadSettings().proxy) }
          ).catch(() => undefined)
          // tags/<v> first (exact release tag), then the bare ref (branch / sha).
          // Checkout failure is NON-FATAL — fall through to default branch.
          let checkedOut = false
          try {
            await execFileAsync(gitBin, ['-C', tmpDest, 'checkout', `tags/${safeRef}`], {
              timeout: 30000,
              env: proxyEnv(loadSettings().proxy)
            })
            checkedOut = true
          } catch {
            try {
              await execFileAsync(gitBin, ['-C', tmpDest, 'checkout', safeRef], {
                timeout: 30000,
                env: proxyEnv(loadSettings().proxy)
              })
              checkedOut = true
            } catch {
              this.opLog?.(`tag/ref "${pinned}" not found — using default branch`, opts.instanceId)
            }
          }
          if (!checkedOut) {
            this.opLog?.(`Continuing with default branch (wanted ${pinned})`, opts.instanceId)
          }
        }
        // Atomic-ish publish: only now do we touch `dest`.
        if (existsSync(dest)) {
          rmSync(tmpDest, { recursive: true, force: true })
          throw new Error(`Destination already exists: ${destName}`)
        }
        renameSync(tmpDest, dest)
        this.emitOpProgress({
          instanceId: opts.instanceId || 'default',
          step: 'clone',
          status: 'done',
          message: pinned ? `Cloned @ ${pinned}` : 'Cloned'
        })
        this.emitOpProgress({
          instanceId: opts.instanceId || 'default',
          step: 'download',
          status: 'skipped',
          message: 'Used git clone'
        })
        this.emitOpProgress({
          instanceId: opts.instanceId || 'default',
          step: 'unpack',
          status: 'skipped',
          message: 'Used git clone'
        })
      } catch (e) {
        // Clean ONLY the temp clone we created — never a pre-existing dest.
        try {
          if (existsSync(tmpDest) && isStrictInside(tmpDest, root)) {
            rmSync(tmpDest, { recursive: true, force: true })
          }
        } catch {
          /* cleanup is best-effort */
        }
        // error is reported by the install() wrapper
        throw e
      }
      return await this.afterInstall(
        resolveNestedPackDir(dest),
        opts.source,
        opts.registryId ?? opts.id,
        opts.instanceId,
        { pinnedVersion: pinned || undefined, signal: opts.signal }
      )
    }

    // ---- registry install: git clone preferred, zip fallback ----

    // Known repository from search results (passed by the renderer).
    let repoUrl = (opts.repository || '').trim()

    // session is needed by both the /install API call and the zip download.
    const { session } = await import('electron')

    // If we don't have a repo URL yet, try the /install API for it.
    let downloadUrl: string | undefined
    if (!repoUrl || !(await gitAvailable())) {
      const versionPart = opts.version ? `/${encodeURIComponent(opts.version)}` : ''
      const apiUrl = `${REGISTRY_API}/nodes/${encodeURIComponent(opts.id)}/install${versionPart}`
      try {
        const res = await session.defaultSession.fetch(apiUrl, {
          headers: { 'User-Agent': 'ComfyPilot/0.1' },
          signal: withAbort(30000, opts.signal)
        })
        if (res.ok) {
          const data = (await res.json()) as {
            url?: string; downloadUrl?: string; status?: string; repository?: string
          }
          if (data.status === 'banned') throw new Error('Node pack is banned on Registry')
          downloadUrl = data.url || data.downloadUrl
          if (!repoUrl) repoUrl = (data.repository || '').trim()
        } else if (res.status !== 401 && res.status !== 403) {
          throw new Error(`Registry install failed: HTTP ${res.status}`)
        }
      } catch (e) {
        if (!repoUrl && !downloadUrl) throw e
        // We have a repo URL — the API is only needed for zip download.
      }
    }

    // Resolve the full repo URL (handles archive / codeload / index lookup).
    const resolvedRepo = await resolveRepoUrl(repoUrl, downloadUrl || '', opts.id)
    const hasGit = await gitAvailable()

    // GIT CLONE PREFERRED — only fall back to zip when git is unavailable.
    if (resolvedRepo && hasGit) {
      try {
        // Mark the zip-only steps as skipped so the modal shows "Git clone"
        // instead of a phantom "Download / Unpack".
        this.emitOpProgress({
          instanceId: opts.instanceId || 'default',
          step: 'download',
          status: 'skipped',
          message: 'Using git clone'
        })
        this.emitOpProgress({
          instanceId: opts.instanceId || 'default',
          step: 'unpack',
          status: 'skipped',
          message: 'Using git clone'
        })
        this.emitOpProgress({
          instanceId: opts.instanceId || 'default',
          step: 'clone',
          status: 'running',
          message: `Cloning ${resolvedRepo}…`
        })
        // Call installInner directly — NOT install() — because install() would
        // re-check assertInstallAllowed('git') which is gated by
        // allowGitUrlInstall (default false). We already passed the registry
        // gate; the internal git clone is just a transport choice.
        const rec = await this.installInner({
          id: resolvedRepo,
          source: 'git',
          url: resolvedRepo,
          version: opts.version,
          registryId: opts.id,
          instanceId: opts.instanceId
        })
        this.emitOpProgress({
          instanceId: opts.instanceId || 'default',
          step: 'clone',
          status: 'done',
          message: 'Cloned'
        })
        this.emitOpProgress({
          instanceId: opts.instanceId || 'default',
          step: 'verify',
          status: 'done',
          message: 'Installed via git'
        })
        return rec
      } catch (e) {
        // Git clone failed — fall back to zip. This is NOT a terminal failure;
        // do NOT emit status:'failed' or the UI modal closes prematurely.
        const msg = e instanceof Error ? e.message : String(e)
        this.opLog?.(`git clone failed (${msg}) — falling back to zip`)
        this.emitOpProgress({
          instanceId: opts.instanceId || 'default',
          step: 'clone',
          status: 'skipped',
          message: `Git clone failed (${msg}) — using zip`
        })
      }
    } else if (!resolvedRepo) {
      this.opLog?.('Registry did not expose a repository URL — using zip download')
    } else {
      this.opLog?.('git is not available — using zip download')
    }

    // ---- zip download fallback (no git, or git clone failed) ----
    // When the /install API didn't give us a downloadUrl (401), construct a
    // GitHub archive URL from the known repository.
    if (!downloadUrl && resolvedRepo) {
      const ghMatch = resolvedRepo.match(/github\.com[/:]([^/]+)\/([^/.]+)/i)
      if (ghMatch) {
        downloadUrl = `https://github.com/${ghMatch[1]}/${ghMatch[2]}/archive/refs/heads/main.zip`
      }
    }
    if (!downloadUrl) {
      throw new Error(
        `Registry install failed: no download URL (HTTP 401) and no repository to build one from`
      )
    }
    const { isSafeExternalUrl } = await import('./security')
    if (!isSafeExternalUrl(downloadUrl)) {
      throw new Error('Blocked registry download URL scheme')
    }

    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: 'clone',
      status: 'skipped',
      message: 'Using zip download'
    })
    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: 'download',
      status: 'running',
      message: 'Downloading package…'
    })
    const zipRes = await session.defaultSession.fetch(downloadUrl, {
      signal: withAbort(30 * 60 * 1000, opts.signal)
    })
    if (!zipRes.ok) throw new Error(`Download failed: HTTP ${zipRes.status}`)
    const total = Number(zipRes.headers.get('content-length') || 0)
    const buf = Buffer.from(await zipRes.arrayBuffer())
    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: 'download',
      status: 'done',
      message: total ? `Downloaded ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB` : 'Download complete'
    })
    const tmpZip = join(root, `._install_${Date.now()}.zip`)
    writeFileSync(tmpZip, buf)
    const destName = sanitizeInstallName(opts.id)
    const dest = join(root, normalizePathEverySegment(destName))
    if (!isStrictInside(dest, root)) {
      try {
        unlinkSync(tmpZip)
      } catch {
        /* ignore */
      }
      throw new Error(`Refusing to install into unsafe destination: ${dest}`)
    }
    // Unzip into a throwaway sibling, then rename — a failed unzip can only
    // ever remove OUR temp dir, never a pre-existing user directory.
    const tmpDest = join(root, `._unzip_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    if (!isStrictInside(tmpDest, root)) {
      try {
        unlinkSync(tmpZip)
      } catch {
        /* ignore */
      }
      throw new Error('Refusing unsafe temp unzip path')
    }
    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: 'download',
      status: 'done',
      message: 'Download complete'
    })
    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: 'unpack',
      status: 'running',
      message: 'Unpacking…'
    })
    try {
      const { safeUnzip } = await import('./zipSafe')
      await safeUnzip(tmpZip, tmpDest)
      if (existsSync(dest)) {
        rmSync(tmpDest, { recursive: true, force: true })
        throw new Error(`Destination already exists: ${destName}`)
      }
      renameSync(tmpDest, dest)
      // GitHub archive zips nest a single folder (e.g. ComfyUI-KJNodes-main/).
      // Flatten it so the pack lives directly at dest/, not dest/nested/.
      flattenSingleNestedDir(dest)
      this.emitOpProgress({
        instanceId: opts.instanceId || 'default',
        step: 'unpack',
        status: 'done',
        message: 'Unpacked'
      })
    } catch (e) {
      try {
        unlinkSync(tmpZip)
      } catch {
        /* ignore */
      }
      // Clean ONLY the temp dir we created — never a pre-existing dest.
      try {
        if (existsSync(tmpDest) && isStrictInside(tmpDest, root)) {
          rmSync(tmpDest, { recursive: true, force: true })
        }
      } catch {
        /* ignore */
      }
      throw e
    }
    try {
      unlinkSync(tmpZip)
    } catch {
      /* ignore */
    }
    const packed = resolveNestedPackDir(dest)
    const rec = await this.afterInstall(packed, 'registry', opts.registryId ?? opts.id, opts.instanceId, {
      pinnedVersion: opts.version?.trim() || undefined,
      signal: opts.signal
    })
    this.emitOpProgress({
      instanceId: opts.instanceId || 'default',
      step: 'verify',
      status: 'done',
      message: 'Installed'
    })
    return rec
  }

  private async afterInstall(
    dir: string,
    source: 'registry' | 'git' | 'manager' | 'local' = 'local',
    registryId?: string,
    instanceId?: string,
    extra?: { pinnedVersion?: string; signal?: AbortSignal }
  ): Promise<NodePackRecord> {
    const meta = readPackMeta(dir)
    const issues = collectIssues(dir, meta)
    // Requirements recorded on the pack record so uninstall can list/offer
    // residual pip deps without re-reading the (soon deleted) directory.
    let pipRequirements: string[] = []
    // Pack deps (requirements.txt). ON by default — a node pack without its
    // deps is a broken install. Settings.allowPipInstall turns this off for
    // users who want ComfyUI-Manager "manual deps" semantics.
    const reqFile = join(dir, 'requirements.txt')
    if (existsSync(reqFile)) {
      try {
        pipRequirements = parseRequirementNames(readFileSync(reqFile, 'utf-8'))
      } catch {
        pipRequirements = []
      }
      const settings = loadSettings()
      if (!settings.allowPipInstall) {
        issues.push({
          code: 'pip-disabled',
          severity: 'warning',
          message: 'requirements.txt present but allow_pip_install is off — dependencies NOT installed',
          suggestion: 'Enable allow_pip_install in Settings, or run pip install -r requirements.txt manually.',
          fixable: false
        })
        this.emitInstallProgress({
          phase: 'pip',
          packName: meta.name || dir,
          op: 'install',
          message: 'Dependencies skipped (allow_pip_install is off)'
        })
        this.emitOpProgress({
          instanceId: instanceId || 'default',
          step: 'requirements',
          status: 'skipped',
          message: 'Dependencies skipped (allow_pip_install is off)'
        })
      } else {
        // Must AWAIT: fire-and-forget meant "install done" while pip was still running,
        // and the catch below never saw async failures (dead pip-failed path).
        try {
          const vpy = resolveInstancePython(instanceId)
          if (vpy) {
            this.emitInstallProgress({
              phase: 'pip',
              packName: meta.name || dir,
              op: 'install',
              message: 'Installing Python dependencies…'
            })
            this.emitOpProgress({
              instanceId: instanceId || 'default',
              step: 'requirements',
              status: 'running',
              message: 'Installing Python dependencies…'
            })
            // Stream pip/uv output into the progress modal line by line.
            const { runStreaming, installRequirements } = await import('./env')
            const { bootstrapService } = await import('./bootstrap')
            const bootstrap = await bootstrapService.ensure({ kinds: ['uv'], downloadIfMissing: false })
            const uvComp = bootstrap.components.find((c) => c.kind === 'uv' && c.installed)
            await installRequirements(vpy, reqFile, async (c, a, o) => {
              // fall back to a buffered run if streaming is not wired
              return execFileAsync(c, a, {
                timeout: o?.timeout ?? 10 * 60 * 1000,
                maxBuffer: 10 * 1024 * 1024,
                windowsHide: true,
                env: proxyEnv(loadSettings().proxy)
              }).then((r) => r.stdout)
            }, {
              uvPath: uvComp?.path,
              pipIndex: String(settings.pipIndex || '').trim(),
              onLine: (line) => {
                this.opLog(line, instanceId || 'default')
                this.emitInstallProgress({
                  phase: 'pip',
                  packName: meta.name || dir,
                  op: 'install',
                  message: line.slice(0, 120)
                })
              }
            })
            void runStreaming
            this.emitOpProgress({
              instanceId: instanceId || 'default',
              step: 'requirements',
              status: 'done',
              message: 'Dependencies installed'
            })
          }
        } catch (err) {
          // Pip failure is NON-FATAL — the node is installed, just missing deps.
          // Emit 'skipped' not 'failed' so the modal stays open until the
          // overall install reaches its terminal state.
          this.emitOpProgress({
            instanceId: instanceId || 'default',
            step: 'requirements',
            status: 'skipped',
            message: `Deps failed: ${err instanceof Error ? err.message : String(err)}`
          })
          issues.push({
            code: 'pip-failed',
            severity: 'error',
            message: `pip install of pack requirements failed: ${err instanceof Error ? err.message : String(err)}`,
            suggestion: 'Install requirements.txt manually in the instance environment.',
            fixable: false
          })
        }
      }
    } else {
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'requirements',
        status: 'skipped',
        message: 'No requirements.txt'
      })
    }
    // Preserve user metadata (lock / tags / author / notes) across update and
    // install-over. afterInstall rebuilds the record from disk metadata, which
    // would otherwise reset those fields on every git pull / registry reinstall.
    const prevList = listNodePacks()
    const dirBase = dir.split(/[\\/]/).pop() || ''
    const prev =
      (registryId && prevList.find((p) => p.registryId === registryId)) ||
      prevList.find((p) => p.name === (meta.name || dirBase)) ||
      prevList.find((p) => p.path && normalizePathEverySegment(p.path) === normalizePathEverySegment(dir)) ||
      prevList.find((p) => p.id === createHash('sha1').update(dir).digest('hex').slice(0, 16))
    const rec: NodePackRecord = {
      id: createHash('sha1').update(dir).digest('hex').slice(0, 16),
      name: meta.name || dir.split(/[\\/]/).pop() || 'unknown',
      displayName: meta.displayName || 'unknown',
      description: meta.description || '',
      author: prev?.author || '',
      // An explicitly requested version wins over on-disk meta — that is what
      // "install version X" means to the user (and what the acceptance checks).
      version: extra?.pinnedVersion || meta.version || '0.0.0',
      status: 'installed',
      path: dir,
      repository: meta.repository,
      registryId: registryId ?? prev?.registryId,
      nodeCount: meta.nodeList?.length || 0,
      tags: prev?.tags || [],
      installSource: source,
      lastCheckedAt: Date.now(),
      issues,
      locked: prev?.locked || false,
      nodeList: meta.nodeList || [],
      license: meta.license,
      pythonCompatible: meta.pythonCompatible,
      notes: prev?.notes,
      pipRequirements: pipRequirements.length ? pipRequirements : prev?.pipRequirements,
      pinnedVersion: extra?.pinnedVersion || undefined,
      gitRev: gitRevOf(dir) ?? prev?.gitRev
    }
    upsertNodePack(rec)
    return rec
  }

  /**
   * Residual pip requirement names recorded for a pack. Empty when the pack
   * ships no requirements.txt. Used by the uninstall dialog to offer an
   * optional pip cleanup.
   */
  pipDeps(idOrName: string, instanceId?: string): string[] {
    const packs = this.list(instanceId)
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack) return []
    if (pack.pipRequirements?.length) return [...pack.pipRequirements]
    // Fall back to reading requirements.txt for records saved before the
    // pipRequirements field existed.
    try {
      if (pack.path) {
        const reqFile = join(pack.path, 'requirements.txt')
        if (existsSync(reqFile)) return parseRequirementNames(readFileSync(reqFile, 'utf-8'))
      }
    } catch {
      /* ignore */
    }
    return []
  }

  /** Uninstall recorded pip requirements for a pack. Returns the removed names. */
  private async removePipDeps(names: string[], instanceId?: string): Promise<string[]> {
    const removed: string[] = []
    const vpy = resolveInstancePython(instanceId)
    if (!vpy || !names.length) return removed
    // Remove in modest batches so a giant requirements list cannot blow argv.
    const BATCH = 20
    for (let i = 0; i < names.length; i += BATCH) {
      const batch = names.slice(i, i + BATCH)
      try {
        await execFileAsync(vpy, ['-m', 'pip', 'uninstall', '-y', ...batch], {
          timeout: 5 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
          env: proxyEnv(loadSettings().proxy)
        })
        removed.push(...batch)
      } catch {
        // Some names may not be installed — keep going and report what worked.
        for (const n of batch) {
          try {
            await execFileAsync(vpy, ['-m', 'pip', 'uninstall', '-y', n], {
              timeout: 60000,
              maxBuffer: 2 * 1024 * 1024,
              windowsHide: true,
              env: proxyEnv(loadSettings().proxy)
            })
            removed.push(n)
          } catch {
            /* not installed / already gone */
          }
        }
      }
    }
    return removed
  }

  async uninstall(
    idOrName: string,
    instanceId?: string,
    opts?: { removePipDeps?: boolean }
  ): Promise<boolean> {
    const packs = this.list(instanceId)
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack?.path) return false
    if (pack.locked) throw new Error('Pack is locked — unlock before uninstall')
    this.emitInstallProgress({
      phase: 'start',
      packName: pack.name || idOrName,
      op: 'uninstall',
      message: `Uninstalling ${pack.name || idOrName}…`
    })
    this.opProgressMap.delete(instanceId || 'default')
    this.emitOpProgress({
      instanceId: instanceId || 'default',
      step: 'verify',
      status: 'running',
      message: `Uninstalling ${pack.name || idOrName}…`
    })
    try {
      // Snapshot before destructive ops so the user can at least see what was removed.
      try {
        this.createSnapshot(`auto-pre-uninstall-${sanitizeInstallName(pack.name)}`, instanceId)
      } catch {
        /* best-effort */
      }
      const targets = this.resolveRemovalTargets(pack.path, instanceId)
      for (const target of targets) {
        const trash = `${target}.trash-${Date.now()}`
        try {
          renameSync(target, trash)
          rmSync(trash, { recursive: true, force: true })
        } catch {
          try {
            rmSync(target, { recursive: true, force: true })
          } catch {
            /* keep going — report via remaining dirs */
          }
        }
      }
      // Optional pip cleanup — offered by the UI after listing the residual deps.
      if (opts?.removePipDeps) {
        const deps = pack.pipRequirements?.length ? pack.pipRequirements : []
        if (deps.length) {
          this.emitOpProgress({
            instanceId: instanceId || 'default',
            step: 'requirements',
            status: 'running',
            message: `Removing ${deps.length} pip package(s)…`
          })
          const removed = await this.removePipDeps(deps, instanceId)
          this.emitOpProgress({
            instanceId: instanceId || 'default',
            step: 'requirements',
            status: removed.length ? 'done' : 'skipped',
            message: removed.length
              ? `Removed pip packages: ${removed.join(', ')}`
              : 'No matching pip packages were installed'
          })
        }
      }
      deleteNodePack(pack.id)
      this.emitInstallProgress({
        phase: 'done',
        packName: pack.name || idOrName,
        op: 'uninstall',
        message: `Uninstalled ${pack.name || idOrName}`
      })
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'done',
        status: 'done',
        message: `Uninstalled ${pack.name || idOrName}`
      })
      return true
    } catch (e) {
      this.emitInstallProgress({
        phase: 'error',
        packName: pack.name || idOrName,
        op: 'uninstall',
        message: e instanceof Error ? e.message : String(e)
      })
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'done',
        status: 'failed',
        message: e instanceof Error ? e.message : String(e)
      })
      throw e
    }
  }

  /**
   * Directories to remove for a pack. When the pack lives in a registry-zip
   * nested layout (custom_nodes/<destShell>/<nested>/), the outer shell must go
   * too — otherwise list() picks up an empty NO_ENTRY ghost pack.
   *
   * Safety: the shell is only removed when it contains EXACTLY ONE entry (the
   * pack itself) — hidden files like `.git` count. A monorepo shell
   * (`Repo/.git` + `Repo/PackA`) is never collapsed.
   */
  private resolveRemovalTargets(packPath: string, instanceId?: string): string[] {
    const targets = [packPath]
    try {
      const parent = dirname(packPath)
      if (!parent || parent === packPath) return targets
      const customNodesRoot = detectCustomNodesRoot(instanceId)
      if (!customNodesRoot) return targets
      const parentNorm = normalizePathEverySegment(parent)
      const rootNorm = normalizePathEverySegment(customNodesRoot)
      if (parentNorm === rootNorm) return targets
      if (!isPathInside(packPath, parent)) return targets
      // parent must be exactly one level under custom_nodes
      const parentParent = dirname(parent)
      if (normalizePathEverySegment(parentParent) !== rootNorm) return targets
      // Count ALL entries, including hidden ones — a shell with .git or any
      // other residue is user/monorepo content, not our unzip artifact.
      const allSiblings = readdirSync(parent)
      const packBase = packPath.split(/[\\/]/).pop() || ''
      if (allSiblings.length === 1 && allSiblings[0] === packBase) {
        targets.push(parent)
      }
    } catch {
      /* ignore */
    }
    return [...new Set(targets)]
  }

  /**
   * Check every installed pack for an available update.
   * - registry packs: compare local version with Registry latest_version
   * - git packs (or packs with .git): git fetch + rev-list behind count
   * - manager packs with a repository and a .git dir behave as git
   */
  async checkUpdates(instancePathOrId?: string): Promise<NodeUpdateCheckResult[]> {
    const packs = this.list(instancePathOrId)
    const results: NodeUpdateCheckResult[] = []
    const registryLatest = new Map<string, string>()

    // Warm registry latest versions for packs that have a registryId or match by name.
    try {
      const page = await this.registrySearch({ limit: 100, page: 1 })
      for (const item of page.items) {
        if (item.id) registryLatest.set(item.id, item.latestVersion || '')
        if (item.name) registryLatest.set(item.name, item.latestVersion || '')
      }
      // Also peek at the local full-catalog index for names not on page 1.
      try {
        const { registryIndex } = await import('./registryIndex')
        await registryIndex.ensure()
        for (const p of packs) {
          if (registryLatest.has(p.registryId || '') || registryLatest.has(p.name)) continue
          const hits = registryIndex.searchPacks(p.name, 5)
          const exact = hits.find((h) => h.name === p.name || h.id === p.registryId)
          if (exact?.latestVersion) registryLatest.set(p.name, exact.latestVersion)
        }
      } catch {
        /* index optional */
      }
    } catch {
      /* offline / registry down — git checks can still run */
    }

    for (const pack of packs) {
      const gitLike =
        pack.installSource === 'git' ||
        pack.installSource === 'manager' ||
        Boolean(pack.path && existsSync(join(pack.path, '.git')))

      if (pack.locked) {
        results.push({
          name: pack.name,
          id: pack.id,
          currentVersion: pack.version,
          latestVersion: pack.latestVersion,
          updatable: false,
          updateSource: 'none',
          reason: 'Pack is locked',
          reasonKey: 'nodes.locked'
        })
        continue
      }

      if (gitLike && pack.path && existsSync(join(pack.path, '.git'))) {
        try {
          const gitBin = resolveGitBinary()
          await execFileAsync(gitBin, ['-C', pack.path, 'fetch', '--quiet'], {
            timeout: 30000,
            env: proxyEnv(loadSettings().proxy)
          })
          const { stdout: behindOut } = await execFileAsync(
            gitBin,
            ['-C', pack.path, 'rev-list', '--count', 'HEAD..@{u}'],
            { timeout: 10000, env: proxyEnv(loadSettings().proxy) }
          )
          const behind = Number(behindOut.trim()) || 0
          const { stdout: remoteVer } = await execFileAsync(
            gitBin,
            ['-C', pack.path, 'describe', '--tags', '--abbrev=0', '@{u}'],
            { timeout: 10000, env: proxyEnv(loadSettings().proxy) }
          ).catch(() => ({ stdout: '' }))
          const latest = remoteVer.trim() || pack.latestVersion
          results.push({
            name: pack.name,
            id: pack.id,
            currentVersion: pack.version,
            latestVersion: latest,
            updatable: behind > 0,
            updateSource: 'git',
            reason: behind > 0 ? `${behind} commit(s) behind` : 'Up to date',
            reasonKey: behind > 0 ? undefined : 'nodes.upToDate'
          })
          continue
        } catch {
          /* fall through to registry comparison */
        }
      }

      const remote =
        (pack.registryId && registryLatest.get(pack.registryId)) || registryLatest.get(pack.name) || pack.latestVersion
      if (!remote) {
        results.push({
          name: pack.name,
          id: pack.id,
          currentVersion: pack.version,
          updatable: false,
          updateSource: 'none',
          reason: 'No remote version information',
          reasonKey: 'nodes.notUpdatable'
        })
        continue
      }
      const canRegistry = pack.installSource === 'registry' && Boolean(pack.registryId)
      const updatable = canRegistry && isUpdateAvailable(pack.version, remote)
      results.push({
        name: pack.name,
        id: pack.id,
        currentVersion: pack.version,
        latestVersion: remote,
        updatable,
        updateSource: canRegistry ? 'registry' : gitLike ? 'git' : 'none',
        reason: updatable
          ? `Update available: ${remote}`
          : canRegistry
            ? 'Up to date'
            : 'Pack is not updatable via Registry or git',
        reasonKey: updatable ? 'nodes.hasUpdate' : canRegistry ? 'nodes.upToDate' : 'nodes.notUpdatable'
      })
      // Persist latestVersion so list() can flag update-available without another round-trip.
      try {
        const known = listNodePacks().find((p) => p.id === pack.id || p.name === pack.name)
        if (known && remote && known.latestVersion !== remote) {
          upsertNodePack({ ...known, latestVersion: remote, lastCheckedAt: Date.now() })
        }
      } catch {
        /* best-effort */
      }
    }
    return results
  }

  /** Sequentially update every updatable pack. Locked/non-updatable are skipped. */
  async updateAll(instancePathOrId?: string): Promise<NodeUpdateAllResult[]> {
    const checks = await this.checkUpdates(instancePathOrId)
    const out: NodeUpdateAllResult[] = []
    try {
      this.createSnapshot('auto-pre-update-all', instancePathOrId)
    } catch {
      /* best-effort */
    }
    for (const c of checks) {
      if (!c.updatable) {
        out.push({ name: c.name, ok: true, skipped: true })
        continue
      }
      this.emitInstallProgress({ phase: 'start', packName: c.name, op: 'update', message: `Updating ${c.name}…` })
      try {
        await this.update(c.name, undefined, instancePathOrId)
        this.emitInstallProgress({ phase: 'done', packName: c.name, op: 'update', message: `Updated ${c.name}` })
        out.push({ name: c.name, ok: true })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.emitInstallProgress({ phase: 'error', packName: c.name, op: 'update', message: msg })
        out.push({ name: c.name, ok: false, error: msg })
      }
    }
    return out
  }

  async update(idOrName: string, version?: string, instanceId?: string): Promise<NodePackRecord> {
    this.emitInstallProgress({ phase: 'start', packName: idOrName, op: 'update', message: `Updating ${idOrName}…` })
    // Fresh op-progress stream so the shared modal can finish (git-pull path
    // never emitted a terminal 'done' before).
    this.opProgressMap.delete(instanceId || 'default')
    this.emitOpProgress({
      instanceId: instanceId || 'default',
      step: 'clone',
      status: 'running',
      message: `Updating ${idOrName}…`
    })
    const signal = this.beginOpAbort(instanceId)
    try {
      const rec = await this.updateInner(idOrName, version, instanceId, signal)
      this.emitInstallProgress({
        phase: 'done',
        packName: rec.name || idOrName,
        op: 'update',
        message: `Updated ${rec.name || idOrName}`
      })
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'done',
        status: 'done',
        message: `Updated ${rec.name || idOrName}`
      })
      return rec
    } catch (e) {
      // Only treat as cancelled when the error itself is an AbortError.
      // `signal.aborted` alone is too broad — a timeout must NOT mask the
      // real error (e.g. HTTP 502) with "Update cancelled".
      const cancelled = isAbortError(e)
      this.emitInstallProgress({
        phase: 'error',
        packName: idOrName,
        op: 'update',
        message: e instanceof Error ? e.message : String(e)
      })
      this.emitOpProgress({
        instanceId: instanceId || 'default',
        step: 'done',
        status: cancelled ? 'cancelled' : 'failed',
        message: e instanceof Error ? e.message : String(e)
      })
      throw cancelled ? codedError('OP_CANCELLED', 'Update cancelled') : e
    } finally {
      this.endOpAbort(instanceId)
    }
  }

  private async updateInner(
    idOrName: string,
    version?: string,
    instanceId?: string,
    _signal?: AbortSignal
  ): Promise<NodePackRecord> {
    const packs = this.list(instanceId)
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack) throw new Error('Pack not found')
    if (pack.locked) throw new Error('Pack is locked')
    // Snapshot before update so enable/disable state can be aligned later.
    try {
      this.createSnapshot(`auto-pre-update-${sanitizeInstallName(pack.name)}`, instanceId)
    } catch {
      /* best-effort */
    }
    const isGitPack =
      pack.installSource === 'git' || Boolean(pack.path && existsSync(join(pack.path, '.git')))
    if (isGitPack && pack.path) {
      const gitBin = resolveGitBinary()
      // Capture the pre-update rev so a failed pull can be hard-reset back to
      // a consistent tree (partial fetch/index state must not survive).
      let oldRev = ''
      try {
        const { stdout } = await execFileAsync(gitBin, ['-C', pack.path, 'rev-parse', 'HEAD'], {
          timeout: 10000,
          env: proxyEnv(loadSettings().proxy)
        })
        oldRev = stdout.trim()
      } catch {
        /* no rev — skip the reset safety net */
      }
      try {
        await execFileAsync(gitBin, ['-C', pack.path, 'pull', '--ff-only'], {
          timeout: 60000,
          maxBuffer: 20 * 1024 * 1024,
          env: proxyEnv(loadSettings().proxy)
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (oldRev) {
          try {
            await execFileAsync(gitBin, ['-C', pack.path, 'reset', '--hard', oldRev], {
              timeout: 30000,
              env: proxyEnv(loadSettings().proxy)
            })
            this.opLog?.(`git pull failed — reset --hard ${oldRev.slice(0, 12)}`, instanceId)
          } catch {
            /* reset is best-effort; the original error still surfaces */
          }
        }
        if (isAbortError(e)) {
          throw codedError('OP_CANCELLED', 'Update cancelled')
        }
        throw new Error(`git pull failed for ${pack.name}: ${msg}`)
      }
      return await this.afterInstall(
        pack.path,
        pack.installSource === 'registry' ? 'git' : pack.installSource,
        pack.registryId,
        instanceId
      )
    }
    if (pack.installSource === 'registry' && pack.registryId && pack.path) {
      const trash = `${pack.path}.bak-${Date.now()}`
      const root = detectCustomNodesRoot(instanceId)
      // Remember pre-update root entries so a failed reinstall can sweep any
      // orphan destName the git-prefer path created under a different folder
      // name than the old pack.path (restore of .bak alone leaves it behind).
      const preEntries = (() => {
        try {
          return root && existsSync(root) ? new Set(readdirSync(root)) : new Set<string>()
        } catch {
          return new Set<string>()
        }
      })()
      renameSync(pack.path, trash)
      try {
        const next = await this.install({
          id: pack.registryId,
          version,
          source: 'registry',
          instanceId
        })
        // Clean backup only after successful reinstall
        try {
          rmSync(trash, { recursive: true, force: true })
        } catch {
          this.emitInstallProgress({
            phase: 'done',
            packName: pack.name,
            message: `Updated, but backup cleanup failed — kept ${trash}`
          })
        }
        // Drop the OLD record only when the id changed — afterInstall already
        // upserted (possibly under the same id) with locked/tags/author/notes
        // preserved. Deleting unconditionally would wipe the fresh record.
        if (pack.id !== next.id) deleteNodePack(pack.id)
        return next
      } catch (e) {
        // rollback — failures here MUST surface, never silently swallow.
        // First sweep orphan dirs the failed install published under a new
        // destName (git-prefer names from the repo URL, not the registry id).
        if (root && existsSync(root)) {
          try {
            for (const name of readdirSync(root)) {
              if (preEntries.has(name)) continue
              const cand = join(root, name)
              if (cand === pack.path || cand === trash) continue
              if (!isStrictInside(cand, root)) continue
              try {
                rmSync(cand, { recursive: true, force: true })
                this.opLog?.(`removed orphan install dir ${name}`, instanceId)
              } catch {
                /* best-effort */
              }
            }
          } catch {
            /* sweep is best-effort */
          }
        }
        let rolledBack = false
        try {
          if (existsSync(pack.path)) rmSync(pack.path, { recursive: true, force: true })
          renameSync(trash, pack.path)
          rolledBack = true
        } catch (rbErr) {
          const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr)
          this.emitInstallProgress({
            phase: 'error',
            packName: pack.name,
            message: `Update failed AND rollback failed (${rbMsg}) — backup kept at ${trash}`
          })
          throw new Error(
            `Update failed for ${pack.name}: ${e instanceof Error ? e.message : String(e)}; rollback also failed (${rbMsg}) — backup at ${trash}`
          )
        }
        this.emitInstallProgress({
          phase: 'error',
          packName: pack.name,
          message: rolledBack ? `Update failed — rolled back to previous version` : 'Update failed'
        })
        throw e
      }
    }
    throw new Error('Pack is not updatable via Registry or git')
  }

  toggle(idOrName: string, enabled: boolean, instanceId?: string): NodePackRecord | undefined {
    const packs = this.list(instanceId)
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack?.path) return undefined
    // Also handle `name.disabled` folder convention
    let dir = pack.path
    if (!enabled) {
      const disabledMarker = join(dir, '.disabled')
      writeFileSync(disabledMarker, String(Date.now()))
      pack.status = 'disabled'
    } else {
      const disabledMarker = join(dir, '.disabled')
      if (existsSync(disabledMarker)) unlinkSync(disabledMarker)
      // rename foo.disabled → foo if needed
      if (dir.endsWith('.disabled')) {
        const target = dir.slice(0, -'.disabled'.length)
        if (!existsSync(target)) {
          renameSync(dir, target)
          dir = target
          pack.path = target
        }
      }
      pack.status = 'installed'
    }
    upsertNodePack(pack)
    return pack
  }

  lock(idOrName: string, locked: boolean, instanceId?: string): NodePackRecord | undefined {
    const packs = this.list(instanceId)
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack) return undefined
    pack.locked = locked
    upsertNodePack(pack)
    return pack
  }

  checkIssues(idOrName: string, instanceId?: string): NodePackIssue[] {
    return this.list(instanceId).find((p) => p.id === idOrName || p.name === idOrName)?.issues || []
  }

  conflicts(instanceId?: string): NodeNameConflict[] {
    const map = new Map<string, string[]>()
    for (const pack of this.list(instanceId)) {
      for (const node of pack.nodeList || []) {
        const arr = map.get(node) || []
        arr.push(pack.name)
        map.set(node, arr)
      }
    }
    return [...map.entries()]
      .filter(([, packs]) => packs.length > 1)
      .map(([nodeName, packs]) => ({ nodeName, packs: [...new Set(packs)] }))
  }

  async smokeTest(idOrName: string, instanceId?: string): Promise<NodePackIssue[]> {
    const pack = this.list(instanceId).find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack?.path) return []
    const issues: NodePackIssue[] = []
    const python = resolveInstancePython(instanceId)
    // Import for real (exec_module) so syntax/import errors surface; path arrives via argv.
    const py = [
      'import importlib.util,sys,os,traceback',
      'p=sys.argv[1]',
      'f=os.path.join(p,"__init__.py")',
      'if not os.path.isfile(f):',
      '    sys.exit(3)',
      'try:',
      '    spec=importlib.util.spec_from_file_location("cp_pack",f)',
      '    if not spec or not spec.loader:',
      '        sys.exit(2)',
      '    m=importlib.util.module_from_spec(spec)',
      '    spec.loader.exec_module(m)',
      '    sys.exit(0)',
      'except Exception:',
      '    traceback.print_exc()',
      '    sys.exit(2)'
    ].join('\n')
    try {
      await execFileAsync(python, ['-c', py, pack.path], {
        timeout: 15000,
        cwd: pack.path,
        maxBuffer: 20 * 1024 * 1024
      })
    } catch (e) {
      const code = (e as { code?: number }).code
      const msg = e instanceof Error ? e.message : String(e)
      if (code === 3) {
        // Missing __init__.py is a low-severity packaging gap, not an import failure.
        issues.push({
          severity: 'warning',
          code: 'NO_INIT',
          message: 'No top-level __init__.py — skipped import smoke test.',
          suggestion: 'Add __init__.py if this pack should be importable as a package.',
          fixable: false
        })
      } else {
        issues.push({
          severity: 'error',
          code: 'IMPORT_FAIL',
          message: `Import smoke test failed: ${msg.slice(0, 220)}`,
          suggestion: 'Check requirements and Python version compatibility.',
          fixable: false
        })
      }
    }
    return issues
  }

  snapshots(instanceId?: string): NodeSnapshot[] {
    const all = listSnapshots()
    // Legacy snapshots carry no instanceId — keep them visible everywhere so
    // older auto-pre-* backups are never silently lost after an instance switch.
    if (!instanceId) return all
    return all.filter((s) => !s.instanceId || s.instanceId === instanceId)
  }

  /**
   * Prune `auto-pre-*` snapshots so the list cannot grow without bound.
   * Keeps the most recent 10 auto snapshots for the given instance (legacy
   * snapshots without an instanceId share the same bucket).
   */
  private pruneAutoSnapshots(instanceId?: string): void {
    const MAX_AUTO = 10
    try {
      const all = listSnapshots()
      const auto = all
        .filter(
          (s) =>
            s.name.startsWith('auto-pre-') &&
            // Legacy snapshots (no instanceId) share every bucket so they
            // cannot accumulate forever.
            (s.instanceId == null || s.instanceId === (instanceId || ''))
        )
        .sort((a, b) => b.createdAt - a.createdAt)
      for (const s of auto.slice(MAX_AUTO)) {
        this.deleteSnapshot(s.id, instanceId)
      }
    } catch {
      /* pruning is best-effort */
    }
  }

  createSnapshot(name?: string, instanceId?: string): NodeSnapshot {
    // Record version AND git rev per pack so a rollback can pin the exact
    // source state that existed when the snapshot was taken.
    const packs = this.list(instanceId).map((p) => ({
      name: p.name,
      version: p.version,
      path: p.path || '',
      source: p.status === 'disabled' ? `${p.installSource}@disabled` : p.installSource,
      gitRev: (p.path && gitRevOf(p.path)) || p.gitRev
    }))
    const snapshot: NodeSnapshot = {
      id: randomUUID(),
      name: name || `snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
      createdAt: Date.now(),
      packs,
      notes: '',
      instanceId
    }
    // Snapshot creation is best-effort on the persistence side — a DB or disk
    // failure must not lose the in-memory snapshot the caller is about to use.
    try {
      insertSnapshot(snapshot)
    } catch {
      /* ignore */
    }
    try {
      writeFileSync(join(snapshotDir(), `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2))
    } catch {
      /* ignore */
    }
    if (name?.startsWith('auto-pre-')) {
      this.pruneAutoSnapshots(instanceId)
    }
    return snapshot
  }

  /**
   * Align enable/disable state with a snapshot.
   * NOTE: this does NOT reinstall missing packs or roll back versions — it only
   * toggles `.disabled` markers to match the snapshot. UI must say so.
   */
  restoreSnapshot(id: string, instanceId?: string): boolean {
    const snap = getSnapshot(id)
    if (!snap) return false
    // Symmetric with deleteSnapshot: never restore an instance's snapshot
    // against a different instance.
    if (instanceId && snap.instanceId && snap.instanceId !== instanceId) return false
    const current = this.list(instanceId)
    const currentNames = new Set(current.map((p) => p.name))
    const snapNames = new Set(snap.packs.map((p) => p.name))
    // Snapshot records disabled state via source suffix "@disabled"
    const snapDisabled = new Set(
      snap.packs.filter((p) => p.source.endsWith('@disabled')).map((p) => p.name)
    )
    const snapEnabled = new Set(
      snap.packs.filter((p) => !p.source.endsWith('@disabled')).map((p) => p.name)
    )

    for (const p of current) {
      if (!snapNames.has(p.name)) {
        this.toggle(p.name, false, instanceId)
      } else if (snapDisabled.has(p.name)) {
        this.toggle(p.name, false, instanceId)
      } else if (snapEnabled.has(p.name)) {
        this.toggle(p.name, true, instanceId)
      }
    }
    for (const s of snap.packs) {
      if (!currentNames.has(s.name) && s.path && existsSync(s.path)) {
        try {
          const marker = join(s.path, '.disabled')
          if (snapDisabled.has(s.name) && !existsSync(marker)) writeFileSync(marker, String(Date.now()))
          if (snapEnabled.has(s.name) && existsSync(marker)) unlinkSync(marker)
        } catch {
          /* ignore */
        }
      }
    }
    return true
  }

  deleteSnapshot(id: string, instanceId?: string): boolean {
    const safe = sanitizeId(id)
    // Scope deletes to the instance when one is given — a snapshot taken on
    // another instance must not disappear because someone cleaned up here.
    if (instanceId) {
      const snap = getSnapshot(safe)
      if (snap?.instanceId && snap.instanceId !== instanceId) return false
    }
    try {
      const file = join(snapshotDir(), `${safe}.json`)
      if (existsSync(file) && isPathInside(file, snapshotDir())) unlinkSync(file)
    } catch {
      /* ignore */
    }
    return dbDeleteSnapshot(safe)
  }
}

export const nodePackService = new NodePackService()
