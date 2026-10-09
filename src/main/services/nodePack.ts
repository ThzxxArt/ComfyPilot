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
import { execFile } from 'child_process'
import { promisify } from 'util'
import { EventEmitter } from 'events'
import type {
  NodeNameConflict,
  NodePackIssue,
  NodePackRecord,
  NodeSnapshot,
  NodeUpdateAllResult,
  NodeUpdateCheckResult,
  RegistryNodePack
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

/**
 * Resolve a usable git binary: PATH first, then the portable MinGit that
 * bootstrap may have downloaded (zero-prereq machines have no git on PATH).
 * Mirrors installer.ts's ComfyUI-clone path so node git installs work offline-prereq.
 */
export function resolveGitBinary(): string {
  const portable = findInRuntimes('git')
  return portable || 'git'
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
  const settings = loadSettings()
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
    settings.defaultInstancePath && join(settings.defaultInstancePath, 'custom_nodes'),
    process.env.COMFYUI_PATH && join(process.env.COMFYUI_PATH, 'custom_nodes')
  ].filter(Boolean) as string[]
  return candidates.find((p) => existsSync(p)) || candidates[0] || ''
}

function readPackMeta(dir: string): Partial<NodePackRecord> & { nodeList?: string[] } {
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
    const r = text.match(/(?:repository|homepage)\s*=\s*["']([^"']+)["']/)
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

  return {
    name,
    displayName: name,
    version,
    description,
    repository,
    license,
    pythonCompatible,
    nodeList
  }
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
      const meta = readPackMeta(dir)
      const issues = collectIssues(dir, meta)
      const disabledMarker = join(dir, '.disabled')
      const disabled = existsSync(disabledMarker) || name.endsWith('.disabled')
      const id = createHash('sha1').update(dir).digest('hex').slice(0, 16)
      const prev = known.get(meta.name || name)
      const latest = prev?.latestVersion
      const hasUpdate =
        !disabled &&
        Boolean(latest) &&
        Boolean(meta.version) &&
        isUpdateAvailable(meta.version || '0.0.0', latest || '')
      packs.push({
        id,
        name: meta.name || name,
        displayName: meta.displayName || name,
        description: meta.description || '',
        author: prev?.author || '',
        version: meta.version || '0.0.0',
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
        pythonCompatible: meta.pythonCompatible
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
    const endpoints = [
      'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/custom-node-list.json',
      'https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/manager-v4/custom-node-list.json'
    ]
    const out: RegistryNodePack[] = []
    const seen = new Set<string>()
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'ComfyPilot/0.1' }
        })
        if (!res.ok) continue
        const data = (await res.json()) as Array<Record<string, unknown>>
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
      } catch {
        if (settings.networkMode === 'offline') break
      }
    }
    return out
  }

  async registrySearch(opts?: {
    query?: string
    limit?: number
    page?: number
    scanPages?: number
  }): Promise<import('@shared/types').RegistryPageResult<RegistryNodePack>> {
    const settings = loadSettings()
    try {
      const { searchRegistry, toPageResult, mapRegistryPack } = await import('./registry')
      const result = await searchRegistry({
        query: opts?.query,
        limit: opts?.limit,
        page: opts?.page,
        scanPages: opts?.scanPages
      })
      return toPageResult(result, mapRegistryPack)
    } catch (err) {
      if (settings.networkMode === 'offline') {
        return { items: [], total: 0, page: 1, pageSize: opts?.limit || 50, totalPages: 0, scanned: 0, clientFiltered: Boolean(opts?.query) }
      }
      throw err
    }
  }

  private assertInstallAllowed(source: 'registry' | 'git' | 'manager'): void {
    const settings = loadSettings()
    // Mirror Manager security semantics (PLAN)
    if (settings.networkMode === 'offline') {
      throw new Error('Offline mode forbids remote installs')
    }
    if (source === 'git') {
      if (!settings.allowGitUrlInstall) {
        throw new Error('Git URL install is disabled (allow_git_url_install=false)')
      }
      if (settings.securityLevel === 'strong') {
        throw new Error('security_level=strong forbids git installs')
      }
    }
    if (source === 'registry' || source === 'manager') {
      if (settings.securityLevel === 'strong') {
        throw new Error('security_level=strong forbids remote node installs')
      }
    }
  }

  async install(opts: {
    id: string
    version?: string
    source: 'registry' | 'git' | 'manager'
    url?: string
    branch?: string
    instanceId?: string
  }): Promise<NodePackRecord> {
    this.assertInstallAllowed(opts.source)
    this.emitInstallProgress({
      phase: 'start',
      packName: opts.id,
      op: 'install',
      message: `Installing ${opts.id}…`
    })
    try {
      const rec = await this.installInner(opts)
      // Must emit 'done' — the UI hangs on the spinner/banner until it arrives.
      this.emitInstallProgress({
        phase: 'done',
        packName: rec.name || opts.id,
        op: 'install',
        message: `Installed ${rec.name || opts.id}`
      })
      return rec
    } catch (e) {
      this.emitInstallProgress({
        phase: 'error',
        packName: opts.id,
        op: 'install',
        message: e instanceof Error ? e.message : String(e)
      })
      throw e
    }
  }

  private async installInner(opts: {
    id: string
    version?: string
    source: 'registry' | 'git' | 'manager'
    url?: string
    branch?: string
    instanceId?: string
  }): Promise<NodePackRecord> {
    // PLAN: 安装前自动快照
    try {
      this.createSnapshot(`auto-pre-install-${sanitizeInstallName(opts.id)}`)
    } catch {
      /* snapshot is best-effort */
    }
    const root = detectCustomNodesRoot(opts.instanceId)
    if (!root) throw new Error('custom_nodes root not found — add a ComfyUI instance first')
    mkdirSync(root, { recursive: true })

    if (opts.source === 'git' || opts.source === 'manager') {
      let url = (opts.url || '').trim()
      if (!url && opts.source === 'manager') {
        const list = await this.managerChannelList()
        const hit = list.find((n) => n.id === opts.id || n.name === opts.id || n.displayName === opts.id)
        url = (hit?.repository || '').trim()
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
        // Atomic-ish publish: only now do we touch `dest`.
        if (existsSync(dest)) {
          rmSync(tmpDest, { recursive: true, force: true })
          throw new Error(`Destination already exists: ${destName}`)
        }
        renameSync(tmpDest, dest)
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
      return await this.afterInstall(resolveNestedPackDir(dest), opts.source, opts.id, opts.instanceId)
    }

    const versionPart = opts.version ? `/${encodeURIComponent(opts.version)}` : ''
    const apiUrl = `${REGISTRY_API}/nodes/${encodeURIComponent(opts.id)}/install${versionPart}`
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'ComfyPilot/0.1' },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) throw new Error(`Registry install failed: HTTP ${res.status}`)
    const data = (await res.json()) as { url?: string; downloadUrl?: string; status?: string }
    const downloadUrl = data.url || data.downloadUrl
    if (data.status === 'banned') throw new Error('Node pack is banned on Registry')
    if (!downloadUrl) throw new Error('Registry did not return a download URL')
    const { isSafeExternalUrl } = await import('./security')
    if (!isSafeExternalUrl(downloadUrl)) {
      throw new Error('Blocked registry download URL scheme')
    }

    const zipRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(180000) })
    if (!zipRes.ok) throw new Error(`Download failed: HTTP ${zipRes.status}`)
    const buf = Buffer.from(await zipRes.arrayBuffer())
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
    try {
      const { safeUnzip } = await import('./zipSafe')
      await safeUnzip(tmpZip, tmpDest)
      if (existsSync(dest)) {
        rmSync(tmpDest, { recursive: true, force: true })
        throw new Error(`Destination already exists: ${destName}`)
      }
      renameSync(tmpDest, dest)
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
    return await this.afterInstall(resolveNestedPackDir(dest), 'registry', opts.id, opts.instanceId)
  }

  private async afterInstall(
    dir: string,
    source: 'registry' | 'git' | 'manager' | 'local' = 'local',
    registryId?: string,
    instanceId?: string
  ): Promise<NodePackRecord> {
    const meta = readPackMeta(dir)
    const issues = collectIssues(dir, meta)
    // Optional pip deps — only when Settings.allowPipInstall is on (Manager semantics)
    const reqFile = join(dir, 'requirements.txt')
    if (existsSync(reqFile)) {
      const settings = loadSettings()
      if (!settings.allowPipInstall) {
        issues.push({
          code: 'pip-disabled',
          severity: 'warning',
          message: 'requirements.txt present but allow_pip_install is off — install deps manually',
          suggestion: 'Enable allow_pip_install in Settings, or pip install -r requirements.txt in the instance venv.',
          fixable: false
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
              message: 'Installing Python dependencies…'
            })
            const pipArgs = ['-m', 'pip', 'install', '-r', reqFile]
            const pipIndex = String(settings.pipIndex || '').trim()
            if (pipIndex) {
              pipArgs.push('-i', pipIndex)
              try {
                pipArgs.push('--trusted-host', new URL(pipIndex).hostname)
              } catch {
                // Scheme-less mirror — still pass -i, skip trusted-host
              }
            }
            const { stdout, stderr } = await execFileAsync(vpy, pipArgs, {
              timeout: 10 * 60 * 1000,
              maxBuffer: 10 * 1024 * 1024,
              windowsHide: true,
              env: proxyEnv(loadSettings().proxy)
            })
            const pipOut = `${stdout || ''}\n${stderr || ''}`
            if (/ERROR:|error: failed/i.test(pipOut) && !/Successfully installed|Requirement already satisfied/i.test(pipOut)) {
              issues.push({
                code: 'pip-failed',
                severity: 'error',
                message: 'pip install of pack requirements reported errors',
                suggestion: 'Install requirements.txt manually in the instance environment.',
                fixable: false
              })
            }
          }
        } catch (err) {
          issues.push({
            code: 'pip-failed',
            severity: 'error',
            message: `pip install of pack requirements failed: ${err instanceof Error ? err.message : String(err)}`,
            suggestion: 'Install requirements.txt manually in the instance environment.',
            fixable: false
          })
        }
      }
    }
    const rec: NodePackRecord = {
      id: createHash('sha1').update(dir).digest('hex').slice(0, 16),
      name: meta.name || dir.split(/[\\/]/).pop() || 'unknown',
      displayName: meta.displayName || 'unknown',
      description: meta.description || '',
      author: '',
      version: meta.version || '0.0.0',
      status: 'installed',
      path: dir,
      repository: meta.repository,
      registryId,
      nodeCount: meta.nodeList?.length || 0,
      tags: [],
      installSource: source,
      lastCheckedAt: Date.now(),
      issues,
      locked: false,
      nodeList: meta.nodeList || [],
      license: meta.license,
      pythonCompatible: meta.pythonCompatible
    }
    upsertNodePack(rec)
    return rec
  }

  async uninstall(idOrName: string, instanceId?: string): Promise<boolean> {
    const packs = this.list(instanceId)
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack?.path) return false
    if (pack.locked) throw new Error('Pack is locked — unlock before uninstall')
    // Snapshot before destructive ops so the user can at least see what was removed.
    try {
      this.createSnapshot(`auto-pre-uninstall-${sanitizeInstallName(pack.name)}`)
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
    deleteNodePack(pack.id)
    return true
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
      const page = await this.registrySearch({ limit: 100, page: 1, scanPages: 1 })
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
      this.createSnapshot('auto-pre-update-all')
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
    try {
      const rec = await this.updateInner(idOrName, version, instanceId)
      this.emitInstallProgress({
        phase: 'done',
        packName: rec.name || idOrName,
        op: 'update',
        message: `Updated ${rec.name || idOrName}`
      })
      return rec
    } catch (e) {
      this.emitInstallProgress({
        phase: 'error',
        packName: idOrName,
        op: 'update',
        message: e instanceof Error ? e.message : String(e)
      })
      throw e
    }
  }

  private async updateInner(idOrName: string, version?: string, instanceId?: string): Promise<NodePackRecord> {
    const packs = this.list(instanceId)
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack) throw new Error('Pack not found')
    if (pack.locked) throw new Error('Pack is locked')
    // Snapshot before update so enable/disable state can be aligned later.
    try {
      this.createSnapshot(`auto-pre-update-${sanitizeInstallName(pack.name)}`)
    } catch {
      /* best-effort */
    }
    const isGitPack =
      pack.installSource === 'git' || Boolean(pack.path && existsSync(join(pack.path, '.git')))
    if (isGitPack && pack.path) {
      const gitBin = resolveGitBinary()
      try {
        await execFileAsync(gitBin, ['-C', pack.path, 'pull', '--ff-only'], {
          timeout: 60000,
          maxBuffer: 20 * 1024 * 1024,
          env: proxyEnv(loadSettings().proxy)
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
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
        deleteNodePack(pack.id)
        return next
      } catch (e) {
        // rollback — failures here MUST surface, never silently swallow.
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

  lock(idOrName: string, locked: boolean): NodePackRecord | undefined {
    const packs = this.list()
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

  snapshots(): NodeSnapshot[] {
    return listSnapshots()
  }

  createSnapshot(name?: string): NodeSnapshot {
    const packs = this.list().map((p) => ({
      name: p.name,
      version: p.version,
      path: p.path || '',
      source: p.status === 'disabled' ? `${p.installSource}@disabled` : p.installSource
    }))
    const snapshot: NodeSnapshot = {
      id: randomUUID(),
      name: name || `snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
      createdAt: Date.now(),
      packs,
      notes: ''
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
    return snapshot
  }

  /**
   * Align enable/disable state with a snapshot.
   * NOTE: this does NOT reinstall missing packs or roll back versions — it only
   * toggles `.disabled` markers to match the snapshot. UI must say so.
   */
  restoreSnapshot(id: string): boolean {
    const snap = getSnapshot(id)
    if (!snap) return false
    const current = this.list()
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
        this.toggle(p.name, false)
      } else if (snapDisabled.has(p.name)) {
        this.toggle(p.name, false)
      } else if (snapEnabled.has(p.name)) {
        this.toggle(p.name, true)
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

  deleteSnapshot(id: string): boolean {
    const safe = sanitizeId(id)
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
