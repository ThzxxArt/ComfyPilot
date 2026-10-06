import { ipcMain, dialog, shell, BrowserWindow, WebContentsView, clipboard } from 'electron'
import type { IpcResult, ComfyInstanceConfig, RemoteInstanceConfig, NodePackRecord, BatchJob, EnvCreateRequest, WorkflowRecord, AppSettings } from '@shared/types'
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

let embedView: WebContentsView | null = null

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  // settings
  ipcMain.handle('settings.get', wrap(() => loadSettings()))
  ipcMain.handle('settings.set', wrap((patch: Partial<AppSettings>) => saveSettings(patch)))
  ipcMain.handle('settings.launchTemplates', wrap(() => LAUNCH_TEMPLATES))

  // instances
  ipcMain.handle('instance.list', wrap(() => instanceService.list()))
  ipcMain.handle('instance.discover', wrap((root?: string) => instanceService.discover(root)))
  ipcMain.handle('instance.save', wrap((config: ComfyInstanceConfig) => instanceService.save(config)))
  ipcMain.handle('instance.remove', wrap((id: string) => instanceService.remove(id)))
  ipcMain.handle('instance.start', wrap((id: string) => instanceService.start(id)))
  ipcMain.handle('instance.stop', wrap((id: string) => instanceService.stop(id)))
  ipcMain.handle('instance.restart', wrap((id: string) => instanceService.restart(id)))
  ipcMain.handle('instance.forceKill', wrap((id: string) => instanceService.forceKill(id)))
  ipcMain.handle('instance.getLogs', wrap((id: string, limit?: number) => instanceService.getLogs(id, limit)))
  ipcMain.handle('instance.clearLogs', wrap((id: string) => instanceService.clearLogs(id)))
  ipcMain.handle('instance.checkPort', wrap((port: number) => instanceService.checkPort(port)))
  ipcMain.handle('instance.suggestPort', wrap(() => instanceService.suggestPort()))
  ipcMain.handle('instance.probeEnv', wrap((id: string) => instanceService.probeEnv(id)))
  ipcMain.handle('instance.exportDiagnostics', wrap((id: string) => instanceService.exportDiagnostics(id)))
  ipcMain.handle('instance.copyDiagnostics', wrap((id: string) => instanceService.copyDiagnostics(id)))

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
  ipcMain.handle('node.registrySearch', wrap((opts?: { query?: string; limit?: number }) => nodePackService.registrySearch(opts)))
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
  ipcMain.handle('node.restoreSnapshot', wrap((id: string) => nodePackService.restoreSnapshot(id)))
  ipcMain.handle('node.deleteSnapshot', wrap((id: string) => nodePackService.deleteSnapshot(id)))

  // workflows
  ipcMain.handle('workflow.list', wrap(() => workflowService.list()))
  ipcMain.handle('workflow.import', wrap((path: string) => workflowService.importFile(path)))
  ipcMain.handle('workflow.launch', wrap((path: string, baseUrl?: string) => {
    if (baseUrl) {
      void shell.openExternal(baseUrl)
      return true
    }
    return shell.openPath(path).then((r) => !r)
  }))
  ipcMain.handle('workflow.tag', wrap((id: string, tags: string[]) => workflowService.tag(id, tags)))
  ipcMain.handle('workflow.queue', wrap((opts: { workflowPath: string; instanceId: string; seed?: number }) => workflowService.queue(opts)))
  ipcMain.handle('workflow.parsePngMeta', wrap((path: string) => workflowService.parsePngMeta(path)))

  // monitor
  ipcMain.handle('monitor.system', wrap(() => monitorService.systemSnapshot()))
  ipcMain.handle('monitor.queue', wrap((baseUrl?: string) => monitorService.queueSnapshot(baseUrl)))
  ipcMain.handle('monitor.history', wrap((baseUrl?: string) => monitorService.history(baseUrl)))
  ipcMain.handle('monitor.connectWs', wrap((baseUrl: string) => monitorService.connectWs(baseUrl)))
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
  ipcMain.handle('backup.restore', wrap((id: string) => backupService.restore(id)))
  ipcMain.handle('backup.delete', wrap((id: string) => backupService.delete(id)))
  ipcMain.handle('backup.openFolder', wrap((id: string) => shell.openPath(backupService.openFolder(id)).then((r) => !r)))

  // env
  ipcMain.handle('env.probe', wrap((opts: { pythonPath: string; venvPath?: string }) => envService.probe(opts)))
  ipcMain.handle('env.createVenv', wrap((req: EnvCreateRequest) => envService.createVenv(req)))
  ipcMain.handle('env.listPythons', wrap(() => envService.listPythons()))
  ipcMain.handle('env.installTorch', wrap((opts: { pythonPath: string; index: string }) => envService.installTorch(opts)))

  // batch
  ipcMain.handle('batch.list', wrap(() => batchService.list()))
  ipcMain.handle('batch.create', wrap((job: Omit<BatchJob, 'id' | 'status' | 'completed' | 'failed' | 'createdAt' | 'promptIds'>) => batchService.create(job)))
  ipcMain.handle('batch.start', wrap((id: string) => batchService.start(id)))
  ipcMain.handle('batch.cancel', wrap((id: string) => batchService.cancel(id)))
  ipcMain.handle('batch.remove', wrap((id: string) => batchService.remove(id)))

  // output
  ipcMain.handle('output.list', wrap((opts?: { root?: string; type?: string; limit?: number }) => outputService.list(opts)))
  ipcMain.handle('output.open', wrap((path: string) => shell.openPath(path).then((r) => !r)))
  ipcMain.handle('output.importToWorkflow', wrap(async (path: string): Promise<WorkflowRecord | null> => {
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
  ipcMain.handle('market.list', wrap((opts?: { query?: string; category?: string }) => marketService.list(opts)))
  ipcMain.handle('market.install', wrap(async (id: string): Promise<NodePackRecord> => {
    return nodePackService.install({ id, source: 'registry' })
  }))

  // shell
  ipcMain.handle('shell.openExternal', wrap((url: string) => shell.openExternal(url)))
  ipcMain.handle('shell.openPath', wrap((path: string) => shell.openPath(path).then((r) => !r)))
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
    if (embedView) {
      win.contentView.removeChildView(embedView)
      embedView.webContents.close()
      embedView = null
    }
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true }
    })
    embedView = view
    win.contentView.addChildView(view)
    const bounds = win.getBounds()
    view.setBounds({ x: 0, y: 64, width: bounds.width, height: Math.max(200, bounds.height - 64) })
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
  void loadInstanceConfigs
  void upsertInstanceConfig
  void deleteInstanceConfig
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}
