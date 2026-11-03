import { existsSync, statSync } from 'fs'
import { clipboard, shell } from 'electron'
import type {
  ComfyInstanceConfig,
  EnvCreateRequest,
  InstallPlan,
  LaunchOptions
} from '@shared/types'
import { bootstrapService } from '../../services/bootstrap'
import { loadInstanceConfigs, loadSettings } from '../../services/db'
import { envService } from '../../services/env'
import { execDiagnosticsService } from '../../services/execDiagnostics'
import { instanceService } from '../../services/instance'
import { installerService, listStarterModels } from '../../services/installer'
import {
  assertSafeEndpointSetting,
  isSafeExternalUrl,
  normalizeForCompare,
  resolveInsideAnyRoot,
  sanitizeId
} from '../../services/security'
import {
  approveReadPath,
  assertApprovedExecutable,
  assertApprovedInstallRoot,
  assertApprovedVenvBase,
  assertApprovedVenvPath,
  broadcastNotification,
  collectRevealRoots,
  notifyPipResult,
  openEmbedInternal,
  wrap,
  type IpcContext
} from '../context'
import { requireLocalInstanceId, safeInstanceId, safeInstanceTarget } from '../trust'

/** ComfyUI locations the discovery flow is allowed to find. */
function discoveredComfyRoots(): string[] {
  return [
    process.env.COMFYUI_PATH,
    'D:\\ComfyUI',
    'C:\\ComfyUI',
    'D:\\AI\\ComfyUI',
    ...(loadSettings().modelScanRoots || [])
  ].filter(Boolean) as string[]
}

/**
 * An instance path is a launch target (`<path>/main.py`). Do not let a
 * renderer register an arbitrary directory it can write to (e.g. via a model
 * download) and then execute a script from it. Home/userData, a directory
 * chosen in the OS picker, the known discovery roots, or the instance's own
 * existing path are accepted.
 */
function assertApprovedInstancePath(path: string, id?: string): void {
  const existing = id ? loadInstanceConfigs().find((c) => c.id === id) : undefined
  if (existing && normalizeForCompare(existing.path) === normalizeForCompare(path)) return
  try {
    assertApprovedInstallRoot(path)
    return
  } catch {
    /* fall through to the discovery allow-list */
  }
  if (resolveInsideAnyRoot(path, discoveredComfyRoots())) return
  throw new Error(
    'Instance path must be inside home, a known ComfyUI location, or chosen with the picker'
  )
}

