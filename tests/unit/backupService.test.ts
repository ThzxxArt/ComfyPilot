/**
 * BackupService behaviour (0.1.10): create/restore/delete with real files on
 * a tmpdir and an in-memory db layer.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => {
  const state = {
    root: '',
    backups: [] as Array<Record<string, unknown>>,
    settings: { locale: 'zh-CN' },
    savedSettings: null as unknown,
    instances: [] as Array<Record<string, unknown>>,
    models: [] as Array<Record<string, unknown>>,
    workflows: [] as Array<Record<string, unknown>>,
    nodes: [] as Array<Record<string, unknown>>,
    snaps: [] as Array<Record<string, unknown>>,
    remotes: [] as Array<Record<string, unknown>>
  }
  return { state }
})

// 0.1.17 (review fix): prove the restore path re-encrypts instead of writing
// whatever `listRemotes()` handed it (which is decrypted plaintext).
vi.mock('../../src/main/services/secretStorage', () => ({
  encryptSecret: (s: string) => (s ? `enc:${Buffer.from(s, 'utf-8').toString('base64')}` : ''),
  decryptSecretSafe: (s: string) =>
    s.startsWith('enc:')
      ? { value: Buffer.from(s.slice(4), 'base64').toString('utf-8'), failed: false }
      : { value: s, failed: false },
  isEncryptedSecret: (s: string) => s.startsWith('enc:')
}))

vi.mock('../../src/main/services/db', () => ({
  backupDir: () => join(h.state.root, 'backups'),
  userDataDir: () => h.state.root,
  insertBackup: (b: Record<string, unknown>) => {
    h.state.backups.push(b)
  },
  deleteBackup: (id: string) => {
    const before = h.state.backups.length
    h.state.backups = h.state.backups.filter((b) => b.id !== id)
    return h.state.backups.length !== before
  },
  listBackups: () => h.state.backups,
  loadSettings: () => h.state.settings,
  saveSettings: (s: unknown) => {
    h.state.savedSettings = s
    return s
  },
  loadInstanceConfigs: () => h.state.instances,
  listRemotes: () => h.state.remotes,
  listModels: () => h.state.models,
  listWorkflows: () => h.state.workflows,
  listNodePacks: () => h.state.nodes,
  listSnapshots: () => h.state.snaps,
  stringifyJsonc: (v: unknown) => JSON.stringify(v)
}))

async function freshBackup(): Promise<any> {
  vi.resetModules()
  return (await import('../../src/main/services/backup')).backupService
}

describe('BackupService (0.1.10 behaviour)', () => {
  // tmpfs hygiene (0.1.15): residue from un-cleaned tmpdirs accumulated to
  // hundreds of MB and once tripped the installer disk gate on a full /tmp.
  beforeEach(() => {
    if (h.state.root) rmSync(h.state.root, { recursive: true, force: true })
    h.state.root = mkdtempSync(join(tmpdir(), 'cp-backup-'))
    h.state.backups = []
    h.state.savedSettings = null
    h.state.savedSettings = null
    h.state.settings = { locale: 'zh-CN' }
    h.state.instances = []
    h.state.models = []
    h.state.workflows = []
    h.state.nodes = []
    h.state.snaps = []
    h.state.remotes = []
  })

  afterAll(() => {
    if (h.state.root) {
      try {
        rmSync(h.state.root, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  it('create() snapshots metadata, copies workflow files and counts missing ones', async () => {
    const goodWf = join(h.state.root, 'wf-good.json')
    writeFileSync(goodWf, '{"nodes":[]}')
    h.state.workflows = [
      { id: 'wf1', path: goodWf },
      { id: 'wf2', path: join(h.state.root, 'does-not-exist.json') }
    ]
    h.state.instances = [{ id: 'i1', name: 'I' }]
    const svc = await freshBackup()
    const manifest = svc.create({ name: 'snap1', notes: 'n' })

    expect(h.state.backups).toHaveLength(1)
    const dir = join(h.state.root, 'backups', manifest.id)
    for (const f of [
      'settings.json',
      'instances.json',
      'node-packs.json',
      'model-manifest.json',
      'workflows.json',
      'manifest.json'
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true)
    }
    const copied = join(dir, 'workflow-files', 'wf1', basename(goodWf))
    expect(existsSync(copied)).toBe(true)
    expect(readFileSync(copied, 'utf-8')).toBe('{"nodes":[]}')
    expect(manifest.includes.workflowFiles).toBe(true)
    expect(manifest.notes).toContain('missing')
    expect(manifest.size).toBeGreaterThan(0)
  })

  it('create() marks workflowFiles=false when nothing was copied', async () => {
    const svc = await freshBackup()
    const manifest = svc.create({ name: 'empty' })
    expect(manifest.includes.workflowFiles).toBe(false)
  })

  it('restore() applies settings + lists + workflow files atomically', async () => {
    const wfDest = join(h.state.root, 'restore-target', 'w.json')
    h.state.workflows = [{ id: 'wf1', path: wfDest }]

    const svc = await freshBackup()
    const id = 'b-restore'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(join(dir, 'workflow-files', 'wf1'), { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en-US' }))
    writeFileSync(join(dir, 'instances.json'), JSON.stringify([{ id: 'i9' }]))
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify([{ id: 'wf1', path: wfDest }]))
    writeFileSync(join(dir, 'workflow-files', 'wf1', 'w.json'), '{"restored":true}')

    expect(svc.restore(id)).toBe(true)
    expect((h.state.savedSettings as any).locale).toBe('en-US')
    expect(JSON.parse(readFileSync(join(h.state.root, 'instances.jsonc'), 'utf-8'))).toEqual([
      { id: 'i9' }
    ])
    expect(JSON.parse(readFileSync(wfDest, 'utf-8'))).toEqual({ restored: true })
  })

  it('restore() aborts with nothing applied when a backup file is corrupt', async () => {
    const svc = await freshBackup()
    const id = 'b-corrupt'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en-US' }))
    writeFileSync(join(dir, 'instances.json'), '{not json')
    expect(() => svc.restore(id)).toThrow(/nothing applied/)
    // Settings must NOT have been applied once any file failed to parse.
    expect(h.state.savedSettings).toBeNull()
  })

  it('restore() returns false for unknown ids; delete() removes dir + record', async () => {
    const svc = await freshBackup()
    expect(svc.restore('missing')).toBe(false)

    const manifest = svc.create({ name: 'to-delete' })
    const dir = join(h.state.root, 'backups', manifest.id)
    expect(existsSync(dir)).toBe(true)
    expect(svc.delete(manifest.id)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(h.state.backups).toHaveLength(0)
    expect(svc.openFolder(manifest.id)).toContain(manifest.id)
  })

  // 0.1.17 (WP8): backups are user-copied folders — credentials must not ride along.
  it('create() strips proxy password and remote API keys from the snapshot', async () => {
    h.state.settings = {
      locale: 'zh-CN',
      proxy: { host: '127.0.0.1', port: 7890, password: 'hunter2' }
    } as typeof h.state.settings
    h.state.remotes = [
      { id: 'r1', name: 'R', baseUrl: 'http://127.0.0.1:8188', apiKey: 'sk-live-secret' }
    ]
    const svc = await freshBackup()
    const manifest = svc.create({ name: 'secrets' })
    const dir = join(h.state.root, 'backups', manifest.id)

    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'))
    expect(settings.proxy).toEqual({ host: '127.0.0.1', port: 7890, password: '' })
    const remotes = JSON.parse(readFileSync(join(dir, 'remote-instances.json'), 'utf-8'))
    expect(remotes[0].apiKey).toBe('')
    expect(manifest.notes).toContain('credentials excluded')
  })

  it('restore() preserves this machine’s credentials when the backup has none', async () => {
    h.state.settings = {
      locale: 'zh-CN',
      proxy: { host: 'old', port: 1080, password: 'local-pass' }
    } as typeof h.state.settings
    h.state.remotes = [
      { id: 'r1', name: 'R', baseUrl: 'http://127.0.0.1:8188', apiKey: 'local-key' }
    ]
    const svc = await freshBackup()
    const id = 'b-keep-secrets'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ locale: 'en-US', proxy: { host: 'new', port: 1080, password: '' } })
    )
    writeFileSync(
      join(dir, 'remote-instances.json'),
      JSON.stringify([{ id: 'r1', name: 'R', baseUrl: 'http://127.0.0.1:8188', apiKey: '' }])
    )

    expect(svc.restore(id)).toBe(true)
    const saved = h.state.savedSettings as any
    expect(saved.locale).toBe('en-US')
    expect(saved.proxy).toEqual({ host: 'new', port: 1080, password: 'local-pass' })
    const remotes = JSON.parse(
      readFileSync(join(h.state.root, 'remote_instances.jsonc'), 'utf-8')
    ) as Array<Record<string, unknown>>
    // The local key is preserved, but re-encrypted on disk (0.1.17 review fix).
    expect(remotes[0].apiKey).toBe(`enc:${Buffer.from('local-key', 'utf-8').toString('base64')}`)
    expect(remotes[0].apiKeyLocked).toBeUndefined()
  })
})

describe('restore() validates untrusted settings (review fix)', () => {
  beforeEach(() => {
    if (h.state.root) rmSync(h.state.root, { recursive: true, force: true })
    h.state.root = mkdtempSync(join(tmpdir(), 'cp-backup-'))
    h.state.savedSettings = null
    h.state.settings = { locale: 'zh-CN' }
  })

  it('rejects a backup whose mirror endpoint is not http(s)', async () => {
    h.state.settings = { locale: 'zh-CN' } as typeof h.state.settings
    const svc = await freshBackup()
    const id = 'b-bad-endpoint'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ locale: 'en-US', githubEndpoint: 'file:///etc/passwd' })
    )
    expect(() => svc.restore(id)).toThrow(/http\(s\)/)
    // Aborted in phase 1: nothing was applied.
    expect(h.state.savedSettings).toBeNull()
  })

  it('rejects a backup whose endpoint embeds credentials', async () => {
    h.state.settings = { locale: 'zh-CN' } as typeof h.state.settings
    const svc = await freshBackup()
    const id = 'b-cred-endpoint'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ locale: 'en-US', pipIndex: 'https://user:token@example.com/simple' })
    )
    expect(() => svc.restore(id)).toThrow(/credentials/)
  })
})
