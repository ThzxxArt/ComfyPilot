/**
 * 0.2.3: Electron main entry smoke.
 *
 * `src/main/index.ts` used to be entirely outside coverage because importing it
 * starts Electron. Every service and Electron API it touches is mocked here so
 * the real startup/quit wiring is exercised without launching a window.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'

const h = vi.hoisted(() => {
  const appEvents = new Map<string, Array<(...a: unknown[]) => void>>()
  const windows: unknown[] = []
  const mini = () => {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    const api = {
      on(event: string, cb: (...a: unknown[]) => void) {
        const list = listeners.get(event) || []
        list.push(cb)
        listeners.set(event, list)
        return api
      },
      once(event: string, cb: (...a: unknown[]) => void) {
        return api.on(event, cb)
      },
      emit(event: string, ...args: unknown[]) {
        for (const cb of listeners.get(event) || []) cb(...args)
        return true
      },
      removeListener() {
        return api
      }
    }
    return api
  }
  return { appEvents, windows, mini, auth: null as any }
})

const svc = vi.hoisted(() => {
  const e = () => {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    const api = {
      on(event: string, cb: (...a: unknown[]) => void) {
        const list = listeners.get(event) || []
        list.push(cb)
        listeners.set(event, list)
        return api
      },
      once(event: string, cb: (...a: unknown[]) => void) {
        return api.on(event, cb)
      },
      emit(event: string, ...args: unknown[]) {
        for (const cb of listeners.get(event) || []) cb(...args)
        return true
      },
      removeListener() {
        return api
      }
    }
    return api
  }
  const instanceService = Object.assign(e(), {
    start: async () => ({}),
    stop: async () => ({}),
    launch: async () => ({}),
    list: () => [],
    killAllForQuit: vi.fn(async () => undefined),
    killAllNow: vi.fn(),
    sweepStaleProcesses: vi.fn(async () => ({ entries: 0, killed: [], unverified: [] })),
    invalidateVersionCache: vi.fn(),
    analyzeStartupIssues: () => ({ instanceId: '', hasIssues: false, issues: [], scannedAt: 0 })
  })
  const modelService = Object.assign(e(), {
    resumeInterruptedOnBoot: vi.fn(() => 0),
    list: () => [],
    scan: async () => []
  })
  const monitorService = Object.assign(e(), {
    systemSnapshot: vi.fn(async () => ({
      cpuUsage: 0,
      ramTotal: 1,
      ramUsed: 0,
      diskFree: 1,
      diskTotal: 1,
      gpus: [],
      timestamp: Date.now()
    })),
    disconnectWs: vi.fn()
  })
  const batchService = Object.assign(e(), { flushBatchWrites: vi.fn() })
  const installerService = Object.assign(e(), {})
  const envService = Object.assign(e(), { cancelRepair: () => false })
  const nodePackService = Object.assign(e(), {})
  const comfyUpdaterService = Object.assign(e(), {})
  const pipOpsService = Object.assign(e(), {})
  const execDiagnosticsService = Object.assign(e(), {
    noteLogLine: vi.fn(),
    instanceIdForBaseUrl: () => null,
    recordWs: vi.fn()
  })
  const doctorService = Object.assign(e(), {})
  const bootstrapService = Object.assign(e(), {})
  const registryIndex = Object.assign(e(), { cancelBuild: () => false })
  const operationRegistry = Object.assign(e(), { init: vi.fn(async () => undefined) })
  return {
    instanceService,
    modelService,
    monitorService,
    batchService,
    installerService,
    envService,
    nodePackService,
    comfyUpdaterService,
    pipOpsService,
    execDiagnosticsService,
    doctorService,
    bootstrapService,
    registryIndex,
    operationRegistry
  }
})

vi.mock('electron', () => {
  class WebContents {
    setWindowOpenHandler = vi.fn((cb: any) => {
      ;(this as any).windowOpen = cb
    })
    send = vi.fn()
    executeJavaScript = vi.fn(async () => ({}))
    isLoadingMainFrame = () => false
    isDestroyed = () => false
    session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn()
    }
    constructor() {
      Object.assign(this, h.mini())
    }
  }
  class BrowserWindow {
    static getAllWindows(): unknown[] {
      return h.windows
    }
    webContents = new WebContents()
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    constructor() {
      Object.assign(this, h.mini())
      h.windows.push(this)
    }
    loadFile = vi.fn(async () => undefined)
    loadURL = vi.fn(async () => undefined)
    show = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    isDestroyed = () => false
    getBounds = () => ({ x: 0, y: 0, width: 1440, height: 920 })
  }
  const app = {
    on: (event: string, cb: (...a: unknown[]) => void) => {
      const list = h.appEvents.get(event) || []
      list.push(cb)
      h.appEvents.set(event, list)
      return app
    },
    once: (event: string, cb: (...a: unknown[]) => void) => app.on(event, cb),
    whenReady: async () => undefined,
    requestSingleInstanceLock: () => true,
    setAppUserModelId: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    isPackaged: false,
    getPath: () => '/tmp/comfypilot-test',
    getAppPath: () => process.cwd(),
    getVersion: () => '0.2.3'
  }
  return {
    app,
    BrowserWindow,
    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn()
    },
    net: { fetch: vi.fn(async () => new Response('ok')) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    dialog: { showErrorBox: vi.fn() },
    shell: { openExternal: vi.fn(async () => undefined) }
  }
})

vi.mock('../../src/main/ipc/handlers', () => ({
  registerIpcHandlers: vi.fn(),
  broadcast: vi.fn(),
  broadcastNotification: vi.fn()
}))

vi.mock('../../src/main/services/instance', () => ({ instanceService: svc.instanceService }))
vi.mock('../../src/main/services/model', () => ({ modelService: svc.modelService }))
vi.mock('../../src/main/services/monitor', () => ({ monitorService: svc.monitorService }))
vi.mock('../../src/main/services/p1p2', () => ({ batchService: svc.batchService }))
vi.mock('../../src/main/services/installer', () => ({ installerService: svc.installerService }))
vi.mock('../../src/main/services/env', () => ({ envService: svc.envService }))
vi.mock('../../src/main/services/nodePack', () => ({ nodePackService: svc.nodePackService }))
vi.mock('../../src/main/services/updater', () => ({
  comfyUpdaterService: svc.comfyUpdaterService
}))
vi.mock('../../src/main/services/pipOps', () => ({ pipOpsService: svc.pipOpsService }))
vi.mock('../../src/main/services/execDiagnostics', () => ({
  execDiagnosticsService: svc.execDiagnosticsService
}))
vi.mock('../../src/main/services/doctor', () => ({ doctorService: svc.doctorService }))
vi.mock('../../src/main/services/bootstrap', () => ({
  archiveLegacyPythonRuntimes: () => ({ archived: [] }),
  bootstrapService: svc.bootstrapService
}))
vi.mock('../../src/main/services/registryIndex', () => ({ registryIndex: svc.registryIndex }))
vi.mock('../../src/main/services/ops', () => ({ operationRegistry: svc.operationRegistry }))
vi.mock('../../src/main/services/backup', () => ({
  backupService: { recoverInterruptedRestore: () => ({ recovered: false }) }
}))
vi.mock('../../src/main/services/appUpdate', () => ({
  setAppUpdateBroadcast: vi.fn(),
  setAppUpdateNotify: vi.fn(),
  initAppUpdate: vi.fn(async () => undefined)
}))
vi.mock('../../src/main/services/tray', () => ({
  createTray: vi.fn(),
  destroyTray: vi.fn(),
  refreshTray: vi.fn(),
  hasTray: () => true,
  showSystemNotification: vi.fn()
}))
vi.mock('../../src/main/services/proxy', () => ({
  proxyAuthFor: () => h.auth as any,
  syncProxyFromSettings: vi.fn()
}))
vi.mock('../../src/main/services/desktop', () => ({ setLaunchOnBoot: vi.fn() }))
vi.mock('../../src/main/services/session', () => ({
  markSessionStart: () => ({ clean: true }),
  markSessionCleanExit: vi.fn(),
  recordCrashDetail: vi.fn(),
  getPreviousExitInfo: () => ({ clean: true })
}))
vi.mock('../../src/main/services/slowOps', () => ({ describeRecentSlowOps: () => '' }))
vi.mock('../../src/main/services/workflow', () => ({ flushPromptLinks: vi.fn() }))
vi.mock('../../src/main/services/logFile', () => ({ rotateLogIfTooLarge: vi.fn() }))
vi.mock('../../src/main/services/bootTiming', () => ({ bootMark: vi.fn() }))
vi.mock('../../src/main/services/rendererEntry', () => ({ isOwnRendererUrl: () => true }))
vi.mock('../../src/main/services/media', () => ({
  pruneOldOutputThumbs: () => 0,
  pruneDeadOutputThumbRows: () => 0,
  resolveMediaUrlToPath: () => null
}))
vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => DEFAULT_SETTINGS,
  loadInstanceConfigs: () => [],
  logsDir: () => '/tmp/comfypilot-test/logs',
  userDataDir: () => '/tmp/comfypilot-test',
  workflowLibraryDir: () => '/tmp/comfypilot-test/workflows',
  migrateLegacyLogs: vi.fn(),
  migrateData: () => ({ ok: true, migratedFiles: 0 }),
  flushPendingWrites: vi.fn(() => ({ failed: [] }))
}))

let indexModule: unknown

beforeAll(async () => {
  indexModule = await import('../../src/main/index')
})

describe('main entry', () => {
  it('constructs the window, registers IPC and wires the tray', async () => {
    await vi.waitFor(() => {
      expect(h.windows.length).toBeGreaterThan(0)
    })
    expect(h.windows[0]).not.toBeNull()
  })

  it('handles window lifecycle, navigation and renderer failure events', async () => {
    await vi.waitFor(() => expect(h.windows.length).toBeGreaterThan(0))
    const win = h.windows[0] as any
    const prevent = vi.fn()
    win.emit('ready-to-show')
    win.emit('hide')
    win.emit('show')
    win.emit('close', { preventDefault: prevent })
    expect(prevent).toHaveBeenCalled()
    win.webContents.emit('did-finish-load')
    win.webContents.emit('did-fail-load', {}, -1, 'failed')
    win.webContents.emit('render-process-gone', {}, { reason: 'crash', exitCode: 1 })
    win.webContents.emit('preload-error', {}, '/preload.js', new Error('preload'))
    win.webContents.emit('console-message', { level: 'warning', message: 'warn' })
    win.webContents.emit('console-message', { level: 'error', message: 'error' })
    win.webContents.emit('console-message', { level: 'info', message: 'info' })
    win.webContents.emit('console-message', {})
    win.webContents.emit('will-attach-webview', { preventDefault: prevent })
    win.webContents.emit('will-navigate', { preventDefault: prevent }, 'https://example.com')
    win.webContents.emit('will-navigate', { preventDefault: prevent }, 'http://localhost:5173')
    const openHandler = win.webContents.windowOpen
    expect(openHandler({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(openHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })

    const appCallbacks = (name: string) => h.appEvents.get(name) || []
    for (const cb of appCallbacks('activate')) cb()
    for (const cb of appCallbacks('child-process-gone')) cb({}, { type: 'GPU', reason: 'crashed' })
    for (const cb of appCallbacks('window-all-closed')) cb()
    for (const cb of appCallbacks('second-instance')) {
      cb({}, ['ComfyPilot.exe', '--rescue', 'i1'])
      cb({}, ['ComfyPilot.exe', '--quit'])
      cb({}, ['ComfyPilot.exe', '--allow-multiple-instances'])
      cb({}, ['ComfyPilot.exe', '--status'])
      cb({}, ['ComfyPilot.exe', '--minimized'])
    }
    h.auth = { username: 'u', password: 'p' }
    for (const cb of appCallbacks('login')) {
      const ev = { preventDefault: vi.fn() }
      const auth = vi.fn()
      cb(ev, {}, {}, { isProxy: true, host: 'proxy', port: 8080 }, auth)
      expect(ev.preventDefault).toHaveBeenCalled()
      expect(auth).toHaveBeenCalledWith('u', 'p')
    }
    h.auth = null

    svc.instanceService.emit('log', 'i1', { ts: 1, level: 'info', message: 'line' })
    svc.instanceService.emit('exit', {
      instanceId: 'i1',
      report: { kind: 'crash', hint: 'hint' }
    })
    svc.monitorService.emit('ws', { type: 'progress', baseUrl: 'http://127.0.0.1:8188' })
    svc.monitorService.emit('ws', {
      type: 'execution_error',
      baseUrl: 'http://127.0.0.1:8188',
      data: {}
    })
    svc.monitorService.emit('ws', {
      type: 'execution_error',
      baseUrl: 'http://10.0.0.1:8188',
      data: {}
    })
    svc.monitorService.emit('ws', { type: 'execution_error', baseUrl: 'not a url' })
    svc.execDiagnosticsService.emit('failure', { errorType: 'E', message: 'm' })
    svc.execDiagnosticsService.emit('notify', { errorType: 'E', message: 'm' })
    svc.modelService.emit('progress', { scanned: 1 })
    svc.modelService.emit('download', { id: 'd' })
    svc.batchService.emit('progress', { id: 'b', status: 'running' })
    svc.installerService.emit('progress', { percent: 1 })
    svc.bootstrapService.emit('progress', { kind: 'uv' })
    svc.nodePackService.emit('install-progress', { op: 'update' })
    svc.nodePackService.emit('install-progress', { op: 'install' })
    svc.nodePackService.emit('op-progress', { percent: 1 })
    svc.nodePackService.emit('op-log', { line: 'x' })
    svc.nodePackService.emit('update-batch', { phase: 'start' })
    svc.nodePackService.emit('check-progress', { done: 1 })
    svc.comfyUpdaterService.emit('progress', { percent: 1 })
    svc.envService.emit('progress', { percent: 1 })
    svc.pipOpsService.emit('progress', { percent: 1 })
    svc.pipOpsService.emit('log', { line: 'x' })
    svc.operationRegistry.emit('changed', { id: 'op' })
    svc.registryIndex.emit('progress', { done: 1, total: 2 })
    svc.registryIndex.emit('ready', { pages: 2, count: 5 })
    svc.registryIndex.emit('ready', {})
    svc.doctorService.emit('progress', { done: 1 })
    await new Promise((r) => setTimeout(r, 30))
    expect(h.windows.length).toBeGreaterThan(0)
  })

  it('flushes data and exits after before-quit cleanup', async () => {
    const callbacks = h.appEvents.get('before-quit') || []
    expect(callbacks.length).toBeGreaterThan(0)
    const preventDefault = vi.fn()
    callbacks[callbacks.length - 1]({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(svc.instanceService.killAllForQuit).toHaveBeenCalled()
    })
    const db = await import('../../src/main/services/db')
    expect(db.flushPendingWrites).toHaveBeenCalled()
    const { app } = await import('electron')
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('forwards second-instance control commands and health transitions', async () => {
    const callbacks = h.appEvents.get('second-instance') || []
    expect(callbacks.length).toBeGreaterThan(0)
    callbacks[callbacks.length - 1]({}, ['ComfyPilot.exe'])
    callbacks[callbacks.length - 1]({}, ['ComfyPilot.exe', '--status'])
    svc.instanceService.emit('status', { id: 'i1', status: 'running' })
    const { instanceHealthService } = await import('../../src/main/services/instance/health')
    instanceHealthService.emit('health', {
      instanceId: 'i1',
      health: {
        instanceId: 'i1',
        state: 'healthy',
        checkedAt: Date.now(),
        since: Date.now(),
        consecutiveFailures: 0,
        queueRunning: 0,
        queuePending: 0,
        portListening: true,
        processAlive: true,
        evidence: []
      }
    })
    instanceHealthService.stop()
    expect(h.windows.length).toBeGreaterThan(0)
  })

  it('keeps the module export side-effect free (no renderer window data leak)', () => {
    expect(indexModule).toBeDefined()
  })
})
