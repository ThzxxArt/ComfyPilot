/**
 * Runtime IPC contract (0.2.0).
 *
 * TypeScript erases `IpcChannelMap`; a compromised/buggy renderer could send
 * any shape to any channel. This layer validates the high-risk channels with
 * zod before the handler runs, and rejects calls from a non-app frame.
 *
 * Every channel in `IPC_CHANNELS` has an entry. Channels whose arguments are
 * intentionally free-form use a loose array schema; the high-risk surface
 * (paths, credentials, lifecycle, destructive actions) is strictly typed.
 */
import { z } from 'zod'
import { IPC_CHANNELS } from '@shared/types'
import { isOwnRendererUrl } from '../services/rendererEntry'

const s = z.string()
const n = z.number()
const b = z.boolean()
const obj = z.record(z.string(), z.unknown())
const strArray = z.array(s)
const loose = z.array(z.unknown())

const schemas = new Map<string, z.ZodType>(
  (IPC_CHANNELS as readonly string[]).map((channel) => [channel, loose])
)

function set(channel: string, schema: z.ZodType): void {
  if (!schemas.has(channel)) {
    // A schema for a channel that is not in the runtime whitelist is dead code.
    throw new Error(`[ipc-contract] unknown channel: ${channel}`)
  }
  schemas.set(channel, schema)
}

// ---- settings / credentials / data ----
set('settings.get', z.tuple([]))
set('settings.set', z.tuple([obj]))
set('settings.setProxyPassword', z.tuple([s]))
set('settings.clearProxyPassword', z.tuple([]))
set('settings.exportConfig', z.tuple([]))
set('settings.importConfig', z.tuple([obj]))
set('settings.credentialStatus', z.tuple([]))
set('settings.launchTemplates', z.tuple([]))
set('settings.dataDir', z.tuple([]))
set('settings.logsDir', z.tuple([]))
set('data.migrationState', z.tuple([]))
set('data.retryMigration', z.tuple([]))
set('proxy.apply', z.tuple([]))
set('proxy.test', z.tuple([obj.optional()]))

// ---- instances / env / installer ----
set('instance.list', z.tuple([]))
set('instance.discover', z.tuple([s.optional()]))
set('instance.save', z.tuple([obj]))
set('instance.migratePython', z.tuple([s]))
set('instance.remove', z.tuple([s]))
set('instance.launch', z.tuple([s, obj.optional()]))
set('instance.launchArgCatalog', z.tuple([s.optional()]))
set('instance.previewLaunch', z.tuple([s]))
set('instance.stop', z.tuple([s]))
set('instance.restart', z.tuple([s, obj.optional()]))
set('instance.forceKill', z.tuple([s]))
set('instance.sweepStale', z.tuple([]))
set('instance.startAll', z.tuple([]))
set('instance.stopAll', z.tuple([]))
set('instance.getLogs', z.tuple([s, n.optional()]))
set('instance.clearLogs', z.tuple([s]))
set('instance.checkPort', z.tuple([n]))
set('instance.suggestPort', z.tuple([]))
set('instance.probeEnv', z.tuple([s]))
set('instance.exportDiagnostics', z.tuple([s]))
set('instance.copyDiagnostics', z.tuple([s]))
set('instance.exportLogs', z.tuple([s]))
set('instance.updateJournal', z.tuple([s]))
set('instance.rollbackUpdate', z.tuple([s]))
set('instance.checkComfyUpdate', z.tuple([s]))
set('instance.updateComfy', z.tuple([s, obj.optional()]))
set('instance.updateStatus', z.tuple([]))
set('instance.cancelUpdate', z.tuple([]))
set('instance.repairStatus', z.tuple([]))
set('instance.repairEnv', z.tuple([s, obj.optional()]))
set('instance.repairCancel', z.tuple([]))
set('instance.capabilities', z.tuple([s]))
set('instance.runStartupSelfCheck', z.tuple([s]))
set('instance.pipInstall', z.tuple([s, s]))
set('instance.applyRecipe', z.tuple([s, s]))
set('instance.pipCancel', z.tuple([s]))
set('instance.pipStatus', z.tuple([s.optional()]))
set('instance.execFailures', z.tuple([s]))
set('instance.clearExecFailures', z.tuple([s]))
set('instance.startupIssues', z.tuple([s]))
set('env.probe', z.tuple([obj]))
set('env.createVenv', z.tuple([obj]))
set('env.listPythons', z.tuple([]))
set('env.installTorch', z.tuple([obj]))
set('installer.detectGpu', z.tuple([]))
set('installer.preflight', z.tuple([obj]))
set('installer.start', z.tuple([obj]))
set('installer.status', z.tuple([]))
set('installer.cancel', z.tuple([]))
set('installer.reset', z.tuple([]))
set('installer.suggestInstallRoot', z.tuple([]))
set('installer.starterModels', z.tuple([]))
set('installer.installStarter', z.tuple([obj]))
set('bootstrap.status', z.tuple([]))
set('bootstrap.ensure', z.tuple([obj.optional()]))
set('bootstrap.download', z.tuple([s]))
set('bootstrap.deleteLegacy', z.tuple([]))
set('net.recommendMirrors', z.tuple([]))
set('instance.exportLaunchScript', z.tuple([s, obj.optional()]))

