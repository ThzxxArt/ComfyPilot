import { basename } from 'path'
import type { BatchJob } from '@shared/types'
import { batchService, remoteService } from '../../services/p1p2'
import { sanitizeId } from '../../services/security'
import { withPausedSlowOp } from '../../services/slowOps'
import { broadcastNotification, isSafeReadPath, requireRunningInstance, wrap } from '../context'
import { safeInstanceTarget } from '../trust'

/**
 * 0.1.17 (WP5): terminal-state notification for a batch run, shared by
 * start / resume / retryFailed so all three report the same way.
 */
function notifyBatchTerminal(result: {
  name: string
  status: string
  submitted: number
  completed: number
  produced: number
  failed: number
  errorSummary?: string
}): void {
  if (result.status === 'done') {
    broadcastNotification({
      type: 'success',
      title: `Batch done: ${result.name}`,
      titleKey: 'notify.batchDone',
      params: { name: result.name },
      message: `queued ${result.submitted} · ok ${result.completed} · produced ${result.produced} · failed ${result.failed}`
    })
  } else if (result.status === 'error') {
    broadcastNotification({
      type: 'error',
      title: `Batch failed: ${result.name}`,
      titleKey: 'notify.batchFailed',
      params: { name: result.name },
      message:
        result.errorSummary ||
        `queued ${result.submitted} · ok ${result.completed} · produced ${result.produced} · failed ${result.failed}`,
      duration: 8000
    })
  } else if (result.status === 'cancelled') {
    broadcastNotification({
      type: 'warning',
      title: `Batch cancelled: ${result.name}`,
      titleKey: 'notify.batchCancelled',
      params: { name: result.name },
      message: `queued ${result.submitted} · ok ${result.completed} · failed ${result.failed}`
    })
  }
}

/** Require the batch job's backend to be live (local running / online remote). */
async function requireBatchTarget(jobId: string): Promise<{ id: string; name: string }> {
  const job = batchService.list().find((j) => j.id === jobId)
  const targetId = String(job?.instanceId || '')
  if (targetId.startsWith('remote:')) {
    const status = await remoteService.test(targetId.slice('remote:'.length))
    if (!status.online) {
      throw new Error(`Remote instance is offline: ${status.error || targetId}`)
    }
  } else {
    await requireRunningInstance(targetId)
  }
  return { id: targetId, name: job?.name || jobId }
}

/**
 * Shared launcher (0.1.17 WP5-7): the IPC call returns as soon as the run is
 * accepted, the terminal notification is attached to the same promise, and
 * `batch.wait` can await it from the UI. A long batch no longer holds the
 * request open (which made the window look frozen until the last image).
 */
async function launchBatch(
  safeId: string,
  kick: () => BatchJob | Promise<BatchJob>
): Promise<BatchJob> {
  const target = await requireBatchTarget(safeId)
  let initial: BatchJob
  try {
    initial = await kick()
  } catch (e) {
    broadcastNotification({
      type: 'error',
      title: `Batch failed: ${target.name}`,
      titleKey: 'notify.batchFailed',
      params: { name: target.name },
      message: e instanceof Error ? e.message : String(e),
      duration: 8000
    })
    throw e
  }
  void batchService
    .wait(safeId)
    .then((settled) => {
      if (settled) notifyBatchTerminal(settled)
    })
    .catch(() => undefined)
  return initial
}

export function createBatchHandlers() {
  return {
    list: wrap(() => batchService.list()),
    create: wrap(
      (input: {
        name: string
        instanceId: string
        items: Array<{
          workflowId?: string
          workflowName?: string
          workflowPath: string
          count: number
        }>
        notes?: string
        params?: import('@shared/types').BatchParamOverrides
      }) => {
        for (const it of input.items || []) {
          if (!it.workflowPath || !isSafeReadPath(it.workflowPath)) {
            throw new Error(
              `Blocked unsafe workflow path: ${basename(it.workflowPath || '(empty)')}`
            )
          }
        }
        return batchService.create({
          ...input,
          instanceId: safeInstanceTarget(input.instanceId) || input.instanceId
        })
      }
    ),
    start: wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      return launchBatch(safeId, () => batchService.startAsync(safeId))
    }),
    // 0.1.17 (WP5): continue an interrupted job / retry only its failed legs.
    resume: wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      return launchBatch(safeId, () => batchService.resumeAsync(safeId))
    }),
    retryFailed: wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      return launchBatch(safeId, () => batchService.retryFailedAsync(safeId))
    }),
    // 0.1.17 (WP5-7): settle without polling.
    wait: wrap((id: string) =>
      // A long batch is a legitimate wait, not a frozen main process.
      withPausedSlowOp(() => batchService.wait(sanitizeId(id)), 'batch.wait')
    ),
    cancel: wrap((id: string) => batchService.cancel(sanitizeId(id))),
    cancelItem: wrap((id: string, workflowPath: string) =>
      batchService.cancelItem(sanitizeId(id), String(workflowPath || ''))
    ),
    remove: wrap((id: string) => batchService.remove(sanitizeId(id))),
    preflight: wrap(async (opts: { workflowPaths: string[]; instanceId: string }) => {
      const paths = Array.isArray(opts?.workflowPaths) ? opts.workflowPaths : []
      for (const p of paths) {
        if (!isSafeReadPath(p)) throw new Error(`Blocked unsafe workflow path: ${basename(p)}`)
      }
      const target = safeInstanceTarget(String(opts?.instanceId || ''))
      if (!target || target.startsWith('remote:')) {
        return {
          available: false,
          missingTypes: [],
          perWorkflow: paths.map((p) => ({
            workflowPath: p,
            name: basename(p),
            missingTypes: [],
            error: 'Preflight is only available for local instances'
          })),
          error: 'Preflight is only available for local instances'
        }
      }
      const { preflightService } = await import('../../services/preflight')
      return preflightService.batch(paths, target)
    })
  }
}
