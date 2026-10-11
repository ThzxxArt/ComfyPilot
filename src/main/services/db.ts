/**
 * JSONC config/data store for ComfyPilot.
 *
 * All persistent state lives as human-editable `.jsonc` files under
 * userData/data/ with line and block comments allowed.
 * No native modules.
 */
import { app } from 'electron'
import { join, basename } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type {
  AppSettings,
  BatchJob,
  BackupManifest,
  ComfyInstanceConfig,
  DownloadTask,
  ModelRecord,
  NodeSnapshot,
  OutputAsset,
  RemoteInstanceConfig,
  WorkflowRecord
} from '@shared/types'

// ---------- JSONC helpers ----------

/** Parse JSONC: strip // and /* *\/ comments outside strings, allow trailing commas. */
export function parseJsonc<T>(text: string): T {
  let out = ''
  let inStr = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === '"') {
        inStr = false
      }
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return JSON.parse(stripTrailingCommas(out)) as T
}

/** Drop `,` before } or ] outside strings (string content like "x,]y" is kept). */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (c === '"') {
        inStr = false
      }
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (j < text.length && (text[j] === '}' || text[j] === ']')) continue
    }
    out += c
  }
  return out
}

export function stringifyJsonc(value: unknown, header?: string): string {
  const body = JSON.stringify(value, null, 2)
  const head = header
    ? header
        .split('\n')
        .map((l) => (l.startsWith('//') ? l : `// ${l}`))
        .join('\n') + '\n'
    : ''
  return head + body + '\n'
}

// ---------- Paths ----------

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function userDataDir(): string {
  return ensureDir(join(app.getPath('userData'), 'data'))
}

export function cacheDir(): string {
  return ensureDir(join(app.getPath('userData'), 'cache'))
}

export function logsDir(): string {
  return ensureDir(join(app.getPath('userData'), 'logs'))
}

export function backupDir(): string {
  return ensureDir(join(userDataDir(), 'backups'))
}

export function snapshotDir(): string {
  return ensureDir(join(userDataDir(), 'node-snapshots'))
}

/** Config directory for human-editable jsonc (same as userDataDir). */
export function configDir(): string {
  return userDataDir()
}

function fileFor(name: string): string {
  return join(userDataDir(), `${name}.jsonc`)
}

function readJsonc<T>(name: string, fallback: T): T {
  const p = fileFor(name)
  try {
    if (!existsSync(p)) return fallback
    try {
      return parseJsonc<T>(readFileSync(p, 'utf-8'))
    } catch (err) {
      console.error('jsonc parse fail', basename(p), err)
      // Keep the unparseable file; defaults must not overwrite user data.
      try {
        renameSync(p, `${p}.bad-${Date.now()}`)
      } catch {
        /* ignore */
      }
      return fallback
    }
  } catch (err) {
    console.error('jsonc read fail', basename(p), err)
    return fallback
  }
}

function writeJsonc(name: string, value: unknown, header?: string): void {
  const p = fileFor(name)
  const tmp = p + '.tmp'
  writeFileSync(tmp, stringifyJsonc(value, header), 'utf-8')
  renameSync(tmp, p)
}

/**
 * Per-file read-modify-write mutex.
 * Current callers are synchronous, but any future `await` between read and
 * write would interleave and silently drop updates. This guard serialises
 * every mutation of a given collection regardless of call-site async shape.
 */
const writeLocks = new Map<string, boolean>()

function withWriteLock<T>(name: string, fn: () => T): T {
  // Re-entrant: a nested call for the same file during a locked section
  // would deadlock if we spun; just run inline (already serialised).
  if (writeLocks.get(name)) return fn()
  writeLocks.set(name, true)
  try {
    return fn()
  } finally {
    writeLocks.set(name, false)
  }
}

function upsertInList<T extends { id?: string; path?: string; name?: string }>(
  name: string,
  item: T,
  match: (a: T, b: T) => boolean
): void {
  withWriteLock(name, () => {
    const list = readJsonc<T[]>(name, [])
    const i = list.findIndex((x) => match(x, item))
    if (i >= 0) list[i] = item
    else list.push(item)
    writeJsonc(name, list)
  })
}

/** Read-modify-write a whole list under the per-file lock. */
function mutateInList<T>(name: string, fallback: T[], fn: (list: T[]) => T[]): T[] {
  return withWriteLock(name, () => {
    const list = readJsonc<T[]>(name, fallback)
    const next = fn(list)
    writeJsonc(name, next)
    return next
  })
}

// ---------- Settings ----------
const SETTINGS_HEADER = `ComfyPilot settings (JSONC)
// Edit safely — comments are allowed. Saved as <userData>/data/settings.jsonc`

/**
 * Encrypt/decrypt proxy password using Electron safeStorage (OS keychain).
 * Falls back to plaintext when safeStorage is unavailable (tests, early init)
 * so existing configs keep working.
 */