// ---- models ----
set('model.list', z.tuple([]))
set('model.scan', z.tuple([obj.optional()]))
set('model.delete', z.tuple([s, b]))
set('model.move', z.tuple([s, s]))
set('model.symlink', z.tuple([s, s]))
set('model.rename', z.tuple([s, s]))
set('model.tag', z.tuple([s, strArray]))
set('model.findDuplicates', z.tuple([]))
set('model.downloads', z.tuple([]))
set('model.download', z.tuple([obj]))
set('model.pauseDownload', z.tuple([s]))
set('model.prioritizeDownload', z.tuple([s]))
set('model.resumeDownload', z.tuple([s]))
set('model.cancelDownload', z.tuple([s]))
set('model.clearFinishedDownloads', z.tuple([]))
set('model.storageStats', z.tuple([]))
set('model.parseExtraPaths', z.tuple([s.optional()]))
set('model.reconcile', z.tuple([s.optional()]))
set('model.fetchCivitaiMeta', z.tuple([s]))
set('model.ensureThumbs', z.tuple([]))
set('model.batchRename', z.tuple([obj]))

// ---- node packs / registry / market ----
set('node.list', z.tuple([s.optional()]))
set('node.refresh', z.tuple([s.optional()]))
set('registry.indexStatus', z.tuple([]))
set('registry.refreshIndex', z.tuple([]))
set('registry.ensureIndex', z.tuple([obj.optional()]))
set('ops.list', z.tuple([]))
set('ops.cancel', z.tuple([s]))
set('registry.cancelIndex', z.tuple([]))
set('node.managerChannel', z.tuple([]))
set('node.install', z.tuple([obj]))
set('node.uninstall', z.tuple([s, s.optional(), obj.optional()]))
set('node.uninstallDeps', z.tuple([s, s.optional()]))
set('node.cancelOp', z.tuple([s.optional()]))
set('node.cancelBatch', z.tuple([s.optional()]))
set('node.update', z.tuple([s, s.optional(), s.optional()]))
set('node.toggle', z.tuple([s, b, s.optional()]))
set('node.lock', z.tuple([s, b, s.optional()]))
set('node.checkIssues', z.tuple([s, s.optional()]))
set('node.loadReport', z.tuple([s.optional()]))
set('node.opStatus', z.tuple([s.optional()]))
set('node.recoveryScan', z.tuple([s.optional()]))
set('node.recoveryRestore', z.tuple([s, s.optional()]))
set('node.recoveryClean', z.tuple([s, s.optional()]))
set('node.recoveryCleanAll', z.tuple([s.optional()]))
set('node.depsAudit', z.tuple([s.optional()]))
set('node.installDeps', z.tuple([s, s.optional(), strArray.optional()]))
set('node.conflicts', z.tuple([s.optional()]))
set('node.smokeTest', z.tuple([s, s.optional()]))
set('node.snapshots', z.tuple([s.optional()]))
set('node.createSnapshot', z.tuple([s.optional(), s.optional()]))
set('node.deleteSnapshot', z.tuple([s, s.optional()]))
set('node.restoreSnapshot', z.tuple([s, s.optional()]))
set('node.checkUpdates', z.tuple([s.optional()]))
set('node.updateAll', z.tuple([s.optional(), obj.optional()]))
set('deps.recipes', z.tuple([]))
set('market.list', z.tuple([obj.optional()]))
set('market.install', z.tuple([obj]))

