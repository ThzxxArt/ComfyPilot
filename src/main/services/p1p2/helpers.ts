import { readFileSync } from 'fs'
import { extname, basename } from 'path'
import type { BatchJob, BatchJobItem, BatchParamOverrides, BatchJobStatus } from '@shared/types'
import { readPngTextMetaFromFile } from '../workflow'

// ---------- helpers ----------

export function instanceUrl(inst: { listen: string; port: number }): string {
  const host =
    inst.listen === '0.0.0.0' || inst.listen === '::' || inst.listen === '[::]'
      ? '127.0.0.1'
      : inst.listen
  return `http://${host}:${inst.port}`
}

/** Bearer auth for a configured remote — EVERY request must carry it, not just
 *  the reachability probe (0.1.11: protected remotes 401'd after a green test). */
export function remoteAuthHeaders(remote?: {
  apiKey?: string
}): Record<string, string> | undefined {
  return remote?.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : undefined
}

export function emptyItem(
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
export function readWorkflowGraph(path: string): Record<string, unknown> | null {
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

export function normalizeLegacyJob(raw: Record<string, unknown>): BatchJob {
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
