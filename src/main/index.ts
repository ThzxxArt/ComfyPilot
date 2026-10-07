import { app, BrowserWindow, shell, protocol, net, nativeImage, dialog } from 'electron'
import { join, resolve } from 'path'
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { registerIpcHandlers, broadcast } from './ipc/handlers'
import { instanceService } from './services/instance'
import { modelService } from './services/model'
import { monitorService } from './services/monitor'
import { batchService } from './services/p1p2'
import { installerService } from './services/installer'
import { syncProxyFromSettings } from './services/proxy'
import { IPC_EVENTS } from '@shared/types'
import { APP_NAME } from '@shared/constants'
import { isSafeExternalUrl, safeResolveUnder, isLocalhostUrl } from './services/security'

let mainWindow: BrowserWindow | null = null

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
    dialog.showErrorBox('ComfyPilot 启动错误', String(err?.stack || err))
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
    const allowed =
      isLocalhostUrl(url) ||
      url.startsWith('file:') ||
      Boolean(process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
    if (!allowed) {
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
    void mainWindow.loadFile(use).then(() => crashLog('probe ' + bootProbe + ' ok')).catch((e) => crashLog('probe fail ' + e))
    return
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    crashLog('loadURL ' + process.env.ELECTRON_RENDERER_URL)
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else if (process.env.COMFYPILOT_BOOT_PROBE === '1') {
    crashLog('probe data url')
    void mainWindow
      .loadURL('data:text/html,<html><body><h1>ComfyPilot</h1></body></html>')
      .then(() => crashLog('probe ok'))
      .catch((e) => crashLog('probe fail ' + e))
  } else {
    // Prefer unpacked renderer (module scripts + native fs are happier outside asar)
    const htmlReal = join(process.resourcesPath || '', 'renderer', 'index.html')
    const htmlAsar = join(__dirname, '../renderer/index.html')
    const html = existsSync(htmlReal) ? htmlReal : htmlAsar
    crashLog('loadFile ' + html + ' exists=' + existsSync(html))
    void mainWindow
      .loadFile(html)
      .then(() => crashLog('loadFile ok'))
      .catch((e) => crashLog('loadFile fail ' + e))
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
        return net.fetch('file://' + resolve(safePath).replace(/\\/g, '/'))
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
      const updater = await import('electron-updater')
      const autoUpdater = updater.autoUpdater || (updater as { default?: { autoUpdater?: unknown } }).default?.autoUpdater
      if (autoUpdater && typeof (autoUpdater as { checkForUpdatesAndNotify?: unknown }).checkForUpdatesAndNotify === 'function') {
        ;(autoUpdater as { checkForUpdatesAndNotify: () => void }).checkForUpdatesAndNotify()
      } else {
        crashLog('updater api missing')
      }
    } catch (err) {
      crashLog('updater skipped: ' + String(err))
    }
  }

  instanceService.on('status', (info) => broadcast(IPC_EVENTS.instanceStatus, info))
  instanceService.on('log', (id, line) => broadcast(IPC_EVENTS.instanceLog, { id, line }))
  modelService.on('progress', (p) => broadcast(IPC_EVENTS.modelScanProgress, p))
  modelService.on('download', (t) => broadcast(IPC_EVENTS.downloadProgress, t))
  monitorService.on('ws', (evt) => broadcast(IPC_EVENTS.monitorWs, evt))
  batchService.on('progress', (job) => broadcast(IPC_EVENTS.batchProgress, job))
  installerService.on('progress', (p) => broadcast(IPC_EVENTS.installProgress, p))

  const timer = setInterval(() => {
    void monitorService.systemSnapshot().then((snap) => broadcast(IPC_EVENTS.monitorTick, snap))
  }, 2000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => {
    clearInterval(timer)
    monitorService.disconnectWs()
    instanceService.stopAll()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
