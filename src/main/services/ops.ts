/**
 * 0.1.18 (WP5): one place that answers "what is running right now?".
 *
 * Every long task already streams progress for its own modal, but the shell had
 * no global view: closing the modal made an install/update/scan invisible, and
 * long expected work (launch, index crawl, batch runs) could not be cancelled
 * from one place. This registry subscribes to the existing streams (no service
 * is forced to know about it), normalizes them into `BackgroundOp`, and exposes
 * list/cancel over IPC plus a change event for the renderer.
 */
import { EventEmitter } from 'events'
import type { BackgroundOp, BackgroundOpKind } from '@shared/types'

type Terminal = 'done' | 'failed' | 'cancelled'

interface InternalOp extends BackgroundOp {
  /** In-memory only: how to stop this operation. */
  cancel?: () => boolean | Promise<boolean>
  updatedAt: number
}

interface OpHandle {
  id: string
  update: (p: Partial<BackgroundOp>) => void
  finish: (s: Terminal, error?: string) => void
}

const KEEP_FINISHED_MS = 5 * 60 * 1000
const MAX_OPS = 50

export class OperationRegistry extends EventEmitter {
  private ops = new Map<string, InternalOp>()
  private inited = false

  list(): BackgroundOp[] {
    this.prune()
    return [...this.ops.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((op) => {
        const { cancel: _cancel, updatedAt: _updatedAt, ...rest } = op
        return rest
      })
  }

  get(id: string): BackgroundOp | undefined {
    return this.list().find((op) => op.id === id)
  }

  /**
   * Create or reuse an operation. A stable id lets repeated stream events keep
   * updating the same row; a finished op with the same id is replaced by a new
   * run. `cancel` is optional — an op without it is visible but not stoppable.
   */
  begin(
    init: {
      id?: string
      kind: BackgroundOpKind
      target: string
      title?: string
      detail?: string
      percent?: number | null
      runId?: string
      cancel?: () => boolean | Promise<boolean>
    },
    opts?: { reuse?: boolean }
  ): OpHandle {
    const id = init.id || `${init.kind}:${init.target}`
    const existing = this.ops.get(id)
    if (opts?.reuse && existing && existing.status === 'running') {
      if (init.cancel) existing.cancel = init.cancel
      return this.handle(existing)
    }
    if (opts?.reuse && existing && existing.status !== 'running') this.ops.delete(id)
    const op: InternalOp = {
      id,
      kind: init.kind,
      target: init.target,
      title: init.title || '',
      status: 'running',
      percent: init.percent ?? null,
      detail: init.detail || '',
      cancellable: Boolean(init.cancel),
      startedAt: Date.now(),
      runId: init.runId,
      cancel: init.cancel,
      updatedAt: Date.now()
    }
    this.ops.set(id, op)
    this.emitChange(op)
    return this.handle(op)
  }

  private handle(op: InternalOp): OpHandle {
    return {
      id: op.id,
      update: (p) => {
        const cur = this.ops.get(op.id)
        if (!cur || cur.status !== 'running') return
        Object.assign(cur, p, { updatedAt: Date.now() })
        this.emitChange(cur)
      },
      finish: (s, error) => this.finish(op.id, s, error)
    }
  }

  update(id: string, p: Partial<BackgroundOp>): void {
    const cur = this.ops.get(id)
    if (!cur || cur.status !== 'running') return
    Object.assign(cur, p, { updatedAt: Date.now() })
    this.emitChange(cur)
  }

  finish(id: string, status: Terminal, error?: string): void {
    const cur = this.ops.get(id)
    if (!cur) return
    cur.status = status
    cur.finishedAt = Date.now()
    cur.error = error
    cur.cancellable = false
    cur.updatedAt = Date.now()
    if (status === 'done') cur.percent = 100
    this.emitChange(cur)
  }

  async cancel(id: string): Promise<boolean> {
    const op = this.ops.get(id)
    if (!op || op.status !== 'running' || !op.cancel) return false
    try {
      return Boolean(await op.cancel())
    } catch {
      return false
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, op] of this.ops) {
      if (op.status !== 'running' && op.finishedAt && now - op.finishedAt > KEEP_FINISHED_MS) {
        this.ops.delete(id)
      }
    }
    if (this.ops.size > MAX_OPS) {
      const finished = [...this.ops.values()]
        .filter((o) => o.status !== 'running')
        .sort((a, b) => a.startedAt - b.startedAt)
      for (const op of finished) {
        if (this.ops.size <= MAX_OPS) break
        this.ops.delete(op.id)
      }
    }
  }

