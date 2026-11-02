import { shell } from 'electron'
import { backupService } from '../../services/backup'
import { sanitizeId } from '../../services/security'
import { broadcastNotification, wrap } from '../context'

export function createBackupHandlers() {
  return {
    list: wrap(() => backupService.list()),
    create: wrap((opts: { name: string; notes?: string }) => backupService.create(opts)),
    preview: wrap((id: string) => backupService.preview(sanitizeId(id))),
    restore: wrap(
      async (id: string, opts?: { sections?: import('@shared/types').BackupRestoreSection[] }) => {
        const result = backupService.restore(sanitizeId(id), opts)
        if (result.ok) {
          broadcastNotification({
            type: 'success',
            title: 'Backup restored',
            titleKey: 'notify.backupRestored',
            message:
              'Settings / instances / node packs / model manifests / workflows / remotes have been restored. Reload views to see changes.',
            duration: 6000
          })
        }
        return result
      }
    ),
    remove: wrap((id: string) => backupService.delete(sanitizeId(id))),
    openFolder: wrap(async (id: string) => {
      const folder = backupService.openFolder(sanitizeId(id))
      return shell.openPath(folder).then((r) => r === '')
    })
  }
}
