import type { WorkflowRecord } from '@shared/types'
import { mutateInList, readJsoncCached, upsertInList } from './jsonc'

// ---------- Workflows ----------
export function listWorkflows(): WorkflowRecord[] {
  return readJsoncCached<WorkflowRecord[]>('workflows', [])
}

export function upsertWorkflow(w: WorkflowRecord): void {
  upsertInList('workflows', w, (a, b) => a.path === b.path || a.id === b.id)
}

/** Batch upsert: one read-modify-write for a whole scan result. */
export function upsertWorkflows(items: WorkflowRecord[]): void {
  if (!items.length) return
  mutateInList<WorkflowRecord>('workflows', [], (list) => {
    for (const w of items) {
      const i = list.findIndex((x) => x.path === w.path || x.id === w.id)
      if (i >= 0) list[i] = w
      else list.push(w)
    }
    return list
  })
}

export function updateWorkflow(id: string, patch: Partial<WorkflowRecord>): WorkflowRecord | null {
  let result: WorkflowRecord | null = null
  mutateInList<WorkflowRecord>('workflows', [], (list) => {
    const i = list.findIndex((w) => w.id === id)
    if (i >= 0) {
      list[i] = { ...list[i], ...patch, id: list[i].id }
      result = list[i]
    }
    return list
  })
  return result
}

export function deleteWorkflow(id: string): boolean {
  const before = readJsoncCached<WorkflowRecord[]>('workflows', []).length
  const next = mutateInList<WorkflowRecord>('workflows', [], (list) =>
    list.filter((w) => w.id !== id)
  )
  return next.length !== before
}
