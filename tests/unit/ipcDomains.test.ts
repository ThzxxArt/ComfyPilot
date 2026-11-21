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
      patch: () => instance,
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
      exportLaunchScript: (_id: string, opts?: unknown) => ({ path: '/tmp/launch', opts }),
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
      list: () => ({ items: [] as any[], total: 0, truncated: false }),
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

  it('instances: rejects unpicked paths, injected launchProfile and non-LAN listen', async () => {
    const { createInstanceHandlers } = await import('../../src/main/ipc/domains/instances')
    const x = createInstanceHandlers(ctx)
    const arbitrary = join(h.root, 'arbitrary')
    mkdirSync(arbitrary, { recursive: true })
    writeFileSync(join(arbitrary, 'main.py'), 'x')
    mkdirSync(join(arbitrary, 'comfy'), { recursive: true })
    const base = {
      id: 'i1',
      name: 'Test',
      path: services.instance.path,
      pythonPath: '',
      venvPath: '',
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default'
    }
    const unpicked = await call(x.save, { ...base, path: arbitrary } as never)
    expect(unpicked.ok).toBe(false)
    expect(unpicked.error).toMatch(/picker|discovery|known ComfyUI/i)

    const injected = await call(x.save, {
      ...base,
      launchProfile: { outputDirectory: '/etc' }
    } as never)
    expect(injected.ok).toBe(false)
    expect(injected.error).toMatch(/outside the instance/i)

    const publicListen = await call(x.save, { ...base, listen: '8.8.8.8' } as never)
    expect(publicListen.ok).toBe(false)
    expect(publicListen.error).toMatch(/listen/i)

    // A free-text override is just as authoritative as config.listen.
    const injectedListen = await call(x.save, {
      ...base,
      extraArgs: ['--listen', 'metadata.google.internal']
    } as never)
    expect(injectedListen.ok).toBe(false)
    expect(injectedListen.error).toMatch(/listen/i)
    const wildcard = await call(x.save, {
      ...base,
      extraArgs: ['--listen', '0.0.0.0,::']
    } as never)
    expect(wildcard.ok).toBe(true)

    writeFileSync(join(services.instance.path, 'python.exe'), 'MZ')
    const evilPython = await call(x.save, {
      ...base,
      pythonPath: join(services.instance.path, 'python.exe')
    } as never)
    expect(evilPython.ok).toBe(false)
    expect(evilPython.error).toMatch(/picker/i)
  })

  it('instances: covers pip, env, installer and update handler guards', async () => {
    const { createInstanceHandlers } = await import('../../src/main/ipc/domains/instances')
    const x = createInstanceHandlers(ctx)
    services.comfyUpdaterService.waitUntilSettled = (async () => null) as any
    expect((await call(x.updateComfy, 'i1')).ok).toBe(true)
    services.comfyUpdaterService.waitUntilSettled = (async () => ({ status: 'done' })) as any
    services.comfyUpdaterService.rollbackFromJournal = async () => false
    expect((await call(x.rollbackUpdate, 'i1')).ok).toBe(true)
    services.comfyUpdaterService.rollbackFromJournal = async () => true
    expect((await call(x.repairEnv, 'i1', { torchChannel: 'cpu' })).ok).toBe(true)
    expect((await call(x.repairEnv, 'missing')).ok).toBe(true)
    expect((await call(x.pipInstall, 'i1', 'numpy')).ok).toBe(true)
    expect((await call(x.pipInstall, 'remote:r1', 'numpy')).ok).toBe(false)
    expect((await call(x.pipInstall, 'missing', '')).ok).toBe(true)
    expect((await call(x.applyRecipe, 'i1', 'r')).ok).toBe(true)
    expect((await call(x.applyRecipe, 'missing', '')).ok).toBe(true)
    expect(await call(x.pipCancel, 'i1')).toMatchObject({ ok: true, data: true })
    expect(await call(x.pipCancel, 'missing')).toMatchObject({ ok: true, data: true })
    expect(await call(x.pipStatus, 'i1')).toMatchObject({ ok: true })
    expect(await call(x.pipStatus, 'missing')).toMatchObject({ ok: true, data: null })
    expect(await call(x.pipStatus, 'remote:r1')).toMatchObject({ ok: true, data: null })
    expect((await call(x.execFailures, 'missing')).ok).toBe(true)
    expect((await call(x.clearExecFailures, 'missing')).ok).toBe(true)
    expect((await call(x.startupIssues, 'missing')).ok).toBe(true)
    expect((await call(x.startupIssues, undefined as never)).ok).toBe(false)
    expect((await call(x.startupIssues, 'i1')).ok).toBe(true)
    expect((await call(x.probe, { pythonPath: '' } as never)).ok).toBe(true)
    expect((await call(x.probe, { pythonPath: '/etc/python' } as never)).ok).toBe(false)
    expect((await call(x.createVenv, {} as never)).ok).toBe(false)
    expect(
      (await call(x.createVenv, { pythonPath: '/etc/python', basePath: h.root } as never)).ok
    ).toBe(false)
    expect((await call(x.createVenv, { pythonPath: 'python', basePath: '/etc' } as never)).ok).toBe(
      false
    )
    expect(
      (
        await call(x.createVenv, {
          pythonPath: 'python',
          basePath: h.root,
          torchIndex: 'ftp://bad'
        } as never)
      ).ok
    ).toBe(false)
    expect(
      (
        await call(x.createVenv, {
          pythonPath: 'python',
          basePath: h.root,
          torchIndex: 'https://download.pytorch.org/whl/cpu/'
        } as never)
      ).ok
    ).toBe(true)
    expect((await call(x.installTorch, {} as never)).ok).toBe(false)
    expect(
      (await call(x.installTorch, { pythonPath: '/etc/python', index: 'https://x' } as never)).ok
    ).toBe(false)
    expect(
      (await call(x.installTorch, { pythonPath: 'python', index: 'ftp://x' } as never)).ok
    ).toBe(false)
    expect(
      (await call(x.installTorch, { pythonPath: 'python', index: 'https://x' } as never)).ok
    ).toBe(true)
    expect((await call(x.preflight, { installRoot: '/etc' } as never)).ok).toBe(false)
    const suggested = await call(x.suggestInstallRoot)
    expect(suggested.ok).toBe(true)
    expect(
      (await call(x.preflight, { installRoot: '/tmp/i', pythonPath: '/etc/python' } as never)).ok
    ).toBe(false)
    expect((await call(x.preflight, { installRoot: '/tmp/i' } as never)).ok).toBe(true)
    expect((await call(x.start, null as never)).ok).toBe(false)
    expect((await call(x.start, { installRoot: '/etc' } as never)).ok).toBe(false)
    expect(
      (await call(x.start, { installRoot: '/tmp/i', pythonPath: '/etc/python' } as never)).ok
    ).toBe(false)
    expect((await call(x.start, { installRoot: '/tmp/i' } as never)).ok).toBe(true)
    expect(
      (await call(x.exportLaunchScript, 'i1', { dir: join(h.root, 'workflows') } as never)).ok
    ).toBe(true)
    expect((await call(x.exportLaunchScript, 'i1', { dir: '/etc' } as never)).ok).toBe(true)
    expect((await call(x.exportLaunchScript, 'i1', {} as never)).ok).toBe(true)
    expect((await call(x.recommendMirrors)).ok).toBe(true)
    expect((await call(x.bootstrapDeleteLegacy)).ok).toBe(true)
    expect((await call(x.reset)).ok).toBe(true)
    expect((await call(x.starterModels)).ok).toBe(true)
    services.installerService.suggestInstallRoot = async () => ({ path: '/tmp/i', freeGb: 1 })
  })

  it('workflows: rejects unsafe paths/ids and validates export destinations', async () => {
    const { createWorkflowHandlers } = await import('../../src/main/ipc/domains/workflows')
    const x = createWorkflowHandlers(ctx)
    const safe = join(h.root, 'comfy', 'wf.json')
    writeFileSync(safe, '{}')
    expect((await call(x.import, safe, 'i1')).ok).toBe(true)
    expect((await call(x.import, '/etc/passwd', 'i1')).ok).toBe(false)
    expect((await call(x.importMany, [] as never)).ok).toBe(true)
    expect((await call(x.importMany, ['/etc/passwd'] as never)).ok).toBe(false)
    expect((await call(x.importMany, [safe] as never, 'i1')).ok).toBe(true)
    expect((await call(x.exportZip, 'w1', join(h.root, 'missing'))).ok).toBe(false)
    expect((await call(x.exportZip, 'w1', '/etc')).ok).toBe(false)
    expect((await call(x.exportZip, 'w1', join(h.root, 'workflows'))).ok).toBe(true)
    expect((await call(x.exportZip, 'w1')).ok).toBe(true)
    expect((await call(x.copyToInstance, 'w1', '')).ok).toBe(false)
    expect((await call(x.copyToInstance, 'w1', 'i1')).ok).toBe(true)
    expect((await call(x.queue, { workflowPath: '/etc/passwd', instanceId: 'i1' })).ok).toBe(false)
    expect((await call(x.queue, { workflowPath: safe, instanceId: '' })).ok).toBe(false)
    services.remoteService.test = async () => ({ online: false, error: 'down' })
    expect((await call(x.queue, { workflowPath: safe, instanceId: 'remote:r1' })).ok).toBe(false)
    services.remoteService.test = async () => ({ online: true })
    expect((await call(x.queue, { workflowPath: safe, instanceId: 'remote:r1' })).ok).toBe(true)
    expect((await call(x.queue, { workflowPath: safe, instanceId: 'i1' })).ok).toBe(false)
    expect((await call(x.parsePngMeta, '/etc/passwd')).ok).toBe(false)
    expect((await call(x.parsePngMeta, safe)).ok).toBe(true)
    expect((await call(x.compare, 'w1', 'w2')).ok).toBe(true)
    expect((await call(x.preflight, '/etc/passwd', 'i1')).ok).toBe(false)
    expect((await call(x.preflight, safe, '')).ok).toBe(false)
    expect((await call(x.preflight, safe, 'remote:r1')).ok).toBe(true)
    expect((await call(x.preflight, safe, 'i1')).ok).toBe(true)
    expect((await call(x.checkModels, '/etc/passwd', 'i1')).ok).toBe(false)
    expect((await call(x.checkModels, safe, 'i1')).ok).toBe(true)
    expect((await call(x.importDefault, { instanceId: '' })).ok).toBe(false)
    expect((await call(x.importDefault, { instanceId: 'remote:r1' })).ok).toBe(false)
    expect((await call(x.importDefault, { instanceId: 'i1' })).ok).toBe(false)
    expect((await call(x.reveal, 'w1')).ok).toBe(true)
    expect((await call(x.libraryInfo, 'i1')).ok).toBe(true)
    expect((await call(x.tag, 'w1', ['x'])).ok).toBe(true)
    expect((await call(x.favorite, 'w1', true)).ok).toBe(true)
    expect((await call(x.rename, 'w1', 'N')).ok).toBe(true)
    expect((await call(x.remove, 'w1', { deleteSource: true })).ok).toBe(true)
  })

  it('outputs: rejects unsafe roots/paths and maps thumbnails', async () => {
    const { createOutputHandlers } = await import('../../src/main/ipc/domains/output')
    const x = createOutputHandlers()
    const safe = join(h.root, 'comfy', 'output')
    mkdirSync(safe, { recursive: true })
    const safeFile = join(h.root, 'comfy', 'out.json')
    writeFileSync(safeFile, '{}')
    expect((await call(x.scan, { root: '/etc' } as never)).ok).toBe(false)
    expect((await call(x.scan, { root: safe } as never)).ok).toBe(true)
    expect((await call(x.scan, {} as never)).ok).toBe(true)
    const originalScan = services.outputService.scanAsync
    services.outputService.scanAsync = async () => {
      throw new Error('scan failed')
    }
    expect((await call(x.scan, { root: safe } as never)).ok).toBe(false)
    services.outputService.scanAsync = originalScan
    expect((await call(x.scanCancel)).ok).toBe(true)
    expect((await call(x.list, { root: '/etc' } as never)).ok).toBe(false)
    expect((await call(x.list, { root: safe, limit: 999 } as never)).ok).toBe(true)
    expect((await call(x.list, { limit: 0 } as never)).ok).toBe(true)
    expect((await call(x.thumb, '/etc/passwd')).ok).toBe(false)
    expect((await call(x.assetsMatch, 'i1', 'a.png')).ok).toBe(true)
    expect((await call(x.open, '/etc/passwd')).ok).toBe(false)
    expect((await call(x.reveal, '/etc/passwd')).ok).toBe(false)
    expect((await call(x.favorite, 'o1', true)).ok).toBe(true)
    expect((await call(x.remove, 'o1', true)).ok).toBe(true)
    expect((await call(x.batchDelete, [] as never, true)).ok).toBe(false)
    expect((await call(x.batchDelete, ['o1'] as never, true)).ok).toBe(true)
    expect((await call(x.importToWorkflow, '/etc/passwd')).ok).toBe(false)
    expect((await call(x.importToWorkflow, safeFile)).ok).toBe(true)
    expect((await call(x.exportZip, [] as never)).ok).toBe(false)
    expect((await call(x.exportZip, ['/etc/passwd'] as never)).ok).toBe(false)
    expect((await call(x.exportZip, [safeFile] as never, '/etc')).ok).toBe(false)
    expect((await call(x.exportZip, [safeFile] as never, join(h.root, 'missing'))).ok).toBe(false)
    expect((await call(x.exportZip, [safeFile] as never, join(h.root, 'workflows'))).ok).toBe(true)
    expect((await call(x.exportZip, [safeFile] as never)).ok).toBe(true)

    const originalList = services.outputService.list
    services.outputService.list = () => ({
      items: [
        {
          id: 'o1',
          path: join(h.root, 'comfy', 'file.png'),
          fileName: 'file.png',
          type: 'image',
          thumbnail: 'comfy-pilot-media:output/x.png',
          size: 1,
          createdAt: 1
        },
        {
          id: 'o2',
          path: join(h.root, 'comfy', 'file.png'),
          fileName: 'file.png',
          type: 'video',
          thumbnail: '/tmp/missing.png',
          size: 1,
          createdAt: 1
        },
        {
          id: 'o3',
          path: '/tmp/missing',
          fileName: 'x',
          type: 'image',
          thumbnail: '/tmp/missing.png',
          size: 1,
          createdAt: 1
        }
      ],
      total: 3,
      truncated: false
    })
    const listed = await call(x.list, {} as never)
    expect(listed.ok).toBe(true)
    services.outputService.list = originalList
  })

  it('instances: exhaustively validates save/patch/port arguments', async () => {
    const { createInstanceHandlers } = await import('../../src/main/ipc/domains/instances')
    const x = createInstanceHandlers(ctx)
    const base = {
      id: 'i1',
      name: 'Test',
      path: services.instance.path,
      pythonPath: '',
      venvPath: '',
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default'
    }
    const bad = async (patch: Record<string, unknown>) => {
      const r = await call(x.save, { ...base, ...patch } as never)
      expect(r.ok, JSON.stringify(patch)).toBe(false)
      return r
    }
    await call(x.save, null as never)
    await call(x.save, {} as never)
    await call(x.save, { ...base, path: join(h.root, 'missing') } as never)
    await call(x.save, { ...base, path: join(h.root, 'file.txt') } as never)
    expect((await call(x.save, base as never)).ok).toBe(true)
    for (const port of [0, 65536, 1.5, 'abc', -1]) {
      await bad({ port })
    }
    await bad({ listen: '8.8.8.8' })
    for (const value of [
      1,
      'a' + String.fromCharCode(0) + 'b',
      'a' + String.fromCharCode(13) + 'b',
      'a' + String.fromCharCode(10) + 'b'
    ]) {
      await bad({ launchProfile: { outputDirectory: value } })
    }
    await bad({ launchProfile: { outputDirectory: '../outside' } })
    await bad({ launchProfile: { outputDirectory: join(h.root, 'outside') } })
    expect(
      (
        await call(x.save, {
          ...base,
          launchProfile: { outputDirectory: join(services.instance.path, 'out') }
        } as never)
      ).ok
    ).toBe(true)
    await bad({ extraArgs: Array.from({ length: 501 }, () => '--x') })
    await bad({ extraArgs: ['a\0b'] })
    expect((await call(x.save, { ...base, extraArgs: ['--listen', '0.0.0.0'] } as never)).ok).toBe(
      true
    )
    await bad({ extraArgs: ['--listen', '8.8.8.8'] })
    await bad({ extraArgs: ['--listen=8.8.8.8'] })
    await bad({ extraArgs: ['--output-directory=../x'] })
    await bad({ extraArgs: ['--output-directory', join(h.root, 'outside')] })
    expect(
      (await call(x.save, { ...base, extraArgs: ['--output-directory', 'relative-out'] } as never))
        .ok
    ).toBe(true)
    expect((await call(x.save, { ...base, extraArgs: ['--output-directory'] } as never)).ok).toBe(
      true
    )
    expect((await call(x.save, { ...base, extraArgs: ['--foo=bar'] } as never)).ok).toBe(true)
    await bad({ pythonPath: 'a\0b' })
    await bad({ pythonPath: '../python' })
    await bad({ pythonPath: join(h.root, 'outside', 'python') })
    await bad({ venvPath: 'a\0b' })
    await bad({ venvPath: '../venv' })
    await bad({ venvPath: join(h.root, '..', 'outside-venv') })
    expect(
      (await call(x.save, { ...base, venvPath: join(services.instance.path, '.venv') } as never)).ok
    ).toBe(true)

    expect((await call(x.patch, 'missing', { notes: 'x' } as never)).ok).toBe(false)
    expect((await call(x.patch, 'i1', null as never)).ok).toBe(false)
    expect((await call(x.patch, 'i1', [] as never)).ok).toBe(false)
    expect((await call(x.patch, 'i1', { extraArgs: ['--listen', '8.8.8.8'] } as never)).ok).toBe(
      false
    )
    expect((await call(x.setPort, 'missing', 8189)).ok).toBe(false)
    expect((await call(x.setPort, 'i1', 0)).ok).toBe(false)
    expect((await call(x.setPort, 'i1', 8189)).ok).toBe(true)
    expect((await call(x.setUpdateChannel, 'i1', 'bad' as never)).ok).toBe(false)
    expect((await call(x.setUpdateChannel, 'i1', 'nightly')).ok).toBe(true)
    expect((await call(x.migratePython, 'missing')).ok).toBe(false)
    services.instance.status = 'running'
    await call(x.migratePython, 'i1')
    services.instance.status = 'stopped'
    await call(x.migratePython, 'i1')
    expect((await call(x.installManager, 'missing')).ok).toBe(false)
    expect((await call(x.setManagerSecurity, 'missing', 'normal' as never)).ok).toBe(false)
    expect((await call(x.openManagerConfig, 'missing')).ok).toBe(false)
    expect((await call(x.discover, join(h.root, 'bad\0path'))).ok).toBe(true)
  })

  it('instances: secondary lifecycle/update/env handlers are reachable', async () => {
    const { createInstanceHandlers } = await import('../../src/main/ipc/domains/instances')
    const x = createInstanceHandlers(ctx)
    const calls: Array<[keyof typeof x, unknown[]]> = [
      ['updateJournal', ['i1']],
      ['rollbackUpdate', ['i1']],
      ['checkComfyUpdate', ['i1']],
      ['updateStatus', []],
      ['cancelUpdate', []],
      ['repairStatus', []],
      ['repairCancel', []],
      ['capabilities', ['i1']],
      ['runStartupSelfCheck', ['i1']],
      ['execFailures', ['i1']],
      ['clearExecFailures', ['i1']],
      ['probe', [{ pythonPath: '' }]],
      ['listPythons', []],
      ['installTorch', [{ pythonPath: 'python', index: 'https://download.pytorch.org/whl/cu130' }]],
      ['detectGpu', []],
      ['status', []],
      ['cancel', []],
      ['starterModels', []],
      ['bootstrapStatus', []],
      ['bootstrapEnsure', [{ kinds: ['uv'] }]],
      ['bootstrapDownload', ['uv']],
      ['bootstrapDeleteLegacy', []],
      ['setPort', ['i1', 8189]],
      ['patch', ['i1', { notes: 'x' }]]
    ]
    for (const [name, args] of calls) {
      const result = await call(x[name] as never, ...args)
      expect(result, String(name)).toHaveProperty('ok')
    }
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
    const thumbFile = join(outRoot, 'thumb.png')
    writeFileSync(thumbFile, 'png')
    expect((await call(x.thumb, thumbFile)).ok).toBe(true)
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
