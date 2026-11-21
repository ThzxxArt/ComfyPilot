/**
 * Main-entry startup variants: dirty sessions, migration failures, orphan
 * sweep notifications, packaged login-item sync, protocol handlers, boot
 * probes and the E2E renderer probe.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const appEvents = new Map<string, Array<(...a: unknown[]) => void>>()
  const windows: any[] = []
  const state = {
    settings: {} as Record<string, unknown>,
    instances: [] as Array<Record<string, unknown>>,
    migrate: { ok: true, migratedFiles: 0 } as Record<string, unknown>,
    prev: { clean: true } as Record<string, unknown>,
    archived: { archived: [] as string[] },
    recovery: { recovered: false } as Record<string, unknown>,
    flush: { failed: [] as string[] },
    sweep: { entries: 0, killed: [] as string[], unverified: [] as string[] },
    modelResume: 0,
    packaged: true,
    lock: true,
    mediaPath: null as string | null,
    executeResult: { mounted: true, bridgeOk: true, ipcOk: true, version: 'en-US' } as any,
    startError: null as Error | null
  }
  const mini = () => {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    const api: any = {
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
      removeListener: () => api
    }
    return api
  }
  const emitApp = (name: string, ...args: unknown[]): void => {
    for (const cb of appEvents.get(name) || []) cb(...args)
  }
  return { appEvents, windows, state, mini, emitApp }
})

const svc = vi.hoisted(() => {
  const mini = () => {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    const api: any = {
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
      removeListener: () => api
    }
    return api
  }
  return {
    mini,
    instanceService: Object.assign(mini(), {
      start: vi.fn(async () => {
        if (h.state.startError) throw h.state.startError
        return {}
      }),
      list: () => [],
      killAllForQuit: vi.fn(async () => undefined),
      killAllNow: vi.fn(),
      sweepStaleProcesses: vi.fn(async () => h.state.sweep),
      invalidateVersionCache: vi.fn(),
      analyzeStartupIssues: () => ({ instanceId: '', hasIssues: false, issues: [], scannedAt: 0 })
    }),
    modelService: Object.assign(mini(), {
      resumeInterruptedOnBoot: vi.fn(() => h.state.modelResume),
      list: () => [],
      scan: async () => []
    }),
    monitorService: Object.assign(mini(), {
      systemSnapshot: vi.fn(async () => ({})),
      disconnectWs: vi.fn()
    }),
    batchService: Object.assign(mini(), { flushBatchWrites: vi.fn() }),
    installerService: mini(),
    envService: mini(),
    nodePackService: mini(),
    comfyUpdaterService: mini(),
    pipOpsService: mini(),
    execDiagnosticsService: Object.assign(mini(), {
      noteLogLine: vi.fn(),
      instanceIdForBaseUrl: () => null,
      recordWs: vi.fn()
    }),
    doctorService: mini(),
    bootstrapService: mini(),
    registryIndex: Object.assign(mini(), { cancelBuild: () => false }),
    operationRegistry: Object.assign(mini(), { init: vi.fn(async () => undefined) }),
    health: Object.assign(mini(), {
      start: vi.fn(),
      stop: vi.fn(),
      refresh: vi.fn()
    })
  }
})

vi.mock('electron', () => {
  class WebContents {
    setWindowOpenHandler = vi.fn((cb: any) => {
      ;(this as any).windowOpen = cb
    })
    send = vi.fn()
    executeJavaScript = vi.fn(async () => {
      if (h.state.executeResult === 'reject') throw new Error('probe failed')
      return h.state.executeResult
    })
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
  const protocol = { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
  const app = {
    on: (event: string, cb: (...a: unknown[]) => void) => {
      const list = h.appEvents.get(event) || []
      list.push(cb)
      h.appEvents.set(event, list)
      return app
    },
    once: (event: string, cb: (...a: unknown[]) => void) => app.on(event, cb),
    whenReady: async () => undefined,
    requestSingleInstanceLock: () => h.state.lock,
    setAppUserModelId: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    get isPackaged() {
      return h.state.packaged
    },
    getPath: () => '/tmp/cp-main-variants',
    getAppPath: () => process.cwd(),
    getVersion: () => '0.2.5'
  }
  return {
    app,
    BrowserWindow,
    protocol,
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
vi.mock('../../src/main/services/instance/health', () => ({
  instanceHealthService: svc.health
}))
vi.mock('../../src/main/services/model', () => ({ modelService: svc.modelService }))
vi.mock('../../src/main/services/monitor', () => ({ monitorService: svc.monitorService }))
vi.mock('../../src/main/services/p1p2', () => ({
  batchService: svc.batchService,
  remoteService: { list: () => [] }
}))
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
  archiveLegacyPythonRuntimes: () => h.state.archived,
  bootstrapService: svc.bootstrapService
}))
vi.mock('../../src/main/services/registryIndex', () => ({ registryIndex: svc.registryIndex }))
vi.mock('../../src/main/services/ops', () => ({ operationRegistry: svc.operationRegistry }))
vi.mock('../../src/main/services/backup', () => ({
  backupService: { recoverInterruptedRestore: () => h.state.recovery }
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
const desktopMock = { setLaunchOnBoot: vi.fn() }
vi.mock('../../src/main/services/desktop', () => desktopMock)
vi.mock('../../src/main/services/session', () => ({
  markSessionStart: () => h.state.prev,
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
  pruneOldOutputThumbs: () => 1,
  pruneDeadOutputThumbRows: () => 2,
  resolveMediaUrlToPath: () => h.state.mediaPath
}))
vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => h.state.settings,
  loadInstanceConfigs: () => h.state.instances,
  logsDir: () => '/tmp/cp-main-variants/logs',
  userDataDir: () => '/tmp/cp-main-variants',
  workflowLibraryDir: () => '/tmp/cp-main-variants/workflows',
  migrateLegacyLogs: vi.fn(),
  migrateData: () => h.state.migrate,
  flushPendingWrites: () => h.state.flush
}))

async function importIndex(): Promise<void> {
  vi.resetModules()
  await import('../../src/main/index')
  await new Promise((r) => setTimeout(r, 20))
}

describe('main entry startup variants', () => {
  beforeEach(() => {
    h.appEvents.clear()
    h.windows.length = 0
    h.state.settings = {
      launchOnBoot: true,
      autoStartInstancesOnLaunch: true,
      locale: 'en-US',
      enableAutoCheckUpdates: false
    }
    h.state.instances = [
      { id: 'i1', name: 'Auto', autoStart: true, enabled: true },
      { id: 'i2', name: 'Disabled', autoStart: true, enabled: false }
    ]
    h.state.migrate = { ok: false, error: 'migration broke' }
    h.state.prev = { clean: false, startedAt: 123, detail: 'dirty detail' }
    h.state.archived = { archived: ['python', 'python-3.12'] }
    h.state.recovery = { recovered: false, error: 'restore recovery failed' }
    h.state.flush = { failed: [] }
    h.state.sweep = { entries: 2, killed: ['pid-a'], unverified: ['pid-b'] }
    h.state.modelResume = 3
    h.state.packaged = true
    h.state.lock = true
    h.state.mediaPath = null
    h.state.startError = null
    delete process.env.COMFYPILOT_BOOT_PROBE
    delete process.env.COMFYPILOT_E2E
    delete process.env.ELECTRON_RENDERER_URL
  })

  it('starts with failure-heavy machine state and covers cleanup variants', async () => {
    h.state.startError = new Error('autostart failed')
    await importIndex()
    expect(h.windows.length).toBeGreaterThan(0)
    expect(desktopMock.setLaunchOnBoot).toHaveBeenCalledWith(true)
    expect(svc.instanceService.sweepStaleProcesses).toHaveBeenCalled()
    expect(svc.modelService.resumeInterruptedOnBoot).toHaveBeenCalled()
    // Auto-start waits for the sweep and records the failure.
    await new Promise((r) => setTimeout(r, 30))
    expect(svc.instanceService.start).toHaveBeenCalled()
    // activate with no windows creates a new one.
    const before = h.windows.length
    h.windows.length = 0
    h.emitApp('activate')
    expect(h.windows.length).toBe(before)
    // Quit flush failure retries three times, warns and exits non-zero.
    h.state.flush = { failed: ['settings.jsonc'] }
    const prevent = vi.fn()
    h.emitApp('before-quit', { preventDefault: prevent })
    expect(prevent).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 900))
    const { app, dialog } = await import('electron')
    expect(dialog.showErrorBox).toHaveBeenCalled()
    expect(app.exit).toHaveBeenCalledWith(1)
  })

  it('invokes both protocol handlers for allowed and forbidden URLs', async () => {
    await importIndex()
    const { protocol, net } = await import('electron')
    const handle = protocol.handle as unknown as ReturnType<typeof vi.fn>
    const appHandler = handle.mock.calls.find((c) => c[0] === 'comfy-pilot')?.[1]
    const mediaHandler = handle.mock.calls.find((c) => c[0] === 'comfy-pilot-media')?.[1]
    expect(appHandler).toBeTruthy()
    expect(mediaHandler).toBeTruthy()

    const forbidden = await appHandler({ url: 'comfy-pilot:../../etc/passwd' })
    expect(forbidden.status).toBe(403)
    await appHandler({ url: 'comfy-pilot:package.json' })
    expect(net.fetch).toHaveBeenCalled()

    h.state.mediaPath = null
    expect((await mediaHandler({ url: 'comfy-pilot-media:missing' })).status).toBe(403)
    h.state.mediaPath = '/tmp/image.png'
    await mediaHandler({ url: 'comfy-pilot-media:ok' })
    expect(net.fetch).toHaveBeenCalled()
  })

  it('uses the probe file map and the data-url probe branch', async () => {
    process.env.COMFYPILOT_BOOT_PROBE = '5'
    await importIndex()
    const win = h.windows[0]
    expect(win.loadFile).toHaveBeenCalled()
    expect(String(win.loadFile.mock.calls[0][0])).toContain('probe-css.html')

    h.windows.length = 0
    process.env.COMFYPILOT_BOOT_PROBE = '1'
    await importIndex()
    expect(h.windows[0].loadURL).toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('runs the E2E renderer probe and quits', async () => {
    process.env.COMFYPILOT_E2E = '1'
    const { app } = await import('electron')
    await importIndex()
    const win = h.windows[0]
    win.webContents.emit('console-message', { level: 'error', message: 'boom' })
    win.webContents.emit('console-message', { level: 'info', message: 'ok' })
    win.webContents.emit('preload-error', {}, '/preload.js', new Error('preload'))
    win.webContents.emit('did-finish-load')
    await new Promise((r) => setTimeout(r, 50))
    expect(win.webContents.executeJavaScript).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 400))
    expect(app.quit).toHaveBeenCalled()
  })

  it('loads the dev renderer URL and honours launchOnBoot in dev', async () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    h.state.packaged = false
    h.state.settings.launchOnBoot = true
    await importIndex()
    expect(h.windows[0].loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(desktopMock.setLaunchOnBoot).toHaveBeenCalledWith(true)
  })

  it('handles a rejecting E2E renderer probe and startup control', async () => {
    process.env.COMFYPILOT_E2E = '1'
    h.state.executeResult = 'reject'
    process.argv.push('--status')
    const { app } = await import('electron')
    try {
      await importIndex()
      const win = h.windows[0]
      win.webContents.emit('did-finish-load')
      await new Promise((r) => setTimeout(r, 50))
      await new Promise((r) => setTimeout(r, 400))
      expect(win.webContents.executeJavaScript).toHaveBeenCalled()
      expect(app.quit).toHaveBeenCalled()
    } finally {
      const idx = process.argv.lastIndexOf('--status')
      if (idx >= 0) process.argv.splice(idx, 1)
    }
  })

  it('quits immediately when another instance owns the lock', async () => {
    h.state.lock = false
    const { app } = await import('electron')
    await importIndex()
    expect(app.quit).toHaveBeenCalled()
  })
})
