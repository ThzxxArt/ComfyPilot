import { app, BrowserWindow, shell, protocol } from 'electron'
import { join } from 'path'
import { registerIpcHandlers, broadcast } from './ipc/handlers'
import { instanceService } from './services/instance'
import { modelService } from './services/model'
import { monitorService } from './services/monitor'
import { batchService } from './services/p1p2'
import { IPC_EVENTS } from '@shared/types'
import { APP_NAME } from '@shared/constants'
import { getDb } from './services/db'

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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('comfy-pilot', (request, callback) => {
    const url = request.url.replace('comfy-pilot://', '')
    callback({ path: join(app.getAppPath(), decodeURIComponent(url)) })
  })

  getDb()
  registerIpcHandlers(() => mainWindow)
  createWindow()

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
