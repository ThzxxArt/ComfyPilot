import type { NodePackRecord } from '@shared/types'
import { PIP_RECIPES } from '@shared/pipRecipes'
import { bootMarkFirstList } from '../../services/bootTiming'
import { nodePackService } from '../../services/nodePack'
import { marketService } from '../../services/p1p2'
import { sanitizeId } from '../../services/security'
import { broadcastNotification, notifyPipResult, wrap } from '../context'
import { requireLocalInstanceId, requireLocalTarget, safeInstanceId } from '../trust'

export function createNodeHandlers() {
  return {
    list: wrap((instanceId?: string) => {
      bootMarkFirstList('node.list')
      return nodePackService.list(safeInstanceId(instanceId))
    }),
    refresh: wrap((instanceId?: string) => nodePackService.refresh(safeInstanceId(instanceId))),
    indexStatus: wrap(async () => {
      const { registryIndex } = await import('../../services/registryIndex')
      return registryIndex.status()
    }),
    refreshIndex: wrap(async () => {
      const { registryIndex } = await import('../../services/registryIndex')
      return registryIndex.ensure({ force: true })
    }),
    ensureIndex: wrap(async (opts?: { force?: boolean }) => {
      const { registryIndex } = await import('../../services/registryIndex')
      return registryIndex.ensure({ force: Boolean(opts?.force) })
    }),
    opsList: wrap(async () => {
      const { operationRegistry } = await import('../../services/ops')
      return operationRegistry.list()
    }),
    opsCancel: wrap(async (id: string) => {
      const { operationRegistry } = await import('../../services/ops')
      return operationRegistry.cancel(String(id))
    }),
    cancelIndex: wrap(async () => {
      const { registryIndex } = await import('../../services/registryIndex')
      return registryIndex.cancelBuild()
    }),
    managerChannel: wrap(() => nodePackService.managerChannelList()),
    install: wrap(
      async (opts: {
        id: string
        version?: string
        source: 'registry' | 'git' | 'manager'
        url?: string
        branch?: string
        instanceId?: string
      }) => {
        const rec = await nodePackService.install({
          ...opts,
          instanceId: requireLocalTarget(opts.instanceId)
        })
        const depsFailed = rec.issues?.some((i) => i.code === 'pip-failed')
        broadcastNotification({
          type: depsFailed ? 'warning' : 'success',
          title: depsFailed ? 'Node pack installed with dependency errors' : 'Node pack installed',
          titleKey: depsFailed ? 'notify.nodeInstalledDepsFailed' : 'notify.nodeInstalled',
          message: `${rec.displayName || rec.name || opts.id} (${rec.version || '?'})`,
          duration: depsFailed ? 9000 : 5000,
          dedupeKey: `node-install:${rec.id || opts.id}`
        })
        // Nodes only load at ComfyUI startup — remind the user to restart.
        broadcastNotification({
          type: 'info',
          title: 'Restart required',
          titleKey: 'notify.restartRequired',
          message: 'Restart the instance for the new node pack to take effect.',
          duration: 8000
        })
        return rec
      }
    ),
    uninstall: wrap(async (id: string, instanceId?: string, opts?: { removePipDeps?: boolean }) => {
      const ok = await nodePackService.uninstall(id, requireLocalTarget(instanceId), opts)
      if (ok) {
        broadcastNotification({
          type: 'success',
          title: 'Node pack uninstalled',
          titleKey: 'notify.nodeUninstalled',
          message: id,
          duration: 5000
        })
      }
      return ok
    }),
    uninstallDeps: wrap((id: string, instanceId?: string) =>
      nodePackService.pipDeps(id, requireLocalTarget(instanceId))
    ),
    cancelOp: wrap((instanceId?: string) =>
      nodePackService.cancelOp(requireLocalTarget(instanceId))
    ),
    cancelBatch: wrap((instanceId?: string) =>
      nodePackService.cancelUpdateBatch(requireLocalTarget(instanceId))
    ),
    update: wrap(async (id: string, version?: string, instanceId?: string) => {
      const rec = await nodePackService.update(id, version, requireLocalTarget(instanceId))
      const depsFailed = rec.issues?.some((i) => i.code === 'pip-failed')
      broadcastNotification({
        type: depsFailed ? 'warning' : 'success',
        title: depsFailed ? 'Node pack updated with dependency errors' : 'Node pack updated',
        titleKey: depsFailed ? 'notify.nodeUpdatedDepsFailed' : 'notify.nodeUpdated',
        message: `${rec.displayName || rec.name || id} (${rec.version || '?'})`,
        duration: depsFailed ? 9000 : 5000,
        dedupeKey: `node-update:${rec.id || id}`
      })
      return rec
    }),
    toggle: wrap((id: string, enabled: boolean, instanceId?: string) =>
      nodePackService.toggle(id, enabled, requireLocalTarget(instanceId))
    ),
    lock: wrap((id: string, locked: boolean, instanceId?: string) =>
      nodePackService.lock(id, locked, requireLocalTarget(instanceId))
    ),
    checkIssues: wrap((id: string, instanceId?: string) =>
      nodePackService.checkIssues(id, requireLocalTarget(instanceId))
    ),
    loadReport: wrap((instanceId?: string) =>
      nodePackService.loadReport(safeInstanceId(instanceId))
    ),
    opStatus: wrap((instanceId?: string) =>
      nodePackService.getOpProgress(safeInstanceId(instanceId))
    ),
    recoveryScan: wrap((instanceId?: string) =>
      nodePackService.scanRecovery(requireLocalTarget(instanceId))
    ),
    recoveryRestore: wrap((name: string, instanceId?: string) =>
      nodePackService.restoreRecovery(name, requireLocalTarget(instanceId))
    ),
    recoveryClean: wrap((name: string, instanceId?: string) =>
      nodePackService.cleanRecovery(name, requireLocalTarget(instanceId))
    ),
    recoveryCleanAll: wrap((instanceId?: string) =>
      nodePackService.cleanAllRecovery(requireLocalTarget(instanceId))
    ),
    depsAudit: wrap((instanceId?: string) =>
      nodePackService.depsAudit(requireLocalInstanceId(instanceId))
    ),
    installDeps: wrap(async (id: string, instanceId?: string, specs?: string[]) => {
      // Requirements installs mutate THIS machine's venv — remote targets are
      // refused with a coded error (see requireLocalInstanceId, 0.1.13).
      const result = await nodePackService.installDeps(
        id,
        requireLocalTarget(instanceId),
        Array.isArray(specs) ? specs : undefined
      )
      notifyPipResult(result)
      return result
    }),
    conflicts: wrap((instanceId?: string) => nodePackService.conflicts(safeInstanceId(instanceId))),
    smokeTest: wrap((id: string, instanceId?: string) =>
      nodePackService.smokeTest(id, requireLocalTarget(instanceId))
    ),
    snapshots: wrap((instanceId?: string) => nodePackService.snapshots(safeInstanceId(instanceId))),
    createSnapshot: wrap((name?: string, instanceId?: string) =>
      nodePackService.createSnapshot(name, requireLocalTarget(instanceId))
    ),
    deleteSnapshot: wrap((id: string, instanceId?: string) =>
      nodePackService.deleteSnapshot(sanitizeId(id), requireLocalTarget(instanceId))
    ),
    restoreSnapshot: wrap((id: string, instanceId?: string) =>
      nodePackService.restoreSnapshot(sanitizeId(id), requireLocalTarget(instanceId))
    ),
    checkUpdates: wrap((instanceId?: string) =>
      nodePackService.checkUpdates(requireLocalTarget(instanceId))
    ),
    updateAll: wrap(
      async (instanceId?: string, opts?: import('@shared/types').NodeUpdateAllOptions) => {
        const target = requireLocalTarget(instanceId)
        const results = await nodePackService.updateAll(target, opts)
        if (results.length) {
          const ok = results.filter((r) => r.ok && !r.skipped).length
          const fail = results.filter((r) => !r.ok && !r.skipped).length
          broadcastNotification({
            type: fail ? 'warning' : 'success',
            title: fail ? 'Node updates finished with errors' : 'Node updates complete',
            titleKey: fail ? 'notify.nodeBatchPartial' : 'notify.nodeBatchDone',
            message: `${ok} updated, ${fail} failed`,
            messageKey: 'notify.nodeBatchMsg',
            params: { ok, fail },
            duration: 7000,
            // One summary for the whole batch — the per-pack notifications were
            // the source of the "all unread popped at once" storm.
            dedupeKey: `node-update-all:${target}`
          })
        }
        return results
      }
    ),

    depsRecipes: wrap(() => PIP_RECIPES),

    // market
    marketList: wrap(
      (opts?: {
        query?: string
        category?: string
        limit?: number
        page?: number
        instanceId?: string
      }) => marketService.list({ ...opts, instanceId: safeInstanceId(opts?.instanceId) })
    ),
    marketInstall: wrap(
      async (opts: {
        id: string
        version?: string
        repository?: string
        instanceId?: string
      }): Promise<NodePackRecord> => {
        const rec = await nodePackService.install({
          id: opts.id,
          version: opts.version,
          source: 'registry',
          repository: opts.repository,
          // 0.1.18 (regression): market.install used the unchecked sanitizer,
          // so the same button enforced the target differently per tab.
          instanceId: requireLocalTarget(opts.instanceId)
        })
        broadcastNotification({
          type: 'success',
          title: 'Node pack installed',
          titleKey: 'notify.nodeInstalled',
          message: `${rec.displayName || rec.name || opts.id} (${rec.version || '?'})`,
          duration: 5000,
          dedupeKey: `node-install:${rec.id || opts.id}`
        })
        return rec
      }
    )
  }
}
