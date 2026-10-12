import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'fs'

// Mock electron before any import of db.ts
const tempDir = mkdtempSync(join(tmpdir(), 'cp-v017-'))
;(globalThis as { __cpTestDir?: string }).__cpTestDir = tempDir

vi.mock('electron', () => ({
  app: {
    getPath: () => (globalThis as { __cpTestDir?: string }).__cpTestDir || 'C:\\tmp\\cp-v017'
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}))

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

// ============ DB module runtime tests ============
describe('DB: JSONC parse/stringify', () => {
  it('parseJsonc handles empty string', async () => {
    const { parseJsonc } = await import('@main/services/db')
    expect(() => parseJsonc('')).toThrow()
  })

  it('parseJsonc handles plain JSON', async () => {
    const { parseJsonc } = await import('@main/services/db')
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 })
  })

  it('parseJsonc handles comments', async () => {
    const { parseJsonc } = await import('@main/services/db')
    const result = parseJsonc('{\n  // comment\n  "a": 1\n}')
    expect(result).toEqual({ a: 1 })
  })

  it('stringifyJsonc produces valid JSON', async () => {
    const { stringifyJsonc } = await import('@main/services/db')
    const out = stringifyJsonc({ a: 1, b: 'test' })
    expect(out).toContain('"a"')
    expect(() => JSON.parse(out.replace(/\/\/.*$/gm, ''))).not.toThrow()
  })
})

describe('DB: default settings', () => {
  it('loadSettings returns defaults when no file exists', async () => {
    const { loadSettings } = await import('@main/services/db')
    const s = loadSettings()
    expect(s.locale).toBe('zh-CN')
    expect(s.proxy).toBeDefined()
    expect(typeof s.securityLevel).toBe('string')
    expect(typeof s.allowPipInstall).toBe('boolean')
    expect(typeof s.modelScanRoots).toBe('object')
    expect(Array.isArray(s.modelScanRoots)).toBe(true)
  })

  it('saveSettings merges partial patch', async () => {
    const { saveSettings } = await import('@main/services/db')
    const next = saveSettings({ locale: 'en-US' })
    expect(next.locale).toBe('en-US')
    // Other fields preserved
    expect(next.proxy).toBeDefined()
    // restore
    saveSettings({ locale: 'zh-CN' })
  })

  it('saveSettings strips unknown keys', async () => {
    const { saveSettings } = await import('@main/services/db')
    const next = saveSettings({ unknownKey: 'evil' } as Record<string, unknown> as never)
    expect((next as Record<string, unknown>).unknownKey).toBeUndefined()
  })
})

describe('DB: instance configs', () => {
  it('loadInstanceConfigs returns array', async () => {
    const { loadInstanceConfigs } = await import('@main/services/db')
    expect(Array.isArray(loadInstanceConfigs())).toBe(true)
  })
})

describe('DB: node packs', () => {
  it('listNodePacks returns array', async () => {
    const { listNodePacks } = await import('@main/services/db')
    expect(Array.isArray(listNodePacks())).toBe(true)
  })
})

describe('DB: workflows', () => {
  it('listWorkflows returns array', async () => {
    const { listWorkflows } = await import('@main/services/db')
    expect(Array.isArray(listWorkflows())).toBe(true)
  })
})

describe('DB: output assets', () => {
  it('listOutputAssetsAll returns array', async () => {
    const { listOutputAssetsAll } = await import('@main/services/db')
    expect(Array.isArray(listOutputAssetsAll())).toBe(true)
  })
})

describe('DB: download tasks', () => {
  it('listDownloadTasks returns array', async () => {
    const { listDownloadTasks } = await import('@main/services/db')
    expect(Array.isArray(listDownloadTasks())).toBe(true)
  })
})

describe('DB: batch jobs', () => {
  it('listBatchJobs returns array', async () => {
    const { listBatchJobs } = await import('@main/services/db')
    expect(Array.isArray(listBatchJobs())).toBe(true)
  })
})

describe('DB: snapshots', () => {
  it('listSnapshots returns array', async () => {
    const { listSnapshots } = await import('@main/services/db')
    expect(Array.isArray(listSnapshots())).toBe(true)
  })
})

