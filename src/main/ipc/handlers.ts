import { ipcMain, dialog, shell, BrowserWindow, WebContentsView, clipboard } from 'electron'
import { existsSync } from 'fs'
import { basename, extname } from 'path'
import type { IpcResult, ComfyInstanceConfig, RemoteInstanceConfig, NodePackRecord, BatchJob, EnvCreateRequest, WorkflowRecord, AppSettings, InstallPlan } from '@shared/types'
import { isSafeExternalUrl, isSafeEmbedUrl, sanitizeId, isSafeOpenPath, isLocalhostUrl } from '../services/security'
import { loadSettings, saveSettings, loadInstanceConfigs, upsertInstanceConfig, deleteInstanceConfig } from '../services/db'
import { LAUNCH_TEMPLATES } from '@shared/constants'
import { instanceService } from '../services/instance'
import { modelService } from '../services/model'
import { nodePackService } from '../services/nodePack'
import { workflowService } from '../services/workflow'
import { monitorService } from '../services/monitor'
import { doctorService } from '../services/doctor'
import { backupService } from '../services/backup'
import { envService } from '../services/env'
import { batchService, outputService, remoteService, marketService } from '../services/p1p2'
import { installerService } from '../services/installer'
import { testProxy, syncProxyFromSettings } from '../services/proxy'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

function wrap<A extends unknown[], R>(
  fn: (...args: A) => Promise<R> | R
): (_event: unknown, ...args: A) => Promise<IpcResult> {
  return async (_event, ...args) => {
    try {
      const data = await fn(...args)
      return ok(data)
    } catch (error) {
      return fail(error)
    }
  }
}

