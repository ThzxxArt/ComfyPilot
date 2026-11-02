/** Shared backup + restore types. */

// ---------- Backup ----------
export interface BackupManifest {
  id: string
  name: string
  createdAt: number
  path: string
  size: number
  includes: {
    settings: boolean
    instances: boolean
    nodePacks: boolean
    modelManifest: boolean
    workflows: boolean
    workflowFiles?: boolean
    nodeSnapshots?: boolean
  }
  notes: string
}

/** Sections a backup restore can apply (0.1.18 WP1/WP7). */
export type BackupRestoreSection =
  'settings' | 'instances' | 'nodePacks' | 'models' | 'workflows' | 'remotes' | 'snapshots'

export interface BackupWorkflowFilePreview {
  id: string
  name: string
  /** Validated write target under a trusted root — never the backup's raw path. */
  target: string
  remapped: boolean
  missing: boolean
}

/**
 * Dry-run result shown before applying a restore (0.1.18). `canRestore:false`
 * means the backup references paths this machine does not trust, or a file is
 * unparseable; restore() refuses with the same evidence.
 */
export interface BackupRestorePreview {
  id: string
  name: string
  counts: Record<string, number>
  settingsChanged: string[]
  workflowFiles: BackupWorkflowFilePreview[]
  invalidPaths: string[]
  warnings: string[]
  canRestore: boolean
}

export interface BackupRestoreResult {
  ok: boolean
  restored: number
  failed: number
  warnings: string[]
  /** 0.1.18 (review): automatic snapshot taken before applying the restore. */
  preRestoreId?: string
}