function encryptProxyPassword(password: string): string {
  if (!password) return ''
  try {
    // Lazy require — safeStorage needs app ready and is main-process only.
    const { safeStorage } = require('electron') as typeof import('electron')
    if (safeStorage?.isEncryptionAvailable?.()) {
      return 'enc:' + safeStorage.encryptString(password).toString('base64')
    }
  } catch {
    /* not in Electron (tests) */
  }
  return password
}

function decryptProxyPassword(stored: string): string {
  if (!stored || !stored.startsWith('enc:')) return stored
  try {
    const { safeStorage } = require('electron') as typeof import('electron')
    const buf = Buffer.from(stored.slice(4), 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    return ''
  }
}

export function loadSettings(): AppSettings {
  const stored = readJsonc<Partial<AppSettings>>('settings', {})
  const proxy = { ...DEFAULT_SETTINGS.proxy, ...(stored.proxy || {}) }
  // Decrypt the password if it was stored encrypted.
  proxy.password = decryptProxyPassword(proxy.password)
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    proxy
  }
}

/** Known top-level AppSettings keys — unknown keys are stripped on save. */
const KNOWN_SETTINGS_KEYS = new Set([
  'locale', 'modelScanRoots', 'githubEndpoint', 'hfEndpoint', 'civitaiEndpoint',
  'enableAutoCheckUpdates', 'embedFrontend', 'securityLevel', 'allowGitUrlInstall',
  'allowPipInstall', 'networkMode', 'aria2Path', 'useAria2', 'launchOnBoot',
  'minimizeToTray', 'autoStartInstancesOnLaunch', 'proxy', 'pipIndex', 'torchIndexMirror'
])

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  // Strip unknown keys to prevent dirty data from accumulating.
  const cleanPatch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (KNOWN_SETTINGS_KEYS.has(k)) cleanPatch[k] = v
  }
  const next: AppSettings = {
    ...current,
    ...cleanPatch,
    proxy: { ...current.proxy, ...((cleanPatch.proxy as Partial<AppSettings['proxy']>) || {}) }
  }
  // Encrypt the password before persisting.
  const toWrite: AppSettings = {
    ...next,
    proxy: { ...next.proxy, password: encryptProxyPassword(next.proxy.password) }
  }
  writeJsonc('settings', toWrite, SETTINGS_HEADER)
  return next
}

// ---------- Instances ----------
export function loadInstanceConfigs(): ComfyInstanceConfig[] {
  return readJsonc<ComfyInstanceConfig[]>('instances', [])
}

export function upsertInstanceConfig(config: ComfyInstanceConfig): void {
  upsertInList('instances', config, (a, b) => a.id === b.id)
}

export function deleteInstanceConfig(id: string): boolean {
  const list = loadInstanceConfigs()
  const next = list.filter((c) => c.id !== id)
  writeJsonc('instances', next, 'ComfyPilot instances')
  return next.length !== list.length
}

// ---------- Models ----------
export function upsertModel(m: ModelRecord): void {
  mutateInList<ModelRecord>('models', [], (list) => {
    const i = list.findIndex((x) => x.path === m.path || x.id === m.id)
    if (i >= 0) list[i] = { ...list[i], ...m }
    else list.push(m)
    return list
  })
}

export function listModels(): ModelRecord[] {
  return readJsonc<ModelRecord[]>('models', [])
}

export function deleteModel(id: string): boolean {
  const before = readJsonc<ModelRecord[]>('models', []).length
  const next = mutateInList<ModelRecord>('models', [], (list) => list.filter((m) => m.id !== id))
  return next.length !== before
}

export function findModelByPath(path: string): ModelRecord | null {
  return readJsonc<ModelRecord[]>('models', []).find((m) => m.path === path) || null
}

export function updateModel(id: string, patch: Partial<ModelRecord>): void {
  mutateInList<ModelRecord>('models', [], (list) => {
    const i = list.findIndex((m) => m.id === id)
    if (i >= 0) list[i] = { ...list[i], ...patch }
    return list
  })
}

// ---------- Node packs ----------
type NodePack = import('@shared/types').NodePackRecord

export function upsertNodePack(p: NodePack): void {
  upsertInList('node_packs', p, (a, b) => a.id === b.id || a.name === b.name)
}

export function listNodePacks(): NodePack[] {
  return readJsonc<NodePack[]>('node_packs', [])
}

export function deleteNodePack(id: string): boolean {
  const list = readJsonc<NodePack[]>('node_packs', [])
  const next = list.filter((p) => p.id !== id)
  writeJsonc('node_packs', next)
  return next.length !== list.length
}

// ---------- Snapshots ----------
export function listSnapshots(): NodeSnapshot[] {
  return readJsonc<NodeSnapshot[]>('node_snapshots', [])
}

