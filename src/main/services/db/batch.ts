import type { BatchJob } from '@shared/types'
import {
  flushPendingWrites,
  mutateInList,
  readJsonc,
  readJsoncCached,
  scheduleFileWrite,
  upsertInList
} from './jsonc'

// ---------- Batch ----------
export function listBatchJobs(): BatchJob[] {
  return readJsonc<BatchJob[]>('batch_jobs', [])
}

export function upsertBatchJob(j: BatchJob): void {
  upsertInList('batch_jobs', j, (a, b) => a.id === b.id)
}

export function deleteBatchJob(id: string): boolean {
  const before = readJsonc<BatchJob[]>('batch_jobs', []).length
  const next = mutateInList<BatchJob>('batch_jobs', [], (list) => list.filter((j) => j.id !== id))
  return next.length !== before
}

// ---------- Install run persistence (0.1.4) ----------
/**
 * Persist the latest install/update run so the UI can restore progress after
 * an app restart. File shape: `{ runs: InstallProgress[] }` with newest first,
 * capped so the file never grows unbounded.
 */
const INSTALL_RUNS_HEADER = `ComfyPilot install runs (JSONC)
// Latest one-click installer runs — written automatically. Safe to delete.`

export function saveInstallRun(progress: {
  runId: string
  status: string
  [k: string]: unknown
}): void {
  try {
    // Progress ticks are frequent — keep the snapshot in memory and debounce
    // the disk write (flushPendingWrites() on quit guarantees durability).
    const file = readJsoncCached<{ runs: Array<Record<string, unknown>> }>('install-runs', {
      runs: []
    })
    const runs = (file.runs || []).slice()
    const idx = runs.findIndex((r) => r.runId === progress.runId)
    if (idx >= 0) runs[idx] = progress
    else runs.unshift(progress)
    scheduleFileWrite('install-runs', { runs: runs.slice(0, 20) }, INSTALL_RUNS_HEADER)
  } catch {
    /* persistence is best-effort — never fail the install because of it */
  }
}

export function loadInstallRuns(): Array<Record<string, unknown>> {
  try {
    return (
      readJsoncCached<{ runs: Array<Record<string, unknown>> }>('install-runs', {
        runs: []
      }).runs || []
    )
  } catch {
    return []
  }
}

/** Most recent run (in-flight preferred: status === 'running'). */
export function loadLatestInstallRun(): Record<string, unknown> | null {
  const runs = loadInstallRuns()
  return runs.find((r) => r.status === 'running') || runs[0] || null
}

export function clearInstallRuns(): void {
  try {
    scheduleFileWrite('install-runs', { runs: [] }, INSTALL_RUNS_HEADER)
    flushPendingWrites()
  } catch {
    /* ignore */
  }
}