  private emitChange(op: InternalOp): void {
    const { cancel: _cancel, updatedAt: _updatedAt, ...rest } = op
    this.emit('changed', rest)
  }

  private isRunning(id: string): boolean {
    return this.ops.get(id)?.status === 'running'
  }

  /**
   * Subscribe to every existing progress stream. Idempotent and lazy (dynamic
   * imports) so importing this module never creates a cycle.
   */
  async init(): Promise<void> {
    if (this.inited) return
    try {
      await this.wire()
      this.inited = true
    } catch (err) {
      // A failed dynamic import must not poison the registry for the session:
      // leaving inited=true made the task center silently empty forever.
      console.error('[ops] subscribe failed:', err)
      this.inited = false
    }
  }

  private async wire(): Promise<void> {
    const [
      { installerService },
      { comfyUpdaterService },
      { envService },
      { nodePackService },
      { batchService },
      { registryIndex }
    ] = await Promise.all([
      import('./installer'),
      import('./updater'),
      import('./env'),
      import('./nodePack'),
      import('./p1p2'),
      import('./registryIndex')
    ])

    // ---- install (bootstrap → register) ----
    let installOp: OpHandle | null = null
    installerService.on(
      'progress',
      (
        p: {
          status?: string
          percent?: number
          message?: string
          instanceId?: string
          error?: string
        } | null
      ) => {
        if (!p) {
          installOp?.finish('cancelled')
          installOp = null
          return
        }
        if (!installOp) {
          installOp = this.begin({
            id: 'install',
            kind: 'install',
            target: p.instanceId || 'local',
            percent: p.percent ?? null,
            detail: p.message || '',
            cancel: () => installerService.cancel()
          })
        }
        installOp.update({ percent: p.percent ?? null, detail: p.message || '' })
        if (p.status === 'done') {
          installOp.finish('done')
          installOp = null
        } else if (p.status === 'failed') {
          installOp.finish('failed', p.error || p.message)
          installOp = null
        } else if (p.status === 'cancelled') {
          installOp.finish('cancelled')
          installOp = null
        }
      }
    )

    // ---- ComfyUI source update / environment repair: same progress shape ----
    const trackUpdates = (
      kind: 'comfy-update' | 'env-repair',
      svc: EventEmitter,
      cancel: () => boolean | Promise<boolean>
    ): void => {
      let id: string | null = null
      svc.on(
        'progress',
        (p: {
          instanceId?: string
          status?: string
          percent?: number
          message?: string
          error?: string
          step?: string
        }) => {
          const target = p.instanceId || 'local'
          if (!id || !this.isRunning(id)) {
            id = `${kind}:${target}`
            this.begin(
              {
                id,
                kind,
                target,
                percent: p.percent ?? null,
                detail: p.message || '',
                cancel
              },
              { reuse: true }
            )
          }
          this.update(id, { percent: p.percent ?? null, detail: p.message || '' })
          if (p.status === 'done') {
            this.finish(id, 'done')
            id = null
          } else if (p.status === 'failed') {
            this.finish(id, 'failed', p.error || p.message)
            id = null
          } else if (p.status === 'cancelled') {
            this.finish(id, 'cancelled')
            id = null
          }
        }
      )
    }
    trackUpdates('comfy-update', comfyUpdaterService, () => comfyUpdaterService.cancel())
    trackUpdates('env-repair', envService, () => envService.cancelRepair())

    // ---- single node operation (one per instance) ----
    nodePackService.on(
      'op-progress',
      (p: {
        instanceId?: string
        status?: string
        percent?: number
        message?: string
        error?: string
        packName?: string
      }) => {
        const target = p.instanceId || 'default'
        const id = `node-op:${target}`
        if (!this.isRunning(id)) {
          this.begin({
            id,
            kind: 'node-op',
            target,
            title: p.packName || '',
            percent: p.percent ?? null,
            detail: p.message || '',
            cancel: () => nodePackService.cancelOp(target)
          })
        }
        this.update(id, {
          percent: p.percent ?? null,
          detail: p.message || ''
        })
        if (p.status === 'done') this.finish(id, 'done')
        else if (p.status === 'failed') this.finish(id, 'failed', p.error || p.message)
        else if (p.status === 'cancelled') this.finish(id, 'cancelled')
      }
    )

    // ---- node "update all" queue ----
    nodePackService.on(
      'update-batch',
      (b: {
        instanceId?: string
        done?: number
        total?: number
        running?: boolean
        message?: string
        cancelled?: boolean
      }) => {
        const target = b.instanceId || 'default'
        const id = `node-batch:${target}`
        const percent = b.total ? Math.round(((b.done || 0) / b.total) * 100) : null
        if (!this.isRunning(id)) {
          this.begin({
            id,
            kind: 'node-batch',
            target,
            percent,
            detail: b.message || '',
            cancel: () => nodePackService.cancelUpdateBatch(target)
          })
        }
        this.update(id, { percent, detail: b.message || '' })
        if (!b.running) this.finish(id, b.cancelled ? 'cancelled' : 'done')
      }
    )

    // ---- batch runs (one op per job) ----
    batchService.on(
      'progress',
      (job: {
        id?: string
        name?: string
        status?: string
        instanceId?: string
        completed?: number
        count?: number
        errorSummary?: string
      }) => {
        if (!job?.id) return
        const id = `batch:${job.id}`
        const percent = job.count ? Math.round(((job.completed || 0) / job.count) * 100) : null
        if (job.status === 'running' || job.status === 'submitting') {
          if (!this.isRunning(id)) {
            this.begin({
              id,
              kind: 'batch',
              target: job.instanceId || 'local',
              title: job.name || '',
              percent,
              cancel: async () => {
                await batchService.cancel(job.id as string)
                return true
              }
            })
          }
          this.update(id, { percent })
        } else if (this.isRunning(id)) {
          const status: Terminal =
            job.status === 'cancelled' ? 'cancelled' : job.status === 'error' ? 'failed' : 'done'
          this.finish(id, status, job.errorSummary)
        }
      }
    )

    // ---- full-catalog index crawl ----
    const indexId = 'registry-index'
    let indexCancelled = false
    registryIndex.on('progress', (p: { done: number; total: number; count: number }) => {
      const percent = p.total ? Math.round((p.done / p.total) * 100) : null
      if (!this.isRunning(indexId)) {
        this.begin({
          id: indexId,
          kind: 'registry-index',
          target: 'local',
          percent,
          detail: `${p.done}/${p.total}`,
          cancel: () => {
            indexCancelled = registryIndex.cancelBuild()
            return indexCancelled
          }
        })
      }
      this.update(indexId, { percent, detail: `${p.done}/${p.total}` })
    })
    registryIndex.on('ready', () => {
      indexCancelled = false
      if (this.isRunning(indexId)) this.finish(indexId, 'done')
    })
    registryIndex.on('idle', () => {
      // `idle` fires for every build end (success, cancel, failure); a success
      // already finished via `ready`, so anything still running here did not
      // end cleanly.
      const userCancelled = indexCancelled || registryIndex.wasCancelledByUser()
      if (this.isRunning(indexId)) this.finish(indexId, userCancelled ? 'cancelled' : 'failed')
      indexCancelled = false
    })
  }

  /** Generic wrapper for request/response operations with no event stream. */
  run<T>(
    init: {
      kind: BackgroundOpKind
      target: string
      title?: string
      cancel?: () => boolean | Promise<boolean>
    },
    body: (op: { update: (p: Partial<BackgroundOp>) => void }) => Promise<T>
  ): Promise<T> {
    const op = this.begin(init)
    return body(op).then(
      (r) => {
        op.finish('done')
        return r
      },
      (e) => {
        const name = (e as { name?: string })?.name
        op.finish(
          name === 'AbortError' ? 'cancelled' : 'failed',
          e instanceof Error ? e.message : String(e)
        )
        throw e
      }
    )
  }
}

export const operationRegistry = new OperationRegistry()
