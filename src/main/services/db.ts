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
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
  lstatSync,
  statSync
} from 'fs'
import { randomUUID } from 'crypto'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { decryptSecretSafe, encryptSecret, isEncryptedSecret } from './secretStorage'
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

/** Synchronous backoff used by the rename retry (no async context available). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* spin — only reached on runtimes without SharedArrayBuffer */
    }
  }
}

function fsyncFile(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r+')
    fsyncSync(fd)
  } catch {
    /* fsync is best-effort on filesystems that do not support it */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** Flush the directory entry so the rename itself survives a power cut (POSIX). */
function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    /* ignore */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Windows can refuse `rename` while another process (antivirus, indexer, a
 * just-closed reader) holds the target. 0.1.18 (WP1): retry with backoff instead
 * of throwing a "failed to save settings" on the first EPERM.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt < 3 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        sleepSync(20 * (attempt + 1))
        continue
      }
      throw e
    }
  }
}

let tmpSeq = 0

/**
 * 0.1.18 (WP1): durable atomic write.
 * - unique tmp name (two app instances used to share `<file>.tmp` and clobber
 *   each other's half-written snapshots),
 * - fsync the tmp file and the directory so a crash/power cut cannot leave the
 *   rename pointing at unwritten data,
 * - retry the rename on Windows sharing violations.
 */