export function insertSnapshot(s: NodeSnapshot): void {
  const list = listSnapshots()
  list.push(s)
  writeJsonc('node_snapshots', list)
}

export function deleteSnapshot(id: string): boolean {
  const list = listSnapshots()
  const next = list.filter((s) => s.id !== id)
  writeJsonc('node_snapshots', next)
  return next.length !== list.length
}

export function getSnapshot(id: string): NodeSnapshot | null {
  return listSnapshots().find((s) => s.id === id) || null
}

// ---------- Workflows ----------
export function listWorkflows(): WorkflowRecord[] {
  return readJsonc<WorkflowRecord[]>('workflows', [])
}

export function upsertWorkflow(w: WorkflowRecord): void {
  upsertInList('workflows', w, (a, b) => a.path === b.path || a.id === b.id)
}

/** Batch upsert: one read-modify-write for a whole scan result. */
export function upsertWorkflows(items: WorkflowRecord[]): void {
  if (!items.length) return
  mutateInList<WorkflowRecord>('workflows', [], (list) => {
    for (const w of items) {
      const i = list.findIndex((x) => x.path === w.path || x.id === w.id)
      if (i >= 0) list[i] = w
      else list.push(w)
    }
    return list
  })
}

export function updateWorkflow(id: string, patch: Partial<WorkflowRecord>): WorkflowRecord | null {
  let result: WorkflowRecord | null = null
  mutateInList<WorkflowRecord>('workflows', [], (list) => {
    const i = list.findIndex((w) => w.id === id)
    if (i >= 0) {
      list[i] = { ...list[i], ...patch, id: list[i].id }
      result = list[i]
    }
    return list
  })
  return result
}

export function deleteWorkflow(id: string): boolean {
  const before = readJsonc<WorkflowRecord[]>('workflows', []).length
  const next = mutateInList<WorkflowRecord>('workflows', [], (list) => list.filter((w) => w.id !== id))
  return next.length !== before
}

/**
 * Legacy ComfyPilot workflow folder (`<userData>/data/workflows`).
 * Imports now land in the instance's `user/default/workflows`; this directory
 * is still scanned so files from older releases stay visible.
 */
export function workflowLibraryDir(): string {
  return ensureDir(join(userDataDir(), 'workflows'))
}

// ---------- Downloads ----------
export function listDownloadTasks(): DownloadTask[] {
  return readJsonc<DownloadTask[]>('downloads', [])
}

export function upsertDownloadTask(t: DownloadTask): void {
  upsertInList('downloads', t, (a, b) => a.id === b.id)
}

// ---------- Batch ----------
export function listBatchJobs(): BatchJob[] {
  return readJsonc<BatchJob[]>('batch_jobs', [])
}

export function upsertBatchJob(j: BatchJob): void {
  upsertInList('batch_jobs', j, (a, b) => a.id === b.id)
}

export function deleteBatchJob(id: string): boolean {
  const before = readJsonc<BatchJob[]>('batch_jobs', []).length
  const next = mutateInList<BatchJob>('batch_jobs', [], (list) => list.filter((j) => j.id !== id))
  return next.length !== before
}

// ---------- Backups ----------
export function listBackups(): BackupManifest[] {
  return readJsonc<BackupManifest[]>('backups', [])
}

export function insertBackup(b: BackupManifest): void {
  const list = listBackups()
  list.push(b)
  writeJsonc('backups', list)
}

export function deleteBackup(id: string): boolean {
  const list = listBackups()
  const next = list.filter((b) => b.id !== id)
  writeJsonc('backups', next)
  return next.length !== list.length
}

// ---------- Output ----------
export function upsertOutputAsset(a: OutputAsset): void {
  upsertInList('output_assets', a, (x, y) => x.path === y.path || x.id === y.id)
}

/**
 * Field-level merge upsert: a disk walk must never wipe linkage written by the
 * batch indexer (batchJobId / workflowId / thumbnail / size).
 */
export function mergeUpsertOutputAsset(a: OutputAsset): void {
  mergeUpsertOutputAssets([a])
}

/** Batch form of mergeUpsertOutputAsset — one read-modify-write for a whole walk. */
export function mergeUpsertOutputAssets(items: OutputAsset[]): void {
  if (!items.length) return
  mutateInList<OutputAsset>('output_assets', [], (list) => {
    for (const a of items) {
      const i = list.findIndex((x) => x.path === a.path || x.id === a.id)
      if (i < 0) {
        list.push(a)
        continue
      }
      list[i] = {
        ...list[i],
        ...a,
        // Keep the earlier non-empty value whenever the incoming one is blank.
        thumbnail: a.thumbnail || list[i].thumbnail,
        width: a.width ?? list[i].width,
        height: a.height ?? list[i].height,
        batchJobId: a.batchJobId || list[i].batchJobId,
        workflowId: a.workflowId || list[i].workflowId,
        workflowName: a.workflowName || list[i].workflowName,
        favorite: a.favorite ?? list[i].favorite,
        promptId: a.promptId || list[i].promptId,
        seed: a.seed ?? list[i].seed,
        params: { ...(list[i].params || {}), ...(a.params || {}) }
      }
    }
    return list
  })
}