export function createInstanceHandlers(ctx: IpcContext) {
  return {
    list: wrap(() => instanceService.list()),
    discover: wrap((root?: string) => instanceService.discover(root)),
    save: wrap((config: ComfyInstanceConfig) => {
      if (!config || typeof config !== 'object') throw new Error('Invalid instance config')
      if (!config.path || !existsSync(config.path)) throw new Error('Instance path does not exist')
      if (!statSync(config.path).isDirectory()) throw new Error('Instance path must be a directory')
      assertApprovedInstancePath(config.path, config.id || undefined)
      if (config.pythonPath) assertApprovedExecutable(config.pythonPath, 'pythonPath', config.path)
      assertApprovedVenvPath(config.venvPath, config.path)
      return instanceService.save({ ...config, id: config.id ? sanitizeId(config.id) : '' })
    }),
    migratePython: wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      const info = instanceService.list().find((i) => i.id === safeId)
      if (!info) throw new Error(`Instance not found: ${safeId}`)
      if (info.status === 'running' || info.status === 'starting') {
        await instanceService.stop(safeId)
      }
      const { migrateInstancePython } = await import('../../services/pythonMigration')
      return migrateInstancePython(safeId)
    }),
    remove: wrap((id: string) => instanceService.remove(sanitizeId(id))),
    launch: wrap(async (id: string, opts?: LaunchOptions) => {
      const safeId = sanitizeId(id)
      const info = await instanceService.launch(safeId, opts)
      const open = opts?.open ?? 'none'
      if (open === 'embed' || open === 'browser') {
        if (!info.url) throw new Error('Instance has no URL')
        if (open === 'browser') {
          if (!isSafeExternalUrl(info.url)) throw new Error('Blocked unsafe URL')
          await shell.openExternal(info.url)
        } else {
          await openEmbedInternal(ctx, info.url, info.name)
        }
      }
      return info
    }),
    launchArgCatalog: wrap(async (instanceId?: string) => {
      const { launchArgCatalog } = await import('../../services/launchArgCatalog')
      return launchArgCatalog(safeInstanceId(instanceId))
    }),
    previewLaunch: wrap((id: string) => instanceService.previewLaunch(sanitizeId(id))),
    stop: wrap((id: string) => instanceService.stop(sanitizeId(id))),
    restart: wrap((id: string, opts?: LaunchOptions) =>
      instanceService.restart(sanitizeId(id), opts)
    ),
    forceKill: wrap((id: string) => instanceService.forceKill(sanitizeId(id))),
    // 0.1.17 (WP3): manual orphan sweep (also runs at startup).
    sweepStale: wrap(() => instanceService.sweepStaleProcesses()),
    startAll: wrap(() => instanceService.startAll()),
    stopAll: wrap(() => instanceService.stopAll()),
    getLogs: wrap((id: string, limit?: number) => instanceService.getLogs(sanitizeId(id), limit)),
    clearLogs: wrap((id: string) => instanceService.clearLogs(sanitizeId(id))),
    checkPort: wrap((port: number) => instanceService.checkPort(port)),
    suggestPort: wrap(() => instanceService.suggestPort()),
    probeEnv: wrap((id: string) => instanceService.probeEnv(sanitizeId(id))),
    exportDiagnostics: wrap((id: string) => instanceService.exportDiagnostics(sanitizeId(id))),
    copyDiagnostics: wrap(async (id: string) => {
      const path = await instanceService.copyDiagnostics(sanitizeId(id))
      clipboard.writeText(path)
      return path
    }),
    exportLogs: wrap(async (id: string) => {
      const result = await instanceService.exportLogs(sanitizeId(id))
      shell.showItemInFolder(result.path)
      return result
    }),
    // 0.1.17 (WP4): an update that died mid-run leaves a journal + backup.
    updateJournal: wrap(async (id: string) => {
      const { comfyUpdaterService } = await import('../../services/updater')
      return comfyUpdaterService.readJournal(sanitizeId(id))
    }),
    rollbackUpdate: wrap(async (id: string) => {
      const { comfyUpdaterService } = await import('../../services/updater')
      const safeId = sanitizeId(id)
      const ok = await comfyUpdaterService.rollbackFromJournal(safeId)
      if (ok) {
        broadcastNotification({
          type: 'success',
          title: 'Update rolled back',
          titleKey: 'notify.updateRolledBack',
          message: 'Core files restored from the pre-update backup',
          messageKey: 'notify.updateRolledBackMsg',
          duration: 6000
        })
      }
      return ok
    }),
    checkComfyUpdate: wrap(async (id: string) => {
      const { comfyUpdaterService } = await import('../../services/updater')
      return comfyUpdaterService.check(sanitizeId(id))
    }),
    updateComfy: wrap(async (id: string, opts?: import('@shared/types').ComfyUpdateOptions) => {
      const { comfyUpdaterService } = await import('../../services/updater')
      const safeId = sanitizeId(id)
      // start() is fire-and-forget (events stream interim progress); we wait here
      // so `await ipc('instance.updateComfy')` resolves only when the run settles.
      const initial = await comfyUpdaterService.start(safeId, opts)
      const final = await comfyUpdaterService.waitUntilSettled()
      const result = final || initial
      // Invalidate version cache so list() shows the post-update version.
      try {
        const configs = loadInstanceConfigs()
        const cfg = configs.find((c) => c.id === safeId)
        if (cfg?.path) instanceService.invalidateVersionCache(cfg.path)
        else instanceService.invalidateVersionCache()
      } catch {
        /* ignore */
      }
      return result
    }),
    updateStatus: wrap(async () => {
      const { comfyUpdaterService } = await import('../../services/updater')
      return comfyUpdaterService.getStatus()
    }),
    cancelUpdate: wrap(async () => {
      const { comfyUpdaterService } = await import('../../services/updater')
      return comfyUpdaterService.cancel()
    }),
    repairStatus: wrap(() => envService.getRepairProgress()),
    repairEnv: wrap(async (id: string, opts?: import('@shared/types').RepairEnvOptions) => {
      // One repair at a time: envService owns the abort controller (WP5).
      const probe = await envService.repairEnv({
        instanceId: sanitizeId(id),
        torchChannel: opts?.torchChannel,
        recreateVenv: opts?.recreateVenv
      })
      try {
        const configs = loadInstanceConfigs()
        const cfg = configs.find((c) => c.id === sanitizeId(id))
        if (cfg?.path) instanceService.invalidateVersionCache(cfg.path)
      } catch {
        /* ignore */
      }
      return probe
    }),
    repairCancel: wrap(() => envService.cancelRepair()),
    capabilities: wrap((id: string) => instanceService.getCapabilities(sanitizeId(id))),
    runStartupSelfCheck: wrap((id: string) => instanceService.runStartupSelfCheck(sanitizeId(id))),
    // ---- 0.1.12: dependency-fix actions + runtime failure diagnosis ----
    pipInstall: wrap(async (id: string, spec: string) => {
      const { pipOpsService } = await import('../../services/pipOps')
      const result = await pipOpsService.installSpec(
        requireLocalInstanceId(id) || '',
        String(spec || '')
      )
      notifyPipResult(result)
      return result
    }),
    applyRecipe: wrap(async (id: string, recipeId: string) => {
      const { pipOpsService } = await import('../../services/pipOps')
      const result = await pipOpsService.installRecipe(
        requireLocalInstanceId(id) || '',
        String(recipeId || '')
      )
      notifyPipResult(result)
      return result
    }),
    pipCancel: wrap(async (id: string) => {
      const target = requireLocalInstanceId(id)
      // Nothing to cancel for an absent/remote target — answer honestly.
      if (!target) return false
      const { pipOpsService } = await import('../../services/pipOps')
      return pipOpsService.cancel(target)
    }),
    pipStatus: wrap(async (instanceId?: string) => {
      // A pure status QUERY — unresolvable/remote targets answer "no op"
      // instead of throwing (0.1.13).
      const target = safeInstanceTarget(instanceId)
      if (!target || target.startsWith('remote:')) return null
      const { pipOpsService } = await import('../../services/pipOps')
      return pipOpsService.getProgress(target)
    }),
    execFailures: wrap((id: string) => execDiagnosticsService.list(safeInstanceTarget(id) || '')),
    clearExecFailures: wrap((id: string) =>
      execDiagnosticsService.clear(safeInstanceTarget(id) || '')
    ),
    startupIssues: wrap((id: string) => {
      const target = safeInstanceTarget(id)
      if (!target) throw new Error(`Instance not found: ${id}`)
      return instanceService.analyzeStartupIssues(target)
    }),

    // env
    probe: wrap((opts: { pythonPath: string; venvPath?: string }) => {
      if (opts?.pythonPath) assertApprovedExecutable(opts.pythonPath, 'pythonPath')
      return envService.probe(opts)
    }),
    createVenv: wrap((req: EnvCreateRequest) => {
      // A renderer-supplied basePath + interpreter is an arbitrary file-write
      // and process-execution primitive unless both are anchored to an
      // instance/home/picked directory.
      if (!req?.pythonPath) throw new Error('pythonPath is required')
      assertApprovedExecutable(req.pythonPath, 'pythonPath')
      assertApprovedVenvBase(req.basePath)
      if (req.torchIndex) assertSafeEndpointSetting('torchIndex', req.torchIndex)
      return envService.createVenv(req)
    }),
    listPythons: wrap(() => envService.listPythons()),
    installTorch: wrap((opts: { pythonPath: string; index: string }) => {
      if (!opts?.pythonPath) throw new Error('pythonPath is required')
      assertApprovedExecutable(opts.pythonPath, 'pythonPath')
      assertSafeEndpointSetting('torch index', opts.index)
      return envService.installTorch(opts)
    }),

    // installer
    detectGpu: wrap(() => installerService.detectGpu()),
    preflight: wrap(
      (opts: {
        installRoot: string
        useUv: boolean
        pythonPath?: string
        torchChannel?: string
      }) => {
        assertApprovedInstallRoot(opts.installRoot)
        if (opts.pythonPath)
          assertApprovedExecutable(opts.pythonPath, 'pythonPath', opts.installRoot)
        return installerService.preflight(opts as Parameters<typeof installerService.preflight>[0])
      }
    ),
    start: wrap((plan: InstallPlan) => {
      if (!plan || typeof plan !== 'object') throw new Error('Invalid install plan')
      assertApprovedInstallRoot(plan.installRoot)
      if (plan.pythonPath) assertApprovedExecutable(plan.pythonPath, 'pythonPath', plan.installRoot)
      return installerService.start(plan)
    }),
    status: wrap(() => installerService.getStatus()),
    cancel: wrap(() => installerService.cancel()),
    reset: wrap(() => {
      // 0.1.17 (WP1): user-facing escape hatch for a run stuck as "running"
      // (app killed mid-install). Clears the persisted snapshot only.
      installerService.reset()
      return true
    }),
    suggestInstallRoot: wrap(async () => {
      const suggested = await installerService.suggestInstallRoot()
      // 0.2.3: the suggested root is frequently on D:/E: (not under the user's
      // home) or under a not-yet-created folder. Approve exactly this path so
      // the following preflight/start gate accepts it without forcing a second
      // manual pick; an arbitrary renderer-supplied root still is not approved.
      approveReadPath(suggested.path)
      return suggested
    }),
    starterModels: wrap(() => listStarterModels()),
    installStarter: wrap((opts: { id: string; instanceId?: string }) =>
      installerService.installStarter(opts)
    ),

    // runtime bootstrap
    bootstrapStatus: wrap(() => bootstrapService.status()),
    bootstrapEnsure: wrap((opts?: { kinds?: string[]; downloadIfMissing?: boolean }) =>
      bootstrapService.ensure(opts as Parameters<typeof bootstrapService.ensure>[0])
    ),
    bootstrapDownload: wrap((kind: string) => bootstrapService.download(kind as never)),
    bootstrapDeleteLegacy: wrap(async () => {
      const { deleteLegacyPythonRuntimes } = await import('../../services/bootstrap')
      return deleteLegacyPythonRuntimes()
    }),

    // network probe → fastest mirrors
    recommendMirrors: wrap(async () => {
      const { recommendMirrors } = await import('../../services/netProbe')
      return recommendMirrors()
    }),

    // launch script export
    exportLaunchScript: wrap(async (id: string, opts?: { dir?: string; kind?: 'bat' | 'sh' }) => {
      const { instanceService } = await import('../../services/instance')
      // 0.1.17 (WP8): `dir` came from the renderer and was joined unchecked, so
      // a compromised renderer could drop a .bat into an autostart folder.
      // Only app-owned / reachable roots are honoured; anything else falls back
      // to the user-facing save dialog (which the UI always uses anyway).
      let dir = opts?.dir
      if (dir) {
        const allowed = resolveInsideAnyRoot(dir, await collectRevealRoots())
        if (!allowed) dir = undefined
      }
      return instanceService.exportLaunchScript(sanitizeId(id), { ...opts, dir })
    })
  }
}
