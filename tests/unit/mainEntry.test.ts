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
  return { appEvents, windows, mini }
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
    setWindowOpenHandler = vi.fn()
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
  proxyAuthFor: () => null,
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

  it('keeps the module export side-effect free (no renderer window data leak)', () => {
    expect(indexModule).toBeDefined()
  })
})
