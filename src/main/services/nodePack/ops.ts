import { randomUUID } from 'crypto'
import type { NodeOpLogEvent, UpdateProgress, UpdateStep, UpdateStepId } from '@shared/types'
import type { NodePackHost } from './host'
import { STEP_WEIGHTS } from './types'

/** Emit node install lifecycle for UI progress (IPC_EVENTS.nodeInstallProgress). */
export function emitInstallProgress(
  this: NodePackHost,
  payload: {
    phase: 'start' | 'download' | 'unzip' | 'pip' | 'done' | 'error'
    packName: string
    message?: string
    /** What kind of operation this is — the UI labels install vs update differently. */
    op?: 'install' | 'update' | 'uninstall'
    /** Stream owner so the renderer's banner never shows another instance's pack. */
    instanceId?: string
  }
): void {
  this.emit('install-progress', {
    ...payload,
    op: payload.op || 'install',
    instanceId: payload.instanceId || 'default',
    ts: Date.now()
  })
}

/** Arm an AbortController for a new install/update run. */
export function beginOpAbort(this: NodePackHost, instanceId?: string): AbortSignal {
  const key = instanceId || 'default'
  // A new run supersedes any stale controller for the same instance.
  this.opAborts.get(key)?.abort()
  const ac = new AbortController()
  this.opAborts.set(key, ac)
  return ac.signal
}

export function endOpAbort(this: NodePackHost, instanceId?: string): void {
  this.opAborts.delete(instanceId || 'default')
}

/**
 * True when an install/update/uninstall/batch is REALLY in flight for the
 * instance (armed abort controller or reserved batch slot). This is the
 * authoritative busy signal for cross-service guards — a leftover progress
 * snapshot whose status says 'running' but has no active controller must
 * never lock dependency installs forever (0.1.13).
 */
export function isOpActive(this: NodePackHost, instanceId?: string): boolean {
  const key = instanceId || 'default'
  return this.opAborts.has(key) || this.opBatches.has(key)
}

/** Cancel the in-flight install/update for an instance. True when something was aborted. */
export function cancelOp(this: NodePackHost, instanceId?: string): boolean {
  const key = instanceId || 'default'
  const ac = this.opAborts.get(key)
  if (!ac) return false
  ac.abort()
  // Do NOT delete here: the op's finally does. Keeping the controller makes
  // the abort→cleanup/rollback window still count as busy for OP_BUSY.
  return true
}

/**
 * Stop a running "update all" queue: abort the current pack AND mark the
 * batch cancelled so remaining packs are skipped instead of started.
 */
export function cancelUpdateBatch(this: NodePackHost, instanceId?: string): boolean {
  const key = instanceId || 'default'
  const batch = this.opBatches.get(key)
  if (batch) batch.cancelled = true
  const aborted = this.cancelOp(instanceId)
  return Boolean(batch) || aborted
}

export function emitBatch(
  this: NodePackHost,
  payload: Omit<import('@shared/types').NodeUpdateBatchEvent, 'ts'>
): void {
  this.emit('update-batch', { ...payload, ts: Date.now() })
}

/**
 * Trim step logs from the op-progress payload: incremental lines travel on
 * `event:node-op-log`, so re-sending up to 400 lines × 6 steps per tick is
 * pure IPC waste. One trailing line is kept for any consumer that still
 * renders "last log line" from the snapshot.
 */
export function progressSnapshot(this: NodePackHost, p: UpdateProgress): UpdateProgress {
  return {
    ...p,
    steps: p.steps.map((s) => (s.log.length > 1 ? { ...s, log: [s.log[s.log.length - 1]] } : s))
  }
}

/** Weighted completion of the six fixed steps (skipped counts as complete). */
export function computePercent(this: NodePackHost, p: UpdateProgress): number {
  let sum = 0
  for (const s of p.steps) {
    const w = STEP_WEIGHTS.find(([id]) => id === s.id)?.[1] ?? 0
    if (s.status === 'done' || s.status === 'skipped') sum += w
    else if (s.status === 'running') sum += w * Math.max(0, Math.min(1, s.progress ?? 0))
  }
  return Math.max(0, Math.min(100, Math.round(sum)))
}

