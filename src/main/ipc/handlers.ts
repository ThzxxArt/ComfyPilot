import { BrowserWindow, ipcMain } from 'electron'
import { IPC_EVENTS } from '@shared/types'
import { FREEZE_OP_MS, instrumentIpcHandle, setSlowOpListener } from '../services/slowOps'
import {
  broadcast as broadcastImpl,
  createIpcContext,
  requireRunningInstance as requireRunningInstanceImpl,
  type NotificationInput
} from './context'
import { createBackupHandlers } from './domains/backup'
import { createBatchHandlers } from './domains/batch'
import { createDoctorHandlers } from './domains/doctor'
import { createInstanceHandlers } from './domains/instances'
import { createIssueHandlers } from './domains/issues'
import { createModelHandlers, registerModelNotifications } from './domains/models'
import { createMonitorHandlers } from './domains/monitor'
import { createNodeHandlers } from './domains/nodes'
import { createOutputHandlers } from './domains/output'
import { createRemoteHandlers } from './domains/remote'
import { createSettingsHandlers } from './domains/settings'
import { createShellHandlers } from './domains/shell'
import { createWorkflowHandlers } from './domains/workflows'
import { instrumentIpcContract } from './contract'

export function broadcast(channel: string, payload: unknown): void {
  broadcastImpl(channel, payload)
}

export function broadcastNotification(n: NotificationInput): void {
  broadcastImpl(IPC_EVENTS.notification, n)
}

