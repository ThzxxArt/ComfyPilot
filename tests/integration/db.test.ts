/**
 * Integration: SQLite store layer with electron mocked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const tempDir = mkdtempSync(join(tmpdir(), 'cp-db-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => tempDir
  }
}))

describe('db store (integration)', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* sqlite may keep file handle briefly on Windows */
    }
  })

  it('loads default settings and merges patches', async () => {
    const db = await import('../../src/main/services/db')
    const s0 = db.loadSettings()
    expect(s0.theme).toBe('light')
    const s1 = db.saveSettings({ theme: 'system', locale: 'en-US' })
    expect(s1.theme).toBe('system')
    expect(s1.locale).toBe('en-US')
    const s2 = db.loadSettings()
    expect(s2.theme).toBe('system')
  })

  it('upserts instance configs', async () => {
    const db = await import('../../src/main/services/db')
    const id = 'test-inst-1'
    db.upsertInstanceConfig({
      id,
      name: 'T1',
      path: '/tmp/comfy',
      pythonPath: 'python',
      venvPath: '',
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true,
      notes: '',
      autoStart: false,
      frontendVersion: ''
    })
    const list = db.loadInstanceConfigs()
    expect(list.find((c) => c.id === id)?.name).toBe('T1')
    expect(db.deleteInstanceConfig(id)).toBe(true)
    expect(db.loadInstanceConfigs().find((c) => c.id === id)).toBeUndefined()
  })

  it('models upsert + list + delete', async () => {
    const db = await import('../../src/main/services/db')
    const id = 'm1'
    db.upsertModel({
      id,
      name: 'test',
      fileName: 'test.safetensors',
      category: 'checkpoints',
      path: '/models/test.safetensors',
      size: 10,
      modifiedAt: Date.now(),
      source: 'local',
      tags: [],
      metadata: {},
      trainedWords: [],
      pathRoot: '/models'
    })
    expect(db.listModels().some((m) => m.id === id)).toBe(true)
    expect(db.deleteModel(id)).toBe(true)
    expect(db.listModels().some((m) => m.id === id)).toBe(false)
  })

  it('node snapshots roundtrip with disabled marker in source', async () => {
    const db = await import('../../src/main/services/db')
    const id = 'snap-1'
    db.insertSnapshot({
      id,
      name: 's1',
      createdAt: Date.now(),
      packs: [{ name: 'p', version: '1.0', path: '/x', source: 'local@disabled' }],
      notes: ''
    })
    const snap = db.getSnapshot(id)
    expect(snap?.packs[0].source.endsWith('@disabled')).toBe(true)
    expect(db.deleteSnapshot(id)).toBe(true)
    expect(db.getSnapshot(id)).toBeNull()
  })
})
