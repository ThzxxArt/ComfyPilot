import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { BackupManifest } from '@shared/types'
import {
  backupDir,
  deleteBackup,
  insertBackup,
  listBackups,
  loadInstanceConfigs,
  loadSettings,
  saveSettings,
  upsertInstanceConfig,
  listRemotes,
  upsertRemote,
  listModels,
  upsertModel,
  listWorkflows,
  upsertWorkflow,
  listNodePacks,
  upsertNodePack
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

    const settingsFile = join(dir, 'settings.json')
    if (existsSync(settingsFile)) {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'))
      saveSettings(settings)
    }

    const instFile = join(dir, 'instances.json')
    if (existsSync(instFile)) {
      const instances = JSON.parse(readFileSync(instFile, 'utf-8')) as Parameters<
        typeof upsertInstanceConfig
      >[0][]
      for (const i of instances) upsertInstanceConfig(i)
    }

    const nodeFile = join(dir, 'node-packs.json')
    if (existsSync(nodeFile)) {
      const packs = JSON.parse(readFileSync(nodeFile, 'utf-8')) as Parameters<
        typeof upsertNodePack
      >[0][]
      for (const p of packs) upsertNodePack(p)
    }

    const modelFile = join(dir, 'model-manifest.json')
    if (existsSync(modelFile)) {
      const models = JSON.parse(readFileSync(modelFile, 'utf-8')) as Parameters<
        typeof upsertModel
      >[0][]
      for (const m of models) upsertModel(m)
    }

    const wfFile = join(dir, 'workflows.json')
    if (existsSync(wfFile)) {
      const workflows = JSON.parse(readFileSync(wfFile, 'utf-8')) as Parameters<
        typeof upsertWorkflow
      >[0][]
      for (const w of workflows) upsertWorkflow(w)
    }

    const remoteFile = join(dir, 'remote-instances.json')
    if (existsSync(remoteFile)) {
      const remotes = JSON.parse(readFileSync(remoteFile, 'utf-8')) as Parameters<
        typeof upsertRemote
      >[0][]
      for (const r of remotes) upsertRemote(r)
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
