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
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type {
  NodeNameConflict,
  NodePackIssue,
  NodePackRecord,
  NodeSnapshot,
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

const execFileAsync = promisify(execFile)

function sanitizeInstallName(name: string): string {
  return String(name)
    .replace(/[^\w.-]/g, '_')
    .replace(/\.\./g, '_')
    .slice(0, 80)
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

function detectCustomNodesRoot(instancePath?: string): string {
  const settings = loadSettings()
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

export class NodePackService {
  list(instancePath?: string): NodePackRecord[] {
    const root = detectCustomNodesRoot(instancePath)
    if (!root || !existsSync(root)) return []
    const known = new Map(listNodePacks().map((p) => [p.name, p]))
    const packs: NodePackRecord[] = []
    for (const name of readdirSync(root)) {
      if (
        name.startsWith('.') ||
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
      packs.push({
        id,
        name: meta.name || name,
        displayName: meta.displayName || name,
        description: meta.description || '',
        author: prev?.author || '',
        version: meta.version || '0.0.0',
        latestVersion: prev?.latestVersion,
        status: disabled
          ? 'disabled'
          : issues.some((i) => i.severity === 'error')
            ? 'error'
            : 'installed',
        path: dir,
        repository: meta.repository,
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

  async refresh(): Promise<NodePackRecord[]> {
    const packs = this.list()
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
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'ComfyPilot/0.1' }
        })
        if (!res.ok) continue
        const data = (await res.json()) as Array<Record<string, unknown>>
        for (const n of data.slice(0, 200)) {
          out.push({
            id: String(n.id || n.title || n.name),
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

  async registrySearch(opts?: { query?: string; limit?: number }): Promise<RegistryNodePack[]> {
    const settings = loadSettings()
    const q = encodeURIComponent(opts?.query || '')
    const url = `${REGISTRY_API}/nodes?limit=${opts?.limit || 30}&offset=0${q ? `&search=${q}` : ''}`
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'ComfyPilot/0.1' },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) throw new Error(`Registry HTTP ${res.status}`)
      const data = (await res.json()) as {
        nodes?: Array<Record<string, unknown>>
        items?: Array<Record<string, unknown>>
      }
      const items = data.nodes || data.items || []
      return items.map((n) => ({
        id: String(n.id || n.name),
        name: String(n.name || ''),
        displayName: String(n.displayName || n.title || n.name),
        description: String(n.description || ''),
        author: String((n.publisher as { name?: string } | undefined)?.name || n.author || ''),
        latestVersion: String(n.latest_version || n.version || ''),
        repository: String(n.repository || n.html_url || ''),
        tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
        downloads: Number(n.downloads || n.downloadsTotal || 0),
        score: Number(n.score || 0),
        icon: n.icon ? String(n.icon) : undefined,
        status: (n.status as RegistryNodePack['status']) || 'active'
      }))
    } catch (err) {
      if (settings.networkMode === 'offline') return []
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
  }): Promise<NodePackRecord> {
    this.assertInstallAllowed(opts.source)
    // PLAN: 安装前自动快照
    try {
      this.createSnapshot(`auto-pre-install-${sanitizeInstallName(opts.id)}`)
    } catch {
      /* snapshot is best-effort */
    }
    const root = detectCustomNodesRoot()
    if (!root) throw new Error('custom_nodes root not found — add a ComfyUI instance first')
    mkdirSync(root, { recursive: true })

    if (opts.source === 'git') {
      const url = opts.url || opts.id
      if (!/^https?:\/\//i.test(url) && !/^git@/i.test(url)) {
        throw new Error('Unsupported git URL')
      }
      const destName = sanitizeInstallName(url.split('/').pop()?.replace(/\.git$/, '') || `pack-${Date.now()}`)
      const dest = join(root, destName)
      await execFileAsync('git', ['clone', '--depth', '1', url, dest], {
        timeout: 120000,
        env: proxyEnv(loadSettings().proxy)
      })
      return this.afterInstall(resolveNestedPackDir(dest))
    }

    const versionPart = opts.version ? `/${opts.version}` : ''
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

    const zipRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(180000) })
    if (!zipRes.ok) throw new Error(`Download failed: HTTP ${zipRes.status}`)
    const buf = Buffer.from(await zipRes.arrayBuffer())
    const tmpZip = join(root, `._install_${Date.now()}.zip`)
    writeFileSync(tmpZip, buf)
    const dest = join(root, sanitizeInstallName(opts.id))
    try {
      const { safeUnzip } = await import('./zipSafe')
      await safeUnzip(tmpZip, dest)
    } catch (e) {
      try {
        unlinkSync(tmpZip)
      } catch {
        /* ignore */
      }
      if (existsSync(dest)) {
        try {
          rmSync(dest, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
      throw e
    }
    try {
      unlinkSync(tmpZip)
    } catch {
      /* ignore */
    }
    return this.afterInstall(resolveNestedPackDir(dest))
  }

  private afterInstall(dir: string): NodePackRecord {
    const meta = readPackMeta(dir)
    const issues = collectIssues(dir, meta)
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
      nodeCount: meta.nodeList?.length || 0,
      tags: [],
      installSource: 'registry',
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

  async uninstall(idOrName: string): Promise<boolean> {
    const packs = this.list()
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack?.path) return false
    if (pack.locked) throw new Error('Pack is locked — unlock before uninstall')
    const trash = `${pack.path}.trash-${Date.now()}`
    try {
      renameSync(pack.path, trash)
      rmSync(trash, { recursive: true, force: true })
    } catch {
      rmSync(pack.path, { recursive: true, force: true })
    }
    deleteNodePack(pack.id)
    return true
  }

  async update(idOrName: string, version?: string): Promise<NodePackRecord> {
    const packs = this.list()
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack) throw new Error('Pack not found')
    if (pack.locked) throw new Error('Pack is locked')
    if (pack.registryId || pack.installSource === 'registry') {
      if (pack.path) {
        const trash = `${pack.path}.bak-${Date.now()}`
        renameSync(pack.path, trash)
        try {
          const next = await this.install({
            id: pack.registryId || pack.name,
            version,
            source: 'registry'
          })
          // Clean backup only after successful reinstall
          try {
            rmSync(trash, { recursive: true, force: true })
          } catch {
            /* keep bak if cleanup fails */
          }
          deleteNodePack(pack.id)
          return next
        } catch (e) {
          // rollback
          try {
            if (existsSync(pack.path)) rmSync(pack.path, { recursive: true, force: true })
            renameSync(trash, pack.path)
          } catch {
            /* ignore */
          }
          throw e
        }
      }
    }
    if (pack.path && existsSync(join(pack.path, '.git'))) {
      await execFileAsync('git', ['-C', pack.path, 'pull', '--ff-only'], { timeout: 60000 })
      return this.afterInstall(pack.path)
    }
    throw new Error('Pack is not updatable via Registry or git')
  }

  toggle(idOrName: string, enabled: boolean): NodePackRecord | undefined {
    const packs = this.list()
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

  checkIssues(idOrName: string): NodePackIssue[] {
    return this.list().find((p) => p.id === idOrName || p.name === idOrName)?.issues || []
  }

  conflicts(): NodeNameConflict[] {
    const map = new Map<string, string[]>()
    for (const pack of this.list()) {
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

  async smokeTest(idOrName: string): Promise<NodePackIssue[]> {
    const pack = this.list().find((p) => p.id === idOrName || p.name === idOrName)
    if (!pack?.path) return []
    const issues: NodePackIssue[] = []
    const settings = loadSettings()
    const configs = loadInstanceConfigs()
    const inst = configs[0]
    let python = settings.defaultInstancePath ? 'python' : 'python'
    if (inst?.venvPath) {
      const win = join(inst.venvPath, 'Scripts', 'python.exe')
      const unix = join(inst.venvPath, 'bin', 'python')
      if (existsSync(win)) python = win
      else if (existsSync(unix)) python = unix
    } else if (inst?.pythonPath) {
      python = inst.pythonPath
    }
    try {
      // No string interpolation of path into -c source; pass via env-less argv list.
      await execFileAsync(
        python,
        [
          '-c',
          'import importlib.util,sys,os;p=sys.argv[1];f=os.path.join(p,"__init__.py");spec=importlib.util.spec_from_file_location("cp_pack",f) if os.path.isfile(f) else None;sys.exit(0 if spec else 2)',
          pack.path
        ],
        { timeout: 15000, cwd: pack.path }
      )
    } catch (e) {
      issues.push({
        severity: 'error',
        code: 'IMPORT_FAIL',
        message: `Import smoke test failed: ${e instanceof Error ? e.message.slice(0, 220) : String(e)}`,
        suggestion: 'Check requirements and Python version compatibility.',
        fixable: false
      })
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
    insertSnapshot(snapshot)
    try {
      writeFileSync(join(snapshotDir(), `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2))
    } catch {
      /* ignore */
    }
    return snapshot
  }

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
    const { sanitizeId, isPathInside } = require('./security') as typeof import('./security')
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