/** Kept for callers that imported the shared runner check from this module. */
export async function requireRunningInstance(instanceId?: string): Promise<{
  id: string
  name: string
  url: string
}> {
  // The shared helper throws "Instance not found: <id>" for unknown ids.
  return requireRunningInstanceImpl(instanceId)
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const ctx = createIpcContext(getWindow)

  // 0.1.17 (WP6): every channel registered below is timed. A call at or above
  // FREEZE_OP_MS also raises one throttled toast, so the user learns the app
  // (not their click) froze. Recording itself never throws into the call.
  const notifiedAt = new Map<string, number>()
  setSlowOpListener((entry) => {
    if (!entry.freeze || entry.ms < FREEZE_OP_MS) return
    const now = Date.now()
    const last = notifiedAt.get(entry.channel) || 0
    if (now - last < 60_000) return
    notifiedAt.set(entry.channel, now)
    broadcastNotification({
      type: 'warning',
      title: 'Main process was busy',
      titleKey: 'notify.appFreeze',
      message: `${entry.channel} took ${entry.ms} ms`,
      messageKey: 'notify.appFreezeMsg',
      params: { channel: entry.channel, ms: entry.ms },
      duration: 8000
    })
  })
  // Validate args + sender frame before any domain handler runs. This is
  // installed first so the slow-op wrapper times the validated call.
  instrumentIpcContract(
    ipcMain as unknown as {
      handle: (channel: string, listener: (...args: never[]) => unknown) => unknown
    }
  )
  instrumentIpcHandle(
    ipcMain as unknown as {
      handle: (channel: string, listener: (...args: never[]) => unknown) => unknown
    }
  )

  const settings = createSettingsHandlers()
  ipcMain.handle('data.migrationState', settings.migrationState)
  ipcMain.handle('data.retryMigration', settings.retryMigration)
  ipcMain.handle('settings.get', settings.get)
  ipcMain.handle('settings.setProxyPassword', settings.setProxyPassword)
  ipcMain.handle('settings.clearProxyPassword', settings.clearProxyPassword)
  ipcMain.handle('settings.exportConfig', settings.exportConfig)
  ipcMain.handle('settings.importConfig', settings.importConfig)
  ipcMain.handle('settings.credentialStatus', settings.credentialStatus)
  ipcMain.handle('settings.set', settings.set)
  ipcMain.handle('settings.launchTemplates', settings.launchTemplates)
  ipcMain.handle('settings.dataDir', settings.dataDir)
  ipcMain.handle('settings.logsDir', settings.logsDir)
  ipcMain.handle('proxy.apply', settings.applyProxy)
  ipcMain.handle('proxy.test', settings.testProxy)

  const instances = createInstanceHandlers(ctx)
  ipcMain.handle('instance.list', instances.list)
  ipcMain.handle('instance.discover', instances.discover)
  ipcMain.handle('instance.save', instances.save)
  ipcMain.handle('instance.migratePython', instances.migratePython)
  ipcMain.handle('instance.remove', instances.remove)
  ipcMain.handle('instance.launch', instances.launch)
  ipcMain.handle('instance.launchArgCatalog', instances.launchArgCatalog)
  ipcMain.handle('instance.previewLaunch', instances.previewLaunch)
  ipcMain.handle('instance.stop', instances.stop)
  ipcMain.handle('instance.restart', instances.restart)
  ipcMain.handle('instance.forceKill', instances.forceKill)
  ipcMain.handle('instance.sweepStale', instances.sweepStale)
  ipcMain.handle('instance.startAll', instances.startAll)
  ipcMain.handle('instance.stopAll', instances.stopAll)
  ipcMain.handle('instance.getLogs', instances.getLogs)
  ipcMain.handle('instance.clearLogs', instances.clearLogs)
  ipcMain.handle('instance.checkPort', instances.checkPort)
  ipcMain.handle('instance.suggestPort', instances.suggestPort)
  ipcMain.handle('instance.probeEnv', instances.probeEnv)
  ipcMain.handle('instance.exportDiagnostics', instances.exportDiagnostics)
  ipcMain.handle('instance.copyDiagnostics', instances.copyDiagnostics)
  ipcMain.handle('instance.exportLogs', instances.exportLogs)
  ipcMain.handle('instance.updateJournal', instances.updateJournal)
  ipcMain.handle('instance.rollbackUpdate', instances.rollbackUpdate)
  ipcMain.handle('instance.checkComfyUpdate', instances.checkComfyUpdate)
  ipcMain.handle('instance.updateComfy', instances.updateComfy)
  ipcMain.handle('instance.updateStatus', instances.updateStatus)
  ipcMain.handle('instance.cancelUpdate', instances.cancelUpdate)
  ipcMain.handle('instance.repairStatus', instances.repairStatus)
  ipcMain.handle('instance.repairEnv', instances.repairEnv)
  ipcMain.handle('instance.repairCancel', instances.repairCancel)
  ipcMain.handle('instance.capabilities', instances.capabilities)
  ipcMain.handle('instance.runStartupSelfCheck', instances.runStartupSelfCheck)
  ipcMain.handle('instance.pipInstall', instances.pipInstall)
  ipcMain.handle('instance.applyRecipe', instances.applyRecipe)
  ipcMain.handle('instance.pipCancel', instances.pipCancel)
  ipcMain.handle('instance.pipStatus', instances.pipStatus)
  ipcMain.handle('instance.execFailures', instances.execFailures)
  ipcMain.handle('instance.clearExecFailures', instances.clearExecFailures)
  ipcMain.handle('instance.startupIssues', instances.startupIssues)
  ipcMain.handle('env.probe', instances.probe)
  ipcMain.handle('env.createVenv', instances.createVenv)
  ipcMain.handle('env.listPythons', instances.listPythons)
  ipcMain.handle('env.installTorch', instances.installTorch)
  ipcMain.handle('installer.detectGpu', instances.detectGpu)
  ipcMain.handle('installer.preflight', instances.preflight)
  ipcMain.handle('installer.start', instances.start)
  ipcMain.handle('installer.status', instances.status)
  ipcMain.handle('installer.cancel', instances.cancel)
  ipcMain.handle('installer.reset', instances.reset)
  ipcMain.handle('installer.suggestInstallRoot', instances.suggestInstallRoot)
  ipcMain.handle('installer.starterModels', instances.starterModels)
  ipcMain.handle('installer.installStarter', instances.installStarter)
  ipcMain.handle('bootstrap.status', instances.bootstrapStatus)
  ipcMain.handle('bootstrap.ensure', instances.bootstrapEnsure)
  ipcMain.handle('bootstrap.download', instances.bootstrapDownload)
  ipcMain.handle('bootstrap.deleteLegacy', instances.bootstrapDeleteLegacy)
  ipcMain.handle('net.recommendMirrors', instances.recommendMirrors)
  ipcMain.handle('instance.exportLaunchScript', instances.exportLaunchScript)

  const models = createModelHandlers()
  ipcMain.handle('model.list', models.list)
  ipcMain.handle('model.scan', models.scan)
  ipcMain.handle('model.delete', models.remove)
  ipcMain.handle('model.move', models.move)
  ipcMain.handle('model.symlink', models.symlink)
  ipcMain.handle('model.rename', models.rename)
  ipcMain.handle('model.tag', models.tag)
  ipcMain.handle('model.findDuplicates', models.findDuplicates)
  ipcMain.handle('model.downloads', models.downloads)
  ipcMain.handle('model.download', models.download)
  ipcMain.handle('model.pauseDownload', models.pauseDownload)
  ipcMain.handle('model.prioritizeDownload', models.prioritizeDownload)
  ipcMain.handle('model.resumeDownload', models.resumeDownload)
  ipcMain.handle('model.cancelDownload', models.cancelDownload)
  ipcMain.handle('model.clearFinishedDownloads', models.clearFinishedDownloads)
  ipcMain.handle('model.storageStats', models.storageStats)
  ipcMain.handle('model.parseExtraPaths', models.parseExtraPaths)
  ipcMain.handle('model.reconcile', models.reconcile)
  ipcMain.handle('model.fetchCivitaiMeta', models.fetchCivitaiMeta)
  ipcMain.handle('model.ensureThumbs', models.ensureThumbs)
  ipcMain.handle('model.batchRename', models.batchRename)
  registerModelNotifications()

  const nodes = createNodeHandlers()
  ipcMain.handle('node.list', nodes.list)
  ipcMain.handle('node.refresh', nodes.refresh)
  ipcMain.handle('registry.indexStatus', nodes.indexStatus)
  ipcMain.handle('registry.refreshIndex', nodes.refreshIndex)
  ipcMain.handle('registry.ensureIndex', nodes.ensureIndex)
  ipcMain.handle('ops.list', nodes.opsList)
  ipcMain.handle('ops.cancel', nodes.opsCancel)
  ipcMain.handle('registry.cancelIndex', nodes.cancelIndex)
  ipcMain.handle('node.managerChannel', nodes.managerChannel)
  ipcMain.handle('node.install', nodes.install)
  ipcMain.handle('node.uninstall', nodes.uninstall)
  ipcMain.handle('node.uninstallDeps', nodes.uninstallDeps)
  ipcMain.handle('node.cancelOp', nodes.cancelOp)
  ipcMain.handle('node.cancelBatch', nodes.cancelBatch)
  ipcMain.handle('node.update', nodes.update)
  ipcMain.handle('node.toggle', nodes.toggle)
  ipcMain.handle('node.lock', nodes.lock)
  ipcMain.handle('node.checkIssues', nodes.checkIssues)
  ipcMain.handle('node.loadReport', nodes.loadReport)
  ipcMain.handle('node.opStatus', nodes.opStatus)
  ipcMain.handle('node.recoveryScan', nodes.recoveryScan)
  ipcMain.handle('node.recoveryRestore', nodes.recoveryRestore)
  ipcMain.handle('node.recoveryClean', nodes.recoveryClean)
  ipcMain.handle('node.recoveryCleanAll', nodes.recoveryCleanAll)
  ipcMain.handle('node.depsAudit', nodes.depsAudit)
  ipcMain.handle('node.installDeps', nodes.installDeps)
  ipcMain.handle('node.conflicts', nodes.conflicts)
  ipcMain.handle('node.smokeTest', nodes.smokeTest)
  ipcMain.handle('node.snapshots', nodes.snapshots)
  ipcMain.handle('node.createSnapshot', nodes.createSnapshot)
  ipcMain.handle('node.deleteSnapshot', nodes.deleteSnapshot)
  ipcMain.handle('node.restoreSnapshot', nodes.restoreSnapshot)
  ipcMain.handle('node.checkUpdates', nodes.checkUpdates)
  ipcMain.handle('node.updateAll', nodes.updateAll)
  ipcMain.handle('deps.recipes', nodes.depsRecipes)
  ipcMain.handle('market.list', nodes.marketList)
  ipcMain.handle('market.install', nodes.marketInstall)

  const issues = createIssueHandlers()
  ipcMain.handle('issue.list', issues.list)
  ipcMain.handle('issue.scan', issues.scan)
  ipcMain.handle('issue.dismiss', issues.dismiss)
  ipcMain.handle('issue.restore', issues.restore)
  ipcMain.handle('issue.resolve', issues.resolve)
  ipcMain.handle('issue.installModule', issues.installModule)
  ipcMain.handle('issue.cleanLeftover', issues.cleanLeftover)

  const workflows = createWorkflowHandlers(ctx)
  ipcMain.handle('workflow.list', workflows.list)
  ipcMain.handle('workflow.import', workflows.import)
  ipcMain.handle('workflow.importMany', workflows.importMany)
  ipcMain.handle('workflow.tag', workflows.tag)
  ipcMain.handle('workflow.favorite', workflows.favorite)
  ipcMain.handle('workflow.rename', workflows.rename)
  ipcMain.handle('workflow.delete', workflows.remove)
  ipcMain.handle('workflow.exportZip', workflows.exportZip)
  ipcMain.handle('workflow.copyToInstance', workflows.copyToInstance)
  ipcMain.handle('workflow.openInFrontend', workflows.openInFrontend)
  ipcMain.handle('workflow.reveal', workflows.reveal)
  ipcMain.handle('workflow.libraryInfo', workflows.libraryInfo)
  ipcMain.handle('workflow.queue', workflows.queue)
  ipcMain.handle('workflow.parsePngMeta', workflows.parsePngMeta)
  ipcMain.handle('workflow.compare', workflows.compare)
  ipcMain.handle('workflow.preflight', workflows.preflight)
  ipcMain.handle('workflow.checkModels', workflows.checkModels)
  ipcMain.handle('workflow.importDefault', workflows.importDefault)

  const monitor = createMonitorHandlers()
  ipcMain.handle('monitor.system', monitor.system)
  ipcMain.handle('monitor.queue', monitor.queue)
  ipcMain.handle('monitor.series', monitor.series)
  ipcMain.handle('monitor.history', monitor.history)
  ipcMain.handle('monitor.jobs', monitor.jobs)
  ipcMain.handle('monitor.connectWs', monitor.connectWs)
  ipcMain.handle('monitor.disconnectWs', monitor.disconnectWs)
  ipcMain.handle('monitor.clearQueue', monitor.clearQueue)
  ipcMain.handle('monitor.interrupt', monitor.interrupt)
  ipcMain.handle('monitor.freeMemory', monitor.freeMemory)

  const doctor = createDoctorHandlers()
  ipcMain.handle('doctor.run', doctor.run)
  ipcMain.handle('doctor.cancel', doctor.cancel)
  ipcMain.handle('doctor.fix', doctor.fix)

  const backup = createBackupHandlers()
  ipcMain.handle('backup.list', backup.list)
  ipcMain.handle('backup.create', backup.create)
  ipcMain.handle('backup.preview', backup.preview)
  ipcMain.handle('backup.restore', backup.restore)
  ipcMain.handle('backup.delete', backup.remove)
  ipcMain.handle('backup.openFolder', backup.openFolder)

  const batch = createBatchHandlers()
  ipcMain.handle('batch.list', batch.list)
  ipcMain.handle('batch.create', batch.create)
  ipcMain.handle('batch.start', batch.start)
  ipcMain.handle('batch.resume', batch.resume)
  ipcMain.handle('batch.retryFailed', batch.retryFailed)
  ipcMain.handle('batch.wait', batch.wait)
  ipcMain.handle('batch.cancel', batch.cancel)
  ipcMain.handle('batch.cancelItem', batch.cancelItem)
  ipcMain.handle('batch.remove', batch.remove)
  ipcMain.handle('batch.preflight', batch.preflight)

  const output = createOutputHandlers()
  ipcMain.handle('output.scan', output.scan)
  ipcMain.handle('output.scanCancel', output.scanCancel)
  ipcMain.handle('output.list', output.list)
  ipcMain.handle('output.thumb', output.thumb)
  ipcMain.handle('output.assetsMatch', output.assetsMatch)
  ipcMain.handle('output.open', output.open)
  ipcMain.handle('output.reveal', output.reveal)
  ipcMain.handle('output.favorite', output.favorite)
  ipcMain.handle('output.delete', output.remove)
  ipcMain.handle('output.batchDelete', output.batchDelete)
  ipcMain.handle('output.importToWorkflow', output.importToWorkflow)
  ipcMain.handle('output.exportZip', output.exportZip)

  const remote = createRemoteHandlers()
  ipcMain.handle('remote.list', remote.list)
  ipcMain.handle('remote.save', remote.save)
  ipcMain.handle('remote.setApiKey', remote.setApiKey)
  ipcMain.handle('remote.clearApiKey', remote.clearApiKey)
  ipcMain.handle('remote.remove', remote.remove)
  ipcMain.handle('remote.test', remote.test)
  ipcMain.handle('remote.listStatus', remote.listStatus)
  ipcMain.handle('remote.freeMemory', remote.freeMemory)

  // shell.reveal / output gates use resolveInsideAnyRoot and throw
  // "Blocked revealing path outside allowed areas" outside app roots.
  const shell = createShellHandlers(ctx)
  ipcMain.handle('app.checkUpdate', shell.checkUpdate)
  ipcMain.handle('app.updateStatus', shell.updateStatus)
  ipcMain.handle('app.installUpdate', shell.installUpdate)
  ipcMain.handle('app.previousExit', shell.previousExit)
  ipcMain.handle('app.exportDiagnostics', shell.exportDiagnostics)
  ipcMain.handle('shell.openExternal', shell.openExternal)
  ipcMain.handle('shell.openPath', shell.openPath)
  ipcMain.handle('shell.reveal', shell.reveal)
  ipcMain.handle('shell.pickDirectory', shell.pickDirectory)
  ipcMain.handle('shell.pickFile', shell.pickFile)
  ipcMain.handle('shell.pickFiles', shell.pickFiles)
  ipcMain.handle('shell.writeClipboard', shell.writeClipboard)
  ipcMain.handle('embed.open', shell.embedOpen)
  ipcMain.handle('embed.resize', shell.embedResize)
  ipcMain.handle('embed.close', shell.embedClose)
}