// ---- issues ----
set('issue.list', z.tuple([b.optional()]))
set('issue.scan', z.tuple([s.optional()]))
set('issue.dismiss', z.tuple([s]))
set('issue.restore', z.tuple([s]))
set('issue.resolve', z.tuple([s]))
set('issue.installModule', z.tuple([s]))
set('issue.cleanLeftover', z.tuple([s]))

// ---- workflows ----
set('workflow.list', z.tuple([obj.optional()]))
set('workflow.import', z.tuple([s, s.optional(), z.enum(['instance', 'library']).optional()]))
set(
  'workflow.importMany',
  z.tuple([strArray, s.optional(), z.enum(['instance', 'library']).optional()])
)
set('workflow.tag', z.tuple([s, strArray]))
set('workflow.favorite', z.tuple([s, b]))
set('workflow.rename', z.tuple([s, s]))
set('workflow.delete', z.tuple([s, obj.optional()]))
set('workflow.exportZip', z.tuple([s, s.optional()]))
set('workflow.copyToInstance', z.tuple([s, s]))
set('workflow.openInFrontend', z.tuple([s, s.optional()]))
set('workflow.reveal', z.tuple([s]))
set('workflow.libraryInfo', z.tuple([s.optional()]))
set('workflow.queue', z.tuple([obj]))
set('workflow.parsePngMeta', z.tuple([s]))
set('workflow.compare', z.tuple([s, s]))
set('workflow.preflight', z.tuple([s, s]))
set('workflow.checkModels', z.tuple([s, s.optional()]))
set('workflow.importDefault', z.tuple([obj]))

// ---- monitor / doctor / backup ----
set('monitor.system', z.tuple([]))
set('monitor.queue', z.tuple([s.optional()]))
set('monitor.series', z.tuple([]))
set('monitor.history', z.tuple([s.optional()]))
set('monitor.jobs', z.tuple([s.optional()]))
set('monitor.connectWs', z.tuple([s]))
set('monitor.disconnectWs', z.tuple([]))
set('monitor.clearQueue', z.tuple([s]))
set('monitor.interrupt', z.tuple([s, s.optional()]))
set('monitor.freeMemory', z.tuple([s]))
set('doctor.run', z.tuple([s]))
set('doctor.cancel', z.tuple([]))
set('doctor.fix', z.tuple([s, s]))
set('backup.list', z.tuple([]))
set('backup.create', z.tuple([obj]))
set('backup.preview', z.tuple([s]))
set('backup.restore', z.tuple([s, obj.optional()]))
set('backup.delete', z.tuple([s]))
set('backup.openFolder', z.tuple([s]))

