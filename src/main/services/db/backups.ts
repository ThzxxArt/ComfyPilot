import type { BackupManifest } from '@shared/types'
import { readJsonc, writeJsonc } from './jsonc'

// ---------- Backups ----------
export function listBackups(): BackupManifest[] {
  return readJsonc<BackupManifest[]>('backups', [])
}

export function insertBackup(b: BackupManifest): void {
  const list = listBackups()
  list.push(b)
  writeJsonc('backups', list)
}

export function deleteBackup(id: string): boolean {
  const list = listBackups()
  const next = list.filter((b) => b.id !== id)
  writeJsonc('backups', next)
  return next.length !== list.length
}
