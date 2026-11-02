/**
 * Low-level JSONC parsing and durable atomic persistence.
 *
 * This module owns ALL shared in-memory state for the store:
 * `fileCache`, `pendingWrites`, the flush timer and per-file write locks.
 * Domain modules must import these helpers instead of creating their own
 * copies, otherwise a cold read can bypass a pending write.
 */
import { basename, dirname, join } from 'path'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { userDataDir } from './paths'
import { fromV2, toV2 } from './schema'

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

export function fileFor(name: string): string {
  return join(userDataDir(), `${name}.jsonc`)
}

// ---------- Migration guard ----------

/**
 * `readJsonc` must run the one-shot v1 → v2 migration before serving data, but
 * `migration.ts` itself calls the write helpers here. A runtime import back
 * would create a cycle, so migration installs its guard after defining it.
 */
let dataMigrationGuard: (() => void) | null = null

export function setDataMigrationGuard(guard: (() => void) | null): void {
  dataMigrationGuard = guard
}

// ---------- Cached reads ----------

/**
 * Callback fired when a cached file changed underneath us (hand-edited jsonc).
 * Domain modules with derived caches subscribe without making this module
 * import them.
 */
let externalEditListener: ((name: string) => void) | null = null

export function setJsoncExternalEditListener(listener: ((name: string) => void) | null): void {
  externalEditListener = listener
}

export function readJsonc<T>(name: string, fallback: T): T {
  dataMigrationGuard?.()
  const p = fileFor(name)
  try {
    if (!existsSync(p)) return fallback
    try {
      const parsed = parseJsonc<unknown>(readFileSync(p, 'utf-8'))
      return fromV2<T>(parsed)
    } catch (err) {
      console.error('jsonc parse fail', basename(p), err)
      // Keep the unparseable file; defaults must not overwrite user data.
      try {
        renameSync(p, `${p}.bad-${Date.now()}`)
      } catch {
        /* ignore */
      }
      throw new Error(`DATA_FILE_CORRUPT: ${basename(p)} — restore a pre-upgrade snapshot`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('DATA_')) throw err
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
export function writeJsonc(name: string, value: unknown, header?: string): void {
  const p = fileFor(name)
  const tmp = `${p}.tmp-${process.pid}-${++tmpSeq}`
  try {
    writeFileSync(tmp, stringifyJsonc(toV2(value), header), 'utf-8')
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

export function readJsoncCached<T>(name: string, fallback: T): T {
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
        // 0.2.0: a hand-edited output index must invalidate list caches too.
        externalEditListener?.(name)
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

export function scheduleFileWrite(name: string, value: unknown, header?: string): void {
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
    flushTimer = setTimeout(
      () => {
        flushTimer = null
        flushPendingWrites()
      },
      Math.max(FLUSH_MS, 2000)
    )
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

export function withWriteLock<T>(name: string, fn: () => T): T {
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

export function persistList(name: string, next: unknown[]): void {
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

export function upsertInList<T extends { id?: string; path?: string; name?: string }>(
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
export function mutateInList<T>(name: string, fallback: T[], fn: (list: T[]) => T[]): T[] {
  return withWriteLock(name, () => {
    const list = readJsoncCached<T[]>(name, fallback)
    const next = fn(list)
    persistList(name, next)
    return next
  })
}
