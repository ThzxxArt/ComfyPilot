/**
 * Slow-IPC attribution (0.1.17).
 *
 * The 0.1.16 watchdog proved the main thread once froze for 12.4 s but left
 * only a number behind — no channel, no duration breakdown, no argument hint.
 * This module records every IPC handler that takes longer than the threshold,
 * keeps a small ring buffer for the watchdog and appends a compact line to
 * `logs/slow-ops.log` so the freeze can be attributed after the fact.
 *
 * Rules that keep it safe:
 * - Never records argument VALUES — only top-level key names and counts.
 * - Never throws into the IPC path; instrumentation is best-effort.
 * - Byte-capped log with a single rotation generation.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { logsDir } from './db'

/** Default slow threshold — anything at or above this is recorded. */
export const DEFAULT_SLOW_OP_MS = 1000
/** At or above this the entry is flagged FREEZE (matches the watchdog concern). */
export const FREEZE_OP_MS = 5000
/** Ring buffer length used by the watchdog / diagnostics. */
export const SLOW_OP_RING_SIZE = 50
/** Arguments digest cap — keeps a single log line bounded. */
export const ARGS_DIGEST_MAX = 200

const LOG_FILE = 'slow-ops.log'
const LOG_MAX_BYTES = 512 * 1024

export interface SlowOpEntry {
  channel: string
  ms: number
  /** Top-level key names / counts only, never values. */
  args: string
  at: number
  freeze: boolean
}

const ring: SlowOpEntry[] = []
let slowThresholdMs = readThresholdFromEnv()
let listener: ((entry: SlowOpEntry) => void) | null = null
const instrumented = new WeakSet<object>()

function readThresholdFromEnv(): number {
  const raw = Number(process.env.COMFYPILOT_SLOW_OP_MS)
  if (Number.isFinite(raw) && raw >= 0) return Math.round(raw)
  return DEFAULT_SLOW_OP_MS
}

/** Current threshold in ms (overridable via COMFYPILOT_SLOW_OP_MS or tests). */
export function getSlowOpThreshold(): number {
  return slowThresholdMs
}

export function setSlowOpThreshold(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) slowThresholdMs = Math.round(ms)
}

/** Registered by the IPC layer so a >5 s freeze can surface a user-visible toast. */
export function setSlowOpListener(cb: ((entry: SlowOpEntry) => void) | null): void {
  listener = cb
}

function describeArg(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') return `str(${(value as string).length})`
  if (t === 'number' || t === 'boolean') return t
  if (Array.isArray(value)) return `arr(${value.length})`
  if (t === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    const head = keys.slice(0, 8).join(',')
    return `{${head}${keys.length > 8 ? ',…' : ''}}`
  }
  return t
}

/**
 * Stable, value-free digest of handler arguments. Object arguments collapse to
 * their top-level key names; primitives to their type. Capped so a log line
 * cannot explode.
 */
export function digestArgs(args: unknown[]): string {
  let out = ''
  try {
    out = args.map(describeArg).join(' ')
  } catch {
    out = 'unreadable'
  }
  return out.slice(0, ARGS_DIGEST_MAX)
}

function slowOpsLogPath(): string {
  return join(logsDir(), LOG_FILE)
}

/** Path of the slow-op log (exported for the diagnostics bundle + tests). */
export function getSlowOpsLogPath(): string {
  return slowOpsLogPath()
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < LOG_MAX_BYTES) return
    const prev = `${file}.1`
    try {
      if (existsSync(prev)) {
        // Single generation: replace the old rotation instead of growing.
        renameSync(prev, `${prev}.tmp`)
      }
    } catch {
      /* ignore */
    }
    renameSync(file, prev)
  } catch {
    /* rotation is best-effort */
  }
}

function appendEntry(entry: SlowOpEntry): void {
  try {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, LOG_FILE)
    rotateIfNeeded(file)
    const marker = entry.freeze ? ' FREEZE' : ' slow'
    appendFileSync(
      file,
      `[${new Date(entry.at).toISOString()}]${marker}: ${entry.channel} ${entry.ms}ms ${entry.args}\n`,
      'utf-8'
    )
  } catch {
    /* logging must never break the IPC call it describes */
  }
}

/**
 * Record one IPC duration. Returns the entry when it crossed the threshold,
 * otherwise null (so callers/tests can assert cheaply).
 */
