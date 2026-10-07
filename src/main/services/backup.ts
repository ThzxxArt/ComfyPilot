import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, renameSync } from 'fs'
import { join } from 'path'
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

    const files: Record<string, unknown> = {
      'settings.json': settings,
      'instances.json': instances,
      'node-packs.json': nodePacks,
      'model-manifest.json': models,
      'workflows.json': workflows,
      'remote-instances.json': remotes
    }
    for (const [name, value] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(value, null, 2))
    }

    const includes = {
      settings: true,
      instances: true,
      nodePacks: true,
      modelManifest: true,
      workflows: true
    }

    let size = 0
    for (const f of Object.keys(files)) {
      try {
        size += statSync(join(dir, f)).size
      } catch {
        /* ignore */
      }
    }

    const manifest: BackupManifest = {
      id,
      name: opts.name || `backup-${new Date().toISOString().slice(0, 10)}`,
      createdAt: Date.now(),
      path: dir,
      size,
      includes,
      notes: opts.notes || ''
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    insertBackup(manifest)
    return manifest
  }

  restore(id: string): boolean {
    const dir = resolveBackupDir(id)
    if (!existsSync(dir)) return false

    // Parse every file first so a corrupt one cannot abort halfway through apply.
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
      ['remote-instances.json', 'remote_instances']
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

    // Apply only after all files parsed: whole-list replace so records deleted
    // after the backup was taken do not survive the restore.
    if (settings) saveSettings(settings)
    for (const [, key] of listEntries) {
      const items = lists[key]
      if (items) replaceJsoncList(key, items)
    }

    return true
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
