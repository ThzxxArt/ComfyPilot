import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ appDir: '', roots: [] as string[] }))

vi.mock('electron', () => ({
  app: { getPath: () => h.appDir }
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => ({ modelScanRoots: h.roots, proxy: {} }),
  loadInstanceConfigs: () => [],
  listModels: () => [],
  deleteModel: vi.fn(),
  upsertModel: vi.fn(),
  upsertModels: vi.fn(),
  updateModel: vi.fn(),
  upsertDownloadTask: vi.fn(),
  replaceDownloadTasks: vi.fn(),
  listDownloadTasks: () => []
}))

import { pathCapabilities } from '../../src/main/services/pathCapability'
import { modelService } from '../../src/main/services/model'

let root = ''
let models = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cp-download-'))
  h.appDir = join(root, 'app')
  models = join(root, 'models')
  mkdirSync(h.appDir, { recursive: true })
  mkdirSync(models, { recursive: true })
  h.roots = [models]
  pathCapabilities.revokeAll()
})

afterEach(() => {
  pathCapabilities.revokeAll()
  rmSync(root, { recursive: true, force: true })
})

describe('model.download extension policy (0.2.5 WP10 / S1+S2)', () => {
  it.each(['main.py', 'python.exe', '.bashrc', 'startup.bat', 'run.sh', 'evil.desktop'])(
    'refuses %s',
    async (fileName) => {
      await expect(
        modelService.download({
          url: 'https://example.com/file',
          destDir: models,
          fileName
        })
      ).rejects.toThrow(/non-model download extension|Empty filename/i)
    }
  )

  it('refuses an extensionless download', async () => {
    await expect(
      modelService.download({ url: 'https://example.com/file', destDir: models })
    ).rejects.toThrow(/non-model download extension/i)
  })

  it('still refuses a destination outside the model roots', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    await expect(
      modelService.download({
        url: 'https://example.com/file',
        destDir: outside,
        fileName: 'model.safetensors'
      })
    ).rejects.toThrow(/outside allowed model roots/i)
  })
})
