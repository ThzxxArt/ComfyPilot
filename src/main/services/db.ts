/**
 * JSONC config/data store for ComfyPilot.
 *
 * All persistent state lives as human-editable `.jsonc` files under
 * userData/data/ with line and block comments allowed.
 * No native modules.
 */
import { app } from 'electron'
import { join, basename, dirname } from 'path'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  lstatSync
} from 'fs'
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

/**
 * Cache root for regenerable ComfyPilot data (thumbnails, registry index).
 *
 * MUST NOT be `<userData>/cache`: on Windows/macOS the filesystem is
 * case-insensitive, so that path IS Chromium's own `Cache` directory —
 * browser cache eviction (or upgrade) wipes our thumbs with it. 0.1.9 moved
 * the root to `app-cache` and migrates legacy data once on first access.
 */
export function cacheDir(): string {
  const root = join(app.getPath('userData'), 'app-cache')
  migrateLegacyCache(app.getPath('userData'), root)
  return ensureDir(root)
}

let legacyCacheMigrated = false

/** One-shot best-effort move of `cache/thumbs` + registry index into app-cache. */
function migrateLegacyCache(userData: string, nextRoot: string): void {
  if (legacyCacheMigrated) return
  legacyCacheMigrated = true
  try {
    const legacyRoot = join(userData, 'cache')
    if (legacyRoot === nextRoot || !existsSync(legacyRoot)) return
    for (const name of ['thumbs', 'registry-index.json', 'registry-index.json.tmp']) {
      moveLegacyEntry(join(legacyRoot, name), join(nextRoot, name))
    }
  } catch {
    /* best effort — a failed migration only costs regenerating thumbs */
  }
}

function moveLegacyEntry(from: string, to: string): void {
  try {
    if (!existsSync(from)) return
    const st = lstatSync(from)
    // Never descend into symlinks/junctions: statSync would follow them and
    // move the LINK TARGET's contents out of the user's real directory.
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true })
      for (const name of readdirSync(from)) moveLegacyEntry(join(from, name), join(to, name))
    } else if (!existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
    }
  } catch {
    /* skip individual entries that resist moving */
  }
}

export function logsDir(): string {
  return ensureDir(join(app.getPath('userData'), 'logs'))
}

let legacyLogsMigrated = false

/**
 * One-shot consolidation of the legacy boot log (0.1.16).
 *
 * `bootstrap.cjs` and the early `crashLog` helper hardcoded
 * `%APPDATA%/ComfyPilot/logs` while the real Electron userData is
 * `%APPDATA%/comfy-pilot` (app `name` ≠ `productName`). The "open logs dir"
 * button therefore pointed at an empty folder and README documented the wrong
 * path. Everything now lives under `logsDir()`; this appends the old boot log
 * (if any) and marks it migrated. Best-effort — never blocks startup.
 */
export function migrateLegacyLogs(): void {
  if (legacyLogsMigrated) return
  legacyLogsMigrated = true
  try {
    const legacyDir = join(app.getPath('appData'), 'ComfyPilot', 'logs')
    const target = logsDir()
    const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
    if (norm(legacyDir) === norm(target)) return
    const legacyBoot = join(legacyDir, 'boot.log')
    if (!existsSync(legacyBoot)) return
    const targetBoot = join(target, 'boot.log')
    const legacyText = readFileSync(legacyBoot, 'utf-8')
    if (existsSync(targetBoot)) appendFileSync(targetBoot, legacyText)
    else writeFileSync(targetBoot, legacyText, 'utf-8')
    try {
      renameSync(legacyBoot, legacyBoot + '.migrated')
    } catch {
      /* leave it in place if locked */
    }
  } catch {
    /* best effort */
  }
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

// ---------- Debounced persistence (0.1.16) ----------
// High-frequency writers (install-progress ticks, download-progress ticks)
// used to rewrite their whole JSONC file synchronously on every tick —
// hundreds of read-modify-writes per install/download. They now keep an
// in-memory snapshot (reads stay immediately consistent) and coalesce disk
// writes; `flushPendingWrites()` is called on quit so nothing is lost, and the
// debounce window is bounded.
interface PendingWrite {
  value: unknown
  header?: string
}
const pendingWrites = new Map<string, PendingWrite>()
const fileCache = new Map<string, unknown>()
let flushTimer: NodeJS.Timeout | null = null
const FLUSH_MS = 400

function readJsoncCached<T>(name: string, fallback: T): T {
  if (fileCache.has(name)) return fileCache.get(name) as T
  return readJsonc<T>(name, fallback)
}

function scheduleFileWrite(name: string, value: unknown, header?: string): void {
  fileCache.set(name, value)
  pendingWrites.set(name, { value, header })
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushPendingWrites()
  }, FLUSH_MS)
  // A pending flush must never keep the process alive on its own.
  if (typeof (flushTimer as { unref?: () => void }).unref === 'function') {
    ;(flushTimer as unknown as { unref: () => void }).unref()
  }
}

