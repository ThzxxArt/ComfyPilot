/**
 * Execution-failure diagnostics (0.1.12) — the bridge between raw failures
 * (WS `execution_error` payloads / console log tracebacks) and the UI's
 * "what failed, which pack, what's missing, how to fix" surface.
 *
 * Two sources, one merged list:
 * - WS payloads: only for runs ComfyPilot submitted (protocol delivers them to
 *   `server.client_id`). Rich fields: node_type, exception_type, traceback.
 * - Console logs: any run (including those started in the ComfyUI frontend).
 *   Parsed by shared/execError into the same shape; attribution via traceback
 *   file paths.
 *
 * Dismissal: `clear()` stamps `dismissedAt` so log-derived failures (which
 * physically stay in the log) do not resurface after the user clears them.
 */
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { ExecFailure, ExecProgressEvent } from '@shared/types'
import { parseExecErrors, stripAnsi } from '@shared/execError'
import { instanceService } from './instance'
import { capabilityService } from './capabilities'
import { loadInstanceConfigs } from './db'

const MAX_FAILURES = 20
/** Rescan debounce after a trigger line (the traceback streams in right after). */
const RESCAN_DELAY_MS = 600
/**
 * Only failures this recent are picked up by a rescan. Without this window,
 * a log tail full of OLD failure blocks (e.g. after a ComfyPilot restart) got
 * re-recorded and re-notified whenever a NEW trigger fired — the in-memory
 * "already recorded" set is empty after a restart.
 */
const RESCAN_WINDOW_MS = 120_000
/** Do not re-announce the same error within this window. */
const NOTIFY_DEDUPE_MS = 10_000

export class ExecDiagnosticsService extends EventEmitter {
  private wsFailures = new Map<string, ExecFailure[]>()
  private logFailures = new Map<string, ExecFailure[]>()
  private dismissedAt = new Map<string, number>()
  private lastNotify = new Map<string, { key: string; at: number }>()
  private rescanTimers = new Map<string, NodeJS.Timeout>()

  /** Map a monitor base URL to a configured instance id (localhost origins). */
  instanceIdForBaseUrl(baseUrl: string): string | undefined {
    if (!baseUrl) return undefined
    let origin = ''
    try {
      origin = new URL(baseUrl).origin
    } catch {
      return undefined
    }
    for (const c of loadInstanceConfigs()) {
      const host =
        c.listen === '0.0.0.0' || c.listen === '::' || c.listen === '[::]'
          ? '127.0.0.1'
          : c.listen || '127.0.0.1'
      if (`http://${host}:${c.port || 8188}` === origin) return c.id
    }
    return undefined
  }

  /** Record an execution_error from the monitor WS (ComfyPilot submissions). */
  recordWs(instanceId: string, evt: ExecProgressEvent): ExecFailure | null {
    if (evt.type !== 'execution_error') return null
    const errorType = evt.errorType || 'ExecutionError'
    const message = evt.errorMessage || 'Execution failed'
    // The console-log rescan may have already recorded this very failure
    // (frontend-started runs parse first) — double-recording produced two
    // rows AND two push events for one error (0.1.13). Mirror rescanLogs'
    // dedupe window in this direction too.
    const now = Date.now()
    const dupLog = (this.logFailures.get(instanceId) || []).some(
      (f) => Math.abs(now - f.at) < 10_000 && f.errorType === errorType && f.message === message
    )
    if (dupLog) return null
    const missing = String(evt.errorMessage || '').match(/No module named\s+['"]([^'"]+)['"]/i)
    const failure: ExecFailure = {
      id: randomUUID(),
      instanceId,
      source: 'ws',
      at: now,
      promptId: evt.promptId,
      nodeId: evt.nodeId,
      nodeType: evt.nodeType,
      errorType,
      message,
      missingModule: missing ? missing[1] : undefined,
      traceback: evt.errorTraceback
    }
    this.push(this.wsFailures, instanceId, failure)
    this.emitFailure(failure)
    return failure
  }

  /**
   * Watch a raw instance log line (called for every pushed line). A failure
   * banner schedules a debounced rescan of the log tail so the (multi-line)
   * traceback is parsed only after it finished streaming.
   */
  noteLogLine(instanceId: string, message: string): void {
    if (!/!!!\s*Exception during processing/i.test(stripAnsi(message))) return
    const prev = this.rescanTimers.get(instanceId)
    if (prev) clearTimeout(prev)
    this.rescanTimers.set(
      instanceId,
      setTimeout(() => {
        this.rescanTimers.delete(instanceId)
        this.rescanLogs(instanceId)
      }, RESCAN_DELAY_MS)
    )
  }

