import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ComfyLogLine } from '@shared/types'
import { stripAnsi } from '@shared/logLine'
import { readTextTail, rotateLogIfTooLarge, MAX_LOG_READ_BYTES } from '../logFile'
import { loadInstanceConfigs, logsDir, userDataDir } from '../db'
import {
  LOG_CAP,
  STATUS_EMIT_MIN_MS,
  type InstanceServiceContext,
  type RuntimeEntry
} from './types'

export function pushLog(
  ctx: InstanceServiceContext,
  rt: RuntimeEntry,
  level: ComfyLogLine['level'],
  message: string
): void {
  const line: ComfyLogLine = { ts: Date.now(), level, message, source: 'comfy' }
  rt.logs.push(line)
  if (rt.logs.length > LOG_CAP) rt.logs.splice(0, rt.logs.length - LOG_CAP)
  ctx.emit('log', rt.config.id, line)
  // Log lines arrive in bursts during startup — emitting full status per line
  // floods the IPC bridge. Only push when status changed, else at most 1/s.
  const now = Date.now()
  const changed = rt.lastEmittedStatus !== rt.status
  if (changed || now - (rt.lastStatusEmitAt ?? 0) >= STATUS_EMIT_MIN_MS) {
    ctx.emitStatus(rt)
  }
  ctx.appendLogFile(rt.config.id, line)
}

export function appendLogFile(ctx: InstanceServiceContext, id: string, line: ComfyLogLine): void {
  try {
    const file = join(logsDir(), `${id}.log`)
    // Rotate periodically (cheap size check every 100 writes) so a
    // long-running instance cannot grow its log without bound (0.1.16).
    const count = (ctx.logWriteCounters.get(id) ?? 0) + 1
    ctx.logWriteCounters.set(id, count)
    if (count % 100 === 0) rotateLogIfTooLarge(file)
    writeFileSync(
      file,
      `[${new Date(line.ts).toISOString()}] ${line.level.toUpperCase()} ${stripAnsi(line.message)}\n`,
      {
        flag: 'a'
      }
    )
  } catch {
    /* ignore */
  }
}

export function getLogs(ctx: InstanceServiceContext, id: string, limit = 500): ComfyLogLine[] {
  const rt = ctx.runtimes.get(id)
  const mem = rt?.logs ?? []
  // Memory only holds the current process session; past runs live in the log file.
  const file = ctx.readLogFile(id)
  if (!file.length) return mem.slice(-limit)
  if (!mem.length) return file.slice(-limit)
  // pushLog writes to both sinks, so memory duplicates the file tail — drop
  // memory lines already present in the file and append only the remainder.
  const fileKeys = new Set(file.map((l) => `${l.ts}|${l.message}`))
  const extra = mem.filter((l) => !fileKeys.has(`${l.ts}|${l.message}`))
  return [...file, ...extra].slice(-limit)
}

export function clearLogs(ctx: InstanceServiceContext, id: string): boolean {
  const rt = ctx.runtimes.get(id)
  if (rt) rt.logs = []
  // Wipe the on-disk history too — getLogs merges the file back in, so leaving
  // it would make "Clear logs" a no-op on the next read. Also clear when there
  // is no live runtime (after an app restart the file is the only history).
  //
  // 0.1.17 (WP10): the rotated generation `<id>.log.1` is read FIRST by
  // readLogFile, so deleting only `<id>.log` resurrected history on the next
  // refresh (and on Windows the live file may be exclusively held by the
  // child). Delete every generation the reader can see.
  let removed = false
  const prefixes = [`${id}.log`]
  try {
    for (const name of readdirSync(logsDir())) {
      if (prefixes.some((p) => name === p || name.startsWith(`${p}.`))) {
        try {
          rmSync(join(logsDir(), name), { force: true })
          removed = true
        } catch {
          /* a locked generation must not stop the others */
        }
      }
    }
  } catch {
    /* logs dir missing — nothing to clear */
  }
  if (rt) ctx.emitStatus(rt)
  return Boolean(rt) || removed
}

export function readLogFile(id: string): ComfyLogLine[] {
  try {
    const file = join(logsDir(), `${id}.log`)
    const archive = `${file}.1`
    // Bounded tail read (0.1.16): never load the whole file. Rotated history
    // (`.log.1`) is read first so the merged view keeps recent history.
    const text =
      (existsSync(archive) ? readTextTail(archive, MAX_LOG_READ_BYTES) : '') +
      readTextTail(file, MAX_LOG_READ_BYTES)
    if (!text) return []
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        // Write format is `[ISO] LEVEL message` with exactly one space after
        // the level. A greedy `\s+` would swallow leading spaces from the
        // message and break ts|message dedupe against in-memory lines
        // (Python traceback indent lines would be duplicated).
        // `[\s\S]` (not `.`) because old logs written before the stream
        // splitter treated bare `\r` as a separator contain CR inside the
        // message. The previous `.` regex failed to match, fell back to
        // `Date.now()` + the whole raw line, and duplicated the entry against
        // the in-memory copy (the `ts|message` dedupe key differed).
        const m = line.match(/^\[([^\]]+)\] (\w+) ([\s\S]*)$/)
        return {
          ts: m ? Date.parse(m[1]) : Date.now(),
          level: (m?.[2]?.toLowerCase() as ComfyLogLine['level']) || 'info',
          // Keep an empty message empty (never fall back to the raw line) so
          // the `ts|message` dedupe key still matches the in-memory copy.
          message: (m ? m[3] : line).replace(/\r/g, '')
        }
      })
  } catch {
    return []
  }
}

/**
 * Export the instance log to a file (0.1.11). Bounded, not unlimited: the
 * in-memory buffer is capped at 100k lines and readLogFile only reads the
 * tail of each generation (MAX_LOG_READ_BYTES). The comment used to claim
 * "ENTIRE" while doing exactly this — now it says what it does (0.1.17).
 */
export async function exportLogs(
  ctx: InstanceServiceContext,
  id: string
): Promise<{ path: string }> {
  const lines = ctx.getLogs(id, 100_000)
  const dir = join(userDataDir(), 'exports')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // Human-readable instance name first (0.1.12 — `id-timestamp` files were
  // indistinguishable); unicode letters/numbers kept, separators collapsed.
  const cfg = loadInstanceConfigs().find((c) => c.id === id)
  const base =
    String(cfg?.name || id)
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || id
  const file = join(dir, `${base}-${stamp}.log`)
  writeFileSync(
    file,
    lines
      .map((l) => `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.message}`)
      .join('\n') + '\n',
    'utf-8'
  )
  return { path: file }
}
