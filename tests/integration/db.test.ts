import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const tempDir = mkdtempSync(join(tmpdir(), 'cp-jsonc-'))
;(globalThis as { __cpTestDir?: string }).__cpTestDir = tempDir

vi.mock('electron', () => ({
  app: {
    getPath: () => (globalThis as { __cpTestDir?: string }).__cpTestDir || 'C:\\tmp\\cp-jsonc'
  }
}))

describe('JSONC store (integration)', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('parseJsonc strips comments and trailing commas', async () => {
    const { parseJsonc } = await import('../../src/main/services/db')
    const v = parseJsonc<{ a: number; b: string[] }>(`{
      // line comment
      "a": 1, /* block */
      "b": ["x", "y",], // tail
    }`)
    expect(v.a).toBe(1)
    expect(v.b).toEqual(['x', 'y'])
  })

  it('parseJsonc keeps comment-like content inside strings', async () => {
    const { parseJsonc } = await import('../../src/main/services/db')
    expect(parseJsonc<{ s: string }>('{"s":"http://x//y"}').s).toBe('http://x//y')
    expect(parseJsonc<{ s: string }>('{"s":"a/*b*/c"}').s).toBe('a/*b*/c')
  })

  it('settings round-trip writes jsonc with header', async () => {
    const db = await import('../../src/main/services/db')
    const s0 = db.loadSettings()
    expect(s0.theme).toBe('light')
    const s1 = db.saveSettings({ locale: 'en-US', proxy: { ...s0.proxy, port: 9999 } })
    expect(s1.locale).toBe('en-US')
    expect(s1.proxy.port).toBe(9999)
    const file = join(db.userDataDir(), 'settings.jsonc')
    expect(existsSync(file)).toBe(true)
    const raw = readFileSync(file, 'utf-8')
    expect(raw.startsWith('//')).toBe(true)
    expect(db.loadSettings().proxy.port).toBe(9999)
  })

  it('instances and models upsert/delete', async () => {
    const db = await import('../../src/main/services/db')
    db.upsertInstanceConfig({
      id: 'i1',
      name: 'T',
      path: '/tmp/c',
      pythonPath: '',
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
    expect(db.loadInstanceConfigs().some((c) => c.id === 'i1')).toBe(true)
    expect(db.deleteInstanceConfig('i1')).toBe(true)

    db.upsertModel({
      id: 'm1',
      name: 'x',
      fileName: 'x.safetensors',
      category: 'checkpoints',
      path: '/m/x.safetensors',
      size: 1,
      modifiedAt: 1,
      source: 'local',
      tags: [],
      metadata: {},
      trainedWords: [],
      pathRoot: '/m'
    })
    expect(db.listModels().some((m) => m.id === 'm1')).toBe(true)
    expect(db.deleteModel('m1')).toBe(true)
  })
})
