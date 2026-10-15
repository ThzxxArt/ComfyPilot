/**
 * Workflow → product attribution via content fingerprint (0.1.11).
 *
 * Why: outputs produced by executing a workflow inside the ComfyUI frontend
 * carry no app-side linkage at all (no batch record, no queue-time sidecar),
 * and duplicate workflow files (library copy vs instance copy) get NEW record
 * ids — both cases broke the "workflow → outputs" filter.
 *
 * The fingerprint is the sha1 of the canonical API-prompt form of the graph
 * (UI graph and API prompt both normalize to the same object). It is stable
 * across widget-array ordering because serialization sorts object keys.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import type { WorkflowRecord } from '@shared/types'
import { toApiPrompt } from './workflowConvert'
import { readPngTextMetaFromFile } from './workflow'
import { listWorkflows } from './db'
import { LruCache } from './lru'

export interface WorkflowFingerprintHit {
  workflowId: string
  workflowName: string
}

/** Canonical, key-order-independent JSON (arrays keep order — they are data). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v)).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

/**
 * `v1:<sha1>` of the canonical API-prompt form; null when the value is not a
 * workflow. The version prefix lets a future normalization change invalidate
 * stored hashes cleanly.
 */
export function fingerprintOf(graph: Record<string, unknown> | null | undefined): string | null {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return null
  try {
    const api = toApiPrompt(graph)
    return 'v1:' + createHash('sha1').update(stableStringify(api)).digest('hex')
  } catch {
    return null
  }
}

const fileHashCache = new LruCache<string, { size: number; mtimeMs: number; hash: string | null }>(
  4000
)

/** Fingerprint of a workflow file (.json graph or .png embedded graph). */
function hashOfFile(path: string): string | null {
  try {
    const st = statSync(path)
    const hit = fileHashCache.get(path)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.hash
    let hash: string | null = null
    if (/\.json$/i.test(path)) {
      try {
        hash = fingerprintOf(JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>)
      } catch {
        hash = null
      }
    } else if (/\.png$/i.test(path)) {
      const meta = readPngTextMetaFromFile(path)
      const raw = String(meta.workflow || meta.prompt || '')
      if (raw) {
        try {
          hash = fingerprintOf(JSON.parse(raw) as Record<string, unknown>)
        } catch {
          hash = null
        }
      }
    }
    fileHashCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, hash })
    return hash
  } catch {
    return null
  }
}

let indexCache: {
  at: number
  sig: string
  byHash: Map<string, WorkflowFingerprintHit[]>
} | null = null
/** Cheap revalidation window — a disk walk calls the lookup once per output. */
const INDEX_TTL_MS = 5000

function indexSignature(workflows: WorkflowRecord[]): string {
  const parts: string[] = []
  for (const w of workflows) {
    if (w.missing || !w.path) continue
    try {
      const st = statSync(w.path)
      parts.push(`${w.id}:${w.path}:${st.size}:${st.mtimeMs}`)
    } catch {
      parts.push(`${w.id}:${w.path}:-`)
    }
  }
  return parts.join('|')
}

function ensureIndex(): Map<string, WorkflowFingerprintHit[]> {
  const now = Date.now()
  if (indexCache && now - indexCache.at < INDEX_TTL_MS) return indexCache.byHash
  const workflows = listWorkflows()
  const sig = indexSignature(workflows)
  if (indexCache && indexCache.sig === sig) {
    indexCache.at = now
    return indexCache.byHash
  }
  const byHash = new Map<string, WorkflowFingerprintHit[]>()
  for (const w of workflows) {
    if (w.missing || !w.path || !existsSync(w.path)) continue
    const hash = hashOfFile(w.path)
    if (!hash) continue
    const arr = byHash.get(hash) || []
    if (!arr.some((h) => h.workflowId === w.id)) {
      arr.push({ workflowId: w.id, workflowName: w.name })
    }
    byHash.set(hash, arr)
  }
  indexCache = { at: now, sig, byHash }
  return byHash
}

/** Reverse lookup: which workflow record(s) does this embedded graph match? */
export function lookupWorkflowByFingerprint(
  graph: Record<string, unknown> | null | undefined
): WorkflowFingerprintHit[] {
  const hash = fingerprintOf(graph)
  if (!hash) return []
  return ensureIndex().get(hash) || []
}

/** Fingerprint of a workflow FILE (.json graph or .png embedded graph).
 *  Same normalization as the reverse lookup — exposed for workflow.list so
 *  the renderer can widen filters across duplicate copies (0.1.11). */
export function fingerprintOfWorkflowFile(path: string): string | null {
  return hashOfFile(path)
}

/** Drop caches (tests / after imports) so the next lookup re-reads disk. */
export function resetFingerprintCaches(): void {
  indexCache = null
  fileHashCache.clear()
}