export function recordSlowOp(
  channel: string,
  ms: number,
  args: unknown[] = [],
  now = Date.now()
): SlowOpEntry | null {
  const rounded = Math.max(0, Math.round(ms))
  if (!Number.isFinite(rounded) || rounded < slowThresholdMs) return null
  const entry: SlowOpEntry = {
    channel: String(channel || 'unknown'),
    ms: rounded,
    args: digestArgs(args),
    at: now,
    freeze: rounded >= FREEZE_OP_MS
  }
  ring.push(entry)
  while (ring.length > SLOW_OP_RING_SIZE) ring.shift()
  appendEntry(entry)
  try {
    listener?.(entry)
  } catch {
    /* a bad listener must not break IPC */
  }
  return entry
}

/** Most recent slow ops (oldest → newest), capped. */
export function getRecentSlowOps(limit = 8): SlowOpEntry[] {
  if (limit <= 0) return []
  return ring.slice(-limit)
}

/** One-line summary for the watchdog / crash log. */
export function describeRecentSlowOps(limit = 3): string {
  const recent = getRecentSlowOps(limit)
  if (!recent.length) return 'none'
  return recent.map((e) => `${e.channel}/${e.ms}ms`).join(', ')
}

/** Read back the persisted log (diagnostics bundle / support). */
export function readSlowOpsLog(limit = 200): string[] {
  try {
    const file = slowOpsLogPath()
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    return limit > 0 ? lines.slice(-limit) : lines
  } catch {
    return []
  }
}

/**
 * 0.1.17 (review fix): a handler that legitimately WAITS (batch.wait for a long
 * run) is not a frozen main process. Callers pause attribution around the wait;
 * the wrapper skips recording for calls made while paused.
 */
let pauseDepth = 0
/** Bumped every time a pause fully ends — lets a call detect "waited inside". */
let pauseEpoch = 0

export function pauseSlowOp(): void {
  pauseDepth += 1
}

export function resumeSlowOp(): void {
  pauseDepth = Math.max(0, pauseDepth - 1)
  if (pauseDepth === 0) pauseEpoch += 1
}

export function isSlowOpPaused(): boolean {
  return pauseDepth > 0
}

export async function withPausedSlowOp<T>(fn: () => Promise<T>): Promise<T> {
  pauseSlowOp()
  try {
    return await fn()
  } finally {
    resumeSlowOp()
  }
}

/** Test-only: clear the in-memory ring (never the persisted log). */
export function resetSlowOpsForTest(): void {
  ring.length = 0
  listener = null
  slowThresholdMs = DEFAULT_SLOW_OP_MS
}

type HandleLike = {
  handle: (channel: string, listener: (...args: never[]) => unknown) => unknown
}

/**
 * Wrap `ipcMain.handle` so every registered channel is timed. Idempotent per
 * ipc object (two calls never double-wrap). Returns true when it installed the
 * wrapper on this call.
 */
export function instrumentIpcHandle(ipc: HandleLike): boolean {
  try {
    if (!ipc || typeof ipc.handle !== 'function') return false
    if (instrumented.has(ipc as unknown as object)) return false
    const original = ipc.handle.bind(ipc) as (
      channel: string,
      fn: (...a: unknown[]) => unknown
    ) => unknown
    ipc.handle = ((channel: string, handler: (...a: unknown[]) => unknown) => {
      if (typeof handler !== 'function') return original(channel, handler)
      const timed = async (...callArgs: unknown[]): Promise<unknown> => {
        const started = Date.now()
        const startedPaused = isSlowOpPaused()
        const epochAtStart = pauseEpoch
        try {
          return await handler(...callArgs)
        } finally {
          try {
            // A wait that was explicitly paused (batch.wait) is not a stall.
            if (!startedPaused && !isSlowOpPaused() && pauseEpoch === epochAtStart) {
              // callArgs[0] is the IPC event; the rest are the renderer's args.
              recordSlowOp(channel, Date.now() - started, callArgs.slice(1))
            }
          } catch {
            /* attribution must never break the call */
          }
        }
      }
      return original(channel, timed as (...a: unknown[]) => unknown)
    }) as HandleLike['handle']
    instrumented.add(ipc as unknown as object)
    return true
  } catch {
    return false
  }
}