describe('DB: backups', () => {
  it('listBackups returns array', async () => {
    const { listBackups } = await import('@main/services/db')
    expect(Array.isArray(listBackups())).toBe(true)
  })
})

describe('DB: remotes', () => {
  it('listRemotes returns array', async () => {
    const { listRemotes } = await import('@main/services/db')
    expect(Array.isArray(listRemotes())).toBe(true)
  })
})

describe('DB: path helpers', () => {
  it('userDataDir returns a string', async () => {
    const { userDataDir } = await import('@main/services/db')
    expect(typeof userDataDir()).toBe('string')
    expect(userDataDir().length).toBeGreaterThan(0)
  })

  it('cacheDir returns a string', async () => {
    const { cacheDir } = await import('@main/services/db')
    expect(typeof cacheDir()).toBe('string')
  })

  it('backupDir returns a string', async () => {
    const { backupDir } = await import('@main/services/db')
    expect(typeof backupDir()).toBe('string')
  })

  it('workflowLibraryDir returns a string', async () => {
    const { workflowLibraryDir } = await import('@main/services/db')
    expect(typeof workflowLibraryDir()).toBe('string')
  })

  it('newId returns a unique string', async () => {
    const { newId } = await import('@main/services/db')
    const a = newId()
    const b = newId()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })
})

// ============ Model service helpers ============
describe('model service: readSafetensorsMeta', () => {
  it('returns null for empty file', async () => {
    const { readSafetensorsMeta } = await import('@main/services/model')
    const p = join(tmpdir(), `empty-${Date.now()}.safetensors`)
    writeFileSync(p, '')
    expect(readSafetensorsMeta(p)).toBeNull()
    rmSync(p, { force: true })
  })

  it('returns null for garbage file', async () => {
    const { readSafetensorsMeta } = await import('@main/services/model')
    const p = join(tmpdir(), `garbage-${Date.now()}.safetensors`)
    writeFileSync(p, 'not a safetensors file at all')
    expect(readSafetensorsMeta(p)).toBeNull()
    rmSync(p, { force: true })
  })
})

// ============ Installer helpers ============
describe('installer: applyGithubMirror', () => {
  it('returns URL unchanged when no mirror set', async () => {
    const { applyGithubMirror } = await import('@main/services/installer')
    const url = 'https://github.com/user/repo'
    const result = applyGithubMirror(url)
    expect(result).toContain('github.com')
    expect(result).toContain('user/repo')
  })

  it('returns empty for empty input', async () => {
    const { applyGithubMirror } = await import('@main/services/installer')
    expect(applyGithubMirror('')).toBe('')
    expect(applyGithubMirror('  ')).toBe('')
  })
})

// ============ Proxy redact ============
describe('proxy: redactProxyUrl', () => {
  it('hides password in URL', async () => {
    const { redactProxyUrl } = await import('@main/services/proxy')
    const result = redactProxyUrl({
      enabled: true,
      protocol: 'http',
      host: 'h',
      port: 1,
      username: 'u',
      password: 'pw',
      bypass: ''
    })
    expect(result).not.toContain('pw')
  })

  it('handles empty settings', async () => {
    const { redactProxyUrl } = await import('@main/services/proxy')
    const result = redactProxyUrl({
      enabled: false,
      protocol: 'http',
      host: '',
      port: 0,
      username: '',
      password: '',
      bypass: ''
    })
    expect(typeof result).toBe('string')
  })
})

// ============ Version comparison ============
describe('version comparison logic (source contract)', () => {
  it('nodePack has isUpdateAvailable or version compare', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'nodePack.ts'),
      'utf-8'
    )
    expect(src).toContain('isUpdateAvailable')
  })
})

