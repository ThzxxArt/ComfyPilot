import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.root }
}))
vi.mock('../../src/main/services/secretStorage', () => ({
  encryptSecret: (s: string) => s,
  decryptSecretSafe: (s: string) => ({ value: s, failed: false }),
  isEncryptedSecret: () => false
}))

describe('JSONC v1 -> v2 migration (0.2.0 one-way)', () => {
  beforeEach(() => {
    h.root = join(tmpdir(), `cp-migrate-${process.pid}-${Date.now()}-${Math.random()}`)
    mkdirSync(join(h.root, 'data'), { recursive: true })
    vi.resetModules()
  })
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true })
  })

  it('snapshots v1, writes schemaVersion 2 and keeps data readable', async () => {
    const data = join(h.root, 'data')
    writeFileSync(join(data, 'settings.jsonc'), JSON.stringify({ locale: 'en-US' }))
    writeFileSync(
      join(data, 'instances.jsonc'),
      JSON.stringify([{ id: 'i1', name: 'One', path: '/x' }])
    )

    const db = await import('../../src/main/services/db')
    const state = db.migrateData()
    expect(state.ok).toBe(true)
    expect(state.migratedFiles).toBe(2)
    expect(state.snapshot && existsSync(state.snapshot)).toBe(true)
    expect(existsSync(join(state.snapshot!, 'settings.jsonc'))).toBe(true)

    const settings = JSON.parse(readFileSync(join(data, 'settings.jsonc'), 'utf-8'))
    expect(settings.schemaVersion).toBe(2)
    expect(settings.locale).toBe('en-US')
    const instances = JSON.parse(readFileSync(join(data, 'instances.jsonc'), 'utf-8'))
    expect(instances).toEqual({
      schemaVersion: 2,
      items: [{ id: 'i1', name: 'One', path: '/x' }]
    })
    expect(db.loadSettings().locale).toBe('en-US')
    expect(db.loadInstanceConfigs()).toHaveLength(1)
  })

  it('rejects a v1 file that appears after the migration', async () => {
    const db = await import('../../src/main/services/db')
    expect(db.migrateData().ok).toBe(true)
    writeFileSync(join(h.root, 'data', 'settings.jsonc'), JSON.stringify({ locale: 'zh-CN' }))
    expect(() => db.loadSettings()).toThrow(/DATA_FILE_CORRUPT|DATA_SCHEMA_V1_REJECTED/)
  })
})
