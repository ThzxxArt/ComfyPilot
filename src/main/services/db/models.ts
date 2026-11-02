import type { DownloadTask, ModelRecord, OutputAsset } from '@shared/types'
import {
  mutateInList,
  readJsoncCached,
  scheduleFileWrite,
  setJsoncExternalEditListener,
  upsertInList
} from './jsonc'

// ---------- Models ----------
export function upsertModel(m: ModelRecord): void {
  upsertModels([m])
}

/**
 * Batch form of `upsertModel` — one read-modify-write for a whole scan
 * (0.1.16). A per-file `upsertModel` inside the scan loop rewrote the entire
 * models.jsonc once per discovered model (O(N²)); this writes it once.
 */
export function upsertModels(items: ModelRecord[]): void {
  if (!items.length) return
  mutateInList<ModelRecord>('models', [], (list) => {
    for (const m of items) {
      const i = list.findIndex((x) => x.path === m.path || x.id === m.id)
      if (i >= 0) list[i] = { ...list[i], ...m }
      else list.push(m)
    }
    return list
  })
}

export function listModels(): ModelRecord[] {
  return readJsoncCached<ModelRecord[]>('models', [])
}

export function deleteModel(id: string): boolean {
  const before = readJsoncCached<ModelRecord[]>('models', []).length
  const next = mutateInList<ModelRecord>('models', [], (list) => list.filter((m) => m.id !== id))
  return next.length !== before
}

export function findModelByPath(path: string): ModelRecord | null {
  return readJsoncCached<ModelRecord[]>('models', []).find((m) => m.path === path) || null
}

export function updateModel(id: string, patch: Partial<ModelRecord>): void {
  mutateInList<ModelRecord>('models', [], (list) => {
    const i = list.findIndex((m) => m.id === id)
    if (i >= 0) list[i] = { ...list[i], ...patch }
    return list
  })
}

// ---------- Downloads ----------
// Progress ticks fire up to every 500ms per task; debounce the whole-file write.
export function listDownloadTasks(): DownloadTask[] {
  return readJsoncCached<DownloadTask[]>('downloads', [])
}

export function upsertDownloadTask(t: DownloadTask): void {
  const list = listDownloadTasks().slice()
  const i = list.findIndex((x) => x.id === t.id)
  if (i >= 0) list[i] = t
  else list.push(t)
  scheduleFileWrite('downloads', list)
}

/** Replace the whole downloads list (used by prune/persist paths). */
export function replaceDownloadTasks(tasks: DownloadTask[]): void {
  scheduleFileWrite('downloads', tasks)
}

// ---------- Output ----------
export function upsertOutputAsset(a: OutputAsset): void {
  outputAssetsRevision++
  upsertInList('output_assets', a, (x, y) => x.path === y.path || x.id === y.id)
}

/**
 * Field-level merge upsert: a disk walk must never wipe linkage written by the
 * batch indexer (batchJobId / workflowId / thumbnail / size).
 */
/**
 * 0.1.18 (WP4/F5): monotonic revision for the output index. List-side caches
 * (sort/filter results) can prove they are fresh instead of trusting a TTL.
 */
let outputAssetsRevision = 0
export function outputAssetsRev(): number {
  return outputAssetsRevision
}

export function mergeUpsertOutputAsset(a: OutputAsset): void {
  mergeUpsertOutputAssets([a])
}

/** Batch form of mergeUpsertOutputAsset — one read-modify-write for a whole walk. */
export function mergeUpsertOutputAssets(items: OutputAsset[]): void {
  if (!items.length) return
  outputAssetsRevision++
  mutateInList<OutputAsset>('output_assets', [], (list) => {
    for (const a of items) {
      const i = list.findIndex((x) => x.path === a.path || x.id === a.id)
      if (i < 0) {
        list.push(a)
        continue
      }
      list[i] = {
        ...list[i],
        ...a,
        // Keep the earlier non-empty value whenever the incoming one is blank.
        thumbnail: a.thumbnail || list[i].thumbnail,
        width: a.width ?? list[i].width,
        height: a.height ?? list[i].height,
        batchJobId: a.batchJobId || list[i].batchJobId,
        workflowId: a.workflowId || list[i].workflowId,
        workflowName: a.workflowName || list[i].workflowName,
        favorite: a.favorite ?? list[i].favorite,
        promptId: a.promptId || list[i].promptId,
        seed: a.seed ?? list[i].seed,
        params: { ...(list[i].params || {}), ...(a.params || {}) }
      }
    }
    return list
  })
}

/**
 * Newest-first by default. The previous `slice(0, limit)` dropped the newest
 * files once the index grew past the limit — always sort before slicing.
 */
export function listOutputAssets(opts?: {
  limit?: number
  offset?: number
  sort?: 'createdAt' | 'size' | 'name'
  order?: 'asc' | 'desc'
}): OutputAsset[] {
  const all = readJsoncCached<OutputAsset[]>('output_assets', [])
  const sort = opts?.sort || 'createdAt'
  const order = opts?.order === 'asc' ? 1 : -1
  const sorted = [...all].sort((a, b) => {
    if (sort === 'name') return order * a.fileName.localeCompare(b.fileName)
    if (sort === 'size') return order * (a.size - b.size)
    return order * (a.createdAt - b.createdAt)
  })
  const offset = Math.max(0, opts?.offset || 0)
  const limit = opts?.limit ?? 200
  return sorted.slice(offset, offset + limit)
}

export function listOutputAssetsAll(): OutputAsset[] {
  return readJsoncCached<OutputAsset[]>('output_assets', [])
}

export function deleteOutputAsset(id: string): boolean {
  outputAssetsRevision++
  const before = readJsoncCached<OutputAsset[]>('output_assets', []).length
  const next = mutateInList<OutputAsset>('output_assets', [], (list) =>
    list.filter((a) => a.id !== id)
  )
  return next.length !== before
}

/**
 * Clear the recorded thumbnail on many rows in ONE write (0.1.17 WP7).
 * The prune loop used to rewrite the whole index once per dead row.
 */
export function clearOutputAssetThumbnails(ids: string[]): number {
  if (!ids.length) return 0
  outputAssetsRevision++
  const wanted = new Set(ids)
  let cleared = 0
  mutateInList<OutputAsset>('output_assets', [], (list) =>
    list.map((a) => {
      if (!wanted.has(a.id)) return a
      cleared += 1
      return { ...a, thumbnail: undefined }
    })
  )
  return cleared
}

export function updateOutputAsset(id: string, patch: Partial<OutputAsset>): OutputAsset | null {
  outputAssetsRevision++
  let result: OutputAsset | null = null
  mutateInList<OutputAsset>('output_assets', [], (list) => {
    const i = list.findIndex((a) => a.id === id)
    if (i >= 0) {
      list[i] = { ...list[i], ...patch, id: list[i].id }
      result = list[i]
    }
    return list
  })
  return result
}

// 0.2.0: a hand-edited output index must invalidate list caches too.
setJsoncExternalEditListener((name) => {
  if (name === 'output_assets') outputAssetsRevision += 1
})