// ============ i18n key coverage for new features ============
describe('i18n keys for v0.1.7 features', () => {
  const zhSrc = readFileSync(
    join(__dirname, '..', '..', 'src', 'renderer', 'src', 'i18n', 'locales', 'zh-CN.ts'),
    'utf-8'
  )
  const enSrc = readFileSync(
    join(__dirname, '..', '..', 'src', 'renderer', 'src', 'i18n', 'locales', 'en-US.ts'),
    'utf-8'
  )

  it('has notify.backupRestored', () => {
    expect(zhSrc).toContain('backupRestored')
    expect(enSrc).toContain('backupRestored')
  })

  it('has notify.restartRequired', () => {
    expect(zhSrc).toContain('restartRequired')
    expect(enSrc).toContain('restartRequired')
  })

  it('has notify.postUpdateNodeCheck', () => {
    expect(zhSrc).toContain('postUpdateNodeCheck')
    expect(enSrc).toContain('postUpdateNodeCheck')
  })

  it('has settings.paths and modelScanRoots', () => {
    expect(zhSrc).toContain('modelScanRoots')
    expect(enSrc).toContain('modelScanRoots')
    expect(zhSrc).toContain('addScanRoot')
    expect(enSrc).toContain('addScanRoot')
  })

  it('has settings.download group', () => {
    expect(zhSrc).toContain("download: '下载'")
    expect(enSrc).toContain("download: 'Download'")
  })

  it('has status.remote', () => {
    expect(zhSrc).toContain('remote')
    expect(enSrc).toContain('remote')
  })

  it('has batch.instanceNotRunning and startInstance', () => {
    expect(zhSrc).toContain('instanceNotRunning')
    expect(zhSrc).toContain('startInstance')
    expect(enSrc).toContain('instanceNotRunning')
    expect(enSrc).toContain('startInstance')
  })

  it('has nodes.uninstallDeps keys', () => {
    expect(zhSrc).toContain('uninstallDepsTitle')
    expect(enSrc).toContain('uninstallDepsTitle')
  })

  it('has market tabManager', () => {
    expect(zhSrc).toContain('tabManager')
    expect(enSrc).toContain('tabManager')
    expect(zhSrc).toContain('tabRegistry')
    expect(enSrc).toContain('tabRegistry')
  })

  it('has instance.recreateVenv and reinstallTorch', () => {
    expect(zhSrc).toContain('recreateVenv')
    expect(enSrc).toContain('recreateVenv')
    expect(zhSrc).toContain('reinstallTorch')
    expect(enSrc).toContain('reinstallTorch')
  })

  it('has instance.copyDiagPath', () => {
    expect(zhSrc).toContain('copyDiagPath')
    expect(enSrc).toContain('copyDiagPath')
  })

  it('has install.runtime keys', () => {
    expect(zhSrc).toContain('runtimeStatus')
    expect(enSrc).toContain('runtimeStatus')
  })

  it('has monitor.tabHistory', () => {
    expect(zhSrc).toContain('tabHistory')
    expect(enSrc).toContain('tabHistory')
  })

  it('has nodes.checkIssues', () => {
    expect(zhSrc).toContain('checkIssues')
    expect(enSrc).toContain('checkIssues')
  })

  it('has models.renameOne and symlinkAction', () => {
    expect(zhSrc).toContain('renameOne')
    expect(enSrc).toContain('renameOne')
    expect(zhSrc).toContain('symlinkAction')
    expect(enSrc).toContain('symlinkAction')
  })

  it('has workflows.formatVersion', () => {
    expect(zhSrc).toContain('formatVersion')
    expect(enSrc).toContain('formatVersion')
  })
})

// ============ Type completeness ============
describe('shared types completeness', () => {
  const typesSrc = readFileSync(join(__dirname, '..', '..', 'src', 'shared', 'types.ts'), 'utf-8')

  it('BatchJobItem has submitFailed and execFailed', () => {
    expect(typesSrc).toContain('submitFailed: number')
    expect(typesSrc).toContain('execFailed: number')
  })

  it('BatchJob has submitFailed and execFailed', () => {
    // Both should appear at least twice (Item + Job)
    const count = (typesSrc.match(/submitFailed: number/g) || []).length
    expect(count).toBeGreaterThanOrEqual(2)
  })

  it('NodePackRecord has pipRequirements', () => {
    expect(typesSrc).toContain('pipRequirements')
  })

  it('NodeSnapshot packs have gitRev', () => {
    expect(typesSrc).toContain('gitRev')
  })

  it('BackupManifest has workflowFiles and nodeSnapshots', () => {
    expect(typesSrc).toContain('workflowFiles')
    expect(typesSrc).toContain('nodeSnapshots')
  })

  it('AppNotification has titleKey and messageKey', () => {
    expect(typesSrc).toContain('titleKey')
    expect(typesSrc).toContain('messageKey')
    expect(typesSrc).toContain('params')
  })

  it('node.install accepts branch', () => {
    expect(typesSrc).toContain('branch')
  })

  it('market.install has version', () => {
    // Check market.install args
    const idx = typesSrc.indexOf("'market.install'")
    const chunk = typesSrc.slice(idx, idx + 200)
    expect(chunk).toContain('version')
    expect(chunk).toContain('repository')
  })
})

