import { existsSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { shell } from 'electron'
import type { WorkflowRecord } from '@shared/types'
import { IPC_EVENTS } from '@shared/types'
import { loadInstanceConfigs } from '../../services/db'
import { outputService } from '../../services/p1p2'
import {
  isSafeExportSourcePath,
  isSafeOpenPathUnderRoots,
  realpathUnderAnyRoot,
  resolveInsideAnyRoot,
  sanitizeId
} from '../../services/security'
import { approvedReadRoots, broadcast, collectRevealRoots, isSafeReadPath, wrap } from '../context'
import { safeInstanceId } from '../trust'

export function createOutputHandlers() {
  return {
    // 0.1.17 (WP7): explicit disk scan, separate from listing. The async walk
    // yields between directories, reports progress and can be cancelled — the
    // old synchronous walk froze every IPC call for the whole 13 GB tree.
    scan: wrap(async (opts?: { root?: string }) => {
      const { outputService } = await import('../../services/p1p2')
      let root = opts?.root
      if (root) {
        const { workflowLibraryDir } = await import('../../services/db')
        const { resolveOutputDir } = await import('@shared/outputDir')
        const allowed = [
          workflowLibraryDir(),
          ...loadInstanceConfigs().map((i) => resolveOutputDir(i)),
          ...loadInstanceConfigs().map((i) => join(i.path, 'user', 'default', 'workflows'))
        ].filter(Boolean) as string[]
        const resolved = resolveInsideAnyRoot(root, allowed)
        if (!resolved) throw new Error('Output root is outside the allowed areas')
        root = resolved
      }
      // 0.1.18 (WP5): scans appear in the shell task center and can be
      // stopped from there, not only from the output page.
      const { operationRegistry } = await import('../../services/ops')
      const op = operationRegistry.begin({
        id: 'output-scan:local',
        kind: 'output-scan',
        target: 'local',
        percent: null,
        cancel: () => {
          outputService.cancelScan()
          return true
        }
      })
      try {
        const result = await outputService.scanAsync(root, (p) => {
          broadcast(IPC_EVENTS.outputScanProgress, p)
          // The walk has no upfront file count — honest indeterminate progress.
          op.update({ detail: `${p.scanned} files`, percent: null })
        })
        op.finish(result.cancelled ? 'cancelled' : 'done')
        return { scanned: result.scanned, cancelled: result.cancelled }
      } catch (e) {
        op.finish('failed', e instanceof Error ? e.message : String(e))
        throw e
      }
    }),
    scanCancel: wrap(async () => {
      const { outputService } = await import('../../services/p1p2')
      outputService.cancelScan()
      return true
    }),
    list: wrap(
      async (opts?: {
        root?: string
        type?: string
        limit?: number
        offset?: number
        favorite?: boolean
        batchJobId?: string
        workflowId?: string
        workflowIds?: string[]
        sort?: 'createdAt' | 'size' | 'name'
        order?: 'asc' | 'desc'
        createdFrom?: number
        createdTo?: number
      }) => {
        // Renderer-supplied root must sit inside an allow-listed output area.
        if (opts?.root) {
          const { workflowLibraryDir } = await import('../../services/db')
          const { resolveOutputDir } = await import('@shared/outputDir')
          const allowed = [
            workflowLibraryDir(),
            ...loadInstanceConfigs().map((i) => resolveOutputDir(i)),
            ...loadInstanceConfigs().map((i) => join(i.path, 'user', 'default', 'workflows'))
          ].filter(Boolean) as string[]
          // Per-segment normalization + resolve so `..` hops can't escape the
          // allow-list (0.1.9; the old prefix check was lexical-only).
          if (!resolveInsideAnyRoot(opts.root, allowed)) {
            throw new Error('Output root is outside the allowed areas')
          }
        }
        const { thumbnailDisplayUrl, toMediaUrl, resolveMediaUrlToPath } =
          await import('../../services/media')
        const { existsSync } = await import('fs')
        // 0.1.17 (WP7): cap the page size and never scan here — scanning is an
        // explicit `output.scan` (a page of 200 thumbs used to rewrite the
        // whole index once per thumbnail).
        const result = outputService.list({
          ...opts,
          limit: Math.max(1, Math.min(Number(opts?.limit) || 60, 200))
        })
        // 0.1.18 (WP4): NO thumbnail generation here. Producing up to 60
        // downscales inside the IPC call cost 2.6 s before the first row could
        // paint. Existing thumbs are resolved synchronously; missing ones are
        // flagged `thumbPending` and fetched one-by-one via `output.thumb`.
        const items = result.items.map((a) => {
          let thumb: string | undefined
          if (a.thumbnail) {
            if (a.thumbnail.startsWith('comfy-pilot-media:')) {
              thumb = resolveMediaUrlToPath(a.thumbnail) ? a.thumbnail : undefined
            } else if (existsSync(a.thumbnail)) {
              thumb = thumbnailDisplayUrl(a.thumbnail) || undefined
            }
          }
          // Only advertise media URLs for files that still exist — a stale DB
          // row for a deleted output must not produce a 403ing <img>/<video>.
          const mediaUrl = existsSync(a.path) ? toMediaUrl(a.path) || undefined : undefined
          return {
            ...a,
            // Images may fall back to the full-size URL until the lazy thumb
            // arrives; videos render <video> directly (no raster thumb).
            thumbnail: thumb || (a.type === 'image' ? mediaUrl : undefined),
            mediaUrl,
            thumbPending: !thumb && a.type === 'image'
          }
        })
        return { ...result, items }
      }
    ),
    thumb: wrap(async (path: string) => {
      // 0.1.18 (WP4): on-demand thumbnail for one already-listed asset. The
      // path must stay inside the output/reveal allow-list — this must never
      // become a generic "rasterize any path" primitive.
      const allowed = resolveInsideAnyRoot(path, await collectRevealRoots())
      if (!allowed) throw new Error('Blocked thumbnail path outside allowed areas')
      const { thumbnailDisplayUrl, thumbnailService } = await import('../../services/media')
      const generated = await thumbnailService.ensureOutputThumb(allowed)
      return { url: generated ? thumbnailDisplayUrl(generated) || undefined : undefined }
    }),
    assetsMatch: wrap(async (instanceId: string, fileName: string) => {
      // Read-only assets-system lookup (0.1.14); never throws — null means
      // "assets API unavailable", [] means "no match".
      const { matchAssetsByFileName } = await import('../../services/assetsApi')
      return matchAssetsByFileName(instanceId, fileName)
    }),
    open: wrap(async (path: string) => {
      const roots = [...(await collectRevealRoots()), ...approvedReadRoots]
      const real = realpathUnderAnyRoot(path, roots)
      if (!real || !isSafeOpenPathUnderRoots(real, roots)) {
        throw new Error('Blocked opening file outside allowed areas')
      }
      return shell.openPath(real).then((r) => r === '')
    }),
    reveal: wrap(async (path: string) => {
      // Same allow-list as shell.reveal — the outputs library must not become
      // a weaker second door into the filesystem (0.1.9). A symlink inside an
      // output root must resolve to a real target that is still inside a root.
      const roots = [...(await collectRevealRoots()), ...approvedReadRoots]
      const real = realpathUnderAnyRoot(path, roots)
      if (!real) throw new Error('Blocked revealing path outside allowed areas')
      shell.showItemInFolder(real)
      return true
    }),
    favorite: wrap((id: string, favorite: boolean) => outputService.favorite(id, favorite)),
    remove: wrap((id: string, deleteFile: boolean) =>
      outputService.remove(sanitizeId(id), Boolean(deleteFile))
    ),
    batchDelete: wrap((ids: string[], deleteFile: boolean) => {
      if (!Array.isArray(ids) || !ids.length) throw new Error('No files selected')
      return outputService.batchRemove(ids.map(String), Boolean(deleteFile))
    }),
    importToWorkflow: wrap(
      async (path: string, instanceId?: string): Promise<WorkflowRecord | null> => {
        if (!isSafeReadPath(path)) throw new Error('Blocked unsafe image path')
        return outputService.importToWorkflow(path, safeInstanceId(instanceId))
      }
    ),
    exportZip: wrap(async (paths: string[], destDir?: string) => {
      if (!Array.isArray(paths) || !paths.length) throw new Error('No files selected')
      const sourceRoots = [...(await collectRevealRoots()), ...approvedReadRoots]
      for (const p of paths) {
        // 0.2.0: an archive source is a READ of a real file. It must resolve
        // under an app-owned/output root; the old `isSafeOpenPath` fallback
        // allowed exporting ANY extension-less file on disk.
        if (!isSafeExportSourcePath(p, sourceRoots)) {
          throw new Error(`Blocked unsafe path: ${basename(p)}`)
        }
      }
      if (destDir) {
        if (!existsSync(destDir)) throw new Error('Export directory does not exist')
        const { workflowLibraryDir, cacheDir } = await import('../../services/db')
        const allowed = [
          join(homedir(), 'Downloads', 'ComfyPilot'),
          workflowLibraryDir(),
          cacheDir(),
          ...loadInstanceConfigs().map((i) => i.path)
        ].filter(Boolean) as string[]
        // resolveInsideAnyRoot collapses `..` (lexical prefix checks let
        // `<allowed>/../Desktop` through on every platform).
        if (!resolveInsideAnyRoot(destDir, allowed)) {
          throw new Error('Export directory is outside the allowed roots')
        }
      }
      return outputService.exportZip(paths, destDir)
    })
  }
}
