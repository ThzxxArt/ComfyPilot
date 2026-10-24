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
    failNextInsert: false
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
    return s
  },
  loadInstanceConfigs: () => h.state.instances,
  listRemotes: () => h.state.remotes,
  listModels: () => h.state.models,
  listWorkflows: () => h.state.workflows,
  listNodePacks: () => h.state.nodes,
  listSnapshots: () => h.state.snaps,
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

    expect(svc.restore(id).ok).toBe(true)
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

  it('rejects an unknown securityLevel instead of weakening the install gate', async () => {
    const svc = await freshBackup()
    const id = 'b-bad-security'
    const dir = join(h.state.root, 'backups', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ securityLevel: 'off', locale: 'en-US' })
    )
    expect(() => svc.restore(id)).toThrow(/securityLevel/)
    expect(h.state.savedSettings).toBeNull()
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
    expect(() => svc.restore('b-bad-model')).toThrow(/model/)
  })
})