  /** Parse the instance log tail, record newly observed failures (deduped). */
  rescanLogs(instanceId: string): ExecFailure[] {
    let parsed: ReturnType<typeof parseExecErrors> = []
    try {
      parsed = parseExecErrors(instanceService.getLogs(instanceId, 5000))
    } catch {
      return []
    }
    const recorded = this.logFailures.get(instanceId) || []
    const fresh: ExecFailure[] = []
    const now = Date.now()
    for (const p of parsed) {
      const at = p.at || now
      // Stale log history must not resurface (see RESCAN_WINDOW_MS).
      if (now - at > RESCAN_WINDOW_MS) continue
      const dupLog = recorded.some(
        (f) => f.at === at && f.errorType === p.errorType && f.message === p.message
      )
      const dupWs = (this.wsFailures.get(instanceId) || []).some(
        (f) =>
          Math.abs(f.at - at) < 10_000 && f.errorType === p.errorType && f.message === p.message
      )
      if (dupLog || dupWs) continue
      const failure: ExecFailure = {
        id: randomUUID(),
        instanceId,
        source: 'log',
        at,
        errorType: p.errorType,
        message: p.message,
        missingModule: p.missingModule,
        packFolder: p.packFolder,
        traceback: p.traceback
      }
      fresh.push(failure)
      recorded.push(failure)
    }
    if (fresh.length) {
      this.logFailures.set(instanceId, recorded.slice(-MAX_FAILURES))
      for (const f of fresh) this.emitFailure(f)
    }
    return fresh
  }

  /** Merged, newest-first failures (WS + log), dismissal-aware. */
  list(instanceId: string): ExecFailure[] {
    const dismissed = this.dismissedAt.get(instanceId) || 0
    const ws = (this.wsFailures.get(instanceId) || []).filter((f) => f.at >= dismissed)
    const logs = (this.logFailures.get(instanceId) || []).filter((f) => f.at >= dismissed)
    const merged = [...ws, ...logs]
    // WS entries carry richer fields; when a log entry duplicates one, drop it.
    const out = merged.filter((f) => {
      if (f.source === 'ws') return true
      return !merged.some(
        (w) =>
          w.source === 'ws' &&
          Math.abs(w.at - f.at) < 10_000 &&
          w.errorType === f.errorType &&
          w.message === f.message
      )
    })
    out.sort((a, b) => b.at - a.at)
    const trimmed = out.slice(0, MAX_FAILURES)
    // Late enrichment: pack attribution from the (possibly now warm) object_info map.
    for (const f of trimmed) {
      if (!f.packFolder && f.nodeType) {
        const folder = capabilityService.pythonModuleForTypeCached(instanceId, f.nodeType)
        if (folder) f.packFolder = folder
      }
    }
    return trimmed
  }

  /** Dismiss everything recorded up to now (log-derived ones included). */
  clear(instanceId: string): boolean {
    this.dismissedAt.set(instanceId, Date.now())
    this.wsFailures.delete(instanceId)
    this.logFailures.delete(instanceId)
    const timer = this.rescanTimers.get(instanceId)
    if (timer) {
      clearTimeout(timer)
      this.rescanTimers.delete(instanceId)
    }
    return true
  }

  private push(map: Map<string, ExecFailure[]>, instanceId: string, f: ExecFailure): void {
    const arr = map.get(instanceId) || []
    arr.push(f)
    map.set(instanceId, arr.slice(-MAX_FAILURES))
  }

  /** Bound the notify-dedupe map — a long session with many distinct
   *  failure keys must not grow it without limit (0.1.13). */
  private static readonly MAX_NOTIFY_KEYS = 200

  private emitFailure(f: ExecFailure): void {
    this.emit('failure', f)
    const key = `${f.errorType}|${f.message}`
    const prev = this.lastNotify.get(f.instanceId)
    const now = Date.now()
    if (prev && prev.key === key && now - prev.at < NOTIFY_DEDUPE_MS) return
    // Refresh insertion order so the oldest key is always the eviction head.
    this.lastNotify.delete(f.instanceId)
    this.lastNotify.set(f.instanceId, { key, at: now })
    while (this.lastNotify.size > ExecDiagnosticsService.MAX_NOTIFY_KEYS) {
      const oldest = this.lastNotify.keys().next().value
      if (oldest === undefined) break
      this.lastNotify.delete(oldest)
    }
    this.emit('notify', f)
  }
}

export const execDiagnosticsService = new ExecDiagnosticsService()
