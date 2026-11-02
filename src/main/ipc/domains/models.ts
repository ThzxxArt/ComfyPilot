import { bootMarkFirstList } from '../../services/bootTiming'
import { modelService } from '../../services/model'
import { sanitizeId } from '../../services/security'
import { broadcastNotification, isSafeReadPath, wrap } from '../context'
import { safeInstanceId } from '../trust'

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
    scan: wrap((opts?: { roots?: string[]; hash?: boolean }) => modelService.scan(opts)),
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
