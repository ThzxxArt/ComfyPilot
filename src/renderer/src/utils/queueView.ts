/**
 * Queue view merge (0.1.11).
 *
 * The monitor used to render /queue (running/pending) and /api/jobs side by
 * side in the same tab — the SAME task showed as「运行中」(running) in one list
 * and「执行中」(in_progress) in the other. On ComfyUI 0.39+ job ids ARE prompt
 * ids (server.py), so active jobs are dropped in favour of the queue lists and
 * only terminal jobs appear in the "recent jobs" section.
 */
import type { ComfyJobSummary, QueueSnapshot } from '@shared/types'

export interface QueueViewItem {
  id: string
  status: string
  /** Creation time for recent jobs (epoch ms). */
  at?: number
}

export interface QueueSection {
  key: 'running' | 'pending' | 'recent'
  items: QueueViewItem[]
}

const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'running'])

export function buildQueueSections(
  queue: QueueSnapshot | null,
  jobs: ComfyJobSummary[] | null
): QueueSection[] {
  const sections: QueueSection[] = []
  const running: QueueViewItem[] = (queue?.running || []).map((q) => ({
    id: q.promptId,
    status: 'running'
  }))
  const pending: QueueViewItem[] = (queue?.pending || []).map((q) => ({
    id: q.promptId,
    status: 'pending'
  }))
  const activeIds = new Set<string>([...running, ...pending].map((i) => i.id))
  const recent: QueueViewItem[] = (jobs || [])
    .filter((j) => !ACTIVE_STATUSES.has(String(j.status || '').toLowerCase()))
    .filter((j) => !activeIds.has(j.id))
    .map((j) => ({ id: j.id, status: j.status, at: j.createdAt }))

  if (running.length) sections.push({ key: 'running', items: running })
  if (pending.length) sections.push({ key: 'pending', items: pending })
  if (recent.length) sections.push({ key: 'recent', items: recent })
  return sections
}
