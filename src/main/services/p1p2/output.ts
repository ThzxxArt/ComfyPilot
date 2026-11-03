import { createHash } from 'crypto'
import { existsSync, lstatSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'fs'
import type { Stats } from 'fs'
import { join, extname, basename, dirname } from 'path'
import type { OutputAsset } from '@shared/types'
import {
  listOutputAssetsAll,
  deleteOutputAsset,
  outputAssetsRev,
  mergeUpsertOutputAsset,
  mergeUpsertOutputAssets,
  updateOutputAsset,
  loadInstanceConfigs,
  loadSettings
} from '../db'
import {
  readPngTextMetaFromFile,
  lookupPromptWorkflowLink,
  recordPromptWorkflowLink
} from '../workflow'
import { lookupWorkflowByFingerprint } from '../workflowFingerprint'
import { assertSafeRelativeFilename, sanitizeId, isPathInside } from '../security'
import { classifyOutputType } from '@shared/mediaTypes'
import { resolveOutputDir } from '@shared/outputDir'
import { LruCache } from '../lru'

// ---------- Output ----------

/** True for a symbolic link/junction, including links whose target is missing. */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export class OutputService {
  /**
   * 0.1.18 (WP4/F5): sorted/filtered list cache. Keyed by the mutation
   * revision exported by db, so it can never serve stale ordering — the entry
   * is dropped the moment any writer bumps the revision.
   */
  private listCache: { rev: number; key: string; rows: OutputAsset[] } | null = null
  /**
   * Resident path→asset map used by walks: O(1) lookups instead of a per-file
   * scan of the whole index (the old `listOutputAssetsAll().find(...)`).
   */
  private readonly prevMap = new LruCache<string, OutputAsset>(50_000)

  private refreshPrevMap(): void {
    for (const a of listOutputAssetsAll()) this.prevMap.set(a.path, a)
  }

  /**
   * Walk the output roots and merge what is on disk into the index (0.1.17
   * WP7). Expensive by design — call it on page entry or an explicit refresh,
   * never on every list/page/filter call.
   */
  scan(root?: string): number {
    const roots = root ? [root] : this.defaultScanRoots()
    // Depth is user-tunable (0.1.9): deep date/nested folders were silently
    // invisible at the old hardcoded 4.
    const raw = Number(loadSettings().outputScanDepth ?? 4)
    const maxDepth = Number.isFinite(raw) ? Math.max(2, Math.min(10, Math.floor(raw))) : 4
    this.refreshPrevMap()
    const assets: OutputAsset[] = []
    for (const r of roots) {
      if (!r || !existsSync(r)) continue
      this.walk(r, assets, 0, maxDepth)
    }
    // Field-level merge so batch/walk concurrent writes never drop linkage.
    // One read-modify-write for the whole walk, not one per file.
    mergeUpsertOutputAssets(assets)
    for (const a of assets) this.prevMap.set(a.path, a)
    // 0.2.0: drop ghost rows whose files were deleted outside the app. Only
    // rows under the scanned roots are touched; a remote index is never pruned.
    try {
      const all = listOutputAssetsAll()
      for (const a of all) {
        if (!a.path || !roots.some((r) => r && isPathInside(a.path, r))) continue
        if (!existsSync(a.path)) deleteOutputAsset(a.id)
      }
    } catch {
      /* pruning is best-effort; the list still excludes missing files */
    }
    return assets.length
  }

  /** Output roots of every local instance (plus a caller-picked root). */
  private defaultScanRoots(): string[] {
    const roots: string[] = []
    for (const c of loadInstanceConfigs()) {
      if (!c.path) continue
      try {
        roots.push(resolveOutputDir(c))
      } catch {
        /* malformed config — skip */
      }
    }
    return roots
  }

  list(opts?: {
    root?: string
    type?: string
    limit?: number
    offset?: number
    favorite?: boolean
    batchJobId?: string
    workflowId?: string
    /** Any-of match across workflow ids (0.1.11 — duplicate-name copies). */
    workflowIds?: string[]
    sort?: 'createdAt' | 'size' | 'name'
    order?: 'asc' | 'desc'
    createdFrom?: number
    createdTo?: number
  }): { items: OutputAsset[]; total: number; truncated: boolean } {
    // 0.1.17 (WP7): listing no longer walks the disk. Callers scan explicitly
    // via `output.scan` (page entry / manual refresh), so paging and filtering
    // are index-only. The old behaviour re-walked 13 GB on every page change.
    const rev = outputAssetsRev()
    const cacheKey = JSON.stringify({
      root: opts?.root || '',
      type: opts?.type || '',
      favorite: Boolean(opts?.favorite),
      batchJobId: opts?.batchJobId || '',
      workflowId: opts?.workflowId || '',
      workflowIds: opts?.workflowIds?.slice().sort() || [],
      sort: opts?.sort || 'createdAt',
      order: opts?.order || 'desc',
      createdFrom: opts?.createdFrom ?? null,
      createdTo: opts?.createdTo ?? null
    })
    if (this.listCache && this.listCache.rev === rev && this.listCache.key === cacheKey) {
      const cached = this.listCache.rows
      const limitC = Math.max(1, Math.min(Math.floor(Number(opts?.limit) || 200), 200))
      const offsetC = Math.max(0, Math.floor(Number(opts?.offset) || 0))
      return {
        items: cached.slice(offsetC, offsetC + limitC),
        total: cached.length,
        truncated: offsetC + Math.min(limitC, Math.max(0, cached.length - offsetC)) < cached.length
      }
    }
    let all = listOutputAssetsAll()
    // When the caller scoped a root, only show files under it (the global index
    // also holds other instances / older roots).
    if (opts?.root) {
      const root = opts.root.replace(/[\\/]+$/, '')
      all = all.filter(
        (a) => a.path === root || a.path.startsWith(root + '/') || a.path.startsWith(root + '\\')
      )
    }
    if (opts?.type && opts.type !== 'all') all = all.filter((a) => a.type === opts.type)
    if (opts?.favorite) all = all.filter((a) => a.favorite)
    if (opts?.batchJobId) all = all.filter((a) => a.batchJobId === opts.batchJobId)
    // workflowIds (any-of) wins over the legacy single-id filter.
    if (opts?.workflowIds?.length) {
      const wanted = new Set(opts.workflowIds)
      all = all.filter((a) => Boolean(a.workflowId && wanted.has(a.workflowId)))
    } else if (opts?.workflowId) {
      all = all.filter((a) => a.workflowId === opts.workflowId)
    }
    // Date range filter on createdAt (epoch ms).
    if (opts?.createdFrom != null) all = all.filter((a) => a.createdAt >= opts.createdFrom!)
    if (opts?.createdTo != null) all = all.filter((a) => a.createdAt <= opts.createdTo!)

    const sort = opts?.sort || 'createdAt'
    const order = opts?.order === 'asc' ? 1 : -1
    all = [...all].sort((a, b) => {
      if (sort === 'name') return order * a.fileName.localeCompare(b.fileName)
      if (sort === 'size') return order * (a.size - b.size)
      return order * (a.createdAt - b.createdAt)
    })
    this.listCache = { rev, key: cacheKey, rows: all }

    // 0.1.17 (WP7): clamp here as well as at the IPC edge — a page must never be
    // unbounded just because a caller forgot the limit.
    const limit = Math.max(1, Math.min(Math.floor(Number(opts?.limit) || 200), 200))
    const offset = Math.max(0, Math.floor(Number(opts?.offset) || 0))
    const items = all.slice(offset, offset + limit)
    return {
      items,
      total: all.length,
      truncated: offset + items.length < all.length
    }
  }

  private walk(dir: string, out: OutputAsset[], depth: number, maxDepth = 4): void {
    if (depth > maxDepth) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      try {
        // Never follow links during an output walk. A symlinked directory can
        // point anywhere on disk, which would index (and later let the UI
        // delete) files outside the approved output root.
        if (isSymlink(full)) continue
        const st = statSync(full)
        if (st.isDirectory()) {
          this.walk(full, out, depth + 1, maxDepth)
          continue
        }
        this.processFile(full, name, st, out)
      } catch {
        /* skip */
      }
    }
  }

  /** Cancel a running `scanAsync` (0.1.17 review fix). */
  cancelScan(): void {
    this.scanCancelRequested = true
  }

  private scanCancelRequested = false

  /**
   * Cancellable, yielding variant of `scan()` for the UI. It walks directory by
   * directory, yields to the event loop between directories (so IPC and input
   * stay responsive on a 13 GB output tree) and reports progress.
   */
  async scanAsync(
    root?: string,
    onProgress?: (p: { scanned: number; total: number; done: boolean; cancelled: boolean }) => void
  ): Promise<{ scanned: number; cancelled: boolean }> {
    this.scanCancelRequested = false
    const roots = root ? [root] : this.defaultScanRoots()
    const raw = Number(loadSettings().outputScanDepth ?? 4)
    const maxDepth = Number.isFinite(raw) ? Math.max(2, Math.min(10, Math.floor(raw))) : 4
    this.refreshPrevMap()
    const assets: OutputAsset[] = []
    let cancelled = false
    const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
    const walkDir = async (dir: string, depth: number): Promise<void> => {
      if (cancelled || this.scanCancelRequested || depth > maxDepth) {
        cancelled = cancelled || this.scanCancelRequested
        return
      }
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (this.scanCancelRequested) {
          cancelled = true
          return
        }
        const full = join(dir, name)
        try {
          // Same containment rule as the synchronous walk (see above).
          if (isSymlink(full)) continue
          const st = statSync(full)
          if (st.isDirectory()) {
            await walkDir(full, depth + 1)
            continue
          }
          this.processFile(full, name, st, assets)
        } catch {
          /* skip unreadable entry */
        }
      }
      // A cancel requested by the progress callback (or another IPC) must be
      // reflected even when no entry is left in this directory.
      if (this.scanCancelRequested) cancelled = true
      onProgress?.({ scanned: assets.length, total: assets.length, done: false, cancelled })
      // Directory boundary: let IPC input and other windows work again.
      await tick()
    }
    for (const r of roots) {
      if (!r || !existsSync(r)) continue
      await walkDir(r, 0)
      if (cancelled) break
    }
    // A cancelled scan still merges what it read: partial truth beats a stale
    // index, and the next scan fills the rest.
    mergeUpsertOutputAssets(assets)
    for (const a of assets) this.prevMap.set(a.path, a)
    onProgress?.({ scanned: assets.length, total: assets.length, done: true, cancelled })
    return { scanned: assets.length, cancelled }
  }

  /**
   * Build the index row for one file, or return null when the file is not an
   * indexable output. Extracted so the synchronous walk and the cancellable
   * async walk share exactly one implementation (0.1.17 review fix).
   */
  private processFile(full: string, name: string, st: Stats, out: OutputAsset[]): void {
    const ext = extname(name).toLowerCase()
    // 0.1.14: single source of truth — 3d/audio/raw-image files are now
    // indexed (the old inline chain dropped them as 'other'); genuinely
    // unknown formats are still skipped to keep the index bounded.
    const type: OutputAsset['type'] = classifyOutputType(name)
    if (type === 'other') return

    // Preserve user-linked fields from an existing index row (resident O(1) map).
    const prev = this.prevMap.get(full)

    // (path,size,mtime) unchanged → the indexed analysis is still valid.
    // PNG rows only skip once pngKeys proves a previous metadata pass ran.
    if (
      prev &&
      prev.size === st.size &&
      prev.createdAt === st.mtimeMs &&
      (ext !== '.png' || Array.isArray(prev.params?.pngKeys))
    ) {
      let workflowId = prev.workflowId
      let workflowName = prev.workflowName
      if (!workflowId && prev.promptId) {
        const link = lookupPromptWorkflowLink(prev.promptId)
        if (link?.workflowId) {
          workflowId = link.workflowId
          workflowName = workflowName || link.workflowName
        }
      }
      // Still unlinked? A fingerprint match may exist — outputs produced by
      // direct ComfyUI-frontend runs never had a sidecar (0.1.11). Read the
      // PNG head once, backfill, and persist a sidecar for cheap rescans.
      if (!workflowId && type === 'image' && ext === '.png') {
        try {
          const meta = readPngTextMetaFromFile(full)
          const raw = String(meta.prompt || meta.workflow || '')
          const graph = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
          const hit = graph ? lookupWorkflowByFingerprint(graph)[0] : undefined
          if (hit) {
            workflowId = hit.workflowId
            workflowName = workflowName || hit.workflowName
            if (prev.promptId) {
              try {
                recordPromptWorkflowLink(prev.promptId, hit.workflowId, hit.workflowName)
              } catch {
                /* best-effort */
              }
            }
          }
        } catch {
          /* unreadable meta — keep unlinked */
        }
      }
      out.push({
        ...prev,
        type,
        size: st.size,
        createdAt: st.mtimeMs,
        fileName: basename(full),
        workflowId,
        workflowName
      })
      return
    }

    let params: Record<string, unknown> = {}
    let seed: number | undefined
    let promptId: string | undefined
    /** Embedded graph (prompt or workflow form) for fingerprint matching. */
    let embeddedGraph: Record<string, unknown> | null = null
    if (type === 'image' && ext === '.png') {
      try {
        const meta = readPngTextMetaFromFile(full)
        if (meta.prompt) {
          try {
            const prompt = JSON.parse(String(meta.prompt)) as Record<
              string,
              { inputs?: Record<string, unknown>; class_type?: string }
            >
            embeddedGraph = prompt as Record<string, unknown>
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
        if (!embeddedGraph && meta.workflow) {
          try {
            embeddedGraph = JSON.parse(String(meta.workflow)) as Record<string, unknown>
          } catch {
            /* ignore */
          }
        }
        if (meta.seed && seed == null) seed = Number(meta.seed)
        if (meta.prompt_id) promptId = String(meta.prompt_id)
        params = {
          ...params,
          pngKeys: Object.keys(meta),
          workflow: undefined,
          prompt: undefined
        }
      } catch {
        /* ignore */
      }
    }

    // Attribution priority: existing record → queue-time sidecar →
    // content-fingerprint reverse match (covers ComfyUI-frontend runs).
    const link = promptId ? lookupPromptWorkflowLink(promptId) : undefined
    let fpHit: { workflowId: string; workflowName: string } | undefined
    if (!prev?.workflowId && !link?.workflowId && embeddedGraph) {
      fpHit = lookupWorkflowByFingerprint(embeddedGraph)[0]
      if (fpHit && promptId) {
        try {
          recordPromptWorkflowLink(promptId, fpHit.workflowId, fpHit.workflowName)
        } catch {
          /* best-effort */
        }
      }
    }

    out.push({
      id: createHash('sha1').update(full).digest('hex').slice(0, 16),
      path: full,
      fileName: basename(full),
      type,
      size: st.size,
      createdAt: st.mtimeMs,
      seed: seed ?? prev?.seed,
      promptId: promptId ?? prev?.promptId,
      favorite: prev?.favorite,
      workflowId: prev?.workflowId || link?.workflowId || fpHit?.workflowId,
      workflowName: prev?.workflowName || link?.workflowName || fpHit?.workflowName,
      batchJobId: prev?.batchJobId,
      thumbnail: prev?.thumbnail,
      width: prev?.width,
      height: prev?.height,
      params: { ...(prev?.params || {}), ...params }
    })
  }

  favorite(id: string, favorite: boolean): boolean {
    return Boolean(updateOutputAsset(id, { favorite }))
  }

  /**
   * Delete an output asset. deleteFile=true also removes the file on disk;
   * false only drops the DB record (the file stays for the OS / recycle bin).
   */
  remove(id: string, deleteFile: boolean): boolean {
    const rec = listOutputAssetsAll().find((a) => a.id === id)
    if (!rec) return false
    if (deleteFile && rec.path && existsSync(rec.path)) {
      unlinkSync(rec.path)
    }
    return deleteOutputAsset(id)
  }

  /**
   * Batch delete (0.1.15): delete every selected asset, collecting per-id
   * failures instead of aborting the whole set. The UI reports the exact
   * ok/failed split — never a fabricated all-success.
   */
  batchRemove(
    ids: string[],
    deleteFile: boolean
  ): { ok: number; failed: Array<{ id: string; label: string; error: string }> } {
    // 0.1.17 (WP9-2): failures carry a human label so the UI can list every one
    // (id alone is unreadable in a dialog).
    const rows = new Map(listOutputAssetsAll().map((a) => [a.id, a]))
    const failed: Array<{ id: string; label: string; error: string }> = []
    let ok = 0
    for (const raw of ids) {
      const id = sanitizeId(raw)
      const label = rows.get(id)?.fileName || String(raw)
      try {
        if (!id || !this.remove(id, Boolean(deleteFile))) {
          failed.push({ id: String(raw), label, error: 'not found' })
          continue
        }
        ok += 1
      } catch (e) {
        failed.push({
          id: String(raw),
          label,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
    return { ok, failed }
  }

  /** Multi-file share bundle. */
  async exportZip(paths: string[], destDir?: string): Promise<{ path: string }> {
    if (!paths.length) throw new Error('No files selected')
    const targetDir = destDir || dirname(paths[0])
    mkdirSync(targetDir, { recursive: true })
    const zipPath = join(targetDir, `comfy-pilot-outputs-${Date.now()}.zip`)
    const { writeZip, uniqueZipNames } = await import('../zipWrite')
    const rawNames = paths.map((p) => {
      if (!existsSync(p)) throw new Error(`Missing file: ${p}`)
      return assertSafeRelativeFilename(basename(p))
    })
    // 0.2.0: two `preview.png` files from different folders used to collide in
    // the archive and silently lose one entry.
    const names = uniqueZipNames(rawNames)
    writeZip(
      zipPath,
      paths.map((p, i) => ({ path: p, name: names[i] }))
    )
    return { path: zipPath }
  }

  /**
   * Restore an output PNG's embedded workflow into the TARGET INSTANCE's
   * workflows folder (same as a normal import — one .json artifact).
   */
  async importToWorkflow(
    path: string,
    instanceId?: string
  ): Promise<import('@shared/types').WorkflowRecord | null> {
    const { workflowService } = await import('../workflow')
    const meta = await workflowService.parsePngMeta(path)
    const hasGraph = Boolean(meta?.workflow || meta?.prompt)
    if (!hasGraph) return null
    return workflowService.importFile(path, instanceId)
  }

  /**
   * Register a produced file into the index (used by tests / future callers).
   * Field-merges so concurrent batch linkage is preserved.
   */
  indexFile(abs: string, extra?: Partial<OutputAsset>): void {
    if (!existsSync(abs)) return
    const st = statSync(abs)
    const id = createHash('sha1').update(abs).digest('hex').slice(0, 16)
    mergeUpsertOutputAsset({
      id,
      path: abs,
      fileName: basename(abs),
      // 0.1.14: unified classification (explicit registrations keep every
      // classified type; the caller owns 'other' decisions).
      type: classifyOutputType(basename(abs)),
      size: st.size,
      createdAt: st.mtimeMs,
      params: {},
      ...extra
    })
  }
}

export const outputService = new OutputService()
