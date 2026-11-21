/**
 * BackupService behaviour (0.1.10, hardened 0.1.18):
 * create/restore/delete with real files on a tmpdir and an in-memory db layer.
 * 0.1.18 adds the untrusted-input boundary: a backup can no longer write to an
 * arbitrary path, and preview/apply share one validation plan.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join, basename, dirname } from 'path'
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
    remotes: [] as Array<Record<string, unknown>>,
    failNextReplace: '',
    failReplaceTimes: 0,
    failNextInsert: false,
    onSaveSettings: null as null | (() => void)
  }
  return { state }
})

const sideEffects = vi.hoisted(() => ({
  syncProxy: vi.fn(),
  setLaunchOnBoot: vi.fn(),
  refreshTray: vi.fn()
}))

// Restore fires these via dynamic imports. Mocking them makes the callbacks
// deterministic on CI instead of depending on whether Electron modules load.
vi.mock('../../src/main/services/proxy', () => ({
  syncProxyFromSettings: sideEffects.syncProxy
}))
vi.mock('../../src/main/services/desktop', () => ({
  setLaunchOnBoot: sideEffects.setLaunchOnBoot
}))
vi.mock('../../src/main/services/tray', () => ({
  refreshTray: sideEffects.refreshTray
}))

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
  workflowLibraryDir: () => join(h.state.root, 'workflows'),
  insertBackup: (b: Record<string, unknown>) => {
    if (h.state.failNextInsert) {
      h.state.failNextInsert = false
      throw new Error('ENOSPC: simulated backup write failure')
    }
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
    h.state.onSaveSettings?.()
    return s
  },
  loadInstanceConfigs: () => h.state.instances,
  listRemotes: () => h.state.remotes,
  listModels: () => h.state.models,
  listWorkflows: () => h.state.workflows,
  listNodePacks: () => h.state.nodes,
  listSnapshots: () => h.state.snaps,
  flushPendingWrites: () => ({ failed: [] }),
  replaceList: (name: string, items: unknown[]) => {
    if (h.state.failNextReplace === name) {
      h.state.failNextReplace = ''
      throw new Error('EACCES: simulated write failure')
    }
    if (h.state.failReplaceTimes > 0) {
      h.state.failReplaceTimes -= 1
      throw new Error('EACCES: simulated persistent write failure')
    }
    writeFileSync(join(h.state.root, `${name}.jsonc`), JSON.stringify(items))
  },
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
    h.state.settings = { locale: 'zh-CN' }
    h.state.instances = []
    h.state.models = []
    h.state.workflows = []
    h.state.nodes = []
    h.state.snaps = []
    h.state.remotes = []
    sideEffects.syncProxy.mockClear()
    sideEffects.setLaunchOnBoot.mockClear()
    sideEffects.refreshTray.mockClear()
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
    const wfDest = join(h.state.root, 'w.json')
    h.state.workflows = [{ id: 'wf1', path: wfDest }]

    const svc = await freshBackup()
    const id = 'b-restore'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(join(dir, 'workflow-files', 'wf1'), { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en-US' }))
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([{ id: 'i9', name: 'I9', path: h.state.root }])
    )
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify([{ id: 'wf1', path: wfDest }]))
    writeFileSync(join(dir, 'workflow-files', 'wf1', 'w.json'), '{"restored":true}')

    const result = svc.restore(id)
    expect(result.ok).toBe(true)
    expect(result.restored).toBe(1)
    expect((h.state.savedSettings as any).locale).toBe('en-US')
    expect(JSON.parse(readFileSync(join(h.state.root, 'instances.jsonc'), 'utf-8'))).toEqual([
      { id: 'i9', name: 'I9', path: h.state.root }
    ])
    // 0.1.18: a non-workflow path is remapped into the library (a backup may
    // not write arbitrary files inside userDataDir / the instance root).
    const safeDest = join(h.state.root, 'workflows', 'w.json')
    expect(JSON.parse(readFileSync(safeDest, 'utf-8'))).toEqual({ restored: true })
    const restoredWfs = JSON.parse(
      readFileSync(join(h.state.root, 'workflows.jsonc'), 'utf-8')
    ) as Array<Record<string, unknown>>
    expect(restoredWfs[0].path).toBe(safeDest)
    // Fire-and-forget hooks must run after the restored settings are applied.
    await new Promise((r) => setTimeout(r, 0))
    expect(sideEffects.syncProxy).toHaveBeenCalled()
    expect(sideEffects.setLaunchOnBoot).toHaveBeenCalled()
    expect(sideEffects.refreshTray).toHaveBeenCalled()
  })

  it('restore() rolls back to the captured state when a list write fails', async () => {
    h.state.settings = { locale: 'zh-CN' }
    h.state.instances = [{ id: 'i-old', name: 'Old', path: h.state.root }]
    const svc = await freshBackup()
    const id = 'b-rollback'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en-US' }))
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([{ id: 'i9', name: 'I9', path: h.state.root }])
    )

    // Fail while applying the restored instance list (after settings already
    // changed) — the service must revert both and name the pre-restore snapshot.
    h.state.failNextReplace = 'instances'
    expect(() => svc.restore(id)).toThrow(/rolled back/)
    expect((h.state.savedSettings as any).locale).toBe('zh-CN')
    expect(JSON.parse(readFileSync(join(h.state.root, 'instances.jsonc'), 'utf-8'))).toEqual([
      { id: 'i-old', name: 'Old', path: h.state.root }
    ])
    // The pre-restore snapshot is the documented recovery path and must exist.
    expect(h.state.backups.some((b) => String(b.name).startsWith('pre-restore-'))).toBe(true)
  })

  it('restore() aborts before applying anything when the pre-restore snapshot fails', async () => {
    h.state.settings = { locale: 'zh-CN' }
    const svc = await freshBackup()
    const id = 'b-nosnap'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en-US' }))
    h.state.failNextInsert = true
    expect(() => svc.restore(id)).toThrow(/pre-restore backup/)
    // Fail closed: settings were not touched without a recovery point.
    expect(h.state.savedSettings).toBeNull()
  })

  it('restore() reports both failures when the rollback itself fails', async () => {
    h.state.settings = { locale: 'zh-CN' }
    h.state.instances = [{ id: 'i-old', name: 'Old', path: h.state.root }]
    const svc = await freshBackup()
    const id = 'b-rb-fail'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en-US' }))
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([{ id: 'i9', name: 'I9', path: h.state.root }])
    )
    // The apply write fails, and so does the rollback write right after it.
    h.state.failReplaceTimes = 2
    expect(() => svc.restore(id)).toThrow(/rollback also failed/)
  })

  it('restore() reverts already-written workflow files when a later file fails', async () => {
    const wfRoot = join(h.state.root, 'workflows')
    mkdirSync(wfRoot, { recursive: true })
    const good = join(wfRoot, 'good.json')
    writeFileSync(good, '{"original":true}')
    // A directory at the destination path makes the staged rename fail.
    const bad = join(wfRoot, 'bad.json')
    mkdirSync(bad, { recursive: true })
    h.state.workflows = [
      { id: 'wf-good', path: good },
      { id: 'wf-bad', path: bad }
    ]
    const svc = await freshBackup()
    const id = 'b-file-rb'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(join(dir, 'workflow-files', 'wf-good'), { recursive: true })
    mkdirSync(join(dir, 'workflow-files', 'wf-bad'), { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en-US' }))
    writeFileSync(
      join(dir, 'workflows.json'),
      JSON.stringify([
        { id: 'wf-good', path: good },
        { id: 'wf-bad', path: bad }
      ])
    )
    writeFileSync(join(dir, 'workflow-files', 'wf-good', 'good.json'), '{"restored":true}')
    writeFileSync(join(dir, 'workflow-files', 'wf-bad', 'bad.json'), '{"restored":true}')

    expect(() => svc.restore(id)).toThrow(/workflow file|rolled back/)
    // The file that had already been overwritten is back to its original bytes.
    expect(readFileSync(good, 'utf-8')).toBe('{"original":true}')
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

  it('restore() returns false-ish result for unknown ids; delete() removes dir + record', async () => {
    const svc = await freshBackup()
    expect(() => svc.restore('missing')).toThrow(/not found/i)

    const manifest = svc.create({ name: 'to-delete' })
    const dir = join(h.state.root, 'backups', manifest.id)
    expect(existsSync(dir)).toBe(true)
    expect(svc.delete(manifest.id)).toBe(true)
    expect(existsSync(dir)).toBe(false)
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

    expect(svc.restore(id).ok).toBe(true)
    const saved = h.state.savedSettings as any
    expect(saved.locale).toBe('en-US')
    // 0.2.0: host changed from `old` to `new`, so the local proxy password
    // must NOT be carried over to the new endpoint.
    expect(saved.proxy).toEqual({ host: 'new', port: 1080, password: '' })
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

  it('drops an imported securityLevel instead of weakening the install gate', async () => {
    const svc = await freshBackup()
    const id = 'b-bad-security'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ securityLevel: 'off', locale: 'en-US' })
    )
    expect(svc.restore(id).ok).toBe(true)
    const saved = h.state.savedSettings as Record<string, unknown>
    expect(saved.locale).toBe('en-US')
    // The local security level is never taken from a file.
    expect(saved.securityLevel).toBeUndefined()
  })
})

describe('restore() path containment (0.1.18 P0)', () => {
  beforeEach(() => {
    if (h.state.root) rmSync(h.state.root, { recursive: true, force: true })
    h.state.root = mkdtempSync(join(tmpdir(), 'cp-backup-'))
    h.state.savedSettings = null
    h.state.settings = { locale: 'zh-CN' }
    h.state.workflows = []
    h.state.instances = []
    h.state.models = []
  })

  function seedBackup(
    id: string,
    opts: {
      workflowPath?: string
      instancePath?: string
      modelPath?: string
      withFile?: boolean
    }
  ): string {
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(join(dir, 'workflow-files', 'wf1'), { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en-US' }))
    writeFileSync(
      join(dir, 'workflows.json'),
      JSON.stringify([{ id: 'wf1', name: 'x', path: opts.workflowPath || '/tmp/wf.json' }])
    )
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([{ id: 'i1', name: 'I', path: opts.instancePath || h.state.root }])
    )
    writeFileSync(
      join(dir, 'model-manifest.json'),
      JSON.stringify([
        { id: 'm1', name: 'M', path: opts.modelPath || join(h.state.root, 'm.safetensors') }
      ])
    )
    if (opts.withFile !== false) {
      writeFileSync(join(dir, 'workflow-files', 'wf1', 'wf.json'), '{"ok":true}')
    }
    return dir
  }

  it('preserves the relative subdirectory under an instance workflows root', async () => {
    const instRoot = join(h.state.root, 'ComfyUI')
    const wfPath = join(instRoot, 'user', 'default', 'workflows', 'sub', 'a.json')
    mkdirSync(dirname(wfPath), { recursive: true })
    writeFileSync(wfPath, 'old')
    h.state.workflows = [{ id: 'wf1', path: wfPath }]
    // The instance must already exist on this machine for its workflows root
    // to be a trusted restore target.
    h.state.instances = [{ id: 'i1', name: 'I', path: instRoot }]
    seedBackup('b-rel', { workflowPath: wfPath, instancePath: instRoot })
    const svc = await freshBackup()
    const result = svc.restore('b-rel')
    expect(result.ok).toBe(true)
    // Same file path (subdirectory kept), new content.
    expect(JSON.parse(readFileSync(wfPath, 'utf-8'))).toEqual({ ok: true })
    const wfs = JSON.parse(readFileSync(join(h.state.root, 'workflows.jsonc'), 'utf-8')) as Array<
      Record<string, unknown>
    >
    expect(wfs[0].path).toBe(wfPath)
  })

  it('suffixes a remapped workflow file that would collide in the library', async () => {
    mkdirSync(join(h.state.root, 'workflows'), { recursive: true })
    writeFileSync(join(h.state.root, 'workflows', 'w.json'), 'existing')
    seedBackup('b-collide', { workflowPath: join(tmpdir(), 'elsewhere', 'w.json') })
    const svc = await freshBackup()
    svc.restore('b-collide')
    // The pre-existing file is untouched; the restored copy gets an id suffix.
    expect(readFileSync(join(h.state.root, 'workflows', 'w.json'), 'utf-8')).toBe('existing')
    expect(existsSync(join(h.state.root, 'workflows', 'w-wf1.json'))).toBe(true)
  })

  it('drops allowUnverifiedRuntime and invalid remotes from a restored backup', async () => {
    const dir = join(h.state.root, 'backups', 'b-sec')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ locale: 'en-US', allowUnverifiedRuntime: true })
    )
    writeFileSync(
      join(dir, 'remote-instances.json'),
      JSON.stringify([
        { id: 'r-ok', name: 'ok', baseUrl: 'http://10.0.0.5:8188', apiKey: '' },
        { id: 'r-bad', name: 'bad', baseUrl: 'file:///etc/passwd' }
      ])
    )
    const svc = await freshBackup()
    const result = svc.restore('b-sec')
    expect(result.ok).toBe(true)
    expect(
      (h.state.savedSettings as Record<string, unknown>).allowUnverifiedRuntime
    ).toBeUndefined()
    // Invalid URL is refused; the valid record survives.
    const remotes = JSON.parse(readFileSync(join(h.state.root, 'remote_instances.jsonc'), 'utf-8'))
    expect(remotes.map((r: { id: string }) => r.id)).toEqual(['r-ok'])
  })

  it('never writes an executable from workflow-files into an instance workflow dir', async () => {
    const instRoot = join(h.state.root, 'ComfyUI')
    const wfDir = join(instRoot, 'user', 'default', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    h.state.instances = [{ id: 'i1', name: 'I', path: instRoot }]
    const dir = join(h.state.root, 'backups', 'b-exe')
    mkdirSync(join(dir, 'workflow-files', 'wf1'), { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{}')
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([{ id: 'i1', name: 'I', path: instRoot }])
    )
    writeFileSync(
      join(dir, 'workflows.json'),
      JSON.stringify([
        { id: 'wf1', name: 'evil', path: join(wfDir, 'python_embeded', 'python.exe') }
      ])
    )
    writeFileSync(join(dir, 'workflow-files', 'wf1', 'python.exe'), 'MZ')
    const svc = await freshBackup()
    const result = svc.restore('b-exe')
    expect(result.ok).toBe(true)
    // Not written under the instance; remapped to a workflow-named library file.
    expect(existsSync(join(wfDir, 'python_embeded', 'python.exe'))).toBe(false)
    expect(existsSync(join(h.state.root, 'workflows', 'wf1.json'))).toBe(true)
    const wfs = JSON.parse(readFileSync(join(h.state.root, 'workflows.jsonc'), 'utf-8')) as Array<
      Record<string, unknown>
    >
    expect(String(wfs[0].path)).toMatch(/\.json$/i)
  })

  it('never writes a workflow file to the absolute path stored in the backup', async () => {
    // Outside every trusted root (userDataDir / library / instances / model roots).
    const evilTarget = join(tmpdir(), `cp-evil-${process.pid}-${Date.now()}`, 'evil.json')
    seedBackup('b-evil', { workflowPath: evilTarget })
    const svc = await freshBackup()

    const result = svc.restore('b-evil')
    expect(result.ok).toBe(true)
    expect(existsSync(evilTarget)).toBe(false)
    // Remapped into the app workflow library instead.
    expect(existsSync(join(h.state.root, 'workflows', 'evil.json'))).toBe(true)
    const wfs = JSON.parse(readFileSync(join(h.state.root, 'workflows.jsonc'), 'utf-8')) as Array<
      Record<string, unknown>
    >
    expect(wfs[0].path).toBe(join(h.state.root, 'workflows', 'evil.json'))
  })

  it('aborts the whole restore when an instance path is outside known roots', async () => {
    seedBackup('b-bad-instance', { instancePath: join(tmpdir(), 'not-this-machine') })
    const svc = await freshBackup()
    expect(() => svc.restore('b-bad-instance')).toThrow(/aborted/)
    expect(h.state.savedSettings).toBeNull()
    expect(existsSync(join(h.state.root, 'workflows.jsonc'))).toBe(false)
  })

  it('preview reports invalid paths and refuses with canRestore=false', async () => {
    seedBackup('b-preview-bad', { instancePath: join(tmpdir(), 'not-this-machine') })
    const svc = await freshBackup()
    const preview = svc.preview('b-preview-bad')
    expect(preview.canRestore).toBe(false)
    expect(preview.invalidPaths.join(' ')).toContain('not-this-machine')
    expect(preview.counts.workflows).toBe(1)
    expect(preview.workflowFiles).toHaveLength(1)
  })

  it('preview marks a remapped workflow and reports changed settings', async () => {
    seedBackup('b-preview-ok', { workflowPath: join(tmpdir(), 'elsewhere', 'flow.json') })
    const svc = await freshBackup()
    const preview = svc.preview('b-preview-ok')
    expect(preview.canRestore).toBe(true)
    expect(preview.workflowFiles[0].remapped).toBe(true)
    expect(preview.settingsChanged).toContain('locale')
  })

  it('selective restore applies only the requested sections', async () => {
    seedBackup('b-sections', {})
    const svc = await freshBackup()
    const result = svc.restore('b-sections', { sections: ['settings'] })
    expect(result.ok).toBe(true)
    expect((h.state.savedSettings as any).locale).toBe('en-US')
    expect(existsSync(join(h.state.root, 'instances.jsonc'))).toBe(false)
    expect(existsSync(join(h.state.root, 'workflows', 'wf.json'))).toBe(false)
  })

  it('aborts when the models list references an unknown path', async () => {
    seedBackup('b-bad-model', { modelPath: join(tmpdir(), 'elsewhere', 'm.safetensors') })
    const svc = await freshBackup()
    expect(Array.isArray(svc.list())).toBe(true)
    expect(() => svc.restore('b-bad-model')).toThrow(/model/)
  })

  it('sanitizes injected pythonPath / launchProfile / extraArgs from a backup', async () => {
    const dir = seedBackup('b-inject', { instancePath: h.state.root })
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([
        {
          id: 'ev',
          name: 'evil',
          path: h.state.root,
          pythonPath: join(tmpdir(), 'payload.exe'),
          venvPath: '/etc',
          launchProfile: {
            outputDirectory: '/etc',
            baseDirectory: 'ok',
            unknownKey: 'x'
          },
          extraArgs: ['--output-directory=/etc', '--listen', '0.0.0.0']
        }
      ])
    )
    const svc = await freshBackup()
    const result = svc.restore('b-inject')
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toMatch(
      /pythonPath rejected|outputDirectory rejected|extraArgs/
    )
    const rows = JSON.parse(readFileSync(join(h.state.root, 'instances.jsonc'), 'utf-8')) as Array<
      Record<string, unknown>
    >
    expect(rows[0].pythonPath).toBe('')
    expect(rows[0].venvPath).toBe('')
    expect(rows[0].launchProfile).toEqual({ baseDirectory: 'ok' })
    expect(rows[0].extraArgs).toEqual(['--listen', '0.0.0.0'])
  })

  it('rejects a python-shaped binary outside the instance and keeps a real embedded interpreter', async () => {
    const inst = join(h.state.root, 'ComfyUI')
    mkdirSync(inst, { recursive: true })
    const evilPython = join(tmpdir(), `cp-evil-python-${process.pid}`, 'python', 'python.exe')
    const goodPython = join(inst, 'python_embeded', 'python.exe')
    const dir = seedBackup('b-python-shape', { instancePath: inst })
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([
        {
          id: 'evil',
          name: 'evil',
          path: inst,
          pythonPath: evilPython,
          venvPath: join(tmpdir(), `cp-evil-venv-${process.pid}`)
        },
        {
          id: 'good',
          name: 'good',
          path: inst,
          pythonPath: goodPython,
          venvPath: join(inst, '.venv')
        },
        {
          id: 'system-shape',
          name: 'system-shape',
          path: inst,
          pythonPath: 'C:\\Program Files\\Evil\\payload.exe'
        }
      ])
    )
    const svc = await freshBackup()
    const result = svc.restore('b-python-shape')
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/pythonPath rejected/)
    const rows = JSON.parse(readFileSync(join(h.state.root, 'instances.jsonc'), 'utf-8')) as Array<
      Record<string, unknown>
    >
    const evil = rows.find((r) => r.id === 'evil')!
    const good = rows.find((r) => r.id === 'good')!
    const systemShape = rows.find((r) => r.id === 'system-shape')!
    expect(evil.pythonPath).toBe('')
    expect(evil.venvPath).toBe('')
    expect(systemShape.pythonPath).toBe('')
    expect(good.pythonPath).toBe(goodPython)
    expect(good.venvPath).toBe(join(inst, '.venv'))
  })

  it('drops --listen overrides and stray path values from restored extraArgs', async () => {
    const dir = seedBackup('b-listen', { instancePath: h.state.root })
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([
        {
          id: 'ev',
          name: 'evil',
          path: h.state.root,
          listen: '127.0.0.1',
          extraArgs: [
            '--listen',
            'metadata.google.internal',
            '--listen=8.8.8.8',
            '--output-directory',
            '/etc',
            '--port',
            '8188'
          ]
        }
      ])
    )
    const svc = await freshBackup()
    const result = svc.restore('b-listen')
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/--listen rejected|--output-directory rejected/)
    const rows = JSON.parse(readFileSync(join(h.state.root, 'instances.jsonc'), 'utf-8')) as Array<
      Record<string, unknown>
    >
    // No rejected flag, and no orphaned value left behind as a positional arg.
    expect(rows[0].extraArgs).toEqual(['--port', '8188'])
  })

  it('skips a restored instance whose listen is a hostname, not a bind address', async () => {
    const dir = seedBackup('b-listen-host', { instancePath: h.state.root })
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([
        { id: 'ev', name: 'evil', path: h.state.root, listen: 'metadata.google.internal' }
      ])
    )
    const svc = await freshBackup()
    const result = svc.restore('b-listen-host')
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/invalid listen host/i)
    const rows = JSON.parse(readFileSync(join(h.state.root, 'instances.jsonc'), 'utf-8')) as Array<
      Record<string, unknown>
    >
    expect(rows).toEqual([])
  })

  it('strips proxy.password from a restored settings file', async () => {
    const dir = join(h.state.root, 'backups', 'b-proxy')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        locale: 'en-US',
        proxy: { enabled: true, protocol: 'http', host: 'bad.example', port: 8080, password: 'pwn' }
      })
    )
    const svc = await freshBackup()
    const result = svc.restore('b-proxy')
    expect(result.ok).toBe(true)
    expect((h.state.savedSettings as any).proxy.password).toBe('')
  })

  it('drops node-pack/snapshot paths and unsafe scan roots from a backup', async () => {
    const dir = join(h.state.root, 'backups', 'b-paths')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ modelScanRoots: ['/', h.state.root] })
    )
    writeFileSync(
      join(dir, 'node-packs.json'),
      JSON.stringify([
        { id: 'ok', name: 'ok', path: join(h.state.root, 'ComfyUI', 'custom_nodes', 'ok') },
        { id: 'bad', name: 'bad', path: '/etc/evil' }
      ])
    )
    writeFileSync(
      join(dir, 'node-snapshots.json'),
      JSON.stringify([
        {
          id: 's',
          name: 's',
          packs: [
            { name: 'ok', path: join(h.state.root, 'ComfyUI', 'custom_nodes', 'ok') },
            { name: 'bad', path: '/etc/evil' }
          ]
        }
      ])
    )
    const svc = await freshBackup()
    const result = svc.restore('b-paths')
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/modelScanRoots|outside roots/)
    const saved = h.state.savedSettings as Record<string, unknown>
    expect(saved.modelScanRoots).toEqual([h.state.root])
    const packs = JSON.parse(readFileSync(join(h.state.root, 'node_packs.jsonc'), 'utf-8'))
    expect(packs.map((p: { id: string }) => p.id)).toEqual(['ok'])
  })

  it('recovers an interrupted restore from the journal, and reports a missing pre-restore backup', async () => {
    const dir = join(h.state.root, 'backups', 'pre')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ locale: 'en-US' }))
    writeFileSync(
      join(h.state.root, 'restore-journal.json'),
      JSON.stringify({
        backupId: 'x',
        preRestoreId: 'pre',
        startedAt: Date.now(),
        status: 'in-progress'
      })
    )
    let svc = await freshBackup()
    const recovered = svc.recoverInterruptedRestore()
    expect(recovered.recovered).toBe(true)
    expect((h.state.savedSettings as Record<string, unknown>).locale).toBe('en-US')

    writeFileSync(
      join(h.state.root, 'restore-journal.json'),
      JSON.stringify({
        backupId: 'x',
        preRestoreId: 'missing',
        startedAt: Date.now(),
        status: 'in-progress'
      })
    )
    svc = await freshBackup()
    const missing = svc.recoverInterruptedRestore()
    expect(missing.recovered).toBe(false)
    expect(missing.error).toMatch(/missing/i)
  })

  it('rejects a concurrent restore (mutex)', async () => {
    seedBackup('b-mutex', {})
    const svc = await freshBackup()
    let nestedError: Error | null = null
    h.state.onSaveSettings = () => {
      h.state.onSaveSettings = null
      try {
        svc.restore('b-mutex')
      } catch (e) {
        nestedError = e as Error
      }
    }
    svc.restore('b-mutex')
    expect((nestedError as Error | null)?.message).toMatch(/already in progress/i)
  })
})

// =====================================================================
// Untrusted backup parsing: malformed files, sanitization variants,
// locked remotes and interrupted-restore recovery edges.
// =====================================================================
describe('BackupService untrusted-input edge branches', () => {
  function backupDirFor(id: string): string {
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('reports malformed settings/list files and refuses restore', async () => {
    const dir = backupDirFor('b-parse')
    writeFileSync(join(dir, 'settings.json'), '[1,2,3]')
    writeFileSync(join(dir, 'instances.json'), '{"nope":1}')
    writeFileSync(join(dir, 'node-packs.json'), 'nope')
    writeFileSync(join(dir, 'model-manifest.json'), 'nope')
    writeFileSync(join(dir, 'workflows.json'), 'nope')
    writeFileSync(join(dir, 'remote-instances.json'), 'nope')
    writeFileSync(join(dir, 'node-snapshots.json'), 'nope')
    writeFileSync(join(dir, 'manifest.json'), '{bad')
    const svc = await freshBackup()
    const preview = svc.preview('b-parse')
    expect(preview.canRestore).toBe(false)
    expect(preview.warnings.join('\n')).toContain('settings.json: expected object')
    expect(preview.warnings.join('\n')).toContain('instances.json: expected array')
    expect(() => svc.restore('b-parse')).toThrow(/aborted, nothing applied/)

    const brokenDir = backupDirFor('b-json-broken')
    writeFileSync(join(brokenDir, 'settings.json'), '{not json')
    const broken = svc.preview('b-json-broken')
    expect(broken.warnings.join('\n')).toContain('settings.json:')
    expect(() => svc.preview('missing-backup')).toThrow(/Backup not found/)
  })

  it('strips local security state and rejects unsafe endpoints/scan roots', async () => {
    const dir = backupDirFor('b-settings')
    const existing = join(h.state.root, 'scan-ok')
    mkdirSync(existing, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        locale: 'en-US',
        allowUnverifiedRuntime: true,
        securityLevel: 'weak',
        allowGitUrlInstall: true,
        allowPipInstall: true,
        githubEndpoint: 'ftp://mirror.example/',
        hfEndpoint: 'https://user:pass@mirror.example/',
        civitaiEndpoint: 'not a url',
        pipIndex: 'ftp://pypi.example',
        torchIndexMirror: 'not a url',
        modelScanRoots: ['', '/', 'C:/', join(h.state.root, 'gone'), existing]
      })
    )
    const svc = await freshBackup()
    const preview = svc.preview('b-settings')
    const warnings = preview.warnings.join('\n')
    expect(warnings).toMatch(/allowUnverifiedRuntime is local security state/)
    expect(warnings).toMatch(/securityLevel is local security state/)
    expect(warnings).toMatch(/modelScanRoots entries outside this machine were dropped/)
    expect(preview.canRestore).toBe(false)
  })

  it('sanitizes instance paths, ports, listens, profiles, interpreters and extra args', async () => {
    const dir = backupDirFor('b-instances')
    const root = join(h.state.root, 'inst-root')
    mkdirSync(join(root, 'python'), { recursive: true })
    writeFileSync(join(root, 'python', 'python.exe'), '')
    writeFileSync(join(root, 'safe.json'), '{}')
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([
        { id: 'nopath', name: 'No path' },
        { id: 'outside', name: 'Outside', path: join(tmpdir(), 'other-machine') },
        { id: 'badport', name: 'Bad port', path: root, port: 70000 },
        { id: 'badlisten', name: 'Bad listen', path: root, listen: '8.8.8.8' },
        {
          id: 'profile',
          name: 'Profile',
          path: root,
          listen: '127.0.0.1',
          port: 8188,
          launchProfile: {
            outputDirectory: '/etc',
            baseDirectory: 'ok',
            unknownKey: 'x',
            extraModelPathsConfig: 'bad\0path'
          },
          pythonPath: join(root, 'python', 'python.exe'),
          venvPath: join(root, 'myvenv'),
          updateChannel: 'beta',
          extraArgs: [
            '--listen',
            '8.8.8.8',
            '--listen',
            '127.0.0.1',
            '--output-directory=/etc',
            '--output-directory',
            '/etc',
            '--base-directory=safe',
            'bad\0arg'
          ]
        },
        {
          id: 'system-python',
          path: root,
          pythonPath: '/usr/bin/python3',
          venvPath: '/etc/venv',
          launchProfile: 'not-an-object',
          extraArgs: 'not-an-array'
        },
        { id: 'bare-python', path: root, pythonPath: 'python' }
      ])
    )
    const svc = await freshBackup()
    const preview = svc.preview('b-instances')
    const warnings = preview.warnings.join('\n')
    expect(preview.invalidPaths.join(' ')).toContain('other-machine')
    expect(warnings).toMatch(/no path, skipped/)
    expect(warnings).toMatch(/invalid port/)
    expect(warnings).toMatch(/invalid listen host/)
    expect(warnings).toMatch(/launchProfile.unknownKey/)
    expect(warnings).toMatch(/extraArgs control character dropped/)
    expect(warnings).toMatch(/extraArgs --listen rejected/)
    expect(warnings).toMatch(/extraArgs --output-directory rejected/)
    expect(preview.canRestore).toBe(false)
  })

  it('drops unsafe node packs, snapshots, remotes and models', async () => {
    const dir = backupDirFor('b-lists')
    const root = join(h.state.root, 'trusted')
    mkdirSync(root, { recursive: true })
    h.state.remotes = [{ id: 'locked', baseUrl: 'https://locked.example', apiKeyLocked: true }]
    writeFileSync(
      join(dir, 'node-packs.json'),
      JSON.stringify([
        { id: 'ok-nopath', name: 'ok' },
        { id: 'ok', name: 'ok', path: root },
        { id: 'bad', name: 'bad', path: '/etc/passwd' }
      ])
    )
    writeFileSync(
      join(dir, 'node-snapshots.json'),
      JSON.stringify([
        { id: 's1', name: 'snap', packs: 'not-array' },
        {
          id: 's2',
          name: 'snap2',
          packs: [{ path: root }, { path: '/etc/passwd' }]
        }
      ])
    )
    writeFileSync(
      join(dir, 'remote-instances.json'),
      JSON.stringify([
        { id: '', baseUrl: 'https://x' },
        { id: 'bad-url', baseUrl: 'not a url' },
        { id: 'ftp', baseUrl: 'ftp://x' },
        { id: 'locked', baseUrl: 'https://locked.example' },
        { id: 'ok', baseUrl: 'https://ok.example' }
      ])
    )
    writeFileSync(
      join(dir, 'model-manifest.json'),
      JSON.stringify([{ id: 'empty' }, { id: 'outside', name: 'evil', path: '/etc/passwd' }])
    )
    const svc = await freshBackup()
    const preview = svc.preview('b-lists')
    const warnings = preview.warnings.join('\n')
    expect(warnings).toMatch(/node pack bad: path outside roots/)
    expect(warnings).toMatch(/snapshot snap2: pack path outside roots/)
    expect(warnings).toMatch(/remote \?: invalid base URL/)
    expect(warnings).toMatch(/remote bad-url: invalid base URL/)
    expect(warnings).toMatch(/remote ftp: invalid base URL/)
    expect(warnings).toMatch(/remote locked: API key is locked/)
    expect(preview.invalidPaths.join(' ')).toContain('model evil')
    expect(preview.canRestore).toBe(false)
  })

  it('remaps workflows without ids/duplicate ids/unsafe names and flags missing files', async () => {
    const dir = backupDirFor('b-wf')
    mkdirSync(join(dir, 'workflow-files', 'emptydir'), { recursive: true })
    writeFileSync(
      join(dir, 'workflows.json'),
      JSON.stringify([
        { name: 'no-id', path: '/tmp/a.json' },
        { id: 'dup', path: '/tmp/b.json' },
        { id: 'dup', path: '/tmp/c.json' },
        { id: 'nopath' },
        { id: 'unsafe', path: '/tmp/evil.exe' },
        { id: 'empty', path: '/tmp/empty.json' }
      ])
    )
    const svc = await freshBackup()
    const preview = svc.preview('b-wf')
    expect(preview.workflowFiles).toHaveLength(3)
    expect(preview.workflowFiles.every((f: any) => f.remapped)).toBe(true)
    expect(
      preview.workflowFiles.find((f: any) => f.id === 'unsafe')?.target.endsWith('.json')
    ).toBe(true)
    expect(preview.workflowFiles.find((f: any) => f.id === 'empty')?.missing).toBe(true)
    expect(preview.counts.workflowFiles).toBe(0)
  })

  it('recovers corrupt journals and reports restore failures', async () => {
    const journal = join(h.state.root, 'restore-journal.json')
    writeFileSync(journal, JSON.stringify({ preRestoreId: 123 }))
    let svc = await freshBackup()
    expect(svc.recoverInterruptedRestore()).toEqual({ recovered: false })

    writeFileSync(
      journal,
      JSON.stringify({ backupId: 'x', preRestoreId: 'pre', startedAt: 1, status: 'in-progress' })
    )
    mkdirSync(join(h.state.root, 'backups', 'pre'), { recursive: true })
    writeFileSync(join(h.state.root, 'backups', 'pre', 'instances.json'), 'not-json')
    svc = await freshBackup()
    const failed = svc.recoverInterruptedRestore()
    expect(failed.recovered).toBe(false)
    expect(failed.error).toBeTruthy()

    svc = await freshBackup()
    svc.restore = () => {
      throw 'string failure'
    }
    writeFileSync(
      journal,
      JSON.stringify({ backupId: 'x', preRestoreId: 'pre', startedAt: 1, status: 'in-progress' })
    )
    const thrown = svc.recoverInterruptedRestore()
    expect(thrown).toMatchObject({ recovered: false, error: 'string failure' })
  })

  it('sanitizes backup ids for delete/openFolder and tolerates missing dirs', async () => {
    const svc = await freshBackup()
    expect(svc.delete('..')).toBe(false)
    expect(svc.delete('missing')).toBe(false)
    const folder = svc.openFolder('..')
    expect(folder).toContain('backups')
    expect(folder).not.toContain('..')
  })
})

describe('BackupService create/restore internals', () => {
  it('creates backups with encrypted remotes, default names and workflow filtering', async () => {
    const dir = join(h.state.root, 'wf-src')
    mkdirSync(dir, { recursive: true })
    const jsonWf = join(dir, 'ok.json')
    const txtWf = join(dir, 'note.txt')
    writeFileSync(jsonWf, '{"nodes":[]}')
    writeFileSync(txtWf, 'x')
    h.state.remotes = [
      { id: 'r1', baseUrl: 'https://a.example', apiKey: 'secret' },
      { id: 'r2', baseUrl: 'https://b.example', apiKey: '' }
    ]
    h.state.instances = [{ id: 'i1', name: 'I' }]
    h.state.settings = {
      locale: 'zh-CN',
      modelScanRoots: [dir, '']
    } as any
    h.state.workflows = [
      { id: 'w1', path: jsonWf },
      { id: 'w2', path: txtWf },
      { id: 'w3', path: join(dir, 'missing.json') }
    ]
    const svc = await freshBackup()
    const manifest = svc.create({} as never)
    expect(manifest.name).toMatch(/^backup-/)
    const bdir = join(h.state.root, 'backups', manifest.id)
    const remotes = JSON.parse(readFileSync(join(bdir, 'remote-instances.json'), 'utf-8'))
    expect(remotes[0].apiKey).toBe('')
    expect(remotes[1].apiKey).toBe('')
    const files = JSON.parse(readFileSync(join(bdir, 'workflows.json'), 'utf-8'))
    expect(files).toHaveLength(3)
    expect(existsSync(join(bdir, 'workflow-files', 'w1'))).toBe(true)
    expect(String(manifest.notes || '')).toMatch(/missing|skipped/)
  })

  it('preserves this machine credential origins and re-encrypts remote keys', async () => {
    h.state.remotes = [{ id: 'r1', baseUrl: 'https://same.example', apiKey: 'local-key' }]
    const dir = join(h.state.root, 'backups', 'b-remotes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'remote-instances.json'),
      JSON.stringify([
        { id: 'r1', baseUrl: 'https://same.example/', apiKey: '' },
        { id: 'r2', baseUrl: 'https://new.example', apiKey: 'new-key' }
      ])
    )
    const svc = await freshBackup()
    const result = svc.restore('b-remotes', { sections: ['remotes'] })
    expect(result.ok).toBe(true)
    const saved = JSON.parse(
      readFileSync(join(h.state.root, 'remote_instances.jsonc'), 'utf-8')
    ) as Array<Record<string, unknown>>
    const byId = new Map(saved.map((r) => [r.id, r]))
    expect(String(byId.get('r1')?.apiKey)).toMatch(/^enc:/)
    expect(Buffer.from(String(byId.get('r1')?.apiKey).slice(4), 'base64').toString()).toBe(
      'local-key'
    )
    expect(Buffer.from(String(byId.get('r2')?.apiKey).slice(4), 'base64').toString()).toBe(
      'new-key'
    )
    expect(byId.get('r2')?.credentialOrigin).toBe('https://new.example')
  })

  it('keeps path-less workflow records and reports proxy setting changes', async () => {
    h.state.settings = {
      locale: 'zh-CN',
      proxy: { enabled: false, host: 'old.example', port: 8080 }
    } as any
    const dir = join(h.state.root, 'backups', 'b-wf-nopath')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ locale: 'en-US', proxy: { host: 'new.example' } })
    )
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify([{ id: 'wf0', name: 'No path' }]))
    const svc = await freshBackup()
    const preview = svc.preview('b-wf-nopath')
    expect(preview.settingsChanged).toContain('proxy.host')
    expect(preview.workflowFiles).toEqual([])
    const result = svc.restore('b-wf-nopath', { sections: ['settings', 'workflows'] })
    expect(result.ok).toBe(true)
    const wfs = JSON.parse(readFileSync(join(h.state.root, 'workflows.jsonc'), 'utf-8'))
    expect(wfs[0]).toMatchObject({ id: 'wf0', name: 'No path' })
  })

  it('ignores a corrupt restore journal and missing backup directory', async () => {
    writeFileSync(join(h.state.root, 'restore-journal.json'), '{bad')
    const svc = await freshBackup()
    expect(svc.recoverInterruptedRestore()).toEqual({ recovered: false })
    expect(() => svc.preview('never-created')).toThrow(/Backup not found/)
    expect(svc.delete('never-created')).toBe(false)
  })
})

describe('BackupService missing-field and path remap branches', () => {
  it('sanitizes records with missing names/ids and unsafe workflow targets', async () => {
    const dir = join(h.state.root, 'backups', 'b-fields')
    mkdirSync(join(dir, 'workflow-files', 'wf-one'), { recursive: true })
    mkdirSync(join(dir, 'workflow-files', 'wf-empty'), { recursive: true })
    writeFileSync(join(dir, 'workflow-files', 'wf-one', 'one.json'), '{}')
    writeFileSync(
      join(dir, 'instances.json'),
      JSON.stringify([
        { path: h.state.root },
        { path: h.state.root, port: 'bad' },
        { path: h.state.root, listen: '' },
        { name: 'NoPath' }
      ])
    )
    writeFileSync(join(dir, 'node-packs.json'), JSON.stringify([{ path: '/etc/passwd' }]))
    writeFileSync(
      join(dir, 'node-snapshots.json'),
      JSON.stringify([{ packs: [{ path: '/etc/passwd' }] }])
    )
    writeFileSync(join(dir, 'model-manifest.json'), JSON.stringify([{ path: '/etc/passwd' }]))
    writeFileSync(
      join(dir, 'remote-instances.json'),
      JSON.stringify([{ baseUrl: '' }, { id: 'r', baseUrl: 'ftp://x' }])
    )
    writeFileSync(
      join(dir, 'workflows.json'),
      JSON.stringify([
        { id: 'wf-one', path: '/' },
        { id: 'wf-two', path: '/tmp/payload.exe' },
        { id: 'wf-empty', path: 'C:\\evil.json' }
      ])
    )
    const svc = await freshBackup()
    const preview = svc.preview('b-fields')
    const text = preview.warnings.join('\n')
    expect(text).toMatch(/no path, skipped/)
    expect(text).toMatch(/invalid port/)
    expect(text).toMatch(/invalid listen host/)
    expect(text).toMatch(/node pack \?: path outside roots/)
    expect(text).toMatch(/snapshot \?: pack path outside roots/)
    expect(text).toMatch(/remote \?: invalid base URL/)
    expect(text).toMatch(/remote r: invalid base URL/)
    expect(preview.invalidPaths.join('\n')).toContain('model ?')
    expect(preview.workflowFiles).toHaveLength(3)
    expect(preview.workflowFiles.every((f: any) => String(f.target).endsWith('.json'))).toBe(true)
    expect(preview.workflowFiles.find((f: any) => f.id === 'wf-one')?.missing).toBe(false)
    expect(preview.workflowFiles.find((f: any) => f.id === 'wf-empty')?.missing).toBe(true)
  })

  it('previews an empty backup without a manifest name', async () => {
    mkdirSync(join(h.state.root, 'backups', 'b-empty'), { recursive: true })
    const svc = await freshBackup()
    const preview = svc.preview('b-empty')
    expect(preview.name).toBe('')
    expect(preview.counts).toEqual({ workflowFiles: 0, workflows: 0 })
    expect(preview.canRestore).toBe(true)
  })
})

describe('BackupService create failure branches', () => {
  it('reports a disk failure from create and cleans the partial directory', async () => {
    h.state.failNextInsert = true
    h.state.instances = [{ id: 'i1', name: 'I', path: h.state.root }]
    const svc = await freshBackup()
    let error: unknown
    try {
      svc.create({ name: 'fails' })
    } catch (e) {
      error = e
    }
    expect(String((error as Error)?.message || error)).toBeTruthy()
  })
})