/**
 * Newest-first by default. The previous `slice(0, limit)` dropped the newest
 * files once the index grew past the limit — always sort before slicing.
 */
export function listOutputAssets(opts?: {
  limit?: number
  offset?: number
  sort?: 'createdAt' | 'size' | 'name'
  order?: 'asc' | 'desc'
}): OutputAsset[] {
  const all = readJsonc<OutputAsset[]>('output_assets', [])
  const sort = opts?.sort || 'createdAt'
  const order = opts?.order === 'asc' ? 1 : -1
  const sorted = [...all].sort((a, b) => {
    if (sort === 'name') return order * a.fileName.localeCompare(b.fileName)
    if (sort === 'size') return order * (a.size - b.size)
    return order * (a.createdAt - b.createdAt)
  })
  const offset = Math.max(0, opts?.offset || 0)
  const limit = opts?.limit ?? 200
  return sorted.slice(offset, offset + limit)
}

export function listOutputAssetsAll(): OutputAsset[] {
  return readJsonc<OutputAsset[]>('output_assets', [])
}

export function deleteOutputAsset(id: string): boolean {
  const before = readJsonc<OutputAsset[]>('output_assets', []).length
  const next = mutateInList<OutputAsset>('output_assets', [], (list) => list.filter((a) => a.id !== id))
  return next.length !== before
}

export function updateOutputAsset(id: string, patch: Partial<OutputAsset>): OutputAsset | null {
  let result: OutputAsset | null = null
  mutateInList<OutputAsset>('output_assets', [], (list) => {
    const i = list.findIndex((a) => a.id === id)
    if (i >= 0) {
      list[i] = { ...list[i], ...patch, id: list[i].id }
      result = list[i]
    }
    return list
  })
  return result
}

// ---------- Remote ----------
export function listRemotes(): RemoteInstanceConfig[] {
  return readJsonc<RemoteInstanceConfig[]>('remote_instances', [])
}

export function upsertRemote(c: RemoteInstanceConfig): void {
  upsertInList('remote_instances', c, (a, b) => a.id === b.id)
}

export function deleteRemote(id: string): boolean {
  const before = readJsonc<RemoteInstanceConfig[]>('remote_instances', []).length
  const next = mutateInList<RemoteInstanceConfig>('remote_instances', [], (list) =>
    list.filter((r) => r.id !== id)
  )
  return next.length !== before
}

export function newId(): string {
  return randomUUID()
}

/** List jsonc config files for UI/debug. */
export function listConfigFiles(): string[] {
  try {
    return readdirSync(userDataDir()).filter((f) => f.endsWith('.jsonc'))
  } catch {
    return []
  }
}

// ---------- Install run persistence (0.1.4) ----------
/**
 * Persist the latest install/update run so the UI can restore progress after
 * an app restart. File shape: `{ runs: InstallProgress[] }` with newest first,
 * capped so the file never grows unbounded.
 */
const INSTALL_RUNS_HEADER = `ComfyPilot install runs (JSONC)
// Latest one-click installer runs — written automatically. Safe to delete.`

export function saveInstallRun(progress: {
  runId: string
  status: string
  [k: string]: unknown
}): void {
  try {
    const file = readJsonc<{ runs: Array<Record<string, unknown>> }>('install-runs', { runs: [] })
    const runs = file.runs || []
    const idx = runs.findIndex((r) => r.runId === progress.runId)
    if (idx >= 0) runs[idx] = progress
    else runs.unshift(progress)
    writeJsonc('install-runs', { runs: runs.slice(0, 20) }, INSTALL_RUNS_HEADER)
  } catch {
    /* persistence is best-effort — never fail the install because of it */
  }
}

export function loadInstallRuns(): Array<Record<string, unknown>> {
  try {
    return readJsonc<{ runs: Array<Record<string, unknown>> }>('install-runs', { runs: [] }).runs || []
  } catch {
    return []
  }
}

/** Most recent run (in-flight preferred: status === 'running'). */
export function loadLatestInstallRun(): Record<string, unknown> | null {
  const runs = loadInstallRuns()
  return runs.find((r) => r.status === 'running') || runs[0] || null
}

export function clearInstallRuns(): void {
  try {
    writeJsonc('install-runs', { runs: [] }, INSTALL_RUNS_HEADER)
  } catch {
    /* ignore */
  }
}
