import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, cpSync } from 'fs'
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
  upsertInstanceConfig
} from './db'
import { listModels, upsertModel } from './db'
import { listWorkflows, upsertWorkflow } from './db'
import { listNodePacks, upsertNodePack } from './db'

export class BackupService {
  list(): BackupManifest[] {
    return listBackups()
  }

  create(opts: { name: string; notes?: string }): BackupManifest {
    const id = randomUUID()
    const dir = join(backupDir(), id)
    mkdirSync(dir, { recursive: true })

    const settings = loadSettings()
    const instances = loadInstanceConfigs()
    const nodePacks = listNodePacks()
    const models = listModels()
    const workflows = listWorkflows()

    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
    writeFileSync(join(dir, 'instances.json'), JSON.stringify(instances, null, 2))
    writeFileSync(join(dir, 'node-packs.json'), JSON.stringify(nodePacks, null, 2))
    writeFileSync(join(dir, 'model-manifest.json'), JSON.stringify(models, null, 2))
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(workflows, null, 2))

    const includes = {
      settings: true,
      instances: true,
      nodePacks: true,
      modelManifest: true,
      workflows: true
    }

    let size = 0
    for (const f of ['settings.json', 'instances.json', 'node-packs.json', 'model-manifest.json', 'workflows.json']) {
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
    const dir = join(backupDir(), id)
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

    return true
  }

  delete(id: string): boolean {
    const dir = join(backupDir(), id)
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    return deleteBackup(id)
  }

  openFolder(id: string): string {
    return join(backupDir(), id)
  }
}

export const backupService = new BackupService()

void cpSync