/** Fresh six-step list for a new op stream. */
function freshSteps(): UpdateStep[] {
  return [
    { id: 'download', title: 'Download', status: 'pending', detail: '', log: [] },
    { id: 'clone', title: 'Git pull / clone', status: 'pending', detail: '', log: [] },
    { id: 'unpack', title: 'Unpack', status: 'pending', detail: '', log: [] },
    { id: 'requirements', title: 'Dependencies', status: 'pending', detail: '', log: [] },
    { id: 'verify', title: 'Finalize', status: 'pending', detail: '', log: [] },
    { id: 'done', title: 'Done', status: 'pending', detail: '', log: [] }
  ] as UpdateStep[]
}

/**
 * Reset the live stream for the NEXT pack of a running batch IN PLACE.
 * The runId survives so the renderer keeps one continuous terminal log
 * across the whole queue (a fresh runId would clear it mid-batch).
 */
export function resetOpSteps(this: NodePackHost, key: string, packName?: string): void {
  const p = this.opProgressMap.get(key)
  if (!p) return
  p.steps = freshSteps()
  p.step = 'download'
  p.status = 'running'
  p.percent = 0
  p.error = undefined
  p.packName = packName
  p.updatedAt = Date.now()
}

/**
 * Emit an UpdateProgress-shaped snapshot so the renderer can reuse
 * ComfyUpdateProgressModal for node installs — the same step list + live
 * pip/uv log the ComfyUI update flow has.
 */
export function emitOpProgress(
  this: NodePackHost,
  opts: {
    instanceId: string
    step: UpdateStepId
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'
    message: string
    logLine?: string
    detailKey?: string
    packName?: string
  }
): void {
  const key = opts.instanceId || 'default'
  let p = this.opProgressMap.get(key)
  if (!p) {
    const currentBatch = this.opBatches.get(key)
    p = {
      runId: randomUUID(),
      instanceId: key,
      step: 'download',
      status: 'running',
      steps: freshSteps(),
      message: opts.message,
      percent: 0,
      packName: opts.packName || currentBatch?.current
    }
    this.opProgressMap.set(key, p)
  }
  if (opts.packName) p.packName = opts.packName
  const s = p.steps.find((x) => x.id === opts.step)
  if (s) {
    s.status = opts.status
    if (opts.status === 'running') s.progress = s.progress ?? 0
    if (opts.message) s.detail = opts.message
    if (opts.detailKey) s.detailKey = opts.detailKey
    if (opts.logLine) {
      s.log.push(opts.logLine)
      if (s.log.length > 400) s.log.splice(0, s.log.length - 400)
      this.emit('op-log', {
        runId: p.runId,
        packName: p.packName,
        line: opts.logLine,
        instanceId: key,
        ts: Date.now()
      } satisfies NodeOpLogEvent)
    }
  }
  p.step = opts.step
  p.message = opts.message
  const prevPercent = p.percent
  p.status =
    opts.status === 'failed' || opts.status === 'cancelled'
      ? opts.status
      : opts.step === 'done' && opts.status === 'done'
        ? 'done'
        : 'running'
  // Surface the failure text on the progress object so the shared modal's
  // error block actually renders something.
  if (p.status === 'failed' || p.status === 'cancelled') p.error = opts.message
  // On terminal success every remaining pending step is closed out so the
  // bar actually reaches 100% instead of stalling on an untouched "verify".
  if (p.status === 'done') {
    for (const x of p.steps) {
      if (x.status === 'pending') x.status = 'skipped'
    }
    p.percent = 100
    p.error = undefined
  } else {
    p.percent = this.computePercent(p)
  }
  // Monotonic guard: a step being (re)marked running — e.g. installInner's
  // clone after updateInner pre-skipped it for reuseStream, or the zip
  // fallback after a skipped download — must never make the bar jump back.
  p.percent = Math.max(prevPercent, p.percent)
  p.updatedAt = Date.now()
  this.attachBatchContext(key, p)
  this.emit('op-progress', this.progressSnapshot(p))
}

