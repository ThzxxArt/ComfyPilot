import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  renameSync,
  copyFileSync,
  readdirSync
} from 'fs'
import { join, basename, dirname } from 'path'
import { randomUUID } from 'crypto'
import type { AppSettings, BackupManifest } from '@shared/types'
import {
  backupDir,
  deleteBackup,
  insertBackup,
  listBackups,
  loadInstanceConfigs,
  loadSettings,
  saveSettings,
  listRemotes,
  listModels,
  listWorkflows,
  listNodePacks,
  listSnapshots,
  stringifyJsonc,
  userDataDir
} from './db'
import { sanitizeId, isPathInside } from './security'

function resolveBackupDir(id: string): string {
  const safe = sanitizeId(id)
  const dir = join(backupDir(), safe)
  if (!isPathInside(dir, backupDir())) {
    throw new Error('Invalid backup id')
  }
  return dir
}

/** Replace a jsonc list wholesale so restore matches the backup snapshot. */
function replaceJsoncList(name: string, items: unknown[]): void {
  const p = join(userDataDir(), `${name}.jsonc`)
  const tmp = p + '.tmp'
  writeFileSync(tmp, stringifyJsonc(items), 'utf-8')
  renameSync(tmp, p)
}

/**
 * Copy every workflow entity file referenced by the manifest into
 * `<backup>/workflow-files/<id>/<basename>`. Missing files are recorded
 * but do not abort the backup (the metadata list is still saved).
 */
function snapshotWorkflowFiles(dir: string): { copied: number; missing: number } {
  const wfDir = join(dir, 'workflow-files')
  mkdirSync(wfDir, { recursive: true })
  let copied = 0
  let missing = 0
  for (const wf of listWorkflows()) {
    if (!wf.path || !existsSync(wf.path)) {
      missing += 1
      continue
    }
    const safeId = sanitizeId(wf.id)
    const targetDir = join(wfDir, safeId)
    mkdirSync(targetDir, { recursive: true })
    try {
      copyFileSync(wf.path, join(targetDir, basename(wf.path)))
      copied += 1
    } catch {
      missing += 1
    }
  }
  return { copied, missing }
}

/**
 * Restore workflow entity files from `<backup>/workflow-files/<id>/<file>`.
 * Writes into a staging directory first, then swaps — a crash mid-restore
 * never leaves a half-written file at the final path.
 */
function restoreWorkflowFiles(dir: string): { restored: number; failed: number } {
  const wfDir = join(dir, 'workflow-files')
  if (!existsSync(wfDir)) return { restored: 0, failed: 0 }
  let restored = 0
  let failed = 0
  for (const wf of listWorkflows()) {
    const safeId = sanitizeId(wf.id)
    const srcDir = join(wfDir, safeId)
    if (!existsSync(srcDir) || !wf.path) continue
    const files = readdirSync(srcDir)
    if (!files.length) continue
    const srcFile = join(srcDir, files[0])
    const dest = wf.path
    const staging = dest + '.restore-tmp'
    try {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(srcFile, staging)
      renameSync(staging, dest)
      restored += 1
    } catch {
      failed += 1
      try {
        if (existsSync(staging)) rmSync(staging, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
  return { restored, failed }
}

export class BackupService {
  list(): BackupManifest[] {
    return listBackups()
  }

  create(opts: { name: string; notes?: string }): BackupManifest {
    const id = sanitizeId(randomUUID())
    const dir = join(backupDir(), id)
    mkdirSync(dir, { recursive: true })

    const settings = loadSettings()
    const instances = loadInstanceConfigs()
    const nodePacks = listNodePacks()
    const models = listModels()
    const workflows = listWorkflows()
    const remotes = listRemotes()
    const snapshots = listSnapshots()

    const files: Record<string, unknown> = {
      'settings.json': settings,
      'instances.json': instances,
      'node-packs.json': nodePacks,
      'model-manifest.json': models,
      'workflows.json': workflows,
      'remote-instances.json': remotes,
      'node-snapshots.json': snapshots
    }
    for (const [name, value] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(value, null, 2))
    }

    // Real workflow entity files — metadata alone leaves dangling paths on restore.
    const wfResult = snapshotWorkflowFiles(dir)

    const includes = {
      settings: true,
      instances: true,
      nodePacks: true,
      modelManifest: true,
      workflows: true,
      workflowFiles: wfResult.copied > 0,
      nodeSnapshots: true
    }

    let size = 0
    for (const f of Object.keys(files)) {
      try {
        size += statSync(join(dir, f)).size
      } catch {
        /* ignore */
      }
    }
    // Include workflow-files size
    try {
      const wfDir = join(dir, 'workflow-files')
      if (existsSync(wfDir)) {
        const walk = (d: string): number => {
          let s = 0
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name)
            if (e.isDirectory()) s += walk(p)
            else s += statSync(p).size
          }
          return s
        }
        size += walk(wfDir)
      }
    } catch {
      /* ignore */
    }

    const manifest: BackupManifest = {
      id,
      name: opts.name || `backup-${new Date().toISOString().slice(0, 10)}`,
      createdAt: Date.now(),
      path: dir,
      size,
      includes,
      notes:
        (opts.notes || '') +
        (wfResult.missing ? ` (${wfResult.missing} workflow files missing)` : '')
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    insertBackup(manifest)
    return manifest
  }

  restore(id: string): boolean {
    const dir = resolveBackupDir(id)
    if (!existsSync(dir)) return false

    // Phase 1: parse every file first so a corrupt one cannot abort halfway.
    const errors: string[] = []
    let settings: AppSettings | undefined
    const lists: Record<string, unknown[]> = {}

    const parseFile = (name: string): unknown => {
      const file = join(dir, name)
      if (!existsSync(file)) return undefined
      try {
        return JSON.parse(readFileSync(file, 'utf-8'))
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
        return undefined
      }
    }

    const settingsVal = parseFile('settings.json')
    if (settingsVal !== undefined) {
      if (settingsVal && typeof settingsVal === 'object' && !Array.isArray(settingsVal)) {
        settings = settingsVal as AppSettings
      } else {
        errors.push('settings.json: expected object')
      }
    }
    // Backup file name → jsonc collection name
    const listEntries: Array<[string, string]> = [
      ['instances.json', 'instances'],
      ['node-packs.json', 'node_packs'],
      ['model-manifest.json', 'models'],
      ['workflows.json', 'workflows'],
      ['remote-instances.json', 'remote_instances'],
      ['node-snapshots.json', 'node_snapshots']
    ]
    for (const [file, key] of listEntries) {
      const val = parseFile(file)
      if (val === undefined) continue
      if (Array.isArray(val)) {
        lists[key] = val
      } else {
        errors.push(`${file}: expected array`)
      }
    }

    if (errors.length) {
      throw new Error(`Backup restore aborted, nothing applied — ${errors.join('; ')}`)
    }

    // Phase 2: apply. Lists first (so workflow records exist for file restore),
    // then entity files. Each file write is tmp+rename (atomic per file).
    if (settings) saveSettings(settings)
    for (const [, key] of listEntries) {
      const items = lists[key]
      if (items) replaceJsoncList(key, items)
    }

    // Phase 3: restore workflow entity files (staging + rename per file).
    const wfResult = restoreWorkflowFiles(dir)

    return wfResult.failed === 0
  }

  delete(id: string): boolean {
    const dir = resolveBackupDir(id)
    try {
      if (existsSync(dir) && isPathInside(dir, backupDir())) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
    return deleteBackup(sanitizeId(id))
  }

  openFolder(id: string): string {
    return resolveBackupDir(id)
  }
}

export const backupService = new BackupService()
