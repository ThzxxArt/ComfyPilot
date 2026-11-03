/**
 * 0.2.3: IPC domain handlers under a mocked service layer.
 *
 * These factories used to contribute 2% coverage: only their imports ran.
 * Calling each channel exercises validation, target gates, delegation and
 * result shaping without starting Electron or touching a real ComfyUI.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'

const h = vi.hoisted(() => ({
  root: '',
  settings: null as unknown,
  instance: null as unknown,
  calls: [] as string[]
}))

const services = vi.hoisted(() => {
  const instance = {
    id: 'i1',
    name: 'Test',
    path: '',
    pythonPath: '',
    venvPath: '',
    port: 8188,
    listen: '127.0.0.1',
    extraArgs: [],
    argTemplateId: 'default',
    enabled: true,
    notes: '',
    autoStart: false,
    frontendVersion: '',
    pinned: false,
    status: 'stopped',
    url: 'http://127.0.0.1:8188',
    version: '0.3.0',
    migrationState: 'none'
  }
  return {
    instance,
    instanceService: {
      list: () => [instance],
      discover: () => [],
      save: () => instance,
      launch: async () => instance,
      previewLaunch: () => ({ command: 'python main.py' }),
      stop: async () => ({ ...instance, exited: true }),
      restart: async () => instance,
      forceKill: async () => ({ ...instance, exited: true }),
      sweepStaleProcesses: async () => ({ entries: 0, killed: [], unverified: [] }),
      startAll: async () => [],
      stopAll: async () => [],
      getLogs: () => [],
      clearLogs: () => true,
      checkPort: async () => ({ port: 8188, available: true }),
      suggestPort: async () => 8189,
      probeEnv: async () => ({ ok: true }),
      exportDiagnostics: async () => ({ path: '/tmp/diag' }),
      copyDiagnostics: async () => '/tmp/diag',
      exportLogs: async () => ({ path: '/tmp/log' }),
      invalidateVersionCache: () => undefined,
      getCapabilities: async () => null,
      runStartupSelfCheck: async () => ({ ok: true, exitCode: 0, output: '' }),
      analyzeStartupIssues: () => ({ instanceId: 'i1', hasIssues: false, issues: [] })
    },
    modelService: {
      list: () => [],
      scan: async () => [],
      remove: async () => true,
      move: async () => ({}),
      symlink: async () => ({}),
      rename: async () => ({}),
      tag: async () => ({}),
      findDuplicates: () => [],
      listDownloads: () => [],
      download: async () => ({}),
      pauseDownload: () => true,
      prioritizeDownload: () => true,
      resumeDownload: () => true,
      cancelDownload: () => true,
      clearFinishedDownloads: () => 0,
      storageStats: () => [],
      reconcile: async () => ({ ok: true, folders: [], uncoveredRoots: [] }),
      fetchCivitaiMeta: async () => null
    },
    monitorService: {
      systemSnapshot: async () => ({}),
      seriesSnapshot: () => [],
      queueSnapshot: async () => ({ running: [], pending: [], doneCount: 0, history: [] }),
      history: async () => ({ running: [], pending: [], doneCount: 0, history: [] }),
      jobsSnapshot: async () => [],
      connectWs: () => true,
      disconnectWs: () => undefined,
      clearQueue: async () => ({ ok: true }),
      interrupt: async () => ({ ok: true }),
      freeMemory: async () => ({ ok: true })
    },
    batchService: {
      list: () => [],
      create: () => ({ id: 'b1' }),
      startAsync: async () => ({ id: 'b1' }),
      resumeAsync: async () => ({ id: 'b1' }),
      retryFailedAsync: async () => ({ id: 'b1' }),
      wait: async () => null,
      cancel: () => true,
      cancelItem: () => true,
      remove: () => true
    },
    installerService: {
      detectGpu: async () => [],
      preflight: async () => ({ ok: true, checks: [] }),
      start: async () => ({ runId: 'r1' }),
      getStatus: () => null,
      cancel: () => true,
      reset: () => undefined,
      suggestInstallRoot: async () => ({ path: '/tmp/i', freeGb: 1 }),
      installStarter: async () => ({})
    },
    envService: {
      probe: async () => ({ ok: true }),
      createVenv: async () => ({ ok: true }),
      listPythons: async () => [],
      installTorch: async () => true,
      repairEnv: async () => ({ ok: true }),
      getRepairProgress: () => null,
      cancelRepair: () => true
    },
    nodePackService: {
      list: async () => [],
      refresh: async () => [],
      managerChannelList: async () => [],
      install: async () => ({ id: 'n1', name: 'N' }),
      uninstall: async () => true,
      pipDeps: async () => [],
      cancelOp: () => true,
      cancelUpdateBatch: () => true,
      update: async () => ({ id: 'n1', name: 'N' }),
      toggle: async () => true,
      lock: async () => true,
      checkIssues: async () => [],
      loadReport: async () => ({ available: false, entries: [] }),
      getOpProgress: () => null,
      scanRecovery: () => [],
      restoreRecovery: () => true,
      cleanRecovery: () => true,
      cleanAllRecovery: () => ({ removed: 0, failed: [] }),
      depsAudit: async () => ({ ok: true, missing: [], unverifiable: [] }),
      installDeps: async () => ({ ok: true, requested: [], installed: [] }),
      conflicts: async () => [],
      smokeTest: async () => ({ ok: true }),
      snapshots: () => [],
      createSnapshot: () => ({ id: 's1', name: 'S' }),
      deleteSnapshot: () => true,
      restoreSnapshot: () => true,
      checkUpdates: async () => [],
      updateAll: async () => []
    },
    marketService: {
      list: async () => ({ items: [], total: 0, totalPages: 1, page: 1 }),
      install: async () => ({ id: 'n1' })
    },
    outputService: {
      scanAsync: async () => ({ scanned: 0, cancelled: false }),
      cancelScan: () => undefined,
      list: () => ({ items: [], total: 0, truncated: false }),
      ensureOutputThumb: async () => null,
      favorite: () => true,
      remove: () => true,
      batchRemove: () => ({ ok: 0, failed: [] }),
      importToWorkflow: async () => null,
      exportZip: async () => ({ path: '/tmp/out.zip' })
    },
    workflowService: {
      list: () => [],
      importFile: () => ({ id: 'w1' }),
      importMany: async () => ({ ok: [], errors: [] }),
      tag: () => ({ id: 'w1' }),
      favorite: () => ({ id: 'w1' }),
      rename: () => ({ id: 'w1' }),
      remove: () => true,
      exportZip: async () => ({ path: '/tmp/w.zip' }),
      copyToInstance: () => ({ path: '/tmp/w.json' }),
      prepareFrontend: async () => ({
        instanceId: 'i1',
        instanceName: 'Test',
        url: 'http://127.0.0.1:8188',
        copiedPath: '/tmp/w.json'
      }),
      reveal: () => true,
      libraryInfo: () => ({ root: '/tmp', instanceName: 'Test', count: 0, missing: 0 }),
      queue: async () => 'p1',
      parsePngMeta: async () => null,
      compare: () => ({ diffs: [] }),
      importDefaultFromInstance: async () => ({ id: 'w1' })
    },
    backupService: {
      list: () => [],
      create: () => ({ id: 'b1', name: 'B' }),
      preview: () => ({ id: 'b1', canRestore: true }),
      restore: () => ({ ok: true, restored: 0, failed: 0, warnings: [] }),
      delete: () => true,
      openFolder: () => '/tmp/backup'
    },
    doctorService: {
      run: async () => ({ summary: { pass: 0, warn: 0, fail: 0 }, checks: [] }),
      fix: async () => ({ ok: true })
    },
    issueHubService: {
      list: () => [],
      scan: async () => [],
      dismiss: () => null,
      restore: () => null,
      resolve: () => null,
      installModule: async () => ({ ok: true, message: 'ok' }),
      cleanLeftover: () => ({ ok: true, message: 'ok' })
    },
    pipOpsService: {
      installSpec: async () => ({ ok: true, requested: [], installed: [] }),
      installRecipe: async () => ({ ok: true, requested: [], installed: [] }),
      cancel: () => true,
      getProgress: () => null
    },
    execDiagnosticsService: { list: () => [], clear: () => true },
    comfyUpdaterService: {
      readJournal: () => null,
      rollbackFromJournal: async () => true,
      check: async () => ({ current: '0.3.0', updatable: false }),
      start: async () => ({ status: 'running' }),
      waitUntilSettled: async () => ({ status: 'done' }),
      getStatus: () => null,
      cancel: () => true
    },
    remoteService: {
      list: () => [{ id: 'r1', name: 'R', baseUrl: 'http://127.0.0.1:8188', enabled: true }],
      save: (c: unknown) => c,
      remove: () => true,
      test: async () => ({ online: true }),
      listStatus: async () => [],
      freeMemory: async () => true
    },
    bootstrapService: {
      status: () => ({ components: [] }),
      ensure: async () => ({ components: [] }),
      download: async () => ({})
    }
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {},
  shell: {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn()
  },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [h.root] })) }
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => h.settings,
  loadInstanceConfigs: () => [h.instance],
  userDataDir: () => h.root,
  logsDir: () => join(h.root, 'logs'),
  workflowLibraryDir: () => join(h.root, 'workflows'),
  cacheDir: () => join(h.root, 'cache'),
  listRemotes: () => [],
  clearRemoteApiKey: vi.fn(),
  setRemoteApiKey: vi.fn(),
  listRemoteSummaries: () => [],
  isProxyPasswordUnreadable: () => false,
  getDataMigrationState: () => ({ ok: true, migratedFiles: 0 }),
  retryDataMigration: () => ({ ok: true, migratedFiles: 0 }),
  saveSettings: () => h.settings,
  setProxyPassword: vi.fn(),
  clearProxyPassword: vi.fn()
}))

vi.mock('../../src/main/services/secretStorage', () => ({
  secretStorageBackend: () => 'plaintext'
}))
vi.mock('../../src/main/services/proxy', () => ({
  syncProxyFromSettings: vi.fn(() => ({ enabled: false, url: '', bypass: '' })),
  testProxy: vi.fn(async () => ({ ok: true, via: 'direct', ms: 1 }))
}))
vi.mock('../../src/main/services/slowOps', () => ({
  withPausedSlowOp: (f: () => unknown) => f()
}))
vi.mock('../../src/main/services/bootTiming', () => ({ bootMarkFirstList: vi.fn() }))
vi.mock('../../src/main/services/ops', () => ({
  operationRegistry: {
    begin: () => ({ id: 'op', update: vi.fn(), finish: vi.fn() })
  }
}))
vi.mock('../../src/main/services/instance', () => ({ instanceService: services.instanceService }))
vi.mock('../../src/main/services/model', () => ({ modelService: services.modelService }))
vi.mock('../../src/main/services/monitor', () => ({ monitorService: services.monitorService }))
vi.mock('../../src/main/services/p1p2', () => ({
  batchService: services.batchService,
  outputService: services.outputService,
  marketService: services.marketService,
  remoteService: services.remoteService
}))
vi.mock('../../src/main/services/installer', () => ({
  installerService: services.installerService,
  listStarterModels: () => []
}))
vi.mock('../../src/main/services/env', () => ({ envService: services.envService }))
vi.mock('../../src/main/services/nodePack', () => ({ nodePackService: services.nodePackService }))
vi.mock('../../src/main/services/workflow', () => ({ workflowService: services.workflowService }))
vi.mock('../../src/main/services/backup', () => ({ backupService: services.backupService }))
vi.mock('../../src/main/services/doctor', () => ({ doctorService: services.doctorService }))
vi.mock('../../src/main/services/issueHub', () => ({ issueHubService: services.issueHubService }))
vi.mock('../../src/main/services/pipOps', () => ({ pipOpsService: services.pipOpsService }))
vi.mock('../../src/main/services/execDiagnostics', () => ({
  execDiagnosticsService: services.execDiagnosticsService
}))
vi.mock('../../src/main/services/updater', () => ({
  comfyUpdaterService: services.comfyUpdaterService
}))
vi.mock('../../src/main/services/bootstrap', () => ({
  bootstrapService: services.bootstrapService,
  deleteLegacyPythonRuntimes: async () => ({ removed: [], failed: [] })
}))
vi.mock('../../src/main/services/media', () => ({
  thumbnailDisplayUrl: () => null,
  toMediaUrl: () => null,
  resolveMediaUrlToPath: () => null,
  thumbnailService: { ensureOutputThumb: async () => null, ensureAll: async () => 0 },
  renameService: { batchRename: () => [] }
}))

beforeAll(() => {
  h.root = mkdtempSync(join(homedir(), 'cp-ipc-domains-'))
  mkdirSync(join(h.root, 'workflows'), { recursive: true })
  mkdirSync(join(h.root, 'cache'), { recursive: true })
  mkdirSync(join(h.root, 'comfy', 'models'), { recursive: true })
  mkdirSync(join(h.root, 'comfy', 'output'), { recursive: true })
  writeFileSync(join(h.root, 'file.txt'), 'x')
  writeFileSync(join(h.root, 'file.json'), '{}')
  services.instance.path = join(h.root, 'comfy')
  h.instance = services.instance
  h.settings = {
    ...DEFAULT_SETTINGS,
    proxy: { ...DEFAULT_SETTINGS.proxy, password: '' },
    modelScanRoots: [join(h.root, 'comfy', 'models')]
  }
})

afterAll(() => {
  rmSync(h.root, { recursive: true, force: true })
})

const ctx = {
  getWindow: () => null,
  broadcast: vi.fn(),
  broadcastNotification: vi.fn()
}
const event = {}

async function call<T>(handler: (event: unknown, ...a: never[]) => Promise<T>, ...args: unknown[]) {
  return handler(event, ...(args as never[]))
}

describe('IPC domains', () => {
  it('instances: list/save/launch/stop and validation', async () => {
    const { createInstanceHandlers } = await import('../../src/main/ipc/domains/instances')
    const x = createInstanceHandlers(ctx)
    expect((await call(x.list)).ok).toBe(true)
    expect((await call(x.previewLaunch, 'i1')).ok).toBe(true)
    expect((await call(x.stop, 'i1')).ok).toBe(true)
    const bad = await call(x.save, { path: '/etc/passwd' } as never)
    expect(bad.ok).toBe(false)
    expect((await call(x.launchArgCatalog)).ok).toBe(true)
  })

  it('models: list/scan gate/reconcile/storage', async () => {
    const { createModelHandlers } = await import('../../src/main/ipc/domains/models')
    const x = createModelHandlers()
    expect((await call(x.list)).ok).toBe(true)
    expect((await call(x.scan, { roots: [join(h.root, 'comfy', 'models')] } as never)).ok).toBe(
      true
    )
    const blocked = await call(x.scan, { roots: ['/etc'] } as never)
    expect(blocked.ok).toBe(false)
    expect((await call(x.reconcile, 'i1')).ok).toBe(true)
    expect((await call(x.storageStats)).ok).toBe(true)
  })

  it('nodes: list/install gate/update/audit', async () => {
    const { createNodeHandlers } = await import('../../src/main/ipc/domains/nodes')
    const x = createNodeHandlers()
    expect((await call(x.list, 'i1')).ok).toBe(true)
    const remote = await call(x.install, { id: 'n', source: 'registry', instanceId: 'remote:r' })
    expect(remote.ok).toBe(false)
    expect((await call(x.update, 'n', undefined, 'i1')).ok).toBe(true)
    expect((await call(x.depsAudit, 'i1')).ok).toBe(true)
  })

  it('output: list/scan/delete/export/assets', async () => {
    const { createOutputHandlers } = await import('../../src/main/ipc/domains/output')
    const x = createOutputHandlers()
    const outRoot = join(h.root, 'comfy', 'output')
    expect((await call(x.list, { root: outRoot })).ok).toBe(true)
    expect((await call(x.scan, { root: outRoot })).ok).toBe(true)
    expect((await call(x.favorite, 'a1', true)).ok).toBe(true)
    expect((await call(x.remove, 'a1', true)).ok).toBe(true)
    expect((await call(x.batchDelete, ['a1'], false)).ok).toBe(true)
    expect((await call(x.exportZip, [join(h.root, 'file.txt')])).ok).toBe(true)
    expect((await call(x.assetsMatch, 'i1', 'a.png')).ok).toBe(true)
  })

  it('workflows: list/import gate/tag/queue/preflight', async () => {
    const { createWorkflowHandlers } = await import('../../src/main/ipc/domains/workflows')
    const x = createWorkflowHandlers(ctx)
    expect((await call(x.list)).ok).toBe(true)
    const blocked = await call(x.import, '/etc/passwd')
    expect(blocked.ok).toBe(false)
    expect((await call(x.import, join(h.root, 'file.json'), 'i1')).ok).toBe(true)
    expect((await call(x.tag, 'w1', ['a'])).ok).toBe(true)
    expect((await call(x.favorite, 'w1', true)).ok).toBe(true)
    expect((await call(x.rename, 'w1', 'new')).ok).toBe(true)
    expect((await call(x.remove, 'w1')).ok).toBe(true)
    expect((await call(x.exportZip, 'w1')).ok).toBe(true)
    expect((await call(x.copyToInstance, 'w1', 'i1')).ok).toBe(true)
    expect((await call(x.libraryInfo, 'i1')).ok).toBe(true)
    expect((await call(x.parsePngMeta, '/etc/passwd')).ok).toBe(false)
    expect((await call(x.checkModels, join(h.root, 'file.json'), 'i1')).ok).toBe(true)
  })

  it('settings: get/set/import/export/credentials', async () => {
    const { createSettingsHandlers } = await import('../../src/main/ipc/domains/settings')
    const x = createSettingsHandlers()
    expect((await call(x.get)).ok).toBe(true)
    const bad = await call(x.set, { securityLevel: 'nope' } as never)
    expect(bad.ok).toBe(false)
    expect((await call(x.set, { locale: 'en-US' } as never)).ok).toBe(true)
    expect((await call(x.exportConfig)).ok).toBe(true)
    expect((await call(x.importConfig, { settings: {} })).ok).toBe(true)
    expect((await call(x.credentialStatus)).ok).toBe(true)
    expect((await call(x.launchTemplates)).ok).toBe(true)
    expect((await call(x.dataDir)).ok).toBe(true)
    expect((await call(x.logsDir)).ok).toBe(true)
    expect((await call(x.applyProxy)).ok).toBe(true)
    expect((await call(x.testProxy)).ok).toBe(true)
  })

  it('shell: url/path gates, pickers, clipboard, embed', async () => {
    const { createShellHandlers } = await import('../../src/main/ipc/domains/shell')
    const x = createShellHandlers(ctx)
    expect((await call(x.openExternal, 'https://example.com')).ok).toBe(true)
    expect((await call(x.openExternal, 'javascript:alert(1)')).ok).toBe(false)
    expect((await call(x.openPath, join(h.root, 'file.txt'))).ok).toBe(true)
    expect((await call(x.openPath, '/etc/passwd')).ok).toBe(false)
    expect((await call(x.reveal, join(h.root, 'file.txt'))).ok).toBe(true)
    expect((await call(x.pickDirectory)).ok).toBe(true)
    expect((await call(x.pickFile)).ok).toBe(true)
    expect((await call(x.pickFiles)).ok).toBe(true)
    expect((await call(x.writeClipboard, 'x')).ok).toBe(true)
    expect((await call(x.embedOpen, { url: 'http://127.0.0.1:8188' })).ok).toBe(true)
    expect((await call(x.embedResize, { x: 0, y: 0, width: 1, height: 1 })).ok).toBe(true)
    expect((await call(x.embedClose)).ok).toBe(true)
  })

  it('monitor: trusted URL gate and runtime ops', async () => {
    const { createMonitorHandlers } = await import('../../src/main/ipc/domains/monitor')
    const x = createMonitorHandlers()
    expect((await call(x.system)).ok).toBe(true)
    expect((await call(x.queue, 'http://127.0.0.1:8188')).ok).toBe(true)
    expect((await call(x.queue, 'http://evil.example')).ok).toBe(false)
    expect((await call(x.series)).ok).toBe(true)
    expect((await call(x.history, 'http://127.0.0.1:8188')).ok).toBe(true)
    expect((await call(x.jobs, 'http://127.0.0.1:8188')).ok).toBe(true)
    expect((await call(x.connectWs, 'http://127.0.0.1:8188')).ok).toBe(true)
    expect((await call(x.disconnectWs)).ok).toBe(true)
    expect((await call(x.clearQueue, 'http://127.0.0.1:8188')).ok).toBe(true)
    expect((await call(x.interrupt, 'http://127.0.0.1:8188', 'p1')).ok).toBe(true)
    expect((await call(x.freeMemory, 'http://127.0.0.1:8188')).ok).toBe(true)
  })

  it('batch/backup/doctor/issues/remote delegate through their services', async () => {
    const batch = (await import('../../src/main/ipc/domains/batch')).createBatchHandlers()
    expect((await call(batch.list)).ok).toBe(true)
    expect(
      (
        await call(batch.create, {
          instanceId: 'i1',
          items: [{ workflowPath: join(h.root, 'file.json'), count: 1 }]
        })
      ).ok
    ).toBe(true)
    expect((await call(batch.cancel, 'b1')).ok).toBe(true)
    expect((await call(batch.remove, 'b1')).ok).toBe(true)

    const backup = (await import('../../src/main/ipc/domains/backup')).createBackupHandlers()
    expect((await call(backup.list)).ok).toBe(true)
    expect((await call(backup.create, { name: 'B' })).ok).toBe(true)
    expect((await call(backup.preview, 'b1')).ok).toBe(true)
    expect((await call(backup.restore, 'b1')).ok).toBe(true)
    expect((await call(backup.remove, 'b1')).ok).toBe(true)
    expect((await call(backup.openFolder, 'b1')).ok).toBe(true)

    const doctor = (await import('../../src/main/ipc/domains/doctor')).createDoctorHandlers()
    expect((await call(doctor.run, 'i1')).ok).toBe(true)
    expect((await call(doctor.cancel)).ok).toBe(true)
    expect((await call(doctor.fix, 'i1', 'pip')).ok).toBe(true)

    const issues = (await import('../../src/main/ipc/domains/issues')).createIssueHandlers()
    expect((await call(issues.list, false)).ok).toBe(true)
    expect((await call(issues.scan, 'i1')).ok).toBe(true)
    expect((await call(issues.dismiss, 'x')).ok).toBe(true)
    expect((await call(issues.restore, 'x')).ok).toBe(true)
    expect((await call(issues.resolve, 'x')).ok).toBe(true)
    expect((await call(issues.installModule, 'x')).ok).toBe(true)
    expect((await call(issues.cleanLeftover, 'x')).ok).toBe(true)

    const remote = (await import('../../src/main/ipc/domains/remote')).createRemoteHandlers()
    expect((await call(remote.list)).ok).toBe(true)
    expect((await call(remote.save, { baseUrl: 'http://127.0.0.1:8188' })).ok).toBe(true)
    expect((await call(remote.save, { baseUrl: 'file:///etc' })).ok).toBe(false)
    expect((await call(remote.setApiKey, 'r1', 'key')).ok).toBe(true)
    expect((await call(remote.clearApiKey, 'r1')).ok).toBe(true)
    expect((await call(remote.remove, 'r1')).ok).toBe(true)
    expect((await call(remote.test, 'r1')).ok).toBe(true)
    expect((await call(remote.listStatus)).ok).toBe(true)
    expect((await call(remote.freeMemory, 'r1')).ok).toBe(true)
  })
})