/** Fill batch fields + monotonic aggregate percent on the progress object. */
export function attachBatchContext(this: NodePackHost, key: string, p: UpdateProgress): void {
  const b = this.opBatches.get(key)
  if (!b || b.total <= 0) return
  p.packName = p.packName || b.current
  p.batchIndex = b.index
  p.batchTotal = b.total
  p.aggregatePercent = Math.round(((b.index - 1 + (p.percent || 0) / 100) / b.total) * 100)
}

/** Advance the running step's fraction (0..1) and re-emit the stream. */
export function setStepFraction(
  this: NodePackHost,
  step: UpdateStepId,
  fraction: number,
  instanceId?: string
): void {
  const key = instanceId || 'default'
  const p = this.opProgressMap.get(key)
  if (!p) return
  const s = p.steps.find((x) => x.id === step)
  if (!s || s.status !== 'running') return
  const next = Math.max(0, Math.min(1, fraction))
  // Never regress inside a step — git/pip output can repeat percentages.
  if ((s.progress ?? 0) >= next) return
  s.progress = next
  p.percent = this.computePercent(p)
  p.updatedAt = Date.now()
  this.attachBatchContext(key, p)
  this.emit('op-progress', this.progressSnapshot(p))
}

/** Update the running step's title (0.1.17 WP2-4 — honest pip stage text). */
export function setStepMessage(
  this: NodePackHost,
  step: UpdateStepId,
  message: string,
  instanceId?: string
): void {
  const key = instanceId || 'default'
  const p = this.opProgressMap.get(key)
  if (!p) return
  const s = p.steps.find((x) => x.id === step)
  if (!s || s.status !== 'running' || s.detail === message) return
  s.detail = message
  p.updatedAt = Date.now()
  this.attachBatchContext(key, p)
  this.emit('op-progress', this.progressSnapshot(p))
}

export function opLog(this: NodePackHost, line: string, instanceId?: string): void {
  const key = instanceId || 'default'
  const p = this.opProgressMap.get(key)
  if (!p) return
  const s = p.steps.find((x) => x.id === p.step)
  if (s) {
    s.log.push(line)
    if (s.log.length > 400) s.log.splice(0, s.log.length - 400)
  }
  this.emit('op-log', {
    runId: p.runId,
    packName: p.packName,
    line,
    instanceId: key,
    ts: Date.now()
  } satisfies NodeOpLogEvent)
  p.updatedAt = Date.now()
  this.emit('op-progress', this.progressSnapshot(p))
}

export function getOpProgress(this: NodePackHost, instanceId?: string): UpdateProgress | null {
  if (instanceId) return this.opProgressMap.get(instanceId) || null
  // Latest stream by LAST-UPDATE time (for status polling without an id).
  // runId is a UUID — string-comparing it picked a pseudo-random "latest"
  // (0.1.13).
  let latest: (UpdateProgress & { updatedAt?: number }) | null = null
  let at = 0
  for (const p of this.opProgressMap.values()) {
    const ts = p.updatedAt ?? 0
    if (!latest || ts >= at) {
      latest = p
      at = ts
    }
  }
  return latest
}

export const opsMethods = {
  emitInstallProgress,
  beginOpAbort,
  endOpAbort,
  isOpActive,
  cancelOp,
  cancelUpdateBatch,
  emitBatch,
  progressSnapshot,
  computePercent,
  resetOpSteps,
  emitOpProgress,
  attachBatchContext,
  setStepFraction,
  setStepMessage,
  opLog,
  getOpProgress
}
