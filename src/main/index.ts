import { app, BrowserWindow, shell, protocol, net, nativeImage, dialog } from 'electron'
import { join, resolve, dirname, relative, isAbsolute } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { registerIpcHandlers, broadcast } from './ipc/handlers'
import { instanceService } from './services/instance'
import { modelService } from './services/model'
import { monitorService } from './services/monitor'
import { batchService } from './services/p1p2'
import { installerService } from './services/installer'
import { syncProxyFromSettings } from './services/proxy'
import { createTray, destroyTray, refreshTray, hasTray } from './services/tray'
import { setLaunchOnBoot } from './services/desktop'
import { loadSettings, loadInstanceConfigs } from './services/db'
import { IPC_EVENTS } from '@shared/types'
import { APP_NAME } from '@shared/constants'
import { isSafeExternalUrl, safeResolveUnder } from './services/security'

// Custom schemes must be privileged BEFORE app ready so <img src="comfy-pilot-media:...">
// and fetch() work inside the renderer.
protocol.registerSchemesAsPrivileged([
  { scheme: 'comfy-pilot', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'comfy-pilot-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let mainWindow: BrowserWindow | null = null
/** Set when the user actually quit — close then destroys instead of hiding. */
let forceQuit = false

function crashLog(msg: string): void {
  try {
    const dir = join(process.env.APPDATA || join(process.env.HOME || '', 'AppData/Roaming'), 'ComfyPilot', 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'boot.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    try {
      const dir = join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'startup-crash.log'), `[${new Date().toISOString()}] ${msg}\n`)
    } catch {
      /* ignore */
    }
  }
}

process.on('uncaughtException', (err) => {
  crashLog('uncaughtException: ' + (err?.stack || err))
  try {
    dialog.showErrorBox('ComfyPilot error', String(err?.stack || err))
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (err) => {
  crashLog('unhandledRejection: ' + String(err))
})

function resolveAppIcon(): string {
  // Prefer .ico on Windows, fallback to PNG elsewhere / in dev
  const candidates =
    process.platform === 'win32'
      ? ['ComfyPilot.ico', 'comfypilot-windows-256.png', 'comfypilot-windows-1024.png']
      : process.platform === 'darwin'
        ? ['ComfyPilot.icns', 'comfypilot-macos-512.png', 'comfypilot-macos-1024.png']
        : ['comfypilot-appstore-512.png', 'comfypilot-appstore-1024.png', 'ComfyPilot.ico']
  const bases = [join(process.resourcesPath || '', 'resources'), join(app.getAppPath(), 'resources'), join(__dirname, '../../resources')]
  for (const base of bases) {
    for (const name of candidates) {
      const p = join(base, name)
      try {
        if (existsSync(p)) return p
      } catch {
        /* ignore */
      }
    }
  }
  return candidates[0]
}

/** Only the renderer entry we load (dev server or our index.html) may navigate. */
function isOwnRendererEntry(url: string): boolean {
  if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) {
    return true
  }
  if (!url.startsWith('file:')) return false
  try {
    const target = resolve(fileURLToPath(url))
    const htmlReal = join(process.resourcesPath || '', 'renderer', 'index.html')
    const htmlAsar = join(__dirname, '../renderer/index.html')
    const entry = resolve(existsSync(htmlReal) ? htmlReal : htmlAsar)
    if (target === entry) return true
    const rendererDir = dirname(entry)
    const rel = relative(rendererDir, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
    return Boolean(safeResolveUnder(rendererDir, rel))
  } catch {
    return false
  }
}

function revealWindow(): void {
  try {
    mainWindow?.show()
    mainWindow?.focus()
  } catch {
    /* ignore */
  }
}

function createWindow(): void {
  crashLog('createWindow enter')
  const iconPath = resolveAppIcon()
  crashLog('icon: ' + iconPath)
  let windowIcon: Electron.NativeImage | undefined
  try {
    if (iconPath && existsSync(iconPath)) {
      windowIcon = nativeImage.createFromPath(iconPath)
      if (windowIcon.isEmpty()) windowIcon = undefined
    }
  } catch {
    windowIcon = undefined
  }
  crashLog('before new BrowserWindow')
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    title: APP_NAME,
    backgroundColor: '#F2F6FC',
    autoHideMenuBar: true,
    icon: process.platform === 'darwin' ? undefined : windowIcon || iconPath,
    webPreferences: {
      // Sandbox preload MUST live outside asar (real filesystem path)
      preload: (() => {
        const candidates = [
          join(process.resourcesPath || '', 'preload', 'index.js'),
          join(__dirname, '../preload/index.js'),
          join(__dirname, '../../preload/index.js')
        ]
        for (const c of candidates) {
          if (existsSync(c)) return c
        }
        return candidates[0]
      })(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    crashLog('ready-to-show')
    mainWindow?.show()
  })

  // Close button hides to tray when minimizeToTray is on (launcher-friendly).
  app.on('before-quit', () => {
    forceQuit = true
  })
  mainWindow.on('close', (e) => {
    if (forceQuit) return
    let minimizeToTray = true
    try {
      minimizeToTray = loadSettings().minimizeToTray !== false
    } catch {
      minimizeToTray = true
    }
    // Only hide when a tray icon can bring the window back — otherwise close for real.
    if (minimizeToTray && hasTray() && mainWindow) {
      e.preventDefault()
      mainWindow.hide()
      void refreshTray()
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    crashLog('did-fail-load ' + code + ' ' + desc)
    revealWindow()
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    crashLog('RENDERER GONE reason=' + details.reason + ' code=' + details.exitCode)
  })
  mainWindow.webContents.on('preload-error', (_e, path, err) => {
    crashLog('PRELOAD ERROR ' + path + ' ' + err)
  })
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) crashLog('renderer console: ' + message)
  })
  crashLog('window constructed')

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isOwnRendererEntry(url)) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    }
  })

  const bootProbe = process.env.COMFYPILOT_BOOT_PROBE
  const probeMap: Record<string, string> = {
    '5': 'probe-css.html',
    '6': 'probe-js.html',
    '7': 'probe-main.html',
    '4': 'index-test.html'
  }
  if (bootProbe && probeMap[bootProbe]) {
    const p = join(process.resourcesPath || '', 'renderer', probeMap[bootProbe])
    const p2 = join(__dirname, '../renderer', probeMap[bootProbe])
    const use = existsSync(p) ? p : p2
    crashLog('probe ' + bootProbe + ' ' + use)
    void mainWindow
      .loadFile(use)
      .then(() => crashLog('probe ' + bootProbe + ' ok'))
      .catch((e) => {
        crashLog('probe fail ' + e)
        revealWindow()
      })
    return
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    crashLog('loadURL ' + process.env.ELECTRON_RENDERER_URL)
    void mainWindow
      .loadURL(process.env.ELECTRON_RENDERER_URL)
      .then(() => crashLog('loadURL ok'))
      .catch((e) => {
        crashLog('loadURL fail ' + e)
        revealWindow()
      })
  } else if (process.env.COMFYPILOT_BOOT_PROBE === '1') {
    crashLog('probe data url')
    void mainWindow
      .loadURL('data:text/html,<html><body><h1>ComfyPilot</h1></body></html>')
      .then(() => crashLog('probe ok'))
      .catch((e) => {
        crashLog('probe fail ' + e)
        revealWindow()
      })
  } else {
    // Prefer unpacked renderer (module scripts + native fs are happier outside asar)
    const htmlReal = join(process.resourcesPath || '', 'renderer', 'index.html')
    const htmlAsar = join(__dirname, '../renderer/index.html')
    const html = existsSync(htmlReal) ? htmlReal : htmlAsar
    crashLog('loadFile ' + html + ' exists=' + existsSync(html))
    void mainWindow
      .loadFile(html)
      .then(() => crashLog('loadFile ok'))
      .catch((e) => {
        crashLog('loadFile fail ' + e)
        revealWindow()
      })
  }
}