/** Origins of configured ComfyUI instances and remotes (renderer may target these). */
function configuredComfyOrigins(): string[] {
  const origins: string[] = []
  for (const inst of loadInstanceConfigs()) {
    let host = inst.listen || '127.0.0.1'
    if (host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1'
    if (!inst.port) continue
    origins.push(`http://${host}:${inst.port}`)
    origins.push(`https://${host}:${inst.port}`)
  }
  for (const remote of remoteService.list()) {
    if (remote.baseUrl) origins.push(remote.baseUrl)
  }
  return origins
}

/** localhost or a configured instance/remote origin only. */
function isTrustedComfyUrl(raw: string | undefined | null): boolean {
  if (!raw) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (isLocalhostUrl(raw)) return true
  for (const candidate of configuredComfyOrigins()) {
    try {
      if (new URL(candidate).origin === u.origin) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

function isAllowedEmbedUrl(raw: string): boolean {
  return isSafeEmbedUrl(raw) && isTrustedComfyUrl(raw)
}

const READ_DATA_EXTS = new Set(['.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.yaml', '.yml', '.txt'])

function isSafeReadPath(path: string): boolean {
  if (!path || path.includes('\0')) return false
  const ext = extname(basename(path)).toLowerCase()
  if (!READ_DATA_EXTS.has(ext)) return false
  return isSafeOpenPath(path) || existsSync(path)
}

let embedView: WebContentsView | null = null

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  // settings
  ipcMain.handle('settings.get', wrap(() => loadSettings()))
  ipcMain.handle('settings.set', wrap((patch: Partial<AppSettings>) => {
    const next = saveSettings(patch)
    // Re-apply proxy whenever settings change
    syncProxyFromSettings()
    return next
  }))
  ipcMain.handle('settings.launchTemplates', wrap(() => LAUNCH_TEMPLATES))
  ipcMain.handle('settings.dataDir', wrap(async () => {
    const { userDataDir } = await import('../services/db')
    return userDataDir()
  }))
  ipcMain.handle('proxy.apply', wrap(() => syncProxyFromSettings()))
  ipcMain.handle('proxy.test', wrap((opts?: { url?: string }) => testProxy(opts)))

  // instances
  ipcMain.handle('instance.list', wrap(() => instanceService.list()))
  ipcMain.handle('instance.discover', wrap((root?: string) => instanceService.discover(root)))
  ipcMain.handle('instance.save', wrap((config: ComfyInstanceConfig) => instanceService.save({ ...config, id: config.id ? sanitizeId(config.id) : '' })))
  ipcMain.handle('instance.remove', wrap((id: string) => instanceService.remove(sanitizeId(id))))
  ipcMain.handle('instance.start', wrap((id: string) => instanceService.start(sanitizeId(id))))
  ipcMain.handle('instance.stop', wrap((id: string) => instanceService.stop(sanitizeId(id))))
  ipcMain.handle('instance.restart', wrap((id: string) => instanceService.restart(sanitizeId(id))))
  ipcMain.handle('instance.forceKill', wrap((id: string) => instanceService.forceKill(sanitizeId(id))))
  ipcMain.handle('instance.getLogs', wrap((id: string, limit?: number) => instanceService.getLogs(sanitizeId(id), limit)))
  ipcMain.handle('instance.clearLogs', wrap((id: string) => instanceService.clearLogs(sanitizeId(id))))
  ipcMain.handle('instance.checkPort', wrap((port: number) => instanceService.checkPort(port)))
  ipcMain.handle('instance.suggestPort', wrap(() => instanceService.suggestPort()))
  ipcMain.handle('instance.probeEnv', wrap((id: string) => instanceService.probeEnv(sanitizeId(id))))
  ipcMain.handle('instance.exportDiagnostics', wrap((id: string) => instanceService.exportDiagnostics(sanitizeId(id))))
  ipcMain.handle('instance.copyDiagnostics', wrap(async (id: string) => {
    const path = await instanceService.copyDiagnostics(sanitizeId(id))
    clipboard.writeText(path)
    return path
  }))

  // models
  ipcMain.handle('model.list', wrap(() => modelService.list()))
  ipcMain.handle('model.scan', wrap((opts?: { roots?: string[]; hash?: boolean }) => modelService.scan(opts)))
  ipcMain.handle('model.delete', wrap((id: string, deleteFile: boolean) => modelService.remove(id, deleteFile)))
  ipcMain.handle('model.move', wrap((id: string, destDir: string) => modelService.move(id, destDir)))
  ipcMain.handle('model.symlink', wrap((id: string, destDir: string) => modelService.symlink(id, destDir)))
  ipcMain.handle('model.rename', wrap((id: string, name: string) => modelService.rename(id, name)))
  ipcMain.handle('model.tag', wrap((id: string, tags: string[]) => modelService.tag(id, tags)))
  ipcMain.handle('model.findDuplicates', wrap(() => modelService.findDuplicates()))
  ipcMain.handle('model.downloads', wrap(() => modelService.listDownloads()))
  ipcMain.handle('model.download', wrap((opts: { url: string; destDir?: string; fileName?: string }) => modelService.download(opts)))
  ipcMain.handle('model.pauseDownload', wrap((id: string) => modelService.pauseDownload(id)))
  ipcMain.handle('model.resumeDownload', wrap((id: string) => modelService.resumeDownload(id)))
  ipcMain.handle('model.cancelDownload', wrap((id: string) => modelService.cancelDownload(id)))
  ipcMain.handle('model.storageStats', wrap(() => modelService.storageStats()))
  ipcMain.handle('model.parseExtraPaths', wrap((file?: string) => import('../services/model').then((m) => m.parseExtraModelPaths(file))))
  ipcMain.handle('model.fetchCivitaiMeta', wrap((id: string) => modelService.fetchCivitaiMeta(id)))
  ipcMain.handle('model.ensureThumbs', wrap(async () => {
    const { thumbnailService } = await import('../services/media')
    return thumbnailService.ensureAll()
  }))
  ipcMain.handle('model.batchRename', wrap(async (opts: { ids: string[]; pattern: string; dryRun?: boolean }) => {
    const { renameService } = await import('../services/media')
    return renameService.batchRename(opts.ids, opts.pattern, opts.dryRun)
  }))

  // node packs
  ipcMain.handle('node.list', wrap(() => nodePackService.list()))
  ipcMain.handle('node.refresh', wrap(() => nodePackService.refresh()))
  ipcMain.handle('node.registrySearch', wrap((opts?: { query?: string; limit?: number; page?: number; scanPages?: number }) => nodePackService.registrySearch(opts)))
  ipcMain.handle('registry.indexStatus', wrap(async () => {
    const { registryIndex } = await import('../services/registryIndex')
    return registryIndex.status()
  }))
  ipcMain.handle('registry.refreshIndex', wrap(async () => {
    const { registryIndex } = await import('../services/registryIndex')
    return registryIndex.ensure({ force: true })
  }))
  ipcMain.handle('registry.ensureIndex', wrap(async () => {
    const { registryIndex } = await import('../services/registryIndex')
    return registryIndex.ensure()
  }))
  ipcMain.handle('node.managerChannel', wrap(() => nodePackService.managerChannelList()))
  ipcMain.handle('node.install', wrap((opts: { id: string; version?: string; source: 'registry' | 'git' | 'manager'; url?: string }) => nodePackService.install(opts)))
  ipcMain.handle('node.uninstall', wrap((id: string) => nodePackService.uninstall(id)))
  ipcMain.handle('node.update', wrap((id: string, version?: string) => nodePackService.update(id, version)))
  ipcMain.handle('node.toggle', wrap((id: string, enabled: boolean) => nodePackService.toggle(id, enabled)))
  ipcMain.handle('node.lock', wrap((id: string, locked: boolean) => nodePackService.lock(id, locked)))
  ipcMain.handle('node.checkIssues', wrap((id: string) => nodePackService.checkIssues(id)))
  ipcMain.handle('node.conflicts', wrap(() => nodePackService.conflicts()))
  ipcMain.handle('node.smokeTest', wrap((id: string) => nodePackService.smokeTest(id)))
  ipcMain.handle('node.snapshots', wrap(() => nodePackService.snapshots()))
  ipcMain.handle('node.createSnapshot', wrap((name?: string) => nodePackService.createSnapshot(name)))
  ipcMain.handle('node.deleteSnapshot', wrap((id: string) => nodePackService.deleteSnapshot(sanitizeId(id))))
  ipcMain.handle('node.restoreSnapshot', wrap((id: string) => nodePackService.restoreSnapshot(sanitizeId(id))))

  // workflows
  ipcMain.handle('workflow.list', wrap(() => workflowService.list()))
  ipcMain.handle('workflow.import', wrap((path: string) => {
    if (!isSafeReadPath(path)) throw new Error('Blocked unsafe workflow path')
    return workflowService.importFile(path)
  }))
  ipcMain.handle('workflow.launch', wrap(async (path: string, baseUrl?: string) => {
    if (baseUrl) {
      if (!isSafeExternalUrl(baseUrl)) throw new Error('Blocked unsafe URL')
      await shell.openExternal(baseUrl)
      return true
    }
    if (!isSafeOpenPath(path)) throw new Error('Blocked opening executable/script file')
    return shell.openPath(path).then((r) => r === '')
  }))
  ipcMain.handle('workflow.tag', wrap((id: string, tags: string[]) => workflowService.tag(id, tags)))
  ipcMain.handle('workflow.queue', wrap((opts: { workflowPath: string; instanceId: string; seed?: number }) => workflowService.queue(opts)))
  ipcMain.handle('workflow.parsePngMeta', wrap((path: string) => {
    if (!isSafeReadPath(path)) throw new Error('Blocked unsafe image path')
    return workflowService.parsePngMeta(path)
  }))

  // monitor
  ipcMain.handle('monitor.system', wrap(() => monitorService.systemSnapshot()))
  ipcMain.handle('monitor.queue', wrap((baseUrl?: string) => {
    if (baseUrl && !isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
    return monitorService.queueSnapshot(baseUrl)
  }))
  ipcMain.handle('monitor.history', wrap((baseUrl?: string) => {
    if (baseUrl && !isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
    return monitorService.history(baseUrl)
  }))
  ipcMain.handle('monitor.connectWs', wrap((baseUrl: string) => {
    if (!isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
    return monitorService.connectWs(baseUrl)
  }))
  ipcMain.handle('monitor.disconnectWs', wrap(() => {
    monitorService.disconnectWs()
    return true
  }))

  // doctor
  ipcMain.handle('doctor.run', wrap((instanceId: string) => doctorService.run(instanceId)))
  ipcMain.handle('doctor.fix', wrap((instanceId: string, fixId: string) => doctorService.fix(instanceId, fixId)))

  // backup
  ipcMain.handle('backup.list', wrap(() => backupService.list()))
  ipcMain.handle('backup.create', wrap((opts: { name: string; notes?: string }) => backupService.create(opts)))
  ipcMain.handle('backup.restore', wrap((id: string) => backupService.restore(sanitizeId(id))))
  ipcMain.handle('backup.delete', wrap((id: string) => backupService.delete(sanitizeId(id))))
  ipcMain.handle('backup.openFolder', wrap(async (id: string) => {
    const folder = backupService.openFolder(sanitizeId(id))
    return shell.openPath(folder).then((r) => r === '')
  }))

  // env
  ipcMain.handle('env.probe', wrap((opts: { pythonPath: string; venvPath?: string }) => envService.probe(opts)))
  ipcMain.handle('env.createVenv', wrap((req: EnvCreateRequest) => envService.createVenv(req)))
  ipcMain.handle('env.listPythons', wrap(() => envService.listPythons()))
  ipcMain.handle('env.installTorch', wrap((opts: { pythonPath: string; index: string }) => envService.installTorch(opts)))

  // installer
  ipcMain.handle('installer.detectGpu', wrap(() => installerService.detectGpu()))
  ipcMain.handle('installer.preflight', wrap((opts: { installRoot: string; useUv: boolean }) => installerService.preflight(opts)))
  ipcMain.handle('installer.start', wrap((plan: InstallPlan) => installerService.start(plan)))
  ipcMain.handle('installer.status', wrap(() => installerService.getStatus()))
  ipcMain.handle('installer.cancel', wrap(() => installerService.cancel()))

  // batch
  ipcMain.handle('batch.list', wrap(() => batchService.list()))
  ipcMain.handle('batch.create', wrap((job: Omit<BatchJob, 'id' | 'status' | 'completed' | 'failed' | 'createdAt' | 'promptIds'>) => batchService.create(job)))
  ipcMain.handle('batch.start', wrap((id: string) => batchService.start(id)))
  ipcMain.handle('batch.cancel', wrap((id: string) => batchService.cancel(id)))
  ipcMain.handle('batch.remove', wrap((id: string) => batchService.remove(id)))

  // output
  ipcMain.handle('output.list', wrap((opts?: { root?: string; type?: string; limit?: number }) => outputService.list(opts)))
  ipcMain.handle('output.open', wrap(async (path: string) => {
    if (!isSafeOpenPath(path)) throw new Error('Blocked opening executable/script file')
    return shell.openPath(path).then((r) => r === '')
  }))
  ipcMain.handle('output.importToWorkflow', wrap(async (path: string): Promise<WorkflowRecord | null> => {
    if (!isSafeReadPath(path)) throw new Error('Blocked unsafe image path')
    const meta = await workflowService.parsePngMeta(path)
    if (meta?.workflow) {
      return workflowService.importFile(path)
    }
    return null
  }))

  // remote
  ipcMain.handle('remote.list', wrap(() => remoteService.list()))
  ipcMain.handle('remote.save', wrap((config: RemoteInstanceConfig) => remoteService.save(config)))
  ipcMain.handle('remote.remove', wrap((id: string) => remoteService.remove(id)))
  ipcMain.handle('remote.test', wrap((id: string) => remoteService.test(id)))
  ipcMain.handle('remote.listStatus', wrap(() => remoteService.listStatus()))

  // market
  ipcMain.handle('market.list', wrap((opts?: { query?: string; category?: string; limit?: number; page?: number; scanPages?: number }) => marketService.list(opts)))
  ipcMain.handle('market.install', wrap(async (id: string): Promise<NodePackRecord> => {
    return nodePackService.install({ id, source: 'registry' })
  }))

  // shell
  ipcMain.handle('shell.openExternal', wrap(async (url: string) => {
    if (!isSafeExternalUrl(url)) throw new Error(`Blocked unsafe URL: ${url.slice(0, 40)}`)
    await shell.openExternal(url)
    return true
  }))
  ipcMain.handle('shell.openPath', wrap(async (path: string) => {
    if (!isSafeOpenPath(path)) throw new Error('Blocked opening executable/script file')
    const result = await shell.openPath(path)
    return result === ''
  }))
  ipcMain.handle('shell.pickDirectory', wrap(async () => {
    const win = getWindow()
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  }))
  ipcMain.handle('shell.pickFile', wrap(async (opts?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
    const win = getWindow()
    const options = { properties: ['openFile' as const], filters: opts?.filters }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return res.canceled ? null : res.filePaths[0]
  }))
  ipcMain.handle('shell.writeClipboard', wrap((text: string) => {
    clipboard.writeText(text)
    return true
  }))

  // embed
  ipcMain.handle('embed.open', wrap((opts: { url: string; title?: string }) => {
    const win = getWindow()
    if (!win) return false
    if (!isAllowedEmbedUrl(opts.url)) throw new Error('Blocked unsafe embed URL')
    if (embedView) {
      win.contentView.removeChildView(embedView)
      embedView.webContents.close()
      embedView = null
    }
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    embedView = view
    win.contentView.addChildView(view)
    const bounds = win.getBounds()
    // Keep sidebar 240px + header 64px visible
    view.setBounds({
      x: 240,
      y: 64,
      width: Math.max(200, bounds.width - 240),
      height: Math.max(200, bounds.height - 64)
    })
    view.webContents.setWindowOpenHandler(({ url: navUrl }) => {
      if (isSafeExternalUrl(navUrl)) void shell.openExternal(navUrl)
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, navUrl) => {
      if (!isAllowedEmbedUrl(navUrl)) {
        event.preventDefault()
      }
    })
    void view.webContents.loadURL(opts.url)
    return true
  }))

  ipcMain.handle('embed.resize', wrap((rect: { x: number; y: number; width: number; height: number }) => {
    if (!embedView) return false
    embedView.setBounds(rect)
    return true
  }))

  ipcMain.handle('embed.close', wrap(() => {
    const win = getWindow()
    if (embedView && win) {
      win.contentView.removeChildView(embedView)
      embedView.webContents.close()
      embedView = null
    }
    return true
  }))

  // keep unused imports referenced for type completeness
  void upsertInstanceConfig
  void deleteInstanceConfig
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}
