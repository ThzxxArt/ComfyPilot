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
  snapshotDir,
  upsertNodePack
} from './db'
import { REGISTRY_API } from '@shared/constants'

const execFileAsync = promisify(execFile)

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
    const packs: NodePackRecord[] = []
    for (const name of readdirSync(root)) {
      if (name.startsWith('.') || name.endsWith('.trash') || name.includes('.trash-')) continue
      const dir = join(root, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const meta = readPackMeta(dir)
      const issues = collectIssues(dir, meta)
      const disabled = existsSync(join(dir, '.disabled')) || name.endsWith('.disabled')
      const id = createHash('sha1').update(dir).digest('hex').slice(0, 16)
      packs.push({
        id,
        name: meta.name || name,
        displayName: meta.displayName || name,
        description: meta.description || '',
        author: '',
        version: meta.version || '0.0.0',
        status: disabled
          ? 'disabled'
          : issues.some((i) => i.severity === 'error')
            ? 'error'
            : 'installed',
        path: dir,
        repository: meta.repository,
        nodeCount: meta.nodeList?.length || 0,
        tags: [],
        installSource: 'local',
        lastCheckedAt: Date.now(),
        issues,
        locked: false,
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

  async install(opts: {
    id: string
    version?: string
    source: 'registry' | 'git' | 'manager'
    url?: string
  }): Promise<NodePackRecord> {
    // PLAN: 安装前自动快照
    try {
      this.createSnapshot(`auto-pre-install-${opts.id}`)
    } catch {
      /* snapshot is best-effort */
    }
    const settings = loadSettings()
    const root = detectCustomNodesRoot()
    if (!root) throw new Error('custom_nodes root not found — add a ComfyUI instance first')
    mkdirSync(root, { recursive: true })

    if (opts.source === 'git') {
      if (!settings.allowGitUrlInstall && settings.securityLevel === 'strong') {
        throw new Error('Git URL install is disabled by security settings')
      }
      const url = opts.url || opts.id
      const dest = join(root, url.split('/').pop()?.replace(/\.git$/, '') || `pack-${Date.now()}`)
      await execFileAsync('git', ['clone', '--depth', '1', url, dest], { timeout: 120000 })
      return this.afterInstall(dest)
    }

    const versionPart = opts.version ? `/${opts.version}` : ''
    const apiUrl = `${REGISTRY_API}/nodes/${opts.id}/install${versionPart}`
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
    const dest = join(root, opts.id.replace(/[^\w.-]/g, '_'))
    if (process.platform === 'win32') {
      await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${tmpZip}' -DestinationPath '${dest}' -Force`
        ],
        { timeout: 60000 }
      )
    } else {
      await execFileAsync('unzip', ['-o', tmpZip, '-d', dest], { timeout: 60000 })
    }
    try {
      unlinkSync(tmpZip)
    } catch {
      /* ignore */
    }
    return this.afterInstall(dest)
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
          return await this.install({
            id: pack.registryId || pack.name,
            version,
            source: 'registry'
          })
        } catch (e) {
          renameSync(trash, pack.path)
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
    const disabledMarker = join(pack.path, '.disabled')
    if (enabled) {
      if (existsSync(disabledMarker)) unlinkSync(disabledMarker)
      pack.status = 'installed'
    } else {
      writeFileSync(disabledMarker, String(Date.now()))
      pack.status = 'disabled'
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
    try {
      await execFileAsync(
        'python',
        ['-c', `import sys; sys.path.insert(0, r'''${pack.path}'''); import importlib; importlib.import_module('__init__')`],
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
      source: p.installSource
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
    for (const p of current) {
      const inSnap = snap.packs.some((s) => s.name === p.name)
      if (!inSnap) this.toggle(p.name, false)
    }
    for (const s of snap.packs) {
      if (current.some((p) => p.name === s.name)) this.toggle(s.name, true)
    }
    return true
  }

  deleteSnapshot(id: string): boolean {
    try {
      const file = join(snapshotDir(), `${id}.json`)
      if (existsSync(file)) unlinkSync(file)
    } catch {
      /* ignore */
    }
    return dbDeleteSnapshot(id)
  }
}

export const nodePackService = new NodePackService()
