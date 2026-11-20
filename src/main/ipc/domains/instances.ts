import { existsSync, statSync } from 'fs'
import { join } from 'path'
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
import { pathCapabilities } from '../../services/pathCapability'

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

/** IPv4/IPv6 literals only; wildcard/loopback/private-LAN ranges. */
function isAllowedListenHost(raw: string): boolean {
  const host = raw.trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) return false
  if (host === '0.0.0.0' || host === '::' || host === '*') return true
  if (host === '::1') return true
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false
    if (a === 127) return true
    if (a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT/Tailscale
    return false
  }
  // IPv6 literal heuristics: loopback, ULA (fc00::/7) and link-local.
  if (!host.includes(':')) return false
  if (host.startsWith('fc') || host.startsWith('fd')) return true
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb'))
    return true
  return false
}

const LAUNCH_PROFILE_DIR_KEYS = [
  'baseDirectory',
  'userDirectory',
  'modelsDirectory',
  'outputDirectory',
  'inputDirectory',
  'tempDirectory',
  'previewsDirectory'
] as const

const PATH_VALUED_FLAGS = new Set([
  '--extra-model-paths-config',
  '--base-directory',
  '--user-directory',
  '--models-directory',
  '--output-directory',
  '--input-directory',
  '--temp-directory',
  '--previews-directory',
  '--front-end-root',
  '--database-url',
  '--tls-keyfile',
  '--tls-certfile',
  '--whitelist-custom-nodes'
])

/**
 * 0.2.5 WP10 / S3: launchProfile paths, listen and port are launch-time
 * primitives. Every path must stay inside the instance root or a picked root;
 * listen must be a literal loopback/wildcard/private address.
 */
