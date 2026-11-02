import { EventEmitter } from 'events'
import { randomUUID, createHash } from 'crypto'
import { existsSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import type { BatchJob, BatchParamOverrides } from '@shared/types'
import {
  deleteBatchJob,
  listBatchJobs,
  listRemotes,
  upsertBatchJob,
  mergeUpsertOutputAsset
} from '../db'
import { resolveReadTarget } from '../target'
import { ComfyApiClient } from '../comfyApi'
import { readPngTextMetaFromFile, recordPromptWorkflowLink } from '../workflow'
import { classifyOutputType } from '@shared/mediaTypes'
import { resolveOutputDir } from '@shared/outputDir'
import {
  emptyItem,
  instanceUrl,
  normalizeLegacyJob,
  readWorkflowGraph,
  remoteAuthHeaders
} from './helpers'

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
      // 0.2.0: count actual outcomes, not `submitted + failed`. A failed prompt
      // is already inside submitted, so the old formula double-counted it and
      // skipped legs that never ran.
      const attempted = Math.min(it.count, it.completed + it.submitFailed + it.execFailed)
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
      start: Math.max(0, it.completed + it.submitFailed + it.execFailed),
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
      const { buildIterationPrompt } = await import('../workflowConvert')
      const { COMFY_CLIENT_ID } = await import('../comfyApi')

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