// ============ View feature presence ============
describe('view feature completeness', () => {
  it('ModelsView has rename/symlink/tag/civitai/extraPaths', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'views', 'models', 'ModelsView.vue'),
      'utf-8'
    )
    expect(src).toContain('model.rename')
    expect(src).toContain('model.symlink')
    expect(src).toContain('model.tag')
    expect(src).toContain('model.fetchCivitaiMeta')
    expect(src).toContain('model.parseExtraPaths')
  })

  it('NodesView has checkIssues and branch', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'views', 'nodes', 'NodesView.vue'),
      'utf-8'
    )
    expect(src).toContain('node.checkIssues')
    expect(src).toContain('branch')
  })

  it('InstallView has runtime status and bootstrap.ensure', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'views', 'install', 'InstallView.vue'),
      'utf-8'
    )
    expect(src).toContain('bootstrap.status')
    expect(src).toContain('bootstrap.ensure')
    expect(src).toContain('userChoseMirror')
    expect(src).toContain('plan.value.useUv !== false')
  })

  it('InstanceDetailView has createVenv/installTorch/copyDiagnostics', () => {
    const src = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'views',
        'instances',
        'InstanceDetailView.vue'
      ),
      'utf-8'
    )
    expect(src).toContain('env.createVenv')
    expect(src).toContain('env.installTorch')
    expect(src).toContain('instance.copyDiagnostics')
  })

  it('MonitorView has history tab', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'views', 'monitor', 'MonitorView.vue'),
      'utf-8'
    )
    expect(src).toContain('monitor.history')
  })

  it('SettingsView has remote.listStatus and modelScanRoots', () => {
    const src = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'views',
        'settings',
        'SettingsView.vue'
      ),
      'utf-8'
    )
    expect(src).toContain('remote.listStatus')
    expect(src).toContain('modelScanRoots')
  })

  it('OutputView has date filter and delete', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'views', 'output', 'OutputView.vue'),
      'utf-8'
    )
    expect(src).toContain('NDatePicker')
    expect(src).toContain('output.delete')
  })

  it('BatchView has per-item progress and cancelItem', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'views', 'workflows', 'BatchView.vue'),
      'utf-8'
    )
    expect(src).toContain('cancelItem')
    expect(src).toContain('useLaunch')
    expect(src).toContain('instanceNotRunning')
  })

  it('WorkflowsView has import error dialog and formatVersion', () => {
    const src = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'views',
        'workflows',
        'WorkflowsView.vue'
      ),
      'utf-8'
    )
    expect(src).toContain('formatVersion')
    expect(src).toContain('modelUsed')
  })
})

// ============ Handler feature presence ============
describe('handler feature completeness', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', 'src', 'main', 'ipc', 'handlers.ts'),
    'utf-8'
  )

  it('node.install broadcasts restartRequired', () => {
    expect(src).toContain('notify.restartRequired')
  })

  it('backup.restore broadcasts backupRestored', () => {
    expect(src).toContain('notify.backupRestored')
  })

  it('output.list validates root with resolveOutputDir', () => {
    expect(src).toContain('resolveOutputDir')
  })

  it('node.cancelOp is registered', () => {
    expect(src).toContain('node.cancelOp')
  })

  it('batch.cancelItem is registered', () => {
    expect(src).toContain('batch.cancelItem')
  })

  it('output.delete is registered', () => {
    expect(src).toContain('output.delete')
  })
})