/** Write every debounced collection to disk immediately. Safe to call anytime. */
export function flushPendingWrites(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!pendingWrites.size) return
  const entries = [...pendingWrites.entries()]
  pendingWrites.clear()
  for (const [name, entry] of entries) {
    try {
      writeJsonc(name, entry.value, entry.header)
    } catch {
      /* persistence is best-effort */
    }
  }
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
  'locale',
  'modelScanRoots',
  'githubEndpoint',
  'hfEndpoint',
  'civitaiEndpoint',
  'enableAutoCheckUpdates',
  'embedFrontend',
  'securityLevel',
  'allowGitUrlInstall',
  'allowPipInstall',
  'networkMode',
  'aria2Path',
  'useAria2',
  'launchOnBoot',
  'minimizeToTray',
  'autoStartInstancesOnLaunch',
  'proxy',
  'pipIndex',
  'torchIndexMirror',
  'outputScanDepth'
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
  upsertModels([m])
}

/**
 * Batch form of `upsertModel` — one read-modify-write for a whole scan
 * (0.1.16). A per-file `upsertModel` inside the scan loop rewrote the entire
 * models.jsonc once per discovered model (O(N²)); this writes it once.
 */
export function upsertModels(items: ModelRecord[]): void {
  if (!items.length) return
  mutateInList<ModelRecord>('models', [], (list) => {
    for (const m of items) {
      const i = list.findIndex((x) => x.path === m.path || x.id === m.id)
      if (i >= 0) list[i] = { ...list[i], ...m }
      else list.push(m)
    }
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
  const next = mutateInList<WorkflowRecord>('workflows', [], (list) =>
    list.filter((w) => w.id !== id)
  )
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
// Progress ticks fire up to every 500ms per task; debounce the whole-file write.
export function listDownloadTasks(): DownloadTask[] {
  return readJsoncCached<DownloadTask[]>('downloads', [])
}

export function upsertDownloadTask(t: DownloadTask): void {
  const list = listDownloadTasks().slice()
  const i = list.findIndex((x) => x.id === t.id)
  if (i >= 0) list[i] = t
  else list.push(t)
  scheduleFileWrite('downloads', list)
}

/** Replace the whole downloads list (used by prune/persist paths). */
export function replaceDownloadTasks(tasks: DownloadTask[]): void {
  scheduleFileWrite('downloads', tasks)
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
  const next = mutateInList<OutputAsset>('output_assets', [], (list) =>
    list.filter((a) => a.id !== id)
  )
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
    // Progress ticks are frequent — keep the snapshot in memory and debounce
    // the disk write (flushPendingWrites() on quit guarantees durability).
    const file = readJsoncCached<{ runs: Array<Record<string, unknown>> }>('install-runs', {
      runs: []
    })
    const runs = (file.runs || []).slice()
    const idx = runs.findIndex((r) => r.runId === progress.runId)
    if (idx >= 0) runs[idx] = progress
    else runs.unshift(progress)
    scheduleFileWrite('install-runs', { runs: runs.slice(0, 20) }, INSTALL_RUNS_HEADER)
  } catch {
    /* persistence is best-effort — never fail the install because of it */
  }
}

export function loadInstallRuns(): Array<Record<string, unknown>> {
  try {
    return (
      readJsoncCached<{ runs: Array<Record<string, unknown>> }>('install-runs', {
        runs: []
      }).runs || []
    )
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
    scheduleFileWrite('install-runs', { runs: [] }, INSTALL_RUNS_HEADER)
    flushPendingWrites()
  } catch {
    /* ignore */
  }
}