crashLog('module body done, registering whenReady')
app.whenReady().then(async () => {
  const e2e = process.env.COMFYPILOT_E2E === '1' || process.argv.includes('--e2e-smoke')
  crashLog('whenReady start')

  // Window first: renderer must boot even if a service module is toxic.
  try {
    createWindow()
    crashLog('createWindow returned')
  } catch (err) {
    crashLog('createWindow fail: ' + (err instanceof Error ? err.stack : String(err)))
  }

  const probe = process.env.COMFYPILOT_BOOT_PROBE
  if (!probe) {
    try {
      protocol.handle('comfy-pilot', (request) => {
        const appRoot = app.getAppPath()
        const raw = request.url.replace(/^comfy-pilot:/, '')
        const safePath = safeResolveUnder(appRoot, raw)
        if (!safePath) {
          return new Response('Forbidden', { status: 403 })
        }
        return net.fetch(pathToFileURL(resolve(safePath)).href)
      })
      // Controlled media for <img> tags: thumbnails + output previews only.
      // Never a general file:// passthrough — roots are explicit allow-lists.
      protocol.handle('comfy-pilot-media', async (request) => {
        const { resolveMediaUrlToPath } = await import('./services/media')
        const abs = resolveMediaUrlToPath(request.url)
        if (!abs) return new Response('Forbidden', { status: 403 })
        return net.fetch(pathToFileURL(abs).href)
      })
      crashLog('protocol ok')
    } catch (err) {
      crashLog('protocol fail ' + err)
    }
    try {
      registerIpcHandlers(() => mainWindow)
      crashLog('ipc ok')
    } catch (err) {
      crashLog('ipc register fail ' + err)
    }
    try {
      syncProxyFromSettings()
    } catch (err) {
      crashLog('proxy fail ' + err)
    }
    crashLog('services ready')
  }

  if (e2e) {
    // Boot the real window then quit cleanly for the smoke suite
    const quitE2e = (): void => app.quit()
    setTimeout(() => {
      try {
        mainWindow?.webContents.once('did-finish-load', () => setTimeout(quitE2e, 300))
      } catch {
        /* ignore */
      }
      setTimeout(quitE2e, 2500)
    }, 150)
  }

  if (app.isPackaged) {
    try {
      const settings = loadSettings()
      // Sync OS login item with the persisted preference
      try {
        setLaunchOnBoot(Boolean(settings.launchOnBoot))
      } catch (e) {
        crashLog('launchOnBoot sync: ' + String(e))
      }
      if (settings.enableAutoCheckUpdates) {
        const updater = await import('electron-updater')
        const autoUpdater = updater.autoUpdater || (updater as { default?: { autoUpdater?: unknown } }).default?.autoUpdater
        if (autoUpdater && typeof (autoUpdater as { checkForUpdatesAndNotify?: unknown }).checkForUpdatesAndNotify === 'function') {
          try {
            const au = autoUpdater as {
              checkForUpdatesAndNotify: () => unknown
              on?: (ev: string, cb: (...a: unknown[]) => void) => void
            }
            au.on?.('error', (e) => crashLog('updater error event: ' + String(e)))
            const maybe = au.checkForUpdatesAndNotify()
            if (maybe && typeof (maybe as Promise<unknown>).catch === 'function') {
              ;(maybe as Promise<unknown>).catch((e) => crashLog('updater check: ' + String(e)))
            }
          } catch (e) {
            crashLog('updater check threw: ' + String(e))
          }
        } else {
          crashLog('updater api missing')
        }
      } else {
        crashLog('updater disabled by settings')
      }
    } catch (err) {
      crashLog('updater skipped: ' + String(err))
    }
  } else {
    // Dev: still honour the login-item preference so the feature is testable
    try {
      const settings = loadSettings()
      if (settings.launchOnBoot) setLaunchOnBoot(true)
    } catch {
      /* ignore */
    }
  }

  // System tray (launcher shell)
  try {
    createTray({ onShowWindow: revealWindow })
    crashLog('tray ok')
  } catch (err) {
    crashLog('tray fail: ' + String(err))
  }

  // Auto-start instances flagged with autoStart (consumes the previously dead field)
  try {
    const settings = loadSettings()
    if (settings.autoStartInstancesOnLaunch !== false) {
      const auto = loadInstanceConfigs().filter((c) => c.autoStart && c.enabled !== false)
      if (auto.length) {
        crashLog(`autoStart: ${auto.length} instance(s)`)
        void (async () => {
          for (const c of auto) {
            try {
              await instanceService.start(c.id)
              crashLog(`autoStart ok: ${c.name}`)
            } catch (e) {
              crashLog(`autoStart fail ${c.name}: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          void refreshTray()
        })()
      }
    }
  } catch (err) {
    crashLog('autoStart skipped: ' + String(err))
  }

  instanceService.on('status', (info) => {
    broadcast(IPC_EVENTS.instanceStatus, info)
    void refreshTray()
  })
  instanceService.on('log', (id, line) => broadcast(IPC_EVENTS.instanceLog, { id, line }))
  modelService.on('progress', (p) => broadcast(IPC_EVENTS.modelScanProgress, p))
  modelService.on('download', (t) => broadcast(IPC_EVENTS.downloadProgress, t))
  monitorService.on('ws', (evt) => broadcast(IPC_EVENTS.monitorWs, evt))
  batchService.on('progress', (job) => broadcast(IPC_EVENTS.batchProgress, job))
  installerService.on('progress', (p) => broadcast(IPC_EVENTS.installProgress, p))
  // Resume interrupted model downloads so Range continues where we left off.
  import('./services/model')
    .then(({ modelService }) => {
      const n = modelService.resumeInterruptedOnBoot?.() ?? 0
      if (n > 0) console.log(`resumed ${n} interrupted download(s) on boot`)
    })
    .catch(() => undefined)
  // Wire previously-declared-but-dead events + bootstrap progress.
  import('./services/bootstrap')
    .then(({ bootstrapService }) => {
      bootstrapService.on('progress', (p) => broadcast(IPC_EVENTS.runtimeProgress, p))
    })
    .catch(() => undefined)
  import('./services/nodePack')
    .then(({ nodePackService }) => {
      nodePackService.on('install-progress', (p: { op?: string }) => {
        // Install/uninstall goes to nodeInstallProgress; updates go to BOTH so
        // the NodesView "updating" banner and Market loading state both react.
        // Previously everything hit nodeUpdateProgress — installs showed as
        // "Updating…" and never cleared (install never emitted done).
        if (p?.op === 'update') {
          broadcast(IPC_EVENTS.nodeUpdateProgress, p)
        } else {
          broadcast(IPC_EVENTS.nodeInstallProgress, p)
        }
      })
    })
    .catch(() => undefined)
  import('./services/updater')
    .then(({ comfyUpdaterService }) => {
      comfyUpdaterService.on('progress', (p) => broadcast(IPC_EVENTS.comfyUpdateProgress, p))
    })
    .catch(() => undefined)
  import('./services/env')
    .then(({ envService }) => {
      envService.on('progress', (p) => broadcast(IPC_EVENTS.repairProgress, p))
    })
    .catch(() => undefined)
  import('./services/doctor')
    .then(({ doctorService }) => {
      // doctorProgress is emitted as 'progress' from DoctorService when running
      if (typeof (doctorService as unknown as { on?: unknown }).on === 'function') {
        ;(doctorService as unknown as { on: (e: string, cb: (p: unknown) => void) => void }).on(
          'progress',
          (p) => broadcast(IPC_EVENTS.doctorProgress, p)
        )
      }
    })
    .catch(() => undefined)
  void import('./services/registryIndex')
    .then(({ registryIndex }) => {
      registryIndex.on('progress', (p) => broadcast(IPC_EVENTS.registryIndexProgress, p))
    })
    .catch(() => undefined)

  const timer = setInterval(() => {
    void monitorService
      .systemSnapshot()
      .then((snap) => broadcast(IPC_EVENTS.monitorTick, snap))
      .catch(() => {})
  }, 2000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else revealWindow()
  })

  app.on('before-quit', () => {
    clearInterval(timer)
    monitorService.disconnectWs()
    try {
      instanceService.killAllNow()
    } catch {
      /* ignore */
    }
    try {
      destroyTray()
    } catch {
      /* ignore */
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
