import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  failWriteName: ''
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.root }
}))
vi.mock('../../src/main/services/secretStorage', () => ({
  encryptSecret: (s: string) => s,
  decryptSecretSafe: (s: string) => ({ value: s, failed: false }),
  isEncryptedSecret: () => false
}))
vi.mock('../../src/main/services/db/jsonc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/db/jsonc')>()
  return {
    ...actual,
    writeJsonc: (name: string, value: unknown) => {
      if (name === h.failWriteName) throw new Error('disk full while migrating')
      return actual.writeJsonc(name, value)
    }
  }
})

describe('JSONC v1 -> v2 migration (0.2.0 one-way)', () => {
  beforeEach(() => {
    h.root = join(tmpdir(), `cp-migrate-${process.pid}-${Date.now()}-${Math.random()}`)
    h.failWriteName = ''
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

  it('fails closed when the pre-upgrade snapshot cannot be created', async () => {
    const data = join(h.root, 'data')
    const settingsPath = join(data, 'settings.jsonc')
    const instancesPath = join(data, 'instances.jsonc')
    const settingsBefore = JSON.stringify({ locale: 'en-US' })
    const instancesBefore = JSON.stringify([{ id: 'i1', name: 'One', path: '/x' }])
    writeFileSync(settingsPath, settingsBefore)
    writeFileSync(instancesPath, instancesBefore)
    // The snapshot name is derived from the clock; a file at that exact path
    // makes mkdirSync fail (EEXIST) before any migration write.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const snapshot = join(data, 'pre-upgrade-2026-01-01T00-00-00-000Z')
      writeFileSync(snapshot, 'not a directory')
      const db = await import('../../src/main/services/db')
      const state = db.migrateData()
      expect(state.ok).toBe(false)
      expect(state.error).toMatch(/pre-upgrade snapshot failed/i)
      // No file was touched.
      expect(readFileSync(settingsPath, 'utf-8')).toBe(settingsBefore)
      expect(readFileSync(instancesPath, 'utf-8')).toBe(instancesBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores every original byte when a mid-migration write fails, then retries cleanly', async () => {
    const data = join(h.root, 'data')
    const settingsPath = join(data, 'settings.jsonc')
    const instancesPath = join(data, 'instances.jsonc')
    const settingsBefore = JSON.stringify({ locale: 'en-US' })
    const instancesBefore = JSON.stringify([{ id: 'i1', name: 'One', path: '/x' }], null, 2)
    writeFileSync(settingsPath, settingsBefore)
    writeFileSync(instancesPath, instancesBefore)
    h.failWriteName = 'instances'
    const db = await import('../../src/main/services/db')
    const state = db.migrateData()
    expect(state.ok).toBe(false)
    expect(state.error).toMatch(/disk full/i)
    expect(state.snapshot && existsSync(state.snapshot)).toBe(true)
    // Rollback restored the exact pre-migration bytes (settings may already
    // have been rewritten before the failing file).
    expect(readFileSync(settingsPath, 'utf-8')).toBe(settingsBefore)
    expect(readFileSync(instancesPath, 'utf-8')).toBe(instancesBefore)
    expect(existsSync(join(state.snapshot!, 'instances.jsonc'))).toBe(true)

    // Retry must reset the counter, not accumulate from the failed attempt.
    h.failWriteName = ''
    const retried = db.retryDataMigration()
    expect(retried.ok).toBe(true)
    expect(retried.migratedFiles).toBe(2)
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).schemaVersion).toBe(2)
    expect(JSON.parse(readFileSync(instancesPath, 'utf-8')).schemaVersion).toBe(2)
  })
})
