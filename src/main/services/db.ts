/**
 * JSON file store — same public API as the previous SQLite layer.
 * Deliberately avoids native modules (better-sqlite3 aborted some Windows hosts).
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
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

function fileFor(name: string): string {
  return join(userDataDir(), `${name}.json`)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const p = fileFor(name)
    if (!existsSync(p)) return fallback
    return JSON.parse(readFileSync(p, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, value: unknown): void {
  const p = fileFor(name)
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(tmp, p)
}

// ---------- Settings ----------
export function loadSettings(): AppSettings {
  const stored = readJson<Partial<AppSettings>>('settings', {})
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    proxy: { ...DEFAULT_SETTINGS.proxy, ...(stored.proxy || {}) }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    proxy: { ...current.proxy, ...(patch.proxy || {}) }
  }
  writeJson('settings', next)
  return next
}

// ---------- Instances ----------
export function loadInstanceConfigs(): ComfyInstanceConfig[] {
  return readJson<ComfyInstanceConfig[]>('instances', [])
}

export function upsertInstanceConfig(config: ComfyInstanceConfig): void {
  const list = loadInstanceConfigs()
  const i = list.findIndex((c) => c.id === config.id)
  if (i >= 0) list[i] = config
  else list.push(config)
  writeJson('instances', list)
}

export function deleteInstanceConfig(id: string): boolean {
  const list = loadInstanceConfigs()
  const next = list.filter((c) => c.id !== id)
  writeJson('instances', next)
  return next.length !== list.length
}

// ---------- Models ----------
export function upsertModel(m: ModelRecord): void {
  const list = readJson<ModelRecord[]>('models', [])
  const i = list.findIndex((x) => x.path === m.path || x.id === m.id)
  if (i >= 0) list[i] = { ...list[i], ...m }
  else list.push(m)
  writeJson('models', list)
}

export function listModels(): ModelRecord[] {
  return readJson<ModelRecord[]>('models', [])
}

export function deleteModel(id: string): boolean {
  const list = readJson<ModelRecord[]>('models', [])
  const next = list.filter((m) => m.id !== id)
  writeJson('models', next)
  return next.length !== list.length
}

export function findModelByPath(path: string): ModelRecord | null {
  return readJson<ModelRecord[]>('models', []).find((m) => m.path === path) || null
}

export function updateModel(id: string, patch: Partial<ModelRecord>): void {
  const list = readJson<ModelRecord[]>('models', [])
  const i = list.findIndex((m) => m.id === id)
  if (i >= 0) {
    list[i] = { ...list[i], ...patch }
    writeJson('models', list)
  }
}

// ---------- Node packs ----------
type NodePack = import('@shared/types').NodePackRecord

export function upsertNodePack(p: NodePack): void {
  const list = readJson<NodePack[]>('node_packs', [])
  const i = list.findIndex((x) => x.id === p.id || x.name === p.name)
  if (i >= 0) list[i] = p
  else list.push(p)
  writeJson('node_packs', list)
}

export function listNodePacks(): NodePack[] {
  return readJson<NodePack[]>('node_packs', [])
}

export function deleteNodePack(id: string): boolean {
  const list = readJson<NodePack[]>('node_packs', [])
  const next = list.filter((p) => p.id !== id)
  writeJson('node_packs', next)
  return next.length !== list.length
}

// ---------- Snapshots ----------
export function listSnapshots(): NodeSnapshot[] {
  return readJson<NodeSnapshot[]>('node_snapshots', [])
}

export function insertSnapshot(s: NodeSnapshot): void {
  const list = listSnapshots()
  list.push(s)
  writeJson('node_snapshots', list)
}

export function deleteSnapshot(id: string): boolean {
  const list = listSnapshots()
  const next = list.filter((s) => s.id !== id)
  writeJson('node_snapshots', next)
  return next.length !== list.length
}

export function getSnapshot(id: string): NodeSnapshot | null {
  return listSnapshots().find((s) => s.id === id) || null
}

// ---------- Workflows ----------
export function listWorkflows(): WorkflowRecord[] {
  return readJson<WorkflowRecord[]>('workflows', [])
}

export function upsertWorkflow(w: WorkflowRecord): void {
  const list = listWorkflows()
  const i = list.findIndex((x) => x.path === w.path || x.id === w.id)
  if (i >= 0) list[i] = w
  else list.push(w)
  writeJson('workflows', list)
}

// ---------- Downloads ----------
export function listDownloadTasks(): DownloadTask[] {
  return readJson<DownloadTask[]>('downloads', [])
}

export function upsertDownloadTask(t: DownloadTask): void {
  const list = listDownloadTasks()
  const i = list.findIndex((x) => x.id === t.id)
  if (i >= 0) list[i] = t
  else list.push(t)
  writeJson('downloads', list)
}

// ---------- Batch ----------
export function listBatchJobs(): BatchJob[] {
  return readJson<BatchJob[]>('batch_jobs', [])
}

export function upsertBatchJob(j: BatchJob): void {
  const list = listBatchJobs()
  const i = list.findIndex((x) => x.id === j.id)
  if (i >= 0) list[i] = j
  else list.push(j)
  writeJson('batch_jobs', list)
}

export function deleteBatchJob(id: string): boolean {
  const list = listBatchJobs()
  const next = list.filter((j) => j.id !== id)
  writeJson('batch_jobs', next)
  return next.length !== list.length
}

// ---------- Backups ----------
export function listBackups(): BackupManifest[] {
  return readJson<BackupManifest[]>('backups', [])
}

export function insertBackup(b: BackupManifest): void {
  const list = listBackups()
  list.push(b)
  writeJson('backups', list)
}

export function deleteBackup(id: string): boolean {
  const list = listBackups()
  const next = list.filter((b) => b.id !== id)
  writeJson('backups', next)
  return next.length !== list.length
}

// ---------- Output ----------
export function upsertOutputAsset(a: OutputAsset): void {
  const list = readJson<OutputAsset[]>('output_assets', [])
  const i = list.findIndex((x) => x.path === a.path || x.id === a.id)
  if (i >= 0) list[i] = a
  else list.push(a)
  writeJson('output_assets', list)
}

export function listOutputAssets(limit = 200): OutputAsset[] {
  return readJson<OutputAsset[]>('output_assets', []).slice(0, limit)
}

// ---------- Remote ----------
export function listRemotes(): RemoteInstanceConfig[] {
  return readJson<RemoteInstanceConfig[]>('remote_instances', [])
}

export function upsertRemote(c: RemoteInstanceConfig): void {
  const list = listRemotes()
  const i = list.findIndex((x) => x.id === c.id)
  if (i >= 0) list[i] = c
  else list.push(c)
  writeJson('remote_instances', list)
}

export function deleteRemote(id: string): boolean {
  const list = listRemotes()
  const next = list.filter((r) => r.id !== id)
  writeJson('remote_instances', next)
  return next.length !== list.length
}

export function newId(): string {
  return randomUUID()
}

/** @deprecated kept for API compat — no SQL layer anymore */
export function getDb(): null {
  return null
}
