import { join } from 'path'
import { bootMarkFirstList } from '../../services/bootTiming'
import { modelService } from '../../services/model'
import { loadInstanceConfigs, loadSettings } from '../../services/db'
import { resolveInsideAnyRoot, sanitizeId } from '../../services/security'
import { approvedReadRoots, broadcastNotification, isSafeReadPath, wrap } from '../context'
import { safeInstanceId } from '../trust'

/**
 * Model scanning walks a directory tree and returns every matching file name.
 * The renderer may only scan roots the user configured (Settings), the active
 * instances' own models/ folders, or a folder explicitly chosen in the OS
 * picker — never an arbitrary path supplied over IPC.
 */
function assertAllowedScanRoots(roots: string[]): void {
  if (!roots.length) return
  const allowed = [
    ...(loadSettings().modelScanRoots || []),
    ...loadInstanceConfigs()
      .map((c) => (c.path ? join(c.path, 'models') : ''))
      .filter(Boolean),
    ...approvedReadRoots
  ]
  for (const root of roots) {
    if (!resolveInsideAnyRoot(root, allowed)) {
      throw new Error(`Blocked model scan root outside the configured model directories: ${root}`)
    }
  }
}

export function createModelHandlers() {
  return {
    list: wrap(async () => {
      bootMarkFirstList('model.list')
      const { thumbnailDisplayUrl } = await import('../../services/media')
      const list = await modelService.list()
      return list.map((m) => ({
        ...m,
        thumbnail: thumbnailDisplayUrl(m.thumbnail) || undefined
      }))
    }),
    scan: wrap((opts?: { roots?: string[]; hash?: boolean }) => {
      if (opts?.roots?.length) assertAllowedScanRoots(opts.roots)
      return modelService.scan(opts)
    }),
    remove: wrap((id: string, deleteFile: boolean) => modelService.remove(id, deleteFile)),
    move: wrap((id: string, destDir: string) => modelService.move(id, destDir)),
    symlink: wrap((id: string, destDir: string) => modelService.symlink(id, destDir)),
    rename: wrap((id: string, name: string) => modelService.rename(id, name)),
    tag: wrap((id: string, tags: string[]) => modelService.tag(id, tags)),
    findDuplicates: wrap(() => modelService.findDuplicates()),
    downloads: wrap(() => modelService.listDownloads()),
    download: wrap((opts: { url: string; destDir?: string; fileName?: string }) =>
      modelService.download(opts)
    ),
    pauseDownload: wrap((id: string) => modelService.pauseDownload(id)),
    prioritizeDownload: wrap((id: string) => modelService.prioritizeDownload(sanitizeId(id))),
    resumeDownload: wrap((id: string) => modelService.resumeDownload(id)),
    cancelDownload: wrap((id: string) => modelService.cancelDownload(id)),
    clearFinishedDownloads: wrap(() => modelService.clearFinishedDownloads()),
    storageStats: wrap(() => modelService.storageStats()),
    parseExtraPaths: wrap(async (file?: string) => {
      // 0.1.18 (regression): every other renderer-supplied read path is gated;
      // this one let the page make main parse an arbitrary file.
      if (file && !isSafeReadPath(file)) throw new Error('Blocked unsafe extra_model_paths path')
      const { parseExtraModelPaths } = await import('../../services/model')
      return parseExtraModelPaths(file)
    }),
    reconcile: wrap((instanceId?: string) => modelService.reconcile(safeInstanceId(instanceId))),
    fetchCivitaiMeta: wrap((id: string) => modelService.fetchCivitaiMeta(id)),
    ensureThumbs: wrap(async () => {
      const { thumbnailService } = await import('../../services/media')
      return thumbnailService.ensureAll()
    }),
    batchRename: wrap(async (opts: { ids: string[]; pattern: string; dryRun?: boolean }) => {
      const { renameService } = await import('../../services/media')
      return renameService.batchRename(opts.ids, opts.pattern, opts.dryRun)
    })
  }
}

/** Terminal download results surface as global toasts (ModelsView may be unmounted). */
export function registerModelNotifications(): void {
  modelService.on('notify', (n) =>
    broadcastNotification(n as Parameters<typeof broadcastNotification>[0])
  )
}