function writeJsonc(name: string, value: unknown, header?: string): void {
  const p = fileFor(name)
  const tmp = `${p}.tmp-${process.pid}-${++tmpSeq}`
  try {
    writeFileSync(tmp, stringifyJsonc(value, header), 'utf-8')
    fsyncFile(tmp)
    renameWithRetry(tmp, p)
    fsyncDir(dirname(p))
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw e
  }
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
/** mtime recorded when a collection entered the cache (external-edit detection). */
const fileCacheStamp = new Map<string, number>()
let flushTimer: NodeJS.Timeout | null = null
const FLUSH_MS = 400

/**
 * Hot collections (0.1.17 WP7): written many times per user action. Reads are
 * served from the in-memory snapshot, disk writes coalesce into one per
 * FLUSH_MS window. Everything else keeps the synchronous write it always had.
 */
// Collections written through `scheduleFileWrite` must be listed here, or a
// cold read bypasses the in-memory snapshot and misses the pending write.
const DEBOUNCED_COLLECTIONS = new Set([
  'models',
  'output_assets',
  'node_packs',
  'workflows',
  'downloads',
  'install-runs'
])

function readJsoncCached<T>(name: string, fallback: T): T {
  // Non-debounced collections keep the old behaviour: direct writers delete the
  // cache entry, and caching their cold reads would only add a second owner.
  if (!DEBOUNCED_COLLECTIONS.has(name)) return readJsonc<T>(name, fallback)
  if (fileCache.has(name) && !pendingWrites.has(name)) {
    // External edit (hand-edited jsonc) invalidates the snapshot.
    try {
      const mtime = statSync(fileFor(name)).mtimeMs
      if (fileCacheStamp.get(name) !== mtime) {
        fileCache.delete(name)
        fileCacheStamp.delete(name)
      }
    } catch {
      /* file missing — keep the snapshot until a write recreates it */
    }
  }
  if (fileCache.has(name)) return fileCache.get(name) as T
  // 0.1.17 (review fix): a cold read used to be served from disk on every call
  // — "reads stay in memory" only became true after the first write.
  const loaded = readJsonc<T>(name, fallback)
  fileCache.set(name, loaded)
  try {
    fileCacheStamp.set(name, statSync(fileFor(name)).mtimeMs)
  } catch {
    fileCacheStamp.delete(name)
  }
  return loaded
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

/**
 * Write every debounced collection to disk immediately. Safe to call anytime.
 *
 * 0.1.17 (review fix): a failed write used to be swallowed after the queue had
 * already been cleared, so the user lost the data silently and memory/disk
 * diverged. Failures now stay queued for the next flush and are reported.
 */
export function flushPendingWrites(): { failed: string[] } {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const failed: string[] = []
  if (!pendingWrites.size) return { failed }
  const entries = [...pendingWrites.entries()]
  pendingWrites.clear()
  for (const [name, entry] of entries) {
    try {
      writeJsonc(name, entry.value, entry.header)
      // Refresh the stamp so our own write is not mistaken for an external edit.
      fileCacheStamp.set(name, statSync(fileFor(name)).mtimeMs)
    } catch (e) {
      // Keep the newest value queued; a later flush (quit or the next tick)
      // retries instead of dropping it.
      failed.push(name)
      pendingWrites.set(name, entry)
      console.error(`[db] failed to persist ${name}:`, e instanceof Error ? e.message : e)
    }
  }
  // 0.1.18 (regression): failures were re-queued but no timer was re-armed, so
  // the data sat in memory until quit. Retry soon instead.
  if (failed.length && !flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushPendingWrites()
    }, Math.max(FLUSH_MS, 2000))
    if (typeof (flushTimer as { unref?: () => void }).unref === 'function') {
      ;(flushTimer as unknown as { unref: () => void }).unref()
    }
  }
  return { failed }
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

function persistList(name: string, next: unknown[]): void {
  if (DEBOUNCED_COLLECTIONS.has(name)) {
    scheduleFileWrite(name, next)
    return
  }
  writeJsonc(name, next)
  fileCache.delete(name)
  fileCacheStamp.delete(name)
}

/**
 * Replace a whole collection (backup restore / migrations).
 *
 * 0.1.18 (WP1): `backup.ts` used to write `<name>.jsonc` itself. That made it a
 * second writer next to the debounce queue: an upsert queued before the restore
 * could flush afterwards with the *older* list and silently undo the restore.
 * Funnelling every wholesale replacement through this function keeps a single
 * owner: flush the queue first, then publish the new snapshot through the same
 * cache/debounce path every other writer uses.
 */
export function replaceList(name: string, items: unknown[]): void {
  flushPendingWrites()
  if (DEBOUNCED_COLLECTIONS.has(name)) {
    scheduleFileWrite(name, items)
    return
  }
  writeJsonc(name, items)
  fileCache.delete(name)
  fileCacheStamp.delete(name)
}

function upsertInList<T extends { id?: string; path?: string; name?: string }>(
  name: string,
  item: T,
  match: (a: T, b: T) => boolean
): void {
  withWriteLock(name, () => {
    const list = readJsoncCached<T[]>(name, [])
    const i = list.findIndex((x) => match(x, item))
    if (i >= 0) list[i] = item
    else list.push(item)
    persistList(name, list)
  })
}

/** Read-modify-write a whole list under the per-file lock. */
function mutateInList<T>(name: string, fallback: T[], fn: (list: T[]) => T[]): T[] {
  return withWriteLock(name, () => {
    const list = readJsoncCached<T[]>(name, fallback)
    const next = fn(list)
    persistList(name, next)
    return next
  })
}

// ---------- Settings ----------
const SETTINGS_HEADER = `ComfyPilot settings (JSONC)
// Edit safely — comments are allowed. Saved as <userData>/data/settings.jsonc`

/**
 * 0.1.17 (review fix): set when the stored proxy password could not be decrypted
 * on this machine. `saveSettings` then keeps the ciphertext instead of writing
 * an empty password over it.
 */
let proxyPasswordUnreadable = false

/** 0.1.18 (WP1 / S6): surface "the stored proxy password cannot be decrypted". */
export function isProxyPasswordUnreadable(): boolean {
  return proxyPasswordUnreadable
}

export function loadSettings(): AppSettings {
  const stored = readJsonc<Partial<AppSettings>>('settings', {})
  const proxy = { ...DEFAULT_SETTINGS.proxy, ...(stored.proxy || {}) }
  // Decrypt the password if it was stored encrypted.
  const decrypted = decryptSecretSafe(proxy.password)
  proxyPasswordUnreadable = decrypted.failed
  proxy.password = decrypted.value
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
  'outputScanDepth',
  'stopMode',
  'allowUnverifiedRuntime'
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
  // 0.1.17 (review fix): an unreadable secret must never be replaced by the
  // empty string the UI shows. Keep the stored ciphertext unless the caller
  // supplied a new password.
  let password = next.proxy.password
  if (!password && proxyPasswordUnreadable) {
    const stored = readJsonc<Partial<AppSettings>>('settings', {})
    const raw = String(stored.proxy?.password || '')
    if (isEncryptedSecret(raw)) password = raw
  }
  // Encrypt the password before persisting.
  const toWrite: AppSettings = {
    ...next,
    proxy: { ...next.proxy, password: encryptSecret(password) }
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
  return readJsoncCached<ModelRecord[]>('models', [])
}

export function deleteModel(id: string): boolean {
  const before = readJsoncCached<ModelRecord[]>('models', []).length
  const next = mutateInList<ModelRecord>('models', [], (list) => list.filter((m) => m.id !== id))
  return next.length !== before
}

export function findModelByPath(path: string): ModelRecord | null {
  return readJsoncCached<ModelRecord[]>('models', []).find((m) => m.path === path) || null
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

/**
 * Junk directory names an early scanner indexed as node packs (0.1.17).
 * `__pycache__` / `*.pyc` / macOS `._*` are never real custom nodes.
 */
function isJunkNodePack(p: { name?: string; path?: string }): boolean {
  const raw = String(p.name || p.path || '')
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || ''
  return base === '__pycache__' || base.endsWith('.pyc') || base.startsWith('._')
}

export function listNodePacks(): NodePack[] {
  const list = readJsoncCached<NodePack[]>('node_packs', [])
  const clean = list.filter((p) => !isJunkNodePack(p))
  if (clean.length !== list.length) {
    // Self-heal once through the single writer (0.1.18 WP1). Writing the file
    // directly here bypassed the debounce queue, so a stale queued snapshot
    // could resurrect the junk rows on the next flush.
    try {
      persistList('node_packs', clean)
    } catch {
      /* a read must never fail because the cleanup write failed */
    }
  }
  return clean
}

export function deleteNodePack(id: string): boolean {
  // 0.1.17 (review fix): go through the debounced collection path. Writing the
  // file directly while an upsert was still queued let the pending (older) list
  // flush afterwards and resurrect the deleted pack.
  const list = listNodePacks()
  const next = list.filter((p) => p.id !== id)
  if (next.length === list.length) return false
  persistList('node_packs', next)
  return true
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
  return readJsoncCached<WorkflowRecord[]>('workflows', [])
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
  const before = readJsoncCached<WorkflowRecord[]>('workflows', []).length
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
  outputAssetsRevision++
  upsertInList('output_assets', a, (x, y) => x.path === y.path || x.id === y.id)
}

/**
 * Field-level merge upsert: a disk walk must never wipe linkage written by the
 * batch indexer (batchJobId / workflowId / thumbnail / size).
 */
/**
 * 0.1.18 (WP4/F5): monotonic revision for the output index. List-side caches
 * (sort/filter results) can prove they are fresh instead of trusting a TTL.
 */
let outputAssetsRevision = 0
export function outputAssetsRev(): number {
  return outputAssetsRevision
}

export function mergeUpsertOutputAsset(a: OutputAsset): void {
  mergeUpsertOutputAssets([a])
}

/** Batch form of mergeUpsertOutputAsset — one read-modify-write for a whole walk. */
export function mergeUpsertOutputAssets(items: OutputAsset[]): void {
  if (!items.length) return
  outputAssetsRevision++
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
  const all = readJsoncCached<OutputAsset[]>('output_assets', [])
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
  return readJsoncCached<OutputAsset[]>('output_assets', [])
}

export function deleteOutputAsset(id: string): boolean {
  outputAssetsRevision++
  const before = readJsoncCached<OutputAsset[]>('output_assets', []).length
  const next = mutateInList<OutputAsset>('output_assets', [], (list) =>
    list.filter((a) => a.id !== id)
  )
  return next.length !== before
}

/**
 * Clear the recorded thumbnail on many rows in ONE write (0.1.17 WP7).
 * The prune loop used to rewrite the whole index once per dead row.
 */
export function clearOutputAssetThumbnails(ids: string[]): number {
  if (!ids.length) return 0
  outputAssetsRevision++
  const wanted = new Set(ids)
  let cleared = 0
  mutateInList<OutputAsset>('output_assets', [], (list) =>
    list.map((a) => {
      if (!wanted.has(a.id)) return a
      cleared += 1
      return { ...a, thumbnail: undefined }
    })
  )
  return cleared
}

export function updateOutputAsset(id: string, patch: Partial<OutputAsset>): OutputAsset | null {
  outputAssetsRevision++
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
/** Remote ids whose stored apiKey could not be decrypted in this process. */
const lockedRemoteApiKeys = new Set<string>()

export function listRemotes(): RemoteInstanceConfig[] {
  // 0.1.17 (WP8): API keys are encrypted at rest; decrypt on every read so all
  // consumers (test/batch/backup) keep receiving usable values.
  return readJsonc<RemoteInstanceConfig[]>('remote_instances', []).map((r) => {
    if (!r.apiKey) return r
    const d = decryptSecretSafe(r.apiKey)
    if (d.failed) {
      // Do not hand out an empty key as if it were the real one, and remember
      // that saving this record must not overwrite the ciphertext.
      lockedRemoteApiKeys.add(r.id)
      return { ...r, apiKey: '', apiKeyLocked: true }
    }
    lockedRemoteApiKeys.delete(r.id)
    return { ...r, apiKey: d.value }
  })
}

export function upsertRemote(c: RemoteInstanceConfig): void {
  // Encrypt before persisting — `upsertInList` compares by id only, so the
  // stored representation may differ from the in-memory one.
  let apiKey = c.apiKey
  if (!apiKey && lockedRemoteApiKeys.has(c.id)) {
    const prev = readJsonc<RemoteInstanceConfig[]>('remote_instances', []).find(
      (r) => r.id === c.id
    )
    if (prev?.apiKey && isEncryptedSecret(prev.apiKey)) {
      // Unreadable on this machine — keep the ciphertext instead of erasing it.
      apiKey = prev.apiKey
    }
  }
  const { apiKeyLocked: _ignored, ...rest } = c
  const stored: RemoteInstanceConfig = {
    ...rest,
    ...(apiKey ? { apiKey: encryptSecret(apiKey) } : { apiKey })
  }
  if (apiKey) lockedRemoteApiKeys.delete(c.id)
  upsertInList('remote_instances', stored, (a, b) => a.id === b.id)
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
