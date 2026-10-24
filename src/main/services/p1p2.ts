import { EventEmitter } from 'events'
import { randomUUID, createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'fs'
import type { Stats } from 'fs'
import { join, extname, basename, dirname } from 'path'
import type {
  BatchJob,
  BatchJobItem,
  BatchParamOverrides,
  BatchJobStatus,
  OutputAsset,
  RemoteInstanceConfig,
  RemoteInstanceStatus
} from '@shared/types'
import {
  deleteBatchJob,
  listBatchJobs,
  listOutputAssetsAll,
  listRemotes,
  upsertBatchJob,
  deleteOutputAsset,
  outputAssetsRev,
  mergeUpsertOutputAsset,
  mergeUpsertOutputAssets,
  updateOutputAsset,
  upsertRemote,
  deleteRemote,
  loadInstanceConfigs,
  loadSettings
} from './db'
import { resolveReadTarget } from './target'
import { ComfyApiClient } from './comfyApi'
import {
  readPngTextMetaFromFile,
  lookupPromptWorkflowLink,
  recordPromptWorkflowLink
} from './workflow'
import { lookupWorkflowByFingerprint } from './workflowFingerprint'
import { assertSafeRelativeFilename, sanitizeId } from './security'
import { classifyOutputType } from '@shared/mediaTypes'
import { LruCache } from './lru'

// ---------- helpers ----------

function instanceUrl(inst: { listen: string; port: number }): string {
  const host =
    inst.listen === '0.0.0.0' || inst.listen === '::' || inst.listen === '[::]'
      ? '127.0.0.1'
      : inst.listen
  return `http://${host}:${inst.port}`
}

/** Bearer auth for a configured remote — EVERY request must carry it, not just
 *  the reachability probe (0.1.11: protected remotes 401'd after a green test). */
function remoteAuthHeaders(remote?: { apiKey?: string }): Record<string, string> | undefined {
  return remote?.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : undefined
}

/**
 * Resolve the actual output directory for an instance.
 * ComfyUI allows `--output-directory <path>` in extraArgs — when present,
 * the output scanner MUST use that directory instead of the default `path/output`.
 */
export function resolveOutputDir(inst: { path: string; extraArgs?: string[] }): string {
  const args = inst.extraArgs || []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output-directory' && args[i + 1]) {
      const custom = args[i + 1]
      // Relative paths resolve against the instance root.
      return custom.match(/^[a-zA-Z]:[\\/]|^\//) ? custom : join(inst.path, custom)
    }
  }
  return join(inst.path, 'output')
}

function emptyItem(
  partial: Partial<BatchJobItem> & { workflowName: string; workflowPath: string; count: number }
): BatchJobItem {
  return {
    workflowId: partial.workflowId,
    workflowName: partial.workflowName,
    workflowPath: partial.workflowPath,
    count: partial.count,
    // Preserve in-flight progress when normalizing stored jobs; default to
    // empty for brand-new create() items.
    submitted: partial.submitted ?? 0,
    completed: partial.completed ?? 0,
    failed: partial.failed ?? 0,
    submitFailed: partial.submitFailed ?? 0,
    execFailed: partial.execFailed ?? 0,
    promptIds: partial.promptIds ?? [],
    seeds: partial.seeds ?? [],
    outputPaths: partial.outputPaths ?? [],
    cancelled: partial.cancelled
  }
}

