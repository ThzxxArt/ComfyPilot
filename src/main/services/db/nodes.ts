import type { NodeSnapshot } from '@shared/types'
import { persistList, readJsonc, readJsoncCached, upsertInList, writeJsonc } from './jsonc'

// ---------- Node packs ----------
type NodePack = import('@shared/types').NodePackRecord

export function upsertNodePack(p: NodePack): void {
  upsertInList('node_packs', p, (a, b) => a.id === b.id || a.name === b.name)
}

/**
 * Junk directory names an early scanner indexed as node packs (0.1.17).
 * `__pycache__` / `*.pyc` / macOS `._*` are never real custom nodes.
 */
function isJunkNodePack(p: { name?: string; path?: string }): boolean {
  const raw = String(p.name || p.path || '')
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || ''
  return base === '__pycache__' || base.endsWith('.pyc') || base.startsWith('._')
}

export function listNodePacks(): NodePack[] {
  const list = readJsoncCached<NodePack[]>('node_packs', [])
  const clean = list.filter((p) => !isJunkNodePack(p))
  if (clean.length !== list.length) {
    // Self-heal once through the single writer (0.1.18 WP1). Writing the file
    // directly here bypassed the debounce queue, so a stale queued snapshot
    // could resurrect the junk rows on the next flush.
    try {
      persistList('node_packs', clean)
    } catch {
      /* a read must never fail because the cleanup write failed */
    }
  }
  return clean
}

export function deleteNodePack(id: string): boolean {
  // 0.1.17 (review fix): go through the debounced collection path. Writing the
  // file directly while an upsert was still queued let the pending (older) list
  // flush afterwards and resurrect the deleted pack.
  const list = listNodePacks()
  const next = list.filter((p) => p.id !== id)
  if (next.length === list.length) return false
  persistList('node_packs', next)
  return true
}

// ---------- Snapshots ----------
export function listSnapshots(): NodeSnapshot[] {
  return readJsonc<NodeSnapshot[]>('node_snapshots', [])
}

export function insertSnapshot(s: NodeSnapshot): void {
  const list = listSnapshots()
  list.push(s)
  writeJsonc('node_snapshots', list)
}

export function deleteSnapshot(id: string): boolean {
  const list = listSnapshots()
  const next = list.filter((s) => s.id !== id)
  writeJsonc('node_snapshots', next)
  return next.length !== list.length
}

export function getSnapshot(id: string): NodeSnapshot | null {
  return listSnapshots().find((s) => s.id === id) || null
}
