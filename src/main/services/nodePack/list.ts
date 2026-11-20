import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type {
  NodeLoadReport,
  NodeNameConflict,
  NodePackIssue,
  NodePackRecord,
  RegistryNodePack,
  RegistryPageResult
} from '@shared/types'
import { parseNodeLoadReport } from '@shared/nodeLoadReport'
import { isUpdateAvailable } from '@shared/version'
import { listNodePacks, loadSettings, upsertNodePack, userDataDir } from '../db'
import { applyGithubMirror } from '../installer'
import { instanceService } from '../instance'
import { LruCache } from '../lru'
import type { NodePackHost } from './host'
import type { PackMeta } from './types'
import {
  detectCustomNodesRoot,
  hasGitRepo,
  isJunkPackName,
  readGitOriginUrl,
  resolveInstanceConfig,
  resolveNestedPackDir
} from './common'

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

/** dir + input signature → parsed meta. */
const packMetaCache = new LruCache<string, { sig: string; meta: PackMeta }>(2000)

export function readPackMeta(dir: string): PackMeta {
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

export function collectIssues(dir: string, meta: Partial<NodePackRecord>): NodePackIssue[] {
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

/**
 * 0.1.18 (WP4): `list()` re-read pack metadata straight off disk for every
 * caller (26 packs → 1.4 s), and it is called on refresh, check, update,
 * toggle and snapshot. Cache the computed records against a directory+mtime
 * signature; any add/remove/rename or pack edit invalidates it naturally.
 */
export function listSignature(
  this: NodePackHost,
  root: string,
  known: Map<string, NodePackRecord>
): string {
  const dirPart = (dir: string): string => {
    let out = ''
    for (const f of ['pyproject.toml', 'package.json', 'node_list.json']) {
      try {
        const st = statSync(join(dir, f))
        out += `${f}:${st.size}:${st.mtimeMs};`
      } catch {
        out += `${f}:-;`
      }
    }
    let git = 'none'
    try {
      const cfg = statSync(join(dir, '.git', 'config'))
      git = `${cfg.size}:${cfg.mtimeMs}`
    } catch {
      git = existsSync(join(dir, '.git')) ? 'dir' : 'none'
    }
    return `${out}git:${git}`
  }
  let dirs = ''
  try {
    // Plain readdir (no Dirent) keeps this compatible with the fs surfaces
    // nodePack already mocks in tests.
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      let mtime = 0
      try {
        mtime = statSync(dir).mtimeMs
      } catch {
        continue
      }
      dirs += `${name}:${mtime}:${dirPart(dir)};`
      if (name === '.disabled') {
        try {
          for (const child of readdirSync(dir)) {
            dirs += `  ${child}:${dirPart(join(dir, child))};`
          }
        } catch {
          /* locked holding dir */
        }
      }
    }
  } catch {
    return ''
  }
  let records = ''
  for (const p of known.values()) {
    records += `${p.name}:${p.latestVersion || ''}:${p.pinnedVersion || ''}:${p.installSource || ''}:${p.registryId || ''}:${p.locked ? 1 : 0}:${p.repository || ''};`
  }
  return `${root}##${dirs}##${records}`
}

export function list(this: NodePackHost, instancePathOrId?: string): NodePackRecord[] {
  const root = detectCustomNodesRoot(instancePathOrId)
  if (!root || !existsSync(root)) return []
  const known = new Map(listNodePacks().map((p) => [p.name, p]))
  const sig = this.listSignature(root, known)
  const cached = this.listCache.get(root)
  if (cached && cached.sig === sig) return cached.packs

  const packs: NodePackRecord[] = []

  const pushPack = (rawName: string, dir: string, disabled: boolean): void => {
    // `foo.disabled` rename convention: strip the suffix for display/lookup.
    const baseName = rawName.endsWith('.disabled') ? rawName.slice(0, -'.disabled'.length) : rawName
    // Registry zips nest a single top-level folder — descend so that
    // collectIssues/readPackMeta see __init__.py / pyproject.toml.
    const packed = resolveNestedPackDir(dir)
    const meta = readPackMeta(packed)
    const issues = collectIssues(packed, meta)
    const id = createHash('sha1').update(dir).digest('hex').slice(0, 16)
    const prev = known.get(meta.name || baseName)
    // 0.2.5 WP9: a persistent install-time pip failure must survive list()
    // refreshes, instead of the pack looking healthy until the next boot.
    for (const issue of prev?.issues || []) {
      if (issue.code === 'pip-failed') issues.push(issue)
    }
    const latest = prev?.latestVersion
    const effectiveVersion = prev?.pinnedVersion || meta.version || '0.0.0'
    const hasUpdate =
      !disabled &&
      Boolean(latest) &&
      Boolean(effectiveVersion) &&
      isUpdateAvailable(effectiveVersion, latest || '')
    // A manually copied checkout (git clone dropped into custom_nodes) has no
    // install record yet — infer the real source from `.git` instead of
    // mislabeling it "local" and hiding its update capability. Explicit DB
    // records win (locked/author/installSource inheritance contract), except
    // that a stale "local" label is corrected to "git" when .git is present.
    const hasGit = hasGitRepo(packed) || (packed !== dir && hasGitRepo(dir))
    const inferredSource: 'git' | 'local' = hasGit ? 'git' : 'local'
    let installSource: NodePackRecord['installSource'] = prev?.installSource || inferredSource
    if (installSource === 'local' && inferredSource === 'git') installSource = 'git'
    const repository =
      meta.repository ||
      prev?.repository ||
      (hasGit
        ? readGitOriginUrl(packed) || (packed !== dir ? readGitOriginUrl(dir) : undefined)
        : undefined)
    packs.push({
      id,
      name: meta.name || baseName,
      displayName: meta.displayName || baseName,
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
      // 0.2.0: `path` is the real pack root (inner dir for registry zips).
      // Requirements/audit/uninstall all use it; no shellPath compatibility.
      path: packed,
      repository,
      registryId: prev?.registryId,
      nodeCount: meta.nodeList?.length || 0,
      tags: prev?.tags || [],
      installSource,
      // Never fake "just checked" — only checkUpdates() may advance this.
      lastCheckedAt: prev?.lastCheckedAt ?? 0,
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

  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    // Manager-compatible disabled holding area: its children ARE listed (as disabled).
    if (name === '.disabled') {
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      let children: string[] = []
      try {
        children = readdirSync(dir)
      } catch {
        // Locked/denied holding dir — degrade gracefully instead of failing list().
        continue
      }
      for (const child of children) {
        if (isJunkPackName(child)) continue
        const childDir = join(dir, child)
        try {
          if (!statSync(childDir).isDirectory()) continue
        } catch {
          continue
        }
        pushPack(child, childDir, true)
      }
      continue
    }
    // Junk / cache dirs that live beside real packs — never list as node packs.
    if (isJunkPackName(name)) continue
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    // Legacy marker file (pack-dir/.disabled) is recognized but no longer written;
    // the real mechanisms are `.disabled/<name>` (Manager) and `<name>.disabled`.
    const legacyMarker = existsSync(join(dir, '.disabled'))
    pushPack(name, dir, legacyMarker || name.endsWith('.disabled'))
  }
  this.listCache.set(root, { sig, packs })
  return packs
}

export async function refresh(
  this: NodePackHost,
  instancePathOrId?: string
): Promise<NodePackRecord[]> {
  const packs = this.list(instancePathOrId)
  const known = new Map(listNodePacks().map((p) => [p.id, p]))
  for (const p of packs) {
    const prev = known.get(p.id)
    if (prev?.locked) p.locked = true
    upsertNodePack(p)
  }
  return packs
}

interface ManagerChannelCache {
  updatedAt: number
  etag?: string
  etagUrl?: string
  items: RegistryNodePack[]
}

function managerChannelCachePath(): string {
  return join(userDataDir(), 'app-cache', 'manager-channel.json')
}

function readManagerChannelCache(): ManagerChannelCache | null {
  try {
    const raw = JSON.parse(readFileSync(managerChannelCachePath(), 'utf-8')) as ManagerChannelCache
    return Array.isArray(raw.items) ? raw : null
  } catch {
    return null
  }
}

/** Parse both real Manager schemas: `{custom_nodes:[...]}` and extension-node-map. */
export function parseManagerChannelPayload(raw: unknown): RegistryNodePack[] {
  const rows: Array<Record<string, unknown>> = []
  if (Array.isArray(raw)) {
    rows.push(...(raw as Array<Record<string, unknown>>))
  } else if (raw && typeof raw === 'object') {
    const custom = (raw as { custom_nodes?: unknown }).custom_nodes
    if (Array.isArray(custom)) {
      rows.push(...(custom as Array<Record<string, unknown>>))
    } else {
      // extension-node-map: { nodeClass: [ {name, ...}, ... ] }
      for (const [nodeClass, entries] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue
        for (const e of entries) {
          if (e && typeof e === 'object') {
            rows.push({ ...(e as Record<string, unknown>), id: nodeClass })
          }
        }
      }
    }
  }
  const out: RegistryNodePack[] = []
  const seen = new Set<string>()
  for (const n of rows) {
    if (!n || typeof n !== 'object') continue
    const files = Array.isArray(n.files) ? (n.files as unknown[]).map(String).filter(Boolean) : []
    const reference = String(n.reference || '')
    const id = String(n.id || n.title || n.name || reference || files[0] || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const repository =
      /^(https?:\/\/|git@|ssh:\/\/)/i.test(reference) || /\.git$/i.test(reference)
        ? reference
        : /^(https?:\/\/|git@|ssh:\/\/)/i.test(files[0] || '')
          ? files[0]
          : String(n.repository || '')
    const tags = Array.isArray(n.tags) ? n.tags.map(String) : []
    const installType = String(n.install_type || '')
    if (installType) tags.push(installType)
    out.push({
      id,
      name: String(n.name || n.title || id),
      displayName: String(n.title || n.name || id),
      description: String(n.description || ''),
      author: String(n.author || ''),
      latestVersion: String(n.version || ''),
      repository,
      tags,
      downloads: Number(n.downloads || 0),
      score: 0,
      icon: typeof n.icon === 'string' ? n.icon : undefined,
      files,
      installType: installType || undefined,
      status:
        n.banned === true
          ? 'banned'
          : n.flagged === true
            ? 'flagged'
            : n.status === 'banned' || n.status === 'flagged'
              ? (n.status as 'banned' | 'flagged')
              : 'active'
    })
  }
  return out
}

/** Manager channel list — v4 first, no early break, cached/ETag/offline. */
export async function managerChannelList(this: NodePackHost): Promise<RegistryNodePack[]> {
  const settings = loadSettings()
  const cache = readManagerChannelCache()
  if (settings.networkMode === 'offline') return cache?.items ?? []

  // 0.2.5 WP4: v4 first, then main, then the legacy ltdrdata repo. A
  // non-empty legacy list used to shadow v4 forever because of `break`.
  const rawEndpoints = [
    'https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/manager-v4/custom-node-list.json',
    'https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/custom-node-list.json',
    'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/custom-node-list.json',
    'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/extension-node-map.json'
  ]
  const endpoints = rawEndpoints.map((u) => applyGithubMirror(u))
  const out: RegistryNodePack[] = []
  const seen = new Set<string>()
  let lastError: string | undefined
  let nextEtag: string | undefined
  for (const [index, url] of endpoints.entries()) {
    try {
      const { session } = await import('electron')
      const headers: Record<string, string> = { 'User-Agent': 'ComfyPilot/0.2' }
      if (index === 0 && cache?.etag && cache.etagUrl === url) {
        headers['If-None-Match'] = cache.etag
      }
      const res = await session.defaultSession.fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers
      })
      if (res.status === 304 && cache?.items.length) {
        for (const item of cache.items) {
          if (seen.has(item.id)) continue
          seen.add(item.id)
          out.push(item)
        }
        continue
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status} from ${url.slice(0, 60)}`
        continue
      }
      if (index === 0) nextEtag = res.headers.get('etag') || undefined
      const parsed = parseManagerChannelPayload(await res.json())
      for (const item of parsed) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        out.push(item)
      }
      // No `break`: merge every source, v4 entries already won the id.
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  if (out.length) {
    try {
      mkdirSync(join(userDataDir(), 'app-cache'), { recursive: true })
      writeFileSync(
        managerChannelCachePath(),
        JSON.stringify(
          {
            updatedAt: Date.now(),
            etag: nextEtag,
            etagUrl: nextEtag ? endpoints[0] : undefined,
            items: out
          },
          null,
          2
        ),
        'utf-8'
      )
    } catch {
      /* cache is best-effort */
    }
    return out
  }
  if (cache?.items.length) {
    this.opLog?.('Manager channel offline — using cached list', undefined)
    return cache.items
  }
  if (lastError) {
    // Do NOT throw — callers (installInner fallback) expect a graceful empty list.
    this.opLog?.(`Manager channel unavailable: ${lastError}`, undefined)
  }
  return out
}

export async function registrySearch(
  this: NodePackHost,
  opts?: {
    query?: string
    limit?: number
    page?: number
  }
): Promise<RegistryPageResult<RegistryNodePack>> {
  const settings = loadSettings()
  try {
    const { searchRegistry, toPageResult, mapRegistryPack } = await import('../registry')
    const result = await searchRegistry({
      query: opts?.query,
      limit: opts?.limit,
      page: opts?.page
    })
    return toPageResult(result, mapRegistryPack)
  } catch (err) {
    if (settings.networkMode === 'offline') {
      return {
        items: [],
        total: 0,
        page: 1,
        pageSize: opts?.limit || 50,
        totalPages: 0,
        scanned: 0,
        clientFiltered: Boolean(opts?.query)
      }
    }
    throw err
  }
}

export function conflicts(this: NodePackHost, instanceId?: string): NodeNameConflict[] {
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

export function checkIssues(
  this: NodePackHost,
  idOrName: string,
  instanceId?: string
): NodePackIssue[] {
  return this.list(instanceId).find((p) => p.id === idOrName || p.name === idOrName)?.issues || []
}

/**
 * Boot-log load report (0.1.10): what ComfyUI actually loaded on its last
 * start, including IMPORT FAILED packs that look fine on disk.
 * NOTE: reads the log TAIL (last 5000 lines) — on very long-running sessions
 * the boot block can roll out; the parser then returns null and the UI shows
 * its neutral "no boot log yet" hint (never a guess).
 */
export function loadReport(this: NodePackHost, instanceId?: string): NodeLoadReport | null {
  const cfg = resolveInstanceConfig(instanceId)
  if (!cfg) return null
  try {
    const all = instanceService.getLogs(cfg.id, 5000)
    // 0.2.0: parse only the last boot; otherwise an old refusal/failure is
    // shown forever even after the pack was fixed/removed.
    let bootAt = -1
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].message.includes('=== ComfyPilot boot ')) {
        bootAt = i
        break
      }
    }
    if (bootAt < 0) return null
    const logs: typeof all = []
    let inSelfCheck = false
    for (const line of all.slice(bootAt + 1)) {
      if (line.message.includes('=== ComfyPilot selfcheck start ===')) {
        inSelfCheck = true
        continue
      }
      if (line.message.includes('=== ComfyPilot selfcheck end ===')) {
        inSelfCheck = false
        continue
      }
      if (!inSelfCheck) logs.push(line)
    }
    return parseNodeLoadReport(logs)
  } catch {
    return null
  }
}

export const listMethods = {
  listSignature,
  list,
  refresh,
  managerChannelList,
  registrySearch,
  conflicts,
  checkIssues,
  loadReport
}