/** Read a workflow file as a raw graph payload (UI or API form). */
function readWorkflowGraph(path: string): Record<string, unknown> | null {
  const ext = extname(path).toLowerCase()
  try {
    if (ext === '.png') {
      const meta = readPngTextMetaFromFile(path)
      if (meta.prompt) {
        try {
          return JSON.parse(String(meta.prompt)) as Record<string, unknown>
        } catch {
          /* fallthrough */
        }
      }
      if (meta.workflow) {
        try {
          return JSON.parse(String(meta.workflow)) as Record<string, unknown>
        } catch {
          /* fallthrough */
        }
      }
      return null
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function normalizeLegacyJob(raw: Record<string, unknown>): BatchJob {
  // 0.1.4 shape: { workflowPath, count, promptIds, ... } with no items[]
  const items = Array.isArray(raw.items) ? (raw.items as BatchJobItem[]) : null
  if (items && items.length) {
    const norm = items.map((it) => emptyItem({ ...it, count: it.count || 1 }))
    const sum = (pick: (i: BatchJobItem) => number): number =>
      norm.reduce((s, i) => s + (pick(i) || 0), 0)
    return {
      id: String(raw.id),
      name: String(raw.name || 'batch'),
      instanceId: String(raw.instanceId || ''),
      items: norm,
      status: (raw.status as BatchJobStatus) || 'queued',
      count: raw.count != null && Number(raw.count) > 0 ? Number(raw.count) : sum((i) => i.count),
      // `??` not `||` — zero is a legitimate value mid-run.
      submitted: raw.submitted != null ? Number(raw.submitted) : sum((i) => i.submitted),
      completed: raw.completed != null ? Number(raw.completed) : sum((i) => i.completed),
      failed: raw.failed != null ? Number(raw.failed) : sum((i) => i.failed),
      submitFailed:
        raw.submitFailed != null ? Number(raw.submitFailed) : sum((i) => i.submitFailed),
      execFailed: raw.execFailed != null ? Number(raw.execFailed) : sum((i) => i.execFailed),
      produced: raw.produced != null ? Number(raw.produced) : 0,
      createdAt: Number(raw.createdAt) || Date.now(),
      finishedAt: raw.finishedAt != null ? Number(raw.finishedAt) : undefined,
      notes: String(raw.notes || ''),
      errorSummary: raw.errorSummary != null ? String(raw.errorSummary) : undefined,
      params: (raw.params as BatchParamOverrides) || {},
      workflowPath: String(raw.workflowPath || norm[0]?.workflowPath || '')
    }
  }
  const item = emptyItem({
    workflowName: basename(String(raw.workflowPath || 'workflow')),
    workflowPath: String(raw.workflowPath || ''),
    count: Number(raw.count) || 1
  })
  if (Array.isArray(raw.promptIds)) item.promptIds = raw.promptIds as string[]
  item.submitted = item.promptIds.length
  return {
    id: String(raw.id),
    name: String(raw.name || 'batch'),
    instanceId: String(raw.instanceId || ''),
    items: [item],
    status: (raw.status as BatchJobStatus) || 'queued',
    count: item.count,
    submitted: item.submitted,
    completed: Number(raw.completed) || 0,
    failed: Number(raw.failed) || 0,
    submitFailed: Number(raw.submitFailed) || 0,
    execFailed: Number(raw.execFailed) || 0,
    produced: Number(raw.produced) || 0,
    createdAt: Number(raw.createdAt) || Date.now(),
    finishedAt: raw.finishedAt != null ? Number(raw.finishedAt) : undefined,
    notes: String(raw.notes || ''),
    errorSummary: raw.errorSummary != null ? String(raw.errorSummary) : undefined,
    params: (raw.params as BatchParamOverrides) || {},
    workflowPath: item.workflowPath
  }
}

// ---------- Batch ----------

export class BatchService extends EventEmitter {
  /** Ids with an in-flight run; cancel() clears the flag so late prompt results are ignored. */
  private runningIds = new Set<string>()
  /** In-flight promises for `batch.wait` (0.1.17 WP5-7). */
  private runs = new Map<string, Promise<BatchJob>>()
  /**
   * 0.1.17 (WP5): per-leg submit plan for a resumed/retry run. Absent = normal
   * full run. `start` is the attempt index to continue from, `count` how many
   * prompts to submit this time.
   */
  private runPlans = new Map<string, Array<{ start: number; count: number }>>()
  /**
   * 0.1.18 (WP4 / F4): the run loop used to re-read and re-parse the whole
   * `batch_jobs.jsonc` list before/after every prompt (O(prompts × jobs)).
   * The authoritative copy now lives in memory; disk writes for live jobs are
   * coalesced to one flush per 400 ms, while terminal states flush immediately
   * so a crash can never leave "running" on disk.
   */
  private cache: BatchJob[] | null = null
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private loadJobs(): BatchJob[] {
    if (!this.cache) {
      this.cache = listBatchJobs().map((j) =>
        normalizeLegacyJob(j as unknown as Record<string, unknown>)
      )
    }
    return this.cache
  }

  /** Persist one job: memory first, disk per the liveness rule above. */
  private persist(job: BatchJob): void {
    const arr = this.loadJobs()
    const idx = arr.findIndex((j) => j.id === job.id)
    const copy = { ...job }
    if (idx >= 0) arr[idx] = copy
    else arr.push(copy)
    this.dirty.add(job.id)
    const live = job.status === 'submitting' || job.status === 'running'
    if (!live) {
      this.flushBatchWrites()
      return
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushBatchWrites(), 400)
      // Never keep the app alive just to flush progress.
      this.flushTimer.unref?.()
    }
  }

  /** Force every pending job write to disk (called before quit and by tests). */
  flushBatchWrites(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.dirty.size) return
    const arr = this.loadJobs()
    for (const id of this.dirty) {
      const job = arr.find((j) => j.id === id)
      if (job) upsertBatchJob(job)
    }
    this.dirty.clear()
  }

  /** Drop a job from memory and disk (single owner of batch job state). */
  private forget(jobId: string): boolean {
    const arr = this.loadJobs()
    const idx = arr.findIndex((j) => j.id === jobId)
    if (idx >= 0) arr.splice(idx, 1)
    this.dirty.delete(jobId)
    return deleteBatchJob(jobId)
  }

  list(): BatchJob[] {
    const jobs = this.loadJobs()
    // 0.1.17 (WP5): self-heal — a persisted submitting/running job cannot be
    // live in this process, so it is `interrupted`, not "running forever".
    let changed = false
    for (const j of jobs) {
      if ((j.status === 'submitting' || j.status === 'running') && !this.runningIds.has(j.id)) {
        j.status = 'interrupted'
        j.finishedAt = j.finishedAt || Date.now()
        j.errorSummary = j.errorSummary || 'Interrupted by app exit — resume or re-run'
        this.persist(j)
        changed = true
      }
    }
    if (changed) this.emit('progress', jobs)
    // Callers receive copies: mutating a returned job must go through
    // persist(), otherwise the in-memory truth and disk would diverge.
    return jobs.map((j) => ({ ...j }))
  }

  create(input: {
    name: string
    instanceId: string
    items: Array<{
      workflowId?: string
      workflowName?: string
      workflowPath: string
      count: number
    }>
    notes?: string
    params?: BatchParamOverrides
  }): BatchJob {
    if (!input.items?.length) throw new Error('Batch job needs at least one workflow')
    const items = input.items.map((it) => {
      if (!it.workflowPath || !existsSync(it.workflowPath)) {
        throw new Error(`Workflow not found: ${it.workflowPath || '(empty)'}`)
      }
      return emptyItem({
        workflowId: it.workflowId,
        workflowName: it.workflowName || basename(it.workflowPath, extname(it.workflowPath)),
        workflowPath: it.workflowPath,
        count: Math.max(1, Math.min(500, Number(it.count) || 1))
      })
    })
    const rec: BatchJob = {
      id: randomUUID(),
      name: input.name || 'Batch',
      instanceId: input.instanceId,
      items,
      status: 'queued',
      count: items.reduce((s, i) => s + i.count, 0),
      submitted: 0,
      completed: 0,
      failed: 0,
      submitFailed: 0,
      execFailed: 0,
      produced: 0,
      createdAt: Date.now(),
      notes: input.notes || '',
      params: input.params || {},
      workflowPath: items[0].workflowPath
    }
    this.persist(rec)
    return rec
  }

  /**
   * 0.1.17 (WP5): continue an interrupted job. Only the legs that never
   * completed are submitted again; counters and already-linked outputs stay.
   * NOTE the honest boundary: prompts still inside ComfyUI's queue cannot be
   * recovered after a server restart — they are re-submitted, not restored.
   */
  async resume(id: string): Promise<BatchJob> {
    return this.start(id, { resume: true, plans: this.resumePlans(id) })
  }

  /** Plan for "only the legs that never ran" (shared by resume + resumeAsync). */
  private resumePlans(id: string): Array<{ start: number; count: number }> {
    this.list() // reconcile: interrupted rather than a ghost "running"
    const job = this.list().find((j) => j.id === id)
    if (!job) throw new Error('Batch job not found')
    if (job.status === 'running' || job.status === 'submitting') {
      throw new Error('Batch job is already running')
    }
    // 0.1.17 (review fix): a prompt submitted right before the app died can
    // never be recovered (its history is gone). Counting it as "attempted"
    // silently dropped it; count it as failed and say so, so the job reports
    // the loss and "Retry failed" can re-run exactly those.
    this.markLostPrompts(job)
    const plans = job.items.map((it) => {
      const attempted = Math.min(it.count, it.submitted + it.failed)
      return { start: attempted, count: Math.max(0, it.count - attempted) }
    })
    if (!plans.some((p) => p.count > 0)) {
      throw new Error('Nothing left to resume — start commits a fresh run')
    }
    return plans
  }

  /**
   * Prompts handed to ComfyUI that never settled (app exited mid-run). They are
   * lost forever — there is no history to link outputs from — so they become
   * failures instead of vanishing from the counters.
   */
  private markLostPrompts(job: BatchJob): void {
    let lost = 0
    for (const it of job.items) {
      const unsettled = Math.max(0, it.submitted - it.completed - it.failed)
      if (!unsettled) continue
      it.execFailed += unsettled
      it.failed += unsettled
      job.execFailed += unsettled
      job.failed += unsettled
      lost += unsettled
    }
    if (!lost) return
    const note = `Lost ${lost} in-flight prompt(s) when the app exited — counted as failed; use "Retry failed" to re-run them`
    job.notes = [job.notes, note].filter(Boolean).join('; ')
    job.errorSummary = note
    this.persist(job)
    this.emit('progress', job)
  }

  /**
   * 0.1.17 (WP5-7): fire-and-forget resume for the IPC layer — same validation
   * as resume(), returns the accepted snapshot instead of the terminal job.
   */
  resumeAsync(id: string): BatchJob {
    return this.startAsync(id, { resume: true, plans: this.resumePlans(id) })
  }

  /**
   * 0.1.17 (WP5): re-submit only the legs that failed. This counts as a NEW run
   * (counters start at zero) so the UI reports what the retry achieved instead
   * of mixing runs together.
   */
  async retryFailed(id: string): Promise<BatchJob> {
    return this.start(id, { plans: this.retryPlans(id) })
  }

  private retryPlans(id: string): Array<{ start: number; count: number }> {
    this.list()
    const job = this.list().find((j) => j.id === id)
    if (!job) throw new Error('Batch job not found')
    if (job.status === 'running' || job.status === 'submitting') {
      throw new Error('Batch job is already running')
    }
    // 0.1.17 (review fix): continue the iteration counter past the attempts
    // already made. Starting at 0 re-used the same increment seeds, so a retry
    // re-rendered the same images with the same seeds as the first run.
    const plans = job.items.map((it) => ({
      start: Math.max(0, it.submitted + it.failed),
      count: Math.max(0, it.failed)
    }))
    if (!plans.some((p) => p.count > 0)) throw new Error('No failed prompts to retry')
    return plans
  }

  /** 0.1.17 (WP5-7): fire-and-forget retry for the IPC layer. */
  retryFailedAsync(id: string): BatchJob {
    return this.startAsync(id, { plans: this.retryPlans(id) })
  }

  /**
   * 0.1.17 (WP5-7): fire-and-forget start used by the IPC layer so a long batch
   * never holds the request open. `wait(id)` yields the same terminal job the
   * awaited `start()` would have returned.
   */
  startAsync(
    id: string,
    opts?: {
      resume?: boolean
      plans?: Array<{ start: number; count: number }>
    }
  ): BatchJob {
    if (this.runningIds.has(id)) throw new Error('Batch job is already running')
    const job = this.list().find((j) => j.id === id)
    if (!job) throw new Error('Batch job not found')
    const p = this.start(id, opts)
    this.runs.set(id, p)
    void p
      .catch(() => undefined)
      .finally(() => {
        if (this.runs.get(id) === p) this.runs.delete(id)
      })
    // The synchronous prologue of start() already flipped the status/counters.
    return this.list().find((j) => j.id === id) || job
  }

  /** Await the in-flight run for `id` (0.1.17 WP5-7 `batch.wait`). */
  async wait(id: string): Promise<BatchJob | null> {
    const p = this.runs.get(id)
    if (p) {
      try {
        return await p
      } catch {
        // The run failed — return the persisted terminal snapshot instead of
        // throwing twice for the same failure.
      }
    }
    return this.list().find((j) => j.id === id) || null
  }

  /**
   * Submit every leg of the job to ComfyUI, then poll history until all
   * prompts settle so `produced` reflects real images — not just "queued".
   */
  async start(
    id: string,
    opts?: {
      /** 0.1.17 (WP5): keep counters and only submit the remaining legs. */
      resume?: boolean
      /** Explicit per-leg submit plan (retry-failed). */
      plans?: Array<{ start: number; count: number }>
    }
  ): Promise<BatchJob> {
    if (this.runningIds.has(id)) {
      throw new Error('Batch job is already running')
    }
    if (opts?.plans) this.runPlans.set(id, opts.plans)
    const jobs = this.list()
    const job = jobs.find((j) => j.id === id)
    if (!job) {
      this.runPlans.delete(id)
      throw new Error('Batch job not found')
    }
    // Any deliberate re-run (done / error / queued / cancelled / interrupted)
    // starts from a clean slate: leftover counters from a previous run would
    // otherwise inflate submitted/completed and hide real failures.
    const rerun =
      !opts?.resume &&
      (job.status === 'done' ||
        job.status === 'error' ||
        job.status === 'queued' ||
        job.status === 'cancelled' ||
        job.status === 'interrupted')
    if (rerun) {
      job.submitted = 0
      job.failed = 0
      job.submitFailed = 0
      job.execFailed = 0
      job.produced = 0
      job.completed = 0
      job.finishedAt = undefined
      job.errorSummary = undefined
      for (const it of job.items) {
        it.submitted = 0
        it.completed = 0
        it.failed = 0
        it.submitFailed = 0
        it.execFailed = 0
        it.promptIds = []
        it.seeds = []
        it.outputPaths = []
        // 0.1.17 (WP5): a re-run must clear per-leg cancel flags, otherwise a
        // previously cancelled leg is silently skipped forever.
        it.cancelled = false
      }
    }
    if (!opts?.plans) this.runPlans.delete(job.id)
    job.runId = randomUUID()
    job.startedAt = Date.now()
    job.status = 'submitting'
    job.finishedAt = undefined
    this.persist(job)
    this.emit('progress', job)

    // Local instance, or a configured remote (`remote:<id>` instanceId).
    const remoteId = job.instanceId.startsWith('remote:')
      ? job.instanceId.slice('remote:'.length)
      : ''
    const remote = remoteId ? listRemotes().find((r) => r.id === remoteId) : undefined
    // A recorded id that no longer resolves must FAIL the job — silently
    // falling back to instances[0] ran the batch on the wrong instance
    // (0.1.13).
    const inst = remote ? null : resolveReadTarget(job.instanceId)
    if (!inst && !remote) {
      const reason = job.instanceId
        ? `Instance not found: ${job.instanceId}`
        : 'No instance configured'
      job.status = 'error'
      job.finishedAt = Date.now()
      job.notes = [job.notes, reason].filter(Boolean).join('; ')
      job.errorSummary = reason
      this.persist(job)
      this.emit('progress', job)
      throw new Error(reason)
    }
    const url = remote ? remote.baseUrl.replace(/\/+$/, '') : instanceUrl(inst!)
    // Remote outputs cannot be verified on this machine — `produced` counts
    // history-reported files instead of indexed local paths (0.1.11).
    const localInstancePath = inst?.path || ''
    // 0.1.17 (WP5): the scanner must follow `--output-directory`, not assume
    // `<instance>/output` — otherwise produced=0 while files exist elsewhere.
    const localOutputDir = inst ? resolveOutputDir(inst) : ''
    const client = new ComfyApiClient(url, { headers: remoteAuthHeaders(remote) })

    this.runningIds.add(id)
    try {
      const { buildIterationPrompt } = await import('./workflowConvert')
      const { COMFY_CLIENT_ID } = await import('./comfyApi')

      for (let li = 0; li < job.items.length; li++) {
        const item = job.items[li]
        // 0.1.18 (review): retry/failed plans narrow how many attempts THIS run
        // makes. Counting "remaining" from the cumulative item counters made a
        // cancelled retry report every original prompt as failed.
        const plan = this.runPlans.get(job.id)?.[li]
        // Per-item cancel — skip the rest of this leg entirely.
        if (item.cancelled) {
          const skip = plan
            ? Math.max(0, plan.count)
            : Math.max(0, item.count - item.submitted - item.failed)
          item.submitFailed += skip
          item.failed += skip
          job.submitFailed += skip
          job.failed += skip
          this.persist(job)
          this.emit('progress', job)
          continue
        }
        const graph = readWorkflowGraph(item.workflowPath)
        if (!graph) {
          const unparseable = plan
            ? Math.max(0, plan.count)
            : Math.max(0, item.count - item.submitted)
          item.submitFailed += unparseable
          item.failed += unparseable
          job.submitFailed += unparseable
          job.failed += unparseable
          job.notes = [job.notes, `#${li + 1} cannot parse ${basename(item.workflowPath)}`]
            .filter(Boolean)
            .join('; ')
            .slice(-800)
          this.persist(job)
          this.emit('progress', job)
          continue
        }

        // Independent loop counter — item.submitted does NOT advance on
        // submit failure, so reusing it would collide seeds in increment mode.
        // 0.1.17 (WP5): a resume/retry plan narrows which attempts this run makes.
        // `start` is the ITERATION number (seed derivation), `count` how many
        // attempts this run makes. A retry starts past the attempts it already
        // made, so `start` may equal `item.count` — it must not clamp `count`.
        const startAt = plan ? Math.max(0, plan.start) : 0
        const runCount = plan ? Math.max(0, plan.count) : item.count
        let iteration = startAt
        for (let i = 0; i < runCount; i++) {
          const live = this.list().find((j) => j.id === id)
          if (!this.runningIds.has(id) || live?.status === 'cancelled') {
            return this.finishCancel(job)
          }
          if (live?.items?.[li]?.cancelled) {
            // Only the attempts this run still owed are skipped.
            const skip = plan
              ? Math.max(0, runCount - i)
              : Math.max(0, item.count - item.submitted - item.failed)
            item.submitFailed += skip
            item.failed += skip
            job.submitFailed += skip
            job.failed += skip
            this.persist(job)
            this.emit('progress', job)
            break
          }
          let seed = 0
          try {
            const built = buildIterationPrompt(graph, {
              iteration,
              seedMode: job.params.seedMode || 'random',
              baseSeed: job.params.baseSeed,
              width: job.params.width,
              height: job.params.height,
              steps: job.params.steps,
              cfg: job.params.cfg
            })
            seed = built.seed
            const promptId = await client.queuePrompt(built.prompt, COMFY_CLIENT_ID, {
              metadata: {
                source: 'comfypilot',
                batchJobId: job.id,
                ...(item.workflowId ? { workflowId: item.workflowId } : {}),
                ...(item.workflowName
                  ? { workflowName: String(item.workflowName).slice(0, 80) }
                  : {})
              }
            })
            const after = this.list().find((j) => j.id === id)
            if (!this.runningIds.has(id) || after?.status === 'cancelled') {
              // Result arrived after cancel — do not count as success.
              if (promptId) void this.tryDequeue(client, [promptId])
              return this.finishCancel(job)
            }
            if (promptId) {
              item.promptIds.push(promptId)
              item.seeds.push(seed)
              item.submitted += 1
              job.submitted += 1
              iteration += 1
              // Persist the prompt→workflow sidecar so an index rebuild can
              // re-attribute outputs even without the batch record (0.1.11).
              try {
                recordPromptWorkflowLink(promptId, item.workflowId, item.workflowName)
              } catch {
                /* best-effort */
              }
            } else {
              // Submit refused — never accepted, so it is NOT an exec failure.
              item.submitFailed += 1
              item.failed += 1
              job.submitFailed += 1
              job.failed += 1
              iteration += 1
            }
          } catch (err) {
            item.submitFailed += 1
            item.failed += 1
            job.submitFailed += 1
            job.failed += 1
            iteration += 1
            const msg = err instanceof Error ? err.message : String(err)
            job.notes = [job.notes, `#${li + 1}.${i + 1} ${msg}`]
              .filter(Boolean)
              .join('; ')
              .slice(-800)
          }
          this.persist(job)
          this.emit('progress', job)
        }
      }

      // Wait for real image completion (or timeout) so the UI shows produced counts.
      job.status = 'running'
      this.persist(job)
      this.emit('progress', job)
      const settledIds = await this.awaitOutputs(job.id, client, localInstancePath, localOutputDir)

      // The job may have been removed while we were polling — never resurrect it.
      const latest = this.list().find((j) => j.id === id)
      if (!latest) return job
      if (latest.status === 'cancelled') return latest
      // Prefer the post-awaitOutputs snapshot so produced/outputPaths survive.
      const done = latest
      // Terminal state:
      //   submitted    = prompts handed to ComfyUI
      //   completed    = prompts that settled successfully
      //   submitFailed = prompts never accepted (refused / build error)
      //   execFailed   = prompts accepted but failed in execution
      //   failed       = submitFailed + execFailed (display compat)
      //   produced     = images linked from history
      if (!done.submitted) {
        done.submitted = done.items.reduce((s, it) => s + (it.submitted || 0), 0)
      }
      // Unsettled = accepted prompts that never reached a terminal exec state.
      // CRITICAL: must subtract ONLY execFailed — including submitFailed here
      // would let submit-failures mask real timeouts (unsettled goes negative).
      const unsettled = done.submitted - done.completed - (done.execFailed || 0)
      if (unsettled > 0) {
        // Only the prompts that never settled — not every promptId on the job.
        const allIds = done.items.flatMap((it) => it.promptIds)
        const timedOutIds = allIds.filter((p) => !settledIds.has(p))
        done.status = 'error'
        const note =
          `timed out waiting for ${unsettled} prompt(s): ` +
          timedOutIds.slice(0, 8).join(', ') +
          (timedOutIds.length > 8 ? '...' : '')
        done.notes = [done.notes, note].filter(Boolean).join('; ').slice(-800)
        done.errorSummary = `Timeout: ${unsettled} prompt(s) never settled`
      } else if (done.completed === 0 && done.failed > 0) {
        done.status = 'error'
        done.errorSummary = `All ${done.failed} prompt(s) failed`
      } else {
        done.status = 'done'
      }
      // Concise failure summary for the UI card (notes stays the full log).
      if (!done.errorSummary && done.failed > 0) {
        done.errorSummary = `${done.failed} failed · ${done.completed} ok · ${done.produced} produced`
      }
      done.finishedAt = Date.now()
      this.persist(done)
      this.emit('progress', done)
      return done
    } catch (e) {
      const still = this.list().find((j) => j.id === id)
      if (still) {
        still.status = 'error'
        still.finishedAt = Date.now()
        const msg = e instanceof Error ? e.message : String(e)
        still.notes = [still.notes, msg].filter(Boolean).join('; ').slice(-800)
        still.errorSummary = msg.slice(0, 200)
        this.persist(still)
        this.emit('progress', still)
      }
      throw e
    } finally {
      this.runningIds.delete(id)
      this.runPlans.delete(id)
    }
  }

  private finishCancel(job: BatchJob): BatchJob {
    // Do not resurrect a job that was deleted mid-run.
    const live = this.list().find((j) => j.id === job.id)
    if (!live) return job
    live.status = 'cancelled'
    live.finishedAt = Date.now()
    this.persist(live)
    this.emit('progress', live)
    return live
  }

  /**
   * HTTP client for a job's target — local instance, or a configured remote
   * (`remote:<id>` instanceId). Remote batch runs use the remote baseUrl
   * directly (0.1.11).
   */
  private clientForJob(job: BatchJob): ComfyApiClient | null {
    const remoteId = job.instanceId.startsWith('remote:')
      ? job.instanceId.slice('remote:'.length)
      : ''
    if (remoteId) {
      const remote = listRemotes().find((r) => r.id === remoteId)
      return remote
        ? new ComfyApiClient(remote.baseUrl.replace(/\/+$/, ''), {
            headers: remoteAuthHeaders(remote)
          })
        : null
    }
    const inst = resolveReadTarget(job.instanceId)
    return inst ? new ComfyApiClient(instanceUrl(inst)) : null
  }

  /** Best-effort: ask ComfyUI to drop still-pending prompts. */
  private async tryDequeue(client: ComfyApiClient, promptIds: string[]): Promise<void> {
    try {
      await client.deleteQueueItems(promptIds)
    } catch {
      /* ComfyUI may already have executed them */
    }
  }

  /**
   * Poll ComfyUI history until every promptId has settled.
   * Uses both the bulk `/history` window AND per-prompt `/history/<id>` so
   * prompts that fall out of the rolling window still settle.
   * Successful prompts bump `produced` + `item.completed` and link output files.
   */
  private async awaitOutputs(
    jobId: string,
    client: ComfyApiClient,
    instancePath: string,
    outputDir: string
  ): Promise<Set<string>> {
    const settled = new Set<string>()
    // Scale the wait with the job: 30s base + 20s per prompt, capped at 30 min.
    const first = this.list().find((j) => j.id === jobId)
    const totalPrompts = first ? first.items.reduce((s, it) => s + it.promptIds.length, 0) : 1
    const deadline = Date.now() + Math.min(30 * 60 * 1000, 30_000 + totalPrompts * 20_000)
    let consecutiveEmpty = 0

    while (Date.now() < deadline) {
      const live = this.list().find((j) => j.id === jobId)
      if (!live || live.status === 'cancelled' || !this.runningIds.has(jobId)) return settled

      const allIds = live.items.flatMap((it) => it.promptIds)
      const pending = allIds.filter((p) => !settled.has(p))
      if (!pending.length) break

      // Bulk window first (cheap), then per-id lookups for anything still pending.
      let history: Awaited<ReturnType<ComfyApiClient['history']>> = []
      try {
        history = await client.history(Math.max(200, pending.length + 50))
      } catch {
        history = []
      }
      const byId = new Map(history.map((h) => [h.promptId, h]))
      consecutiveEmpty = history.length === 0 ? consecutiveEmpty + 1 : 0

      // 0.1.17 (WP5): point lookups run 8-at-a-time — the old serial loop made
      // a 60-prompt job take 60 round-trips per poll.
      const missing = pending.filter((p) => !byId.has(p))
      const fetched = new Map<string, Awaited<ReturnType<ComfyApiClient['historyItem']>>>()
      for (let i = 0; i < missing.length; i += 8) {
        const batch = missing.slice(i, i + 8)
        const results = await Promise.all(
          batch.map(async (pid) => {
            try {
              return [pid, await client.historyItem(pid)] as const
            } catch {
              return [pid, null] as const
            }
          })
        )
        for (const [pid, one] of results) if (one) fetched.set(pid, one)
        if (!this.runningIds.has(jobId)) return settled
      }

      for (const pid of pending) {
        const h = byId.get(pid) ?? fetched.get(pid) ?? null
        if (!h) continue
        settled.add(pid)
        const ok = h.status !== 'error'
        for (const item of live.items) {
          const idx = item.promptIds.indexOf(pid)
          if (idx < 0) continue
          if (ok) {
            item.completed += 1
            live.completed += 1
          } else {
            // Accepted-but-failed — this is an exec failure, NOT a submit failure.
            item.execFailed += 1
            item.failed += 1
            live.execFailed += 1
            live.failed += 1
          }
        }
        // Link output files from history. `produced` counts ONLY files that
        // actually exist on disk and are pushed into item.outputPaths — a
        // "success" prompt whose files are missing is NOT a produced image.
        if (ok && h.outputs?.length) {
          if (!instancePath) {
            // Remote target (0.1.11): the remote filesystem is not ours to
            // scan — count history-reported outputs honestly, never fabricate
            // local paths.
            live.produced += h.outputs.length
          } else {
            for (const out of h.outputs) {
              const abs = this.resolveHistoryOutput(out, instancePath, outputDir)
              if (!abs) continue
              let linked = false
              for (const item of live.items) {
                if (item.promptIds.includes(pid) && !item.outputPaths.includes(abs)) {
                  item.outputPaths.push(abs)
                  linked = true
                }
              }
              if (linked) live.produced += 1
              this.indexPromptOutput(abs, live, pid)
            }
          }
        }
      }
      // A cancel during history() must not be clobbered by this stale snapshot.
      if (!this.runningIds.has(jobId)) return settled
      this.persist(live)
      this.emit('progress', live)

      if (settled.size >= allIds.length) break
      // Nothing is ever coming back — stop burning the deadline.
      if (consecutiveEmpty >= 12 && settled.size === 0) break
      await new Promise((r) => setTimeout(r, 2500))
    }

    // Final pass: persist whatever settled. Unsettled prompts stay pending —
    // they are neither produced nor failed (history may still be writing).
    const live = this.list().find((j) => j.id === jobId)
    if (live && live.status !== 'cancelled') {
      this.persist(live)
      this.emit('progress', live)
    }
    return settled
  }

  private resolveHistoryOutput(
    out: { filename?: string; subfolder?: string; type?: string },
    instancePath: string,
    outputDir?: string
  ): string | null {
    if (!out?.filename) return null
    const sub = out.subfolder || ''
    // 0.1.17 (WP5): `output` files live under the resolved output dir (which
    // already honours --output-directory); inputs stay under the instance.
    const base =
      out.type === 'input' ? join(instancePath, 'input') : outputDir || join(instancePath, 'output')
    const abs = join(base, sub, basename(out.filename))
    if (!existsSync(abs)) {
      // History referenced a file that is not on disk — log it so the gap is
      // visible, and do NOT count it as a produced image.
      console.warn(`[batch] history output file missing: ${abs}`)
      return null
    }
    return abs
  }

  private indexPromptOutput(abs: string, job: BatchJob, promptId: string): void {
    try {
      const st = statSync(abs)
      const item = job.items.find((it) => it.promptIds.includes(promptId))
      const id = createHash('sha1').update(abs).digest('hex').slice(0, 16)
      const params: Record<string, unknown> = { promptId, batchJobId: job.id }
      let seed: number | undefined
      if (/\.png$/i.test(abs)) {
        try {
          const meta = readPngTextMetaFromFile(abs)
          if (meta.seed) seed = Number(meta.seed)
          if (meta.prompt) {
            try {
              const prompt = JSON.parse(String(meta.prompt)) as Record<
                string,
                { inputs?: Record<string, unknown> }
              >
              params.nodeCount = Object.keys(prompt).length
              for (const node of Object.values(prompt)) {
                if (node?.inputs && typeof node.inputs.seed === 'number' && seed == null) {
                  seed = node.inputs.seed as number
                }
              }
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
      }
      if (seed == null && item?.seeds.length) {
        const idx = item.promptIds.indexOf(promptId)
        if (idx >= 0) seed = item.seeds[idx]
      }
      mergeUpsertOutputAsset({
        id,
        path: abs,
        fileName: basename(abs),
        // 0.1.14: unified classification (adds 3d + audio + raw images; the old
        // inline chain also silently defaulted unknown files to 'image').
        type: classifyOutputType(basename(abs)),
        size: st.size,
        createdAt: st.mtimeMs,
        seed,
        promptId,
        workflowId: item?.workflowId,
        workflowName: item?.workflowName,
        batchJobId: job.id,
        params
      })
    } catch {
      /* indexing is best-effort */
    }
  }

  /**
   * Per-item cancel: mark one workflow leg cancelled, dequeue its pending
   * prompts, and let the submit loop skip whatever is left.
   */
  cancelItem(id: string, workflowPath: string): BatchJob {
    const job = this.list().find((j) => j.id === id)
    if (!job) throw new Error('Batch job not found')
    const item = job.items.find((it) => it.workflowPath === workflowPath)
    if (!item) throw new Error('Batch item not found')
    item.cancelled = true
    this.persist(job)
    this.emit('progress', job)

    // Fire-and-forget cancel of this leg's prompts. ComfyUI 0.39+'s atomic
    // /api/jobs cancel can stop the RUNNING one too; older builds fall back to
    // dequeuing the still-pending prompts only.
    void (async () => {
      try {
        const client = this.clientForJob(job)
        if (!client) return
        const ids = [...item.promptIds]
        if (!ids.length) return
        const atomic = await client.jobsCancel(ids)
        // Per-leg fallback stays dequeue-only: a directed interrupt on an older
        // build would be GLOBAL and could kill a sibling leg's running prompt.
        if (!atomic) await this.tryDequeue(client, ids)
      } catch {
        /* ignore */
      }
    })()
    return job
  }

  cancel(id: string): BatchJob {
    // 0.1.17 (review fix): read the job BEFORE dropping the running flag.
    // `list()` self-heals submitting/running rows to `interrupted`, so deleting
    // first made a user cancel look like an app crash.
    const job = this.list().find((j) => j.id === id)
    this.runningIds.delete(id)
    if (!job) throw new Error('Batch job not found')
    // Never clobber a terminal state that is not re-runnable via cancel.
    if (job.status === 'done' || job.status === 'error') {
      return job
    }
    job.status = 'cancelled'
    job.finishedAt = Date.now()
    this.persist(job)
    this.emit('progress', job)

    // Fire-and-forget cancel: atomic jobs cancel on 0.39+, plain dequeue otherwise.
    void (async () => {
      try {
        const client = this.clientForJob(job)
        if (!client) return
        const ids = job.items.flatMap((it) => it.promptIds)
        if (!ids.length) return
        const atomic = await client.jobsCancel(ids)
        if (!atomic) {
          // Legacy fallback: drop pending prompts, then directed-interrupt the
          // most recently submitted ones. On 0.39+ a prompt_id only interrupts
          // THAT running job; older builds ignore the body (a global interrupt,
          // acceptable here because the user cancelled the WHOLE job).
          await client.deleteQueueItems(ids)
          for (const pid of ids.slice(-5).reverse()) void client.interrupt(pid, 1500)
        }
      } catch {
        /* ignore */
      }
    })()
    return job
  }

  remove(id: string): boolean {
    if (this.runningIds.has(id)) {
      throw new Error('Batch job is running — cancel it before removing')
    }
    this.runningIds.delete(id)
    return this.forget(id)
  }
}

export const batchService = new BatchService()

// ---------- Output ----------

export class OutputService {
  /**
   * 0.1.18 (WP4/F5): sorted/filtered list cache. Keyed by the mutation
   * revision exported by db, so it can never serve stale ordering — the entry
   * is dropped the moment any writer bumps the revision.
   */
  private listCache: { rev: number; key: string; rows: OutputAsset[] } | null = null
  /**
   * Resident path→asset map used by walks: O(1) lookups instead of a per-file
   * scan of the whole index (the old `listOutputAssetsAll().find(...)`).
   */
  private readonly prevMap = new LruCache<string, OutputAsset>(50_000)

  private refreshPrevMap(): void {
    for (const a of listOutputAssetsAll()) this.prevMap.set(a.path, a)
  }

  /**
   * Walk the output roots and merge what is on disk into the index (0.1.17
   * WP7). Expensive by design — call it on page entry or an explicit refresh,
   * never on every list/page/filter call.
   */
  scan(root?: string): number {
    const roots = root ? [root] : this.defaultScanRoots()
    // Depth is user-tunable (0.1.9): deep date/nested folders were silently
    // invisible at the old hardcoded 4.
    const raw = Number(loadSettings().outputScanDepth ?? 4)
    const maxDepth = Number.isFinite(raw) ? Math.max(2, Math.min(10, Math.floor(raw))) : 4
    this.refreshPrevMap()
    const assets: OutputAsset[] = []
    for (const r of roots) {
      if (!r || !existsSync(r)) continue
      this.walk(r, assets, 0, maxDepth)
    }
    // Field-level merge so batch/walk concurrent writes never drop linkage.
    // One read-modify-write for the whole walk, not one per file.
    mergeUpsertOutputAssets(assets)
    for (const a of assets) this.prevMap.set(a.path, a)
    return assets.length
  }

  /** Output roots of every local instance (plus a caller-picked root). */
  private defaultScanRoots(): string[] {
    const roots: string[] = []
    for (const c of loadInstanceConfigs()) {
      if (!c.path) continue
      try {
        roots.push(resolveOutputDir(c))
      } catch {
        /* malformed config — skip */
      }
    }
    return roots
  }

  list(opts?: {
    root?: string
    type?: string
    limit?: number
    offset?: number
    favorite?: boolean
    batchJobId?: string
    workflowId?: string
    /** Any-of match across workflow ids (0.1.11 — duplicate-name copies). */
    workflowIds?: string[]
    sort?: 'createdAt' | 'size' | 'name'
    order?: 'asc' | 'desc'
    createdFrom?: number
    createdTo?: number
  }): { items: OutputAsset[]; total: number; truncated: boolean } {
    // 0.1.17 (WP7): listing no longer walks the disk. Callers scan explicitly
    // via `output.scan` (page entry / manual refresh), so paging and filtering
    // are index-only. The old behaviour re-walked 13 GB on every page change.
    const rev = outputAssetsRev()
    const cacheKey = JSON.stringify({
      root: opts?.root || '',
      type: opts?.type || '',
      favorite: Boolean(opts?.favorite),
      batchJobId: opts?.batchJobId || '',
      workflowId: opts?.workflowId || '',
      workflowIds: opts?.workflowIds?.slice().sort() || [],
      sort: opts?.sort || 'createdAt',
      order: opts?.order || 'desc',
      createdFrom: opts?.createdFrom ?? null,
      createdTo: opts?.createdTo ?? null
    })
    if (this.listCache && this.listCache.rev === rev && this.listCache.key === cacheKey) {
      const cached = this.listCache.rows
      const limitC = Math.max(1, Math.min(Math.floor(Number(opts?.limit) || 200), 200))
      const offsetC = Math.max(0, Math.floor(Number(opts?.offset) || 0))
      return {
        items: cached.slice(offsetC, offsetC + limitC),
        total: cached.length,
        truncated: offsetC + Math.min(limitC, Math.max(0, cached.length - offsetC)) < cached.length
      }
    }
    let all = listOutputAssetsAll()
    // When the caller scoped a root, only show files under it (the global index
    // also holds other instances / older roots).
    if (opts?.root) {
      const root = opts.root.replace(/[\\/]+$/, '')
      all = all.filter(
        (a) => a.path === root || a.path.startsWith(root + '/') || a.path.startsWith(root + '\\')
      )
    }
    if (opts?.type && opts.type !== 'all') all = all.filter((a) => a.type === opts.type)
    if (opts?.favorite) all = all.filter((a) => a.favorite)
    if (opts?.batchJobId) all = all.filter((a) => a.batchJobId === opts.batchJobId)
    // workflowIds (any-of) wins over the legacy single-id filter.
    if (opts?.workflowIds?.length) {
      const wanted = new Set(opts.workflowIds)
      all = all.filter((a) => Boolean(a.workflowId && wanted.has(a.workflowId)))
    } else if (opts?.workflowId) {
      all = all.filter((a) => a.workflowId === opts.workflowId)
    }
    // Date range filter on createdAt (epoch ms).
    if (opts?.createdFrom != null) all = all.filter((a) => a.createdAt >= opts.createdFrom!)
    if (opts?.createdTo != null) all = all.filter((a) => a.createdAt <= opts.createdTo!)

    const sort = opts?.sort || 'createdAt'
    const order = opts?.order === 'asc' ? 1 : -1
    all = [...all].sort((a, b) => {
      if (sort === 'name') return order * a.fileName.localeCompare(b.fileName)
      if (sort === 'size') return order * (a.size - b.size)
      return order * (a.createdAt - b.createdAt)
    })
    this.listCache = { rev, key: cacheKey, rows: all }

    // 0.1.17 (WP7): clamp here as well as at the IPC edge — a page must never be
    // unbounded just because a caller forgot the limit.
    const limit = Math.max(1, Math.min(Math.floor(Number(opts?.limit) || 200), 200))
    const offset = Math.max(0, Math.floor(Number(opts?.offset) || 0))
    const items = all.slice(offset, offset + limit)
    return {
      items,
      total: all.length,
      truncated: offset + items.length < all.length
    }
  }

  private walk(dir: string, out: OutputAsset[], depth: number, maxDepth = 4): void {
    if (depth > maxDepth) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          this.walk(full, out, depth + 1, maxDepth)
          continue
        }
        this.processFile(full, name, st, out)
      } catch {
        /* skip */
      }
    }
  }

  /** Cancel a running `scanAsync` (0.1.17 review fix). */
  cancelScan(): void {
    this.scanCancelRequested = true
  }

  private scanCancelRequested = false

  /**
   * Cancellable, yielding variant of `scan()` for the UI. It walks directory by
   * directory, yields to the event loop between directories (so IPC and input
   * stay responsive on a 13 GB output tree) and reports progress.
   */
  async scanAsync(
    root?: string,
    onProgress?: (p: { scanned: number; total: number; done: boolean; cancelled: boolean }) => void
  ): Promise<{ scanned: number; cancelled: boolean }> {
    this.scanCancelRequested = false
    const roots = root ? [root] : this.defaultScanRoots()
    const raw = Number(loadSettings().outputScanDepth ?? 4)
    const maxDepth = Number.isFinite(raw) ? Math.max(2, Math.min(10, Math.floor(raw))) : 4
    this.refreshPrevMap()
    const assets: OutputAsset[] = []
    let cancelled = false
    const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
    const walkDir = async (dir: string, depth: number): Promise<void> => {
      if (cancelled || this.scanCancelRequested || depth > maxDepth) {
        cancelled = cancelled || this.scanCancelRequested
        return
      }
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (this.scanCancelRequested) {
          cancelled = true
          return
        }
        const full = join(dir, name)
        try {
          const st = statSync(full)
          if (st.isDirectory()) {
            await walkDir(full, depth + 1)
            continue
          }
          this.processFile(full, name, st, assets)
        } catch {
          /* skip unreadable entry */
        }
      }
      // A cancel requested by the progress callback (or another IPC) must be
      // reflected even when no entry is left in this directory.
      if (this.scanCancelRequested) cancelled = true
      onProgress?.({ scanned: assets.length, total: assets.length, done: false, cancelled })
      // Directory boundary: let IPC input and other windows work again.
      await tick()
    }
    for (const r of roots) {
      if (!r || !existsSync(r)) continue
      await walkDir(r, 0)
      if (cancelled) break
    }
    // A cancelled scan still merges what it read: partial truth beats a stale
    // index, and the next scan fills the rest.
    mergeUpsertOutputAssets(assets)
    for (const a of assets) this.prevMap.set(a.path, a)
    onProgress?.({ scanned: assets.length, total: assets.length, done: true, cancelled })
    return { scanned: assets.length, cancelled }
  }

  /**
   * Build the index row for one file, or return null when the file is not an
   * indexable output. Extracted so the synchronous walk and the cancellable
   * async walk share exactly one implementation (0.1.17 review fix).
   */
  private processFile(full: string, name: string, st: Stats, out: OutputAsset[]): void {
    const ext = extname(name).toLowerCase()
    // 0.1.14: single source of truth — 3d/audio/raw-image files are now
    // indexed (the old inline chain dropped them as 'other'); genuinely
    // unknown formats are still skipped to keep the index bounded.
    const type: OutputAsset['type'] = classifyOutputType(name)
    if (type === 'other') return

    // Preserve user-linked fields from an existing index row (resident O(1) map).
    const prev = this.prevMap.get(full)

    // (path,size,mtime) unchanged → the indexed analysis is still valid.
    // PNG rows only skip once pngKeys proves a previous metadata pass ran.
    if (
      prev &&
      prev.size === st.size &&
      prev.createdAt === st.mtimeMs &&
      (ext !== '.png' || Array.isArray(prev.params?.pngKeys))
    ) {
      let workflowId = prev.workflowId
      let workflowName = prev.workflowName
      if (!workflowId && prev.promptId) {
        const link = lookupPromptWorkflowLink(prev.promptId)
        if (link?.workflowId) {
          workflowId = link.workflowId
          workflowName = workflowName || link.workflowName
        }
      }
      // Still unlinked? A fingerprint match may exist — outputs produced by
      // direct ComfyUI-frontend runs never had a sidecar (0.1.11). Read the
      // PNG head once, backfill, and persist a sidecar for cheap rescans.
      if (!workflowId && type === 'image' && ext === '.png') {
        try {
          const meta = readPngTextMetaFromFile(full)
          const raw = String(meta.prompt || meta.workflow || '')
          const graph = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
          const hit = graph ? lookupWorkflowByFingerprint(graph)[0] : undefined
          if (hit) {
            workflowId = hit.workflowId
            workflowName = workflowName || hit.workflowName
            if (prev.promptId) {
              try {
                recordPromptWorkflowLink(prev.promptId, hit.workflowId, hit.workflowName)
              } catch {
                /* best-effort */
              }
            }
          }
        } catch {
          /* unreadable meta — keep unlinked */
        }
      }
      out.push({
        ...prev,
        type,
        size: st.size,
        createdAt: st.mtimeMs,
        fileName: basename(full),
        workflowId,
        workflowName
      })
      return
    }

    let params: Record<string, unknown> = {}
    let seed: number | undefined
    let promptId: string | undefined
    /** Embedded graph (prompt or workflow form) for fingerprint matching. */
    let embeddedGraph: Record<string, unknown> | null = null
    if (type === 'image' && ext === '.png') {
      try {
        const meta = readPngTextMetaFromFile(full)
        if (meta.prompt) {
          try {
            const prompt = JSON.parse(String(meta.prompt)) as Record<
              string,
              { inputs?: Record<string, unknown>; class_type?: string }
            >
            embeddedGraph = prompt as Record<string, unknown>
            params.nodeCount = Object.keys(prompt).length
            for (const node of Object.values(prompt)) {
              if (node?.inputs && typeof node.inputs.seed === 'number' && seed == null) {
                seed = node.inputs.seed as number
              }
            }
          } catch {
            /* ignore */
          }
        }
        if (!embeddedGraph && meta.workflow) {
          try {
            embeddedGraph = JSON.parse(String(meta.workflow)) as Record<string, unknown>
          } catch {
            /* ignore */
          }
        }
        if (meta.seed && seed == null) seed = Number(meta.seed)
        if (meta.prompt_id) promptId = String(meta.prompt_id)
        params = {
          ...params,
          pngKeys: Object.keys(meta),
          workflow: undefined,
          prompt: undefined
        }
      } catch {
        /* ignore */
      }
    }

    // Attribution priority: existing record → queue-time sidecar →
    // content-fingerprint reverse match (covers ComfyUI-frontend runs).
    const link = promptId ? lookupPromptWorkflowLink(promptId) : undefined
    let fpHit: { workflowId: string; workflowName: string } | undefined
    if (!prev?.workflowId && !link?.workflowId && embeddedGraph) {
      fpHit = lookupWorkflowByFingerprint(embeddedGraph)[0]
      if (fpHit && promptId) {
        try {
          recordPromptWorkflowLink(promptId, fpHit.workflowId, fpHit.workflowName)
        } catch {
          /* best-effort */
        }
      }
    }

    out.push({
      id: createHash('sha1').update(full).digest('hex').slice(0, 16),
      path: full,
      fileName: basename(full),
      type,
      size: st.size,
      createdAt: st.mtimeMs,
      seed: seed ?? prev?.seed,
      promptId: promptId ?? prev?.promptId,
      favorite: prev?.favorite,
      workflowId: prev?.workflowId || link?.workflowId || fpHit?.workflowId,
      workflowName: prev?.workflowName || link?.workflowName || fpHit?.workflowName,
      batchJobId: prev?.batchJobId,
      thumbnail: prev?.thumbnail,
      width: prev?.width,
      height: prev?.height,
      params: { ...(prev?.params || {}), ...params }
    })
  }

  favorite(id: string, favorite: boolean): boolean {
    return Boolean(updateOutputAsset(id, { favorite }))
  }

  /**
   * Delete an output asset. deleteFile=true also removes the file on disk;
   * false only drops the DB record (the file stays for the OS / recycle bin).
   */
  remove(id: string, deleteFile: boolean): boolean {
    const rec = listOutputAssetsAll().find((a) => a.id === id)
    if (!rec) return false
    if (deleteFile && rec.path && existsSync(rec.path)) {
      unlinkSync(rec.path)
    }
    return deleteOutputAsset(id)
  }

  /**
   * Batch delete (0.1.15): delete every selected asset, collecting per-id
   * failures instead of aborting the whole set. The UI reports the exact
   * ok/failed split — never a fabricated all-success.
   */
  batchRemove(
    ids: string[],
    deleteFile: boolean
  ): { ok: number; failed: Array<{ id: string; label: string; error: string }> } {
    // 0.1.17 (WP9-2): failures carry a human label so the UI can list every one
    // (id alone is unreadable in a dialog).
    const rows = new Map(listOutputAssetsAll().map((a) => [a.id, a]))
    const failed: Array<{ id: string; label: string; error: string }> = []
    let ok = 0
    for (const raw of ids) {
      const id = sanitizeId(raw)
      const label = rows.get(id)?.fileName || String(raw)
      try {
        if (!id || !this.remove(id, Boolean(deleteFile))) {
          failed.push({ id: String(raw), label, error: 'not found' })
          continue
        }
        ok += 1
      } catch (e) {
        failed.push({
          id: String(raw),
          label,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
    return { ok, failed }
  }

  /** Multi-file share bundle. */
  async exportZip(paths: string[], destDir?: string): Promise<{ path: string }> {
    if (!paths.length) throw new Error('No files selected')
    const targetDir = destDir || dirname(paths[0])
    mkdirSync(targetDir, { recursive: true })
    const zipPath = join(targetDir, `comfy-pilot-outputs-${Date.now()}.zip`)
    const { writeZip } = await import('./zipWrite')
    writeZip(
      zipPath,
      paths.map((p) => {
        if (!existsSync(p)) throw new Error(`Missing file: ${p}`)
        // Keep only the basename inside the archive (no path traversal).
        return { path: p, name: assertSafeRelativeFilename(basename(p)) }
      })
    )
    return { path: zipPath }
  }

  /**
   * Restore an output PNG's embedded workflow into the TARGET INSTANCE's
   * workflows folder (same as a normal import — one .json artifact).
   */
  async importToWorkflow(
    path: string,
    instanceId?: string
  ): Promise<import('@shared/types').WorkflowRecord | null> {
    const { workflowService } = await import('./workflow')
    const meta = await workflowService.parsePngMeta(path)
    const hasGraph = Boolean(meta?.workflow || meta?.prompt)
    if (!hasGraph) return null
    return workflowService.importFile(path, instanceId)
  }

  /**
   * Register a produced file into the index (used by tests / future callers).
   * Field-merges so concurrent batch linkage is preserved.
   */
  indexFile(abs: string, extra?: Partial<OutputAsset>): void {
    if (!existsSync(abs)) return
    const st = statSync(abs)
    const id = createHash('sha1').update(abs).digest('hex').slice(0, 16)
    mergeUpsertOutputAsset({
      id,
      path: abs,
      fileName: basename(abs),
      // 0.1.14: unified classification (explicit registrations keep every
      // classified type; the caller owns 'other' decisions).
      type: classifyOutputType(basename(abs)),
      size: st.size,
      createdAt: st.mtimeMs,
      params: {},
      ...extra
    })
  }
}

export const outputService = new OutputService()

export class RemoteService {
  list(): RemoteInstanceConfig[] {
    return listRemotes()
  }

  save(config: RemoteInstanceConfig): RemoteInstanceConfig {
    upsertRemote(config)
    return config
  }

  remove(id: string): boolean {
    return deleteRemote(id)
  }

  async test(id: string): Promise<RemoteInstanceStatus> {
    const remotes = listRemotes()
    const remote = remotes.find((r) => r.id === id)
    if (!remote) throw new Error('Remote not found')
    const headers: Record<string, string> = remote.apiKey
      ? { Authorization: `Bearer ${remote.apiKey}` }
      : {}
    try {
      const res = await fetch(`${remote.baseUrl.replace(/\/$/, '')}/system_stats`, {
        headers,
        signal: AbortSignal.timeout(4000)
      })
      if (!res.ok)
        return { id, online: false, queueRunning: 0, queuePending: 0, error: `HTTP ${res.status}` }
      let queueRunning = 0
      let queuePending = 0
      try {
        const queueRes = await fetch(`${remote.baseUrl.replace(/\/$/, '')}/queue`, {
          headers,
          signal: AbortSignal.timeout(3000)
        })
        if (queueRes.ok) {
          const queue = (await queueRes.json()) as {
            queue_running?: unknown[]
            queue_pending?: unknown[]
          }
          queueRunning = queue.queue_running?.length || 0
          queuePending = queue.queue_pending?.length || 0
        }
      } catch {
        // stats succeeded — still online even if queue is unreachable
      }
      return {
        id,
        online: true,
        queueRunning,
        queuePending
      }
    } catch (e) {
      return {
        id,
        online: false,
        queueRunning: 0,
        queuePending: 0,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  async listStatus(): Promise<RemoteInstanceStatus[]> {
    const remotes = listRemotes().filter((r) => r.enabled)
    return Promise.all(remotes.map((r) => this.test(r.id)))
  }
}

export const remoteService = new RemoteService()

export class MarketService {
  async list(opts?: {
    query?: string
    category?: string
    limit?: number
    page?: number
    instanceId?: string
  }) {
    const settings = loadSettings()
    try {
      const { searchRegistry, toPageResult, mapMarketItem, packKeyVariants } =
        await import('./registry')
      const result = await searchRegistry({
        query: opts?.query,
        limit: opts?.limit,
        page: opts?.page
      })
      // Installed detection must target the selected instance's custom_nodes.
      // Match on directory name AND pack metadata name/registryId — registry
      // `name` often differs from the folder the zip extracted to.
      let instancePath = ''
      if (opts?.instanceId) {
        const inst = loadInstanceConfigs().find((c) => c.id === opts.instanceId)
        if (inst?.path) instancePath = inst.path
      }
      const installed = collectInstalledKeys(instancePath, packKeyVariants)
      try {
        const { nodePackService } = await import('./nodePack')
        for (const p of nodePackService.list(opts?.instanceId)) {
          if (p.name) for (const v of packKeyVariants(p.name)) installed.add(v)
          if (p.registryId) for (const v of packKeyVariants(p.registryId)) installed.add(v)
        }
      } catch {
        /* nodePack unavailable — directory keys still apply */
      }
      return toPageResult(result, (n) => mapMarketItem(n, installed, opts?.category || 'tools'))
    } catch (err) {
      if (settings.networkMode === 'offline') {
        return {
          items: [],
          total: 0,
          page: opts?.page || 1,
          pageSize: opts?.limit || 50,
          totalPages: 0,
          scanned: 0,
          clientFiltered: Boolean(opts?.query)
        }
      }
      throw err
    }
  }
}

function readdirSafe(instancePath: string): string[] {
  if (!instancePath) return []
  try {
    const dir = join(instancePath, 'custom_nodes')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Keys that mark a registry item as already installed: every normalized form
 * of the directory basename. Metadata names / registryIds are merged in by the
 * caller once nodePack is loaded.
 */
function collectInstalledKeys(
  instancePath: string,
  variants: (s: string) => string[]
): Set<string> {
  const keys = new Set<string>()
  for (const n of readdirSafe(instancePath)) {
    if (n.startsWith('.') || n === '__pycache__' || n === '__MACOSX' || n === 'node_modules')
      continue
    for (const v of variants(n)) keys.add(v)
  }
  return keys
}

export const marketService = new MarketService()