// ---- batch / output / remote / shell / embed ----
set('batch.list', z.tuple([]))
set('batch.create', z.tuple([obj]))
set('batch.start', z.tuple([s]))
set('batch.resume', z.tuple([s]))
set('batch.retryFailed', z.tuple([s]))
set('batch.wait', z.tuple([s]))
set('batch.cancel', z.tuple([s]))
set('batch.cancelItem', z.tuple([s, s]))
set('batch.remove', z.tuple([s]))
set('batch.preflight', z.tuple([obj]))
set('output.scan', z.tuple([obj.optional()]))
set('output.scanCancel', z.tuple([]))
set('output.list', z.tuple([obj.optional()]))
set('output.thumb', z.tuple([s]))
set('output.assetsMatch', z.tuple([s, s]))
set('output.open', z.tuple([s]))
set('output.reveal', z.tuple([s]))
set('output.favorite', z.tuple([s, b]))
set('output.delete', z.tuple([s, b]))
set('output.batchDelete', z.tuple([strArray, b]))
set('output.importToWorkflow', z.tuple([s, s.optional()]))
set('output.exportZip', z.tuple([strArray, s.optional()]))
set('remote.list', z.tuple([]))
set('remote.save', z.tuple([obj]))
set('remote.setApiKey', z.tuple([s, s]))
set('remote.clearApiKey', z.tuple([s]))
set('remote.remove', z.tuple([s]))
set('remote.test', z.tuple([s]))
set('remote.listStatus', z.tuple([]))
set('remote.freeMemory', z.tuple([s]))
set('app.checkUpdate', z.tuple([]))
set('app.updateStatus', z.tuple([]))
set('app.installUpdate', z.tuple([]))
set('app.previousExit', z.tuple([]))
set('app.exportDiagnostics', z.tuple([]))
set('shell.openExternal', z.tuple([s]))
set('shell.openPath', z.tuple([s]))
set('shell.reveal', z.tuple([s]))
set('shell.pickDirectory', z.tuple([]))
set('shell.pickFile', z.tuple([obj.optional()]))
set('shell.pickFiles', z.tuple([obj.optional()]))
set('shell.writeClipboard', z.tuple([s]))
set('embed.open', z.tuple([obj]))
set('embed.resize', z.tuple([obj]))
set('embed.close', z.tuple([]))

export function validateIpcArgs(channel: string, args: unknown[]): void {
  const schema = schemas.get(channel)
  if (!schema) {
    throw Object.assign(new Error(`Unknown IPC channel: ${channel}`), {
      code: 'IPC_UNKNOWN_CHANNEL'
    })
  }
  const result = schema.safeParse(args)
  if (!result.success) {
    const first = result.error.issues[0]
    const detail = first
      ? `${first.path.join('.') || 'args'}: ${first.message}`
      : result.error.message
    throw Object.assign(new Error(`Invalid IPC arguments for ${channel} (${detail})`), {
      code: 'IPC_INVALID_ARGS',
      detail
    })
  }
}

type HandleLike = {
  handle: (channel: string, listener: (...args: never[]) => unknown) => unknown
}

/**
 * Wrap `ipcMain.handle` once. Sender-frame validation happens here as well as
 * in the handler wrapper so a future domain that forgets `wrap` is still safe.
 */
export function instrumentIpcContract(ipc: HandleLike): boolean {
  try {
    if (!ipc || typeof ipc.handle !== 'function') return false
    const marker = '__comfypilot_contract__'
    if ((ipc as unknown as Record<string, unknown>)[marker]) return false
    const original = ipc.handle.bind(ipc) as (
      channel: string,
      fn: (...a: unknown[]) => unknown
    ) => unknown
    ipc.handle = ((channel: string, handler: (...a: unknown[]) => unknown) => {
      if (typeof handler !== 'function') return original(channel, handler)
      const guarded = async (event: unknown, ...args: unknown[]): Promise<unknown> => {
        try {
          if (event && typeof event === 'object' && 'senderFrame' in event) {
            const frame = (event as { senderFrame?: { url?: string } | null }).senderFrame
            if (!frame || !isOwnRendererUrl(String(frame.url || ''))) {
              throw Object.assign(new Error('Blocked IPC from an untrusted frame'), {
                code: 'IPC_UNTRUSTED_FRAME'
              })
            }
          }
          validateIpcArgs(channel, args)
          return await handler(event, ...args)
        } catch (err) {
          const e = err as Error & { code?: string; detail?: string; retryable?: boolean }
          return {
            ok: false,
            error: e?.message || String(err),
            code: typeof e?.code === 'string' ? e.code : undefined,
            detail: typeof e?.detail === 'string' ? e.detail : undefined,
            retryable: typeof e?.retryable === 'boolean' ? e.retryable : undefined
          }
        }
      }
      return original(channel, guarded as (...a: unknown[]) => unknown)
    }) as HandleLike['handle']
    ;(ipc as unknown as Record<string, unknown>)[marker] = true
    return true
  } catch {
    return false
  }
}

export function channelSchemaCount(): number {
  return schemas.size
}

export function hasSchema(channel: string): boolean {
  return schemas.has(channel)
}