function assertSafeLaunchConfig(config: ComfyInstanceConfig): void {
  const port = Number(config.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Instance port must be an integer between 1 and 65535')
  }
  const listen = String(config.listen || '127.0.0.1')
  for (const addr of listen.split(',')) {
    if (!isAllowedListenHost(addr)) {
      throw new Error(`Instance listen address is not a local/LAN literal: ${addr.trim()}`)
    }
  }
  const roots = [config.path, ...pathCapabilities.rootsFor('write')]
  const profile = config.launchProfile || {}
  for (const key of LAUNCH_PROFILE_DIR_KEYS) {
    const value = profile[key]
    if (!value) continue
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
      throw new Error(`launchProfile.${key} is not a valid path`)
    }
    if (value.split(/[\\/]+/).includes('..')) {
      throw new Error(`launchProfile.${key} must not contain '..'`)
    }
    const abs = value.match(/^[a-zA-Z]:[\\/]|^\//) ? value : join(config.path, value)
    if (!resolveInsideAnyRoot(abs, roots)) {
      throw new Error(`launchProfile.${key} is outside the instance and picked roots`)
    }
  }
  const extra = Array.isArray(config.extraArgs) ? config.extraArgs : []
  if (extra.length > 500) throw new Error('extraArgs is unreasonably long')
  for (let i = 0; i < extra.length; i++) {
    const token = String(extra[i] ?? '')
    if (/[\0\r\n]/.test(token)) throw new Error('extraArgs contains a control character')
    const eq = token.indexOf('=')
    const flag = eq > 2 ? token.slice(0, eq) : token
    let value = eq > 2 ? token.slice(eq + 1) : undefined
    if (!PATH_VALUED_FLAGS.has(flag)) continue
    if (value === undefined) {
      const next = extra[i + 1]
      if (next && !String(next).startsWith('--')) value = String(next)
    }
    if (!value) continue
    if (/[\\/]\.\.[\\/]|^\.\.$/.test(value)) throw new Error(`extraArgs ${flag} must not contain '..'`)
    const abs = value.match(/^[a-zA-Z]:[\\/]|^\//) ? value : join(config.path, value)
    if (!resolveInsideAnyRoot(abs, roots)) {
      throw new Error(`extraArgs ${flag} points outside the instance and picked roots`)
    }
  }
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
    discover: wrap((root?: string) => {
      const found = instanceService.discover(root)
      // A discovery result is a trusted proposal: issue a write capability so a
      // subsequent instance.save can accept exactly these paths.
      for (const c of found) {
        try {
          pathCapabilities.issue(c.path, 'write', 'discovery')
          pathCapabilities.issue(c.path, 'read', 'discovery')
          pathCapabilities.issue(c.path, 'exec', 'discovery')
        } catch {
          /* skip invalid */
        }
      }
      return found
    }),
    save: wrap((config: ComfyInstanceConfig) => {
      if (!config || typeof config !== 'object') throw new Error('Invalid instance config')
      if (!config.path || !existsSync(config.path)) throw new Error('Instance path does not exist')
      if (!statSync(config.path).isDirectory()) throw new Error('Instance path must be a directory')
      assertApprovedInstancePath(config.path, config.id || undefined)
      if (config.pythonPath) assertApprovedExecutable(config.pythonPath, 'pythonPath', config.path)
      assertApprovedVenvPath(config.venvPath, config.path)
      assertSafeLaunchConfig(config)
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
    patch: wrap((id: string, partial: Partial<ComfyInstanceConfig>) => {
      const safeId = sanitizeId(id)
      const existing = instanceService.list().find((i) => i.id === safeId)
      if (!existing) throw new Error(`Instance not found: ${safeId}`)
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        throw new Error('instance.patch expects an object')
      }
      const merged = { ...existing, ...partial } as ComfyInstanceConfig
      assertSafeLaunchConfig(merged)
      return instanceService.patch(safeId, partial)
    }),
    setPort: wrap((id: string, port: number) => {
      const safeId = sanitizeId(id)
      const existing = instanceService.list().find((i) => i.id === safeId)
      if (!existing) throw new Error(`Instance not found: ${safeId}`)
      assertSafeLaunchConfig({ ...existing, port } as ComfyInstanceConfig)
      // Only the port changes — migration/version fields stay intact.
      return instanceService.patch(safeId, { port })
    }),
    health: wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      const { instanceHealthService } = await import('../../services/instance/health')
      return instanceHealthService.get(safeId) ?? (await instanceHealthService.check(safeId))
    }),
    checkHealth: wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      const { instanceHealthService } = await import('../../services/instance/health')
      return instanceHealthService.check(safeId)
    }),
    rescue: wrap(async (id: string, opts?: { safe?: boolean }) => {
      const { executeControlCommand } = await import('../../control')
      return executeControlCommand({
        action: opts?.safe ? 'safe-rescue' : 'rescue',
        instanceId: sanitizeId(id)
      })
    }),
    exportRescueScript: wrap(async (id: string) => {
      const { exportRescueScript } = await import('../../control')
      return exportRescueScript(sanitizeId(id))
    }),
    managerInfo: wrap(async (id: string) => {
      const { managerInfoForId } = await import('../../services/manager')
      return managerInfoForId(sanitizeId(id))
    }),
    setManagerSecurity: wrap(async (id: string, level: import('@shared/types').ManagerSecurityLevel) => {
      const safeId = sanitizeId(id)
      const { setManagerSecurityLevel } = await import('../../services/manager')
      const cfg = loadInstanceConfigs().find((c) => c.id === safeId)
      if (!cfg) throw new Error(`Instance not found: ${safeId}`)
      return setManagerSecurityLevel(cfg, level)
    }),
    openManagerConfig: wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      const { managerInfoForId } = await import('../../services/manager')
      const info = await managerInfoForId(safeId)
      if (!info.configPath || !existsSync(info.configPath)) {
        throw new Error('Manager config.ini does not exist yet')
      }
      shell.showItemInFolder(info.configPath)
      return { path: info.configPath }
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
