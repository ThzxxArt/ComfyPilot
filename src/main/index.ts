import { app, BrowserWindow, shell, protocol, net } from 'electron'
import { join, resolve } from 'path'
import { autoUpdater } from 'electron-updater'
import { registerIpcHandlers, broadcast } from './ipc/handlers'
import { instanceService } from './services/instance'
import { modelService } from './services/model'
import { monitorService } from './services/monitor'
import { batchService } from './services/p1p2'
import { IPC_EVENTS } from '@shared/types'
import { APP_NAME } from '@shared/constants'
import { getDb } from './services/db'
import { isSafeExternalUrl, safeResolveUnder } from './services/security'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    title: APP_NAME,
    backgroundColor: '#F2F6FC',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed =
      url.startsWith('http://localhost') ||
      url.startsWith('http://127.0.0.1') ||
      url.startsWith('file:') ||
      Boolean(process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
    if (!allowed) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Custom protocol with strict path containment (no traversal outside app root)
  protocol.handle('comfy-pilot', (request) => {
    const appRoot = app.getAppPath()
    const raw = request.url.replace(/^comfy-pilot:/, '')
    const safePath = safeResolveUnder(appRoot, raw)
    if (!safePath) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch('file://' + resolve(safePath).replace(/\\/g, '/'))
  })

  getDb()
  registerIpcHandlers(() => mainWindow)
  createWindow()

  if (app.isPackaged) {
    try {
      autoUpdater.checkForUpdatesAndNotify()
    } catch {
      /* ignore update errors in dev */
    }
  }

  instanceService.on('status', (info) => broadcast(IPC_EVENTS.instanceStatus, info))
  instanceService.on('log', (id, line) => broadcast(IPC_EVENTS.instanceLog, { id, line }))
  modelService.on('progress', (p) => broadcast(IPC_EVENTS.modelScanProgress, p))
  modelService.on('download', (t) => broadcast(IPC_EVENTS.downloadProgress, t))
  monitorService.on('ws', (evt) => broadcast(IPC_EVENTS.monitorWs, evt))
  batchService.on('progress', (job) => broadcast(IPC_EVENTS.batchProgress, job))

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
