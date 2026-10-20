import { ipcMain, dialog, shell, BrowserWindow, WebContentsView, clipboard } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type {
  IpcResult,
  ComfyInstanceConfig,
  RemoteInstanceConfig,
  NodePackRecord,
  EnvCreateRequest,
  WorkflowRecord,
  AppSettings,
  InstallPlan,
  LaunchOptions,
  BatchJob
} from '@shared/types'
import { IPC_EVENTS } from '@shared/types'
import { mapPool } from '../services/workPool'
import { withPausedSlowOp } from '../services/slowOps'
import {
  isSafeExternalUrl,
  isSafeEmbedUrl,
  sanitizeId,
  isSafeOpenPath,
  isLocalhostUrl,
  resolveInsideAnyRoot,
  normalizeForCompare,
  isSafeDataReadPath,
  assertSafeEndpointSetting
} from '../services/security'
import {
  loadSettings,
  saveSettings,
  loadInstanceConfigs,
  userDataDir,
  workflowLibraryDir
} from '../services/db'
import { LAUNCH_TEMPLATES } from '@shared/constants'
import { instanceService } from '../services/instance'
import { modelService } from '../services/model'
import { nodePackService } from '../services/nodePack'
import { workflowService } from '../services/workflow'
import { monitorService } from '../services/monitor'
import { doctorService } from '../services/doctor'
import { bootstrapService } from '../services/bootstrap'
import { backupService } from '../services/backup'
import { envService } from '../services/env'
import {
  batchService,
  outputService,
  remoteService,
  marketService,
  resolveOutputDir
} from '../services/p1p2'
import { installerService, listStarterModels } from '../services/installer'
import { testProxy, syncProxyFromSettings } from '../services/proxy'
import { execDiagnosticsService } from '../services/execDiagnostics'
import { PIP_RECIPES } from '@shared/pipRecipes'
import { instrumentIpcHandle, setSlowOpListener, FREEZE_OP_MS } from '../services/slowOps'

function ok<T>(data: T): IpcResult<T> {
  // Structured-clone safety: never hand a class instance / Response / Proxy
  // back over IPC — reduce to plain JSON data first.
  return { ok: true, data: toPlainIpcData(data) }
}

function fail(error: unknown): IpcResult<never> {
  if (error && typeof error === 'object') {
    const e = error as Error & { code?: string; suggestedPort?: number }
    return {
      ok: false,
      error: e.message || String(error),
      code: typeof e.code === 'string' ? e.code : undefined,
      suggestedPort: typeof e.suggestedPort === 'number' ? e.suggestedPort : undefined
    }
  }
  return { ok: false, error: String(error) }
}

/** JSON round-trip keeps IPC payloads structured-clone safe. */
function toPlainIpcData<T>(data: T): T {
  if (data === undefined || data === null) return data
  const t = typeof data
  if (t === 'string' || t === 'number' || t === 'boolean') return data
  try {
    return JSON.parse(JSON.stringify(data)) as T
  } catch (e) {
    // Never hand a fake success with `data: null` — surface the serialisation
    // failure so the caller sees a real error.
    throw new Error(
      `IPC payload is not serialisable: ${e instanceof Error ? e.message : String(e)}`
    )
  }
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

/**
 * Renderer-supplied instance id. MUST be a sanitized opaque id — never a
 * filesystem path. nodePack.detectCustomNodesRoot accepts path-form input for
 * internal callers; allowing that from IPC would be a path-injection surface.
 */
function safeInstanceId(instanceId?: string): string | undefined {
  if (instanceId == null || instanceId === '') return undefined
  const raw = String(instanceId)
  if (raw.includes('/') || raw.includes('\\') || raw.includes('\0') || raw.includes('..')) {
    throw new Error('Invalid instance id')
  }
  return sanitizeId(raw)
}

/**
 * Instance target id or `remote:<id>` (0.1.11). sanitizeId would rewrite the
 * `:` separator, so the remote prefix is stripped, sanitized, and re-attached.
 */
function safeInstanceTarget(instanceId?: string): string | undefined {
  if (instanceId == null || instanceId === '') return undefined
  const raw = String(instanceId)
  if (raw.startsWith('remote:')) {
    const id = safeInstanceId(raw.slice('remote:'.length))
    return id ? `remote:${id}` : undefined
  }
  return safeInstanceId(raw)
}

/**
 * Package/environment channels only make sense for LOCAL instances (the venv
 * lives on this machine). Refuse `remote:*` targets with a coded, localizable
 * error instead of sanitizing them into a bogus id (`remote:x` → `remote_x`
 * used to surface as an inexplicable INSTANCE_NOT_FOUND — 0.1.13).
 */
function requireLocalInstanceId(instanceId?: string): string | undefined {
  const target = safeInstanceTarget(instanceId)
  if (target && target.startsWith('remote:')) {
    const e = new Error('Package operations are only available for local instances') as Error & {
      code?: string
    }
    e.code = 'REMOTE_NOT_SUPPORTED'
    throw e
  }
  return target
}

// Paths the user explicitly chose via the OS picker (0.1.16). A picked file is
// trusted as-is; a picked folder becomes a readable root for the session.
// Anything else must resolve under an app-owned root — the old implementation
// trusted ANY existing file with a data extension, i.e. the whole disk.
const approvedReadRoots = new Set<string>()

function approveReadPath(p: string | null | undefined): void {
  if (!p) return
  try {
    approvedReadRoots.add(normalizeForCompare(p))
  } catch {
    /* ignore */
  }
}

/** App-owned roots the renderer may read data files from. */
function allowedReadRoots(): string[] {
  const roots: string[] = []
  try {
    roots.push(userDataDir(), workflowLibraryDir())
  } catch {
    /* ignore */
  }
  for (const c of loadInstanceConfigs()) {
    if (!c.path) continue
    try {
      roots.push(c.path, resolveOutputDir(c), join(c.path, 'user', 'default', 'workflows'))
    } catch {
      /* malformed config — skip */
    }
  }
  for (const r of loadSettings().modelScanRoots || []) roots.push(r)
  return roots
}

/** Settings fields that must be http(s) URLs when set (0.1.17 WP8). */
const URL_SETTING_KEYS = [
  'githubEndpoint',
  'hfEndpoint',
  'civitaiEndpoint',
  'pipIndex',
  'torchIndexMirror'
] as const

function assertSafeEndpointSettings(patch: Partial<AppSettings>): void {
  for (const key of URL_SETTING_KEYS) {
    assertSafeEndpointSetting(key, (patch as Record<string, unknown>)[key])
  }
}

function isSafeReadPath(path: string): boolean {
  return isSafeDataReadPath(path, {
    approvedRoots: [...approvedReadRoots],
    allowedRoots: allowedReadRoots()
  })
}

let embedView: WebContentsView | null = null

/** Open (or replace) the embedded ComfyUI Frontend. Bounds come from renderer via embed.resize. */
async function openEmbedInternal(url: string, title?: string): Promise<boolean> {
  const win = getWindowRef()
  if (!win) return false
  if (!isAllowedEmbedUrl(url)) throw new Error('Blocked unsafe embed URL')
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
  // Temporary bounds until renderer sends embed.resize with the real layout.
  const bounds = win.getBounds()
  view.setBounds({
    x: 240,
    y: 64,
    width: Math.max(200, bounds.width - 240),
    height: Math.max(200, bounds.height - 64)
  })
  if (title) {
    try {
      view.webContents.once('page-title-updated', (e) => e.preventDefault())
    } catch {
      /* ignore */
    }
  }
  view.webContents.setWindowOpenHandler(({ url: navUrl }) => {
    if (isSafeExternalUrl(navUrl)) void shell.openExternal(navUrl)
    return { action: 'deny' }
  })
  view.webContents.on('will-navigate', (event, navUrl) => {
    if (!isAllowedEmbedUrl(navUrl)) {
      event.preventDefault()
    }
  })
  // 0.1.17 (WP9): report load failures to the renderer so the embed pane can
  // show an error + retry instead of a silent blank rectangle.
  view.webContents.on('did-finish-load', () => {
    broadcast(IPC_EVENTS.embedState, { state: 'ready', url })
  })
  view.webContents.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      broadcast(IPC_EVENTS.embedState, {
        state: 'failed',
        url,
        errorCode,
        errorDescription,
        validatedURL
      })
    }
  )
  void view.webContents.loadURL(url).catch((err: unknown) => {
    broadcast(IPC_EVENTS.embedState, {
      state: 'failed',
      url,
      errorDescription: err instanceof Error ? err.message : String(err)
    })
  })
  return true
}

/** Late-bound window getter so openEmbedInternal can run before registerIpcHandlers. */
let getWindowRef: () => BrowserWindow | null = () => null

/**
 * 0.1.17 (WP5): terminal-state notification for a batch run, shared by
 * start / resume / retryFailed so all three report the same way.
 */
function notifyBatchTerminal(result: {
  name: string
  status: string
  submitted: number
  completed: number
  produced: number
  failed: number
  errorSummary?: string
}): void {
  if (result.status === 'done') {
    broadcastNotification({
      type: 'success',
      title: `Batch done: ${result.name}`,
      titleKey: 'notify.batchDone',
      params: { name: result.name },
      message: `queued ${result.submitted} · ok ${result.completed} · produced ${result.produced} · failed ${result.failed}`
    })
  } else if (result.status === 'error') {
    broadcastNotification({
      type: 'error',
      title: `Batch failed: ${result.name}`,
      titleKey: 'notify.batchFailed',
      params: { name: result.name },
      message:
        result.errorSummary ||
        `queued ${result.submitted} · ok ${result.completed} · produced ${result.produced} · failed ${result.failed}`,
      duration: 8000
    })
  } else if (result.status === 'cancelled') {
    broadcastNotification({
      type: 'warning',
      title: `Batch cancelled: ${result.name}`,
      titleKey: 'notify.batchCancelled',
      params: { name: result.name },
      message: `queued ${result.submitted} · ok ${result.completed} · failed ${result.failed}`
    })
  }
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  getWindowRef = getWindow

  /** Require the batch job's backend to be live (local running / online remote). */
  async function requireBatchTarget(jobId: string): Promise<{ id: string; name: string }> {
    const job = batchService.list().find((j) => j.id === jobId)
    const targetId = String(job?.instanceId || '')
    if (targetId.startsWith('remote:')) {
      const status = await remoteService.test(targetId.slice('remote:'.length))
      if (!status.online) {
        throw new Error(`Remote instance is offline: ${status.error || targetId}`)
      }
    } else {
      await requireRunningInstance(targetId)
    }
    return { id: targetId, name: job?.name || jobId }
  }

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
  instrumentIpcHandle(
    ipcMain as unknown as {
      handle: (channel: string, listener: (...args: never[]) => unknown) => unknown
    }
  )

  // settings
  ipcMain.handle(
    'settings.get',
    wrap(() => loadSettings())
  )
  ipcMain.handle(
    'settings.set',
    wrap(async (patch: Partial<AppSettings>) => {
      // 0.1.17 (WP8): endpoint-shaped settings flow straight into installers and
      // network probes. Accepting `file:`/`javascript:`/garbage there turned a
      // settings write into a local-file or scheme-injection primitive.
      assertSafeEndpointSettings(patch)
      const next = saveSettings(patch)
      // Re-apply proxy whenever settings change
      syncProxyFromSettings()
      // Keep OS login item in sync with the persisted preference
      if (patch.launchOnBoot !== undefined) {
        try {
          const { setLaunchOnBoot } = await import('../services/desktop')
          setLaunchOnBoot(Boolean(next.launchOnBoot))
        } catch {
          /* ignore */
        }
      }
      // Language switch must re-render the native tray menu.
      if (patch.locale !== undefined) {
        try {
          const { refreshTray } = await import('../services/tray')
          void refreshTray()
        } catch {
          /* ignore */
        }
      }
      return next
    })
  )
  ipcMain.handle(
    'settings.launchTemplates',
    wrap(() => LAUNCH_TEMPLATES)
  )
  ipcMain.handle(
    'settings.dataDir',
    wrap(async () => {
      const { userDataDir } = await import('../services/db')
      return userDataDir()
    })
  )
  ipcMain.handle(
    'settings.logsDir',
    wrap(async () => {
      const { logsDir } = await import('../services/db')
      return logsDir()
    })
  )
  ipcMain.handle(
    'proxy.apply',
    wrap(() => syncProxyFromSettings())
  )
  ipcMain.handle(
    'proxy.test',
    wrap((opts?: { url?: string }) => testProxy(opts))
  )

  // instances
  ipcMain.handle(
    'instance.list',
    wrap(() => instanceService.list())
  )
  ipcMain.handle(
    'instance.discover',
    wrap((root?: string) => instanceService.discover(root))
  )
  ipcMain.handle(
    'instance.save',
    wrap((config: ComfyInstanceConfig) =>
      instanceService.save({ ...config, id: config.id ? sanitizeId(config.id) : '' })
    )
  )
  ipcMain.handle(
    'instance.remove',
    wrap((id: string) => instanceService.remove(sanitizeId(id)))
  )
  ipcMain.handle(
    'instance.launch',
    wrap(async (id: string, opts?: LaunchOptions) => {
      const safeId = sanitizeId(id)
      const info = await instanceService.launch(safeId, opts)
      const open = opts?.open ?? 'none'
      if (open === 'embed' || open === 'browser') {
        if (!info.url) throw new Error('Instance has no URL')
        if (open === 'browser') {
          if (!isSafeExternalUrl(info.url)) throw new Error('Blocked unsafe URL')
          await shell.openExternal(info.url)
        } else {
          await openEmbedInternal(info.url, info.name)
        }
      }
      return info
    })
  )
  ipcMain.handle(
    'instance.previewLaunch',
    wrap((id: string) => instanceService.previewLaunch(sanitizeId(id)))
  )
  ipcMain.handle(
    'instance.stop',
    wrap((id: string) => instanceService.stop(sanitizeId(id)))
  )
  ipcMain.handle(
    'instance.restart',
    wrap((id: string, opts?: LaunchOptions) => instanceService.restart(sanitizeId(id), opts))
  )
  ipcMain.handle(
    'instance.forceKill',
    wrap((id: string) => instanceService.forceKill(sanitizeId(id)))
  )
  // 0.1.17 (WP3): manual orphan sweep (also runs at startup).
  ipcMain.handle(
    'instance.sweepStale',
    wrap(() => instanceService.sweepStaleProcesses())
  )
  ipcMain.handle(
    'instance.startAll',
    wrap(() => instanceService.startAll())
  )
  ipcMain.handle(
    'instance.stopAll',
    wrap(() => instanceService.stopAll())
  )
  ipcMain.handle(
    'instance.getLogs',
    wrap((id: string, limit?: number) => instanceService.getLogs(sanitizeId(id), limit))
  )
  ipcMain.handle(
    'instance.clearLogs',
    wrap((id: string) => instanceService.clearLogs(sanitizeId(id)))
  )
  ipcMain.handle(
    'instance.checkPort',
    wrap((port: number) => instanceService.checkPort(port))
  )
  ipcMain.handle(
    'instance.suggestPort',
    wrap(() => instanceService.suggestPort())
  )
  ipcMain.handle(
    'instance.probeEnv',
    wrap((id: string) => instanceService.probeEnv(sanitizeId(id)))
  )
  ipcMain.handle(
    'instance.exportDiagnostics',
    wrap((id: string) => instanceService.exportDiagnostics(sanitizeId(id)))
  )
  ipcMain.handle(
    'instance.copyDiagnostics',
    wrap(async (id: string) => {
      const path = await instanceService.copyDiagnostics(sanitizeId(id))
      clipboard.writeText(path)
      return path
    })
  )
  ipcMain.handle(
    'instance.exportLogs',
    wrap(async (id: string) => {
      const result = await instanceService.exportLogs(sanitizeId(id))
      shell.showItemInFolder(result.path)
      return result
    })
  )
  // 0.1.17 (WP4): an update that died mid-run leaves a journal + backup.
  ipcMain.handle(
    'instance.updateJournal',
    wrap(async (id: string) => {
      const { comfyUpdaterService } = await import('../services/updater')
      return comfyUpdaterService.readJournal(sanitizeId(id))
    })
  )
  ipcMain.handle(
    'instance.rollbackUpdate',
    wrap(async (id: string) => {
      const { comfyUpdaterService } = await import('../services/updater')
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
    })
  )
  ipcMain.handle(
    'instance.checkComfyUpdate',
    wrap(async (id: string) => {
      const { comfyUpdaterService } = await import('../services/updater')
      return comfyUpdaterService.check(sanitizeId(id))
    })
  )
  ipcMain.handle(
    'instance.updateComfy',
    wrap(async (id: string, opts?: import('@shared/types').ComfyUpdateOptions) => {
      const { comfyUpdaterService } = await import('../services/updater')
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
    })
  )
  ipcMain.handle(
    'instance.updateStatus',
    wrap(async () => {
      const { comfyUpdaterService } = await import('../services/updater')
      return comfyUpdaterService.getStatus()
    })
  )
  ipcMain.handle(
    'instance.cancelUpdate',
    wrap(async () => {
      const { comfyUpdaterService } = await import('../services/updater')
      return comfyUpdaterService.cancel()
    })
  )
  ipcMain.handle(
    'instance.repairStatus',
    wrap(() => envService.getRepairProgress())
  )
  ipcMain.handle(
    'instance.repairEnv',
    wrap(async (id: string, opts?: import('@shared/types').RepairEnvOptions) => {
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
    })
  )
  ipcMain.handle(
    'instance.capabilities',
    wrap((id: string) => instanceService.getCapabilities(sanitizeId(id)))
  )
  ipcMain.handle(
    'instance.runStartupSelfCheck',
    wrap((id: string) => instanceService.runStartupSelfCheck(sanitizeId(id)))
  )
  // ---- 0.1.12: dependency-fix actions + runtime failure diagnosis ----
  ipcMain.handle(
    'instance.pipInstall',
    wrap(async (id: string, spec: string) => {
      const { pipOpsService } = await import('../services/pipOps')
      const result = await pipOpsService.installSpec(
        requireLocalInstanceId(id) || '',
        String(spec || '')
      )
      notifyPipResult(result)
      return result
    })
  )
  ipcMain.handle(
    'instance.applyRecipe',
    wrap(async (id: string, recipeId: string) => {
      const { pipOpsService } = await import('../services/pipOps')
      const result = await pipOpsService.installRecipe(
        requireLocalInstanceId(id) || '',
        String(recipeId || '')
      )
      notifyPipResult(result)
      return result
    })
  )
  ipcMain.handle(
    'instance.pipCancel',
    wrap(async (id: string) => {
      const target = requireLocalInstanceId(id)
      // Nothing to cancel for an absent/remote target — answer honestly.
      if (!target) return false
      const { pipOpsService } = await import('../services/pipOps')
      return pipOpsService.cancel(target)
    })
  )
  ipcMain.handle(
    'instance.pipStatus',
    wrap(async (instanceId?: string) => {
      // A pure status QUERY — unresolvable/remote targets answer "no op"
      // instead of throwing (0.1.13).
      const target = safeInstanceTarget(instanceId)
      if (!target || target.startsWith('remote:')) return null
      const { pipOpsService } = await import('../services/pipOps')
      return pipOpsService.getProgress(target)
    })
  )
  ipcMain.handle(
    'instance.execFailures',
    wrap((id: string) => execDiagnosticsService.list(safeInstanceTarget(id) || ''))
  )
  ipcMain.handle(
    'instance.clearExecFailures',
    wrap((id: string) => execDiagnosticsService.clear(safeInstanceTarget(id) || ''))
  )
  ipcMain.handle(
    'instance.startupIssues',
    wrap((id: string) => {
      const target = safeInstanceTarget(id)
      if (!target) throw new Error(`Instance not found: ${id}`)
      return instanceService.analyzeStartupIssues(target)
    })
  )

  // models
  ipcMain.handle(
    'model.list',
    wrap(async () => {
      const { thumbnailDisplayUrl } = await import('../services/media')
      const list = await modelService.list()
      return list.map((m) => ({
        ...m,
        thumbnail: thumbnailDisplayUrl(m.thumbnail) || undefined
      }))
    })
  )
  ipcMain.handle(
    'model.scan',
    wrap((opts?: { roots?: string[]; hash?: boolean }) => modelService.scan(opts))
  )
  ipcMain.handle(
    'model.delete',
    wrap((id: string, deleteFile: boolean) => modelService.remove(id, deleteFile))
  )
  ipcMain.handle(
    'model.move',
    wrap((id: string, destDir: string) => modelService.move(id, destDir))
  )
  ipcMain.handle(
    'model.symlink',
    wrap((id: string, destDir: string) => modelService.symlink(id, destDir))
  )
  ipcMain.handle(
    'model.rename',
    wrap((id: string, name: string) => modelService.rename(id, name))
  )
  ipcMain.handle(
    'model.tag',
    wrap((id: string, tags: string[]) => modelService.tag(id, tags))
  )
  ipcMain.handle(
    'model.findDuplicates',
    wrap(() => modelService.findDuplicates())
  )
  ipcMain.handle(
    'model.downloads',
    wrap(() => modelService.listDownloads())
  )
  ipcMain.handle(
    'model.download',
    wrap((opts: { url: string; destDir?: string; fileName?: string }) =>
      modelService.download(opts)
    )
  )
  ipcMain.handle(
    'model.pauseDownload',
    wrap((id: string) => modelService.pauseDownload(id))
  )
  ipcMain.handle(
    'model.resumeDownload',
    wrap((id: string) => modelService.resumeDownload(id))
  )
  ipcMain.handle(
    'model.cancelDownload',
    wrap((id: string) => modelService.cancelDownload(id))
  )
  ipcMain.handle(
    'model.clearFinishedDownloads',
    wrap(() => modelService.clearFinishedDownloads())
  )
  // Terminal download results surface as global toasts (ModelsView may be unmounted).
  modelService.on('notify', (n) =>
    broadcastNotification(n as Parameters<typeof broadcastNotification>[0])
  )
  ipcMain.handle(
    'model.storageStats',
    wrap(() => modelService.storageStats())
  )
  ipcMain.handle(
    'model.parseExtraPaths',
    wrap((file?: string) => import('../services/model').then((m) => m.parseExtraModelPaths(file)))
  )
  ipcMain.handle(
    'model.reconcile',
    wrap((instanceId?: string) => modelService.reconcile(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'model.fetchCivitaiMeta',
    wrap((id: string) => modelService.fetchCivitaiMeta(id))
  )
  ipcMain.handle(
    'model.ensureThumbs',
    wrap(async () => {
      const { thumbnailService } = await import('../services/media')
      return thumbnailService.ensureAll()
    })
  )
  ipcMain.handle(
    'model.batchRename',
    wrap(async (opts: { ids: string[]; pattern: string; dryRun?: boolean }) => {
      const { renameService } = await import('../services/media')
      return renameService.batchRename(opts.ids, opts.pattern, opts.dryRun)
    })
  )

  // node packs
  ipcMain.handle(
    'node.list',
    wrap((instanceId?: string) => nodePackService.list(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'node.refresh',
    wrap((instanceId?: string) => nodePackService.refresh(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'registry.indexStatus',
    wrap(async () => {
      const { registryIndex } = await import('../services/registryIndex')
      return registryIndex.status()
    })
  )
  ipcMain.handle(
    'registry.refreshIndex',
    wrap(async () => {
      const { registryIndex } = await import('../services/registryIndex')
      return registryIndex.ensure({ force: true })
    })
  )
  ipcMain.handle(
    'registry.ensureIndex',
    wrap(async () => {
      const { registryIndex } = await import('../services/registryIndex')
      return registryIndex.ensure()
    })
  )
  ipcMain.handle(
    'node.managerChannel',
    wrap(() => nodePackService.managerChannelList())
  )
  ipcMain.handle(
    'node.install',
    wrap(
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
          instanceId: safeInstanceId(opts.instanceId)
        })
        broadcastNotification({
          type: 'success',
          title: 'Node pack installed',
          titleKey: 'notify.nodeInstalled',
          message: `${rec.displayName || rec.name || opts.id} (${rec.version || '?'})`,
          duration: 5000
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
    )
  )
  ipcMain.handle(
    'node.uninstall',
    wrap(async (id: string, instanceId?: string, opts?: { removePipDeps?: boolean }) => {
      const ok = await nodePackService.uninstall(id, safeInstanceId(instanceId), opts)
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
    })
  )
  ipcMain.handle(
    'node.uninstallDeps',
    wrap((id: string, instanceId?: string) =>
      nodePackService.pipDeps(id, safeInstanceId(instanceId))
    )
  )
  ipcMain.handle(
    'node.cancelOp',
    wrap((instanceId?: string) => nodePackService.cancelOp(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'node.cancelBatch',
    wrap((instanceId?: string) => nodePackService.cancelUpdateBatch(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'node.update',
    wrap(async (id: string, version?: string, instanceId?: string) => {
      const rec = await nodePackService.update(id, version, safeInstanceId(instanceId))
      broadcastNotification({
        type: 'success',
        title: 'Node pack updated',
        titleKey: 'notify.nodeUpdated',
        message: `${rec.displayName || rec.name || id} (${rec.version || '?'})`,
        duration: 5000
      })
      return rec
    })
  )
  ipcMain.handle(
    'node.toggle',
    wrap((id: string, enabled: boolean, instanceId?: string) =>
      nodePackService.toggle(id, enabled, safeInstanceId(instanceId))
    )
  )
  ipcMain.handle(
    'node.lock',
    wrap((id: string, locked: boolean, instanceId?: string) =>
      nodePackService.lock(id, locked, safeInstanceId(instanceId))
    )
  )
  ipcMain.handle(
    'node.checkIssues',
    wrap((id: string, instanceId?: string) =>
      nodePackService.checkIssues(id, safeInstanceId(instanceId))
    )
  )
  ipcMain.handle(
    'node.loadReport',
    wrap((instanceId?: string) => nodePackService.loadReport(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'node.opStatus',
    wrap((instanceId?: string) => nodePackService.getOpProgress(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'node.depsAudit',
    wrap((instanceId?: string) => nodePackService.depsAudit(requireLocalInstanceId(instanceId)))
  )
  ipcMain.handle(
    'node.installDeps',
    wrap(async (id: string, instanceId?: string) => {
      // Requirements installs mutate THIS machine's venv — remote targets are
      // refused with a coded error (see requireLocalInstanceId, 0.1.13).
      const result = await nodePackService.installDeps(id, requireLocalInstanceId(instanceId))
      notifyPipResult(result)
      return result
    })
  )
  ipcMain.handle(
    'node.conflicts',
    wrap((instanceId?: string) => nodePackService.conflicts(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'node.smokeTest',
    wrap((id: string, instanceId?: string) =>
      nodePackService.smokeTest(id, safeInstanceId(instanceId))
    )
  )
  ipcMain.handle(
    'node.snapshots',
    wrap((instanceId?: string) => nodePackService.snapshots(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'node.createSnapshot',
    wrap((name?: string, instanceId?: string) =>
      nodePackService.createSnapshot(name, safeInstanceId(instanceId))
    )
  )
  ipcMain.handle(
    'node.deleteSnapshot',
    wrap((id: string, instanceId?: string) =>
      nodePackService.deleteSnapshot(sanitizeId(id), safeInstanceId(instanceId))
    )
  )
  ipcMain.handle(
    'node.restoreSnapshot',
    wrap((id: string, instanceId?: string) =>
      nodePackService.restoreSnapshot(sanitizeId(id), safeInstanceId(instanceId))
    )
  )
  ipcMain.handle(
    'node.checkUpdates',
    wrap((instanceId?: string) => nodePackService.checkUpdates(safeInstanceId(instanceId)))
  )
  ipcMain.handle(
    'node.updateAll',
    wrap((instanceId?: string, opts?: import('@shared/types').NodeUpdateAllOptions) =>
      nodePackService.updateAll(safeInstanceId(instanceId), opts)
    )
  )

  // workflows
  ipcMain.handle(
    'workflow.list',
    wrap(async (opts?: { includeMissing?: boolean }) => {
      const list = workflowService.list(opts)
      // Attach a transient content fingerprint so the renderer can widen the
      // workflow→outputs filter across duplicate copies (0.1.11).
      const { fingerprintOfWorkflowFile } = await import('../services/workflowFingerprint')
      return list.map((w) => ({
        ...w,
        contentHash:
          !w.missing && w.path ? fingerprintOfWorkflowFile(w.path) || undefined : undefined
      }))
    })
  )
  ipcMain.handle(
    'workflow.import',
    wrap((path: string, instanceId?: string, target?: 'instance' | 'library') => {
      if (!isSafeReadPath(path)) throw new Error('Blocked unsafe workflow path')
      return workflowService.importFile(path, safeInstanceId(instanceId), target || 'instance')
    })
  )
  ipcMain.handle(
    'workflow.importMany',
    wrap(async (paths: string[], instanceId?: string, target?: 'instance' | 'library') => {
      if (!Array.isArray(paths) || !paths.length) return { ok: [], errors: [] }
      for (const p of paths) {
        if (!isSafeReadPath(p)) throw new Error(`Blocked unsafe workflow path: ${basename(p)}`)
      }
      return workflowService.importMany(paths, safeInstanceId(instanceId), target || 'instance')
    })
  )
  ipcMain.handle(
    'workflow.tag',
    wrap((id: string, tags: string[]) => workflowService.tag(id, tags))
  )
  ipcMain.handle(
    'workflow.favorite',
    wrap((id: string, favorite: boolean) => workflowService.favorite(id, favorite))
  )
  ipcMain.handle(
    'workflow.rename',
    wrap((id: string, name: string) => workflowService.rename(id, name))
  )
  ipcMain.handle(
    'workflow.delete',
    wrap((id: string, opts?: { deleteSource?: boolean }) =>
      workflowService.remove(sanitizeId(id), opts)
    )
  )
  ipcMain.handle(
    'workflow.exportZip',
    wrap(async (id: string, destDir?: string) => {
      if (destDir) {
        if (!existsSync(destDir)) throw new Error('Export directory does not exist')
        const { workflowLibraryDir, cacheDir } = await import('../services/db')
        const allowed = [
          join(homedir(), 'Downloads', 'ComfyPilot'),
          workflowLibraryDir(),
          cacheDir(),
          ...loadInstanceConfigs().map((i) => i.path)
        ].filter(Boolean) as string[]
        // resolveInsideAnyRoot collapses `..` (lexical prefix checks let
        // `<allowed>/../Desktop` through on every platform).
        if (!resolveInsideAnyRoot(destDir, allowed)) {
          throw new Error('Export directory is outside the allowed roots')
        }
      }
      return workflowService.exportZip(sanitizeId(id), destDir)
    })
  )
  ipcMain.handle(
    'workflow.copyToInstance',
    wrap((id: string, instanceId: string) => {
      // Local instances only — a remote target gets the coded refusal, and
      // an empty/unresolvable id must never resolve to another instance
      // (0.1.13).
      const target = requireLocalInstanceId(instanceId)
      if (!target) throw new Error('No instance configured')
      return workflowService.copyToInstance(sanitizeId(id), target)
    })
  )
  /**
   * ComfyUI must already be up. ComfyPilot NEVER starts an instance on its
   * own — the user starts it from the Instances page. Anything that needs a
   * live backend gets a clear refusal instead of a silent auto-launch.
   */
  async function requireRunningInstance(instanceId?: string): Promise<{
    id: string
    name: string
    url: string
  }> {
    const instances = loadInstanceConfigs()
    const wanted = instanceId ? safeInstanceId(instanceId) : ''
    // Explicit instanceId must resolve — never silently fall back to instances[0]
    // (that would send the request to the wrong instance).
    const inst = wanted ? instances.find((i) => i.id === wanted) : instances[0]
    if (!inst) {
      if (wanted) throw new Error(`Instance not found: ${wanted}`)
      throw new Error('No instance configured')
    }
    const host =
      inst.listen === '0.0.0.0' || inst.listen === '::' || inst.listen === '[::]'
        ? '127.0.0.1'
        : inst.listen
    const url = `http://${host}:${inst.port}`
    const { ComfyApiClient } = await import('../services/comfyApi')
    const stats = await new ComfyApiClient(url).systemStats()
    if (!stats) {
      throw new Error('Instance is not running — start it on the Instances page first')
    }
    return { id: inst.id, name: inst.name, url }
  }

  ipcMain.handle(
    'workflow.openInFrontend',
    wrap(async (id: string, instanceId?: string) => {
      // Refuse BEFORE copying anything when the backend is down.
      await requireRunningInstance(instanceId)
      const prepared = await workflowService.prepareFrontend(
        sanitizeId(id),
        safeInstanceId(instanceId)
      )
      const settings = loadSettings()
      const mode: 'embed' | 'browser' = settings.embedFrontend === false ? 'browser' : 'embed'
      if (!isSafeExternalUrl(prepared.url)) throw new Error('Blocked unsafe URL')
      if (mode === 'embed') {
        await openEmbedInternal(prepared.url, prepared.instanceName)
      } else {
        await shell.openExternal(prepared.url)
      }
      return {
        opened: true,
        mode,
        instanceName: prepared.instanceName,
        url: prepared.url
      }
    })
  )
  ipcMain.handle(
    'workflow.reveal',
    wrap((id: string) => workflowService.reveal(sanitizeId(id)))
  )
  ipcMain.handle(
    'workflow.libraryInfo',
    wrap((instanceId?: string) => workflowService.libraryInfo(safeInstanceTarget(instanceId)))
  )
  ipcMain.handle(
    'workflow.queue',
    wrap(async (opts: { workflowPath: string; instanceId: string; seed?: number }) => {
      if (!isSafeReadPath(opts?.workflowPath)) throw new Error('Blocked unsafe workflow path')
      const target = safeInstanceTarget(String(opts.instanceId || ''))
      if (!target) throw new Error('Invalid instance id')
      // Queueing needs a live backend — local instance or reachable remote.
      if (target.startsWith('remote:')) {
        const status = await remoteService.test(target.slice('remote:'.length))
        if (!status.online) {
          throw new Error(`Remote instance is offline: ${status.error || target}`)
        }
      } else {
        await requireRunningInstance(target)
      }
      return workflowService.queue({
        workflowPath: opts.workflowPath,
        instanceId: target,
        seed: opts.seed
      })
    })
  )
  ipcMain.handle(
    'workflow.parsePngMeta',
    wrap((path: string) => {
      if (!isSafeReadPath(path)) throw new Error('Blocked unsafe image path')
      return workflowService.parsePngMeta(path)
    })
  )
  ipcMain.handle(
    'workflow.compare',
    wrap((idA: string, idB: string) => workflowService.compare(sanitizeId(idA), sanitizeId(idB)))
  )
  ipcMain.handle(
    'workflow.preflight',
    wrap(async (workflowPath: string, instanceId: string) => {
      if (!isSafeReadPath(workflowPath)) throw new Error('Blocked unsafe workflow path')
      const target = safeInstanceTarget(String(instanceId || ''))
      if (!target) throw new Error('Invalid instance id')
      if (target.startsWith('remote:')) {
        // Remote object_info needs auth headers; capabilityService probes local
        // instances only — report honestly as unavailable rather than guessing.
        return {
          available: false,
          missingTypes: [],
          nodeTypes: 0,
          error: 'Preflight is only available for local instances'
        }
      }
      const { preflightService } = await import('../services/preflight')
      return preflightService.workflow(workflowPath, target)
    })
  )
  ipcMain.handle(
    'workflow.importDefault',
    wrap(async (opts: { instanceId: string; target?: 'instance' | 'library' }) => {
      const raw = String(opts?.instanceId || '')
      if (!raw) throw new Error('No instance selected')
      const target = safeInstanceTarget(raw)
      if (!target || target.startsWith('remote:')) {
        // Local-only: remote auth surface for graph fetches stays out of scope,
        // matching every other instance-targeted workflow import.
        throw new Error('Default workflow import is only available for local instances')
      }
      // The default workflow lives on the RUNNING server — never auto-start.
      await requireRunningInstance(target)
      return workflowService.importDefaultFromInstance(target, opts?.target || 'instance')
    })
  )

  // monitor
  ipcMain.handle(
    'monitor.system',
    wrap(() => monitorService.systemSnapshot())
  )
  ipcMain.handle(
    'monitor.queue',
    wrap((baseUrl?: string) => {
      if (baseUrl && !isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.queueSnapshot(baseUrl)
    })
  )
  ipcMain.handle(
    'monitor.history',
    wrap((baseUrl?: string) => {
      if (baseUrl && !isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.history(baseUrl)
    })
  )
  ipcMain.handle(
    'monitor.jobs',
    wrap((baseUrl?: string) => {
      if (baseUrl && !isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.jobsSnapshot(baseUrl)
    })
  )
  ipcMain.handle(
    'monitor.connectWs',
    wrap((baseUrl: string) => {
      if (!isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.connectWs(baseUrl)
    })
  )
  ipcMain.handle(
    'monitor.disconnectWs',
    wrap(() => {
      monitorService.disconnectWs()
      return true
    })
  )
  // Runtime operations (0.1.15): same trusted-URL gate as every monitor call;
  // the service re-validates (assertMonitorBaseUrl) and attaches remote auth.
  ipcMain.handle(
    'monitor.clearQueue',
    wrap((baseUrl: string) => {
      if (!isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.clearQueue(baseUrl)
    })
  )
  ipcMain.handle(
    'monitor.interrupt',
    wrap((baseUrl: string, promptId?: string) => {
      if (!isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.interrupt(baseUrl, promptId ? String(promptId) : undefined)
    })
  )
  ipcMain.handle(
    'monitor.freeMemory',
    wrap((baseUrl: string) => {
      if (!isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.freeMemory(baseUrl)
    })
  )

  // doctor
  ipcMain.handle(
    'doctor.run',
    wrap((instanceId: string) => doctorService.run(instanceId))
  )
  ipcMain.handle(
    'doctor.fix',
    wrap((instanceId: string, fixId: string) => doctorService.fix(instanceId, fixId))
  )

  // backup
  ipcMain.handle(
    'backup.list',
    wrap(() => backupService.list())
  )
  ipcMain.handle(
    'backup.create',
    wrap((opts: { name: string; notes?: string }) => backupService.create(opts))
  )
  ipcMain.handle(
    'backup.restore',
    wrap(async (id: string) => {
      const ok = backupService.restore(sanitizeId(id))
      if (ok) {
        broadcastNotification({
          type: 'success',
          title: 'Backup restored',
          titleKey: 'notify.backupRestored',
          message:
            'Settings / instances / node packs / model manifests / workflows / remotes have been restored. Reload views to see changes.',
          duration: 6000
        })
      }
      return ok
    })
  )
  ipcMain.handle(
    'backup.delete',
    wrap((id: string) => backupService.delete(sanitizeId(id)))
  )
  ipcMain.handle(
    'backup.openFolder',
    wrap(async (id: string) => {
      const folder = backupService.openFolder(sanitizeId(id))
      return shell.openPath(folder).then((r) => r === '')
    })
  )

  // env
  ipcMain.handle(
    'env.probe',
    wrap((opts: { pythonPath: string; venvPath?: string }) => envService.probe(opts))
  )
  ipcMain.handle(
    'env.createVenv',
    wrap((req: EnvCreateRequest) => envService.createVenv(req))
  )
  ipcMain.handle(
    'env.listPythons',
    wrap(() => envService.listPythons())
  )
  ipcMain.handle(
    'env.installTorch',
    wrap((opts: { pythonPath: string; index: string }) => envService.installTorch(opts))
  )
  ipcMain.handle(
    'deps.recipes',
    wrap(() => PIP_RECIPES)
  )

  // installer
  ipcMain.handle(
    'installer.detectGpu',
    wrap(() => installerService.detectGpu())
  )
  ipcMain.handle(
    'installer.preflight',
    wrap(
      (opts: { installRoot: string; useUv: boolean; pythonPath?: string; torchChannel?: string }) =>
        installerService.preflight(opts as Parameters<typeof installerService.preflight>[0])
    )
  )
  ipcMain.handle(
    'installer.start',
    wrap((plan: InstallPlan) => installerService.start(plan))
  )
  ipcMain.handle(
    'installer.status',
    wrap(() => installerService.getStatus())
  )
  ipcMain.handle(
    'installer.cancel',
    wrap(() => installerService.cancel())
  )
  ipcMain.handle(
    'installer.reset',
    wrap(() => {
      // 0.1.17 (WP1): user-facing escape hatch for a run stuck as "running"
      // (app killed mid-install). Clears the persisted snapshot only.
      installerService.reset()
      return true
    })
  )
  ipcMain.handle(
    'installer.suggestInstallRoot',
    wrap(() => installerService.suggestInstallRoot())
  )
  ipcMain.handle(
    'installer.starterModels',
    wrap(() => listStarterModels())
  )
  ipcMain.handle(
    'installer.installStarter',
    wrap((opts: { id: string; instanceId?: string }) => installerService.installStarter(opts))
  )

  // runtime bootstrap
  ipcMain.handle(
    'bootstrap.status',
    wrap(() => bootstrapService.status())
  )
  ipcMain.handle(
    'bootstrap.ensure',
    wrap((opts?: { kinds?: string[]; downloadIfMissing?: boolean }) =>
      bootstrapService.ensure(opts as Parameters<typeof bootstrapService.ensure>[0])
    )
  )
  ipcMain.handle(
    'bootstrap.download',
    wrap((kind: string) => bootstrapService.download(kind as never))
  )

  // network probe → fastest mirrors
  ipcMain.handle(
    'net.recommendMirrors',
    wrap(async () => {
      const { recommendMirrors } = await import('../services/netProbe')
      return recommendMirrors()
    })
  )

  // launch script export
  ipcMain.handle(
    'instance.exportLaunchScript',
    wrap(async (id: string, opts?: { dir?: string; kind?: 'bat' | 'sh' }) => {
      const { instanceService } = await import('../services/instance')
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
  )

  // batch
  ipcMain.handle(
    'batch.list',
    wrap(() => batchService.list())
  )
  ipcMain.handle(
    'batch.create',
    wrap(
      (input: {
        name: string
        instanceId: string
        items: Array<{
          workflowId?: string
          workflowName?: string
          workflowPath: string
          count: number
        }>
        notes?: string
        params?: import('@shared/types').BatchParamOverrides
      }) => {
        for (const it of input.items || []) {
          if (!it.workflowPath || !isSafeReadPath(it.workflowPath)) {
            throw new Error(
              `Blocked unsafe workflow path: ${basename(it.workflowPath || '(empty)')}`
            )
          }
        }
        return batchService.create({
          ...input,
          instanceId: safeInstanceTarget(input.instanceId) || input.instanceId
        })
      }
    )
  )
  /**
   * Shared launcher (0.1.17 WP5-7): the IPC call returns as soon as the run is
   * accepted, the terminal notification is attached to the same promise, and
   * `batch.wait` can await it from the UI. A long batch no longer holds the
   * request open (which made the window look frozen until the last image).
   */
  const launchBatch = async (
    safeId: string,
    kick: () => BatchJob | Promise<BatchJob>
  ): Promise<BatchJob> => {
    const target = await requireBatchTarget(safeId)
    let initial: BatchJob
    try {
      initial = await kick()
    } catch (e) {
      broadcastNotification({
        type: 'error',
        title: `Batch failed: ${target.name}`,
        titleKey: 'notify.batchFailed',
        params: { name: target.name },
        message: e instanceof Error ? e.message : String(e),
        duration: 8000
      })
      throw e
    }
    void batchService
      .wait(safeId)
      .then((settled) => {
        if (settled) notifyBatchTerminal(settled)
      })
      .catch(() => undefined)
    return initial
  }

  ipcMain.handle(
    'batch.start',
    wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      return launchBatch(safeId, () => batchService.startAsync(safeId))
    })
  )
  // 0.1.17 (WP5): continue an interrupted job / retry only its failed legs.
  ipcMain.handle(
    'batch.resume',
    wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      return launchBatch(safeId, () => batchService.resumeAsync(safeId))
    })
  )
  ipcMain.handle(
    'batch.retryFailed',
    wrap(async (id: string) => {
      const safeId = sanitizeId(id)
      return launchBatch(safeId, () => batchService.retryFailedAsync(safeId))
    })
  )
  // 0.1.17 (WP5-7): settle without polling.
  ipcMain.handle(
    'batch.wait',
    wrap((id: string) =>
      // A long batch is a legitimate wait, not a frozen main process.
      withPausedSlowOp(() => batchService.wait(sanitizeId(id)))
    )
  )
  ipcMain.handle(
    'batch.cancel',
    wrap((id: string) => batchService.cancel(sanitizeId(id)))
  )
  ipcMain.handle(
    'batch.cancelItem',
    wrap((id: string, workflowPath: string) =>
      batchService.cancelItem(sanitizeId(id), String(workflowPath || ''))
    )
  )
  ipcMain.handle(
    'batch.remove',
    wrap((id: string) => batchService.remove(sanitizeId(id)))
  )
  ipcMain.handle(
    'batch.preflight',
    wrap(async (opts: { workflowPaths: string[]; instanceId: string }) => {
      const paths = Array.isArray(opts?.workflowPaths) ? opts.workflowPaths : []
      for (const p of paths) {
        if (!isSafeReadPath(p)) throw new Error(`Blocked unsafe workflow path: ${basename(p)}`)
      }
      const target = safeInstanceTarget(String(opts?.instanceId || ''))
      if (!target || target.startsWith('remote:')) {
        return {
          available: false,
          missingTypes: [],
          perWorkflow: paths.map((p) => ({
            workflowPath: p,
            name: basename(p),
            missingTypes: [],
            error: 'Preflight is only available for local instances'
          })),
          error: 'Preflight is only available for local instances'
        }
      }
      const { preflightService } = await import('../services/preflight')
      return preflightService.batch(paths, target)
    })
  )

  // output
  // 0.1.17 (WP7): explicit disk scan, separate from listing. The async walk
  // yields between directories, reports progress and can be cancelled — the
  // old synchronous walk froze every IPC call for the whole 13 GB tree.
  ipcMain.handle(
    'output.scan',
    wrap(async (opts?: { root?: string }) => {
      const { outputService } = await import('../services/p1p2')
      let root = opts?.root
      if (root) {
        const { workflowLibraryDir } = await import('../services/db')
        const { resolveOutputDir } = await import('../services/p1p2')
        const allowed = [
          workflowLibraryDir(),
          ...loadInstanceConfigs().map((i) => resolveOutputDir(i)),
          ...loadInstanceConfigs().map((i) => join(i.path, 'user', 'default', 'workflows'))
        ].filter(Boolean) as string[]
        const resolved = resolveInsideAnyRoot(root, allowed)
        if (!resolved) throw new Error('Output root is outside the allowed areas')
        root = resolved
      }
      const result = await outputService.scanAsync(root, (p) => {
        broadcast(IPC_EVENTS.outputScanProgress, p)
      })
      return { scanned: result.scanned, cancelled: result.cancelled }
    })
  )
  ipcMain.handle(
    'output.scanCancel',
    wrap(async () => {
      const { outputService } = await import('../services/p1p2')
      outputService.cancelScan()
      return true
    })
  )
  ipcMain.handle(
    'output.list',
    wrap(
      async (opts?: {
        root?: string
        type?: string
        limit?: number
        offset?: number
        favorite?: boolean
        batchJobId?: string
        workflowId?: string
        workflowIds?: string[]
        sort?: 'createdAt' | 'size' | 'name'
        order?: 'asc' | 'desc'
        createdFrom?: number
        createdTo?: number
      }) => {
        // Renderer-supplied root must sit inside an allow-listed output area.
        if (opts?.root) {
          const { workflowLibraryDir } = await import('../services/db')
          const { resolveOutputDir } = await import('../services/p1p2')
          const allowed = [
            workflowLibraryDir(),
            ...loadInstanceConfigs().map((i) => resolveOutputDir(i)),
            ...loadInstanceConfigs().map((i) => join(i.path, 'user', 'default', 'workflows'))
          ].filter(Boolean) as string[]
          // Per-segment normalization + resolve so `..` hops can't escape the
          // allow-list (0.1.9; the old prefix check was lexical-only).
          if (!resolveInsideAnyRoot(opts.root, allowed)) {
            throw new Error('Output root is outside the allowed areas')
          }
        }
        const { thumbnailDisplayUrl, toMediaUrl, resolveMediaUrlToPath, thumbnailService } =
          await import('../services/media')
        const { existsSync } = await import('fs')
        // 0.1.17 (WP7): cap the page size and never scan here — scanning is an
        // explicit `output.scan` (a page of 200 thumbs used to rewrite the
        // whole index once per thumbnail).
        const result = outputService.list({
          ...opts,
          limit: Math.max(1, Math.min(Number(opts?.limit) || 60, 200))
        })
        // Generate downscaled thumbs for image assets so the grid does not load
        // full-size PNGs (产物库缩略图管线). A recorded thumb that no longer
        // exists on disk (stale DB row / cache eviction) must NOT win over a
        // regenerated thumb or the full-size fallback — that produced 403s.
        // One item is cheap; 200 image decodes at once is not. Bounded pool of 8.
        const items = await mapPool(result.items, 8, async (a) => {
          let thumb: string | undefined
          if (a.thumbnail) {
            if (a.thumbnail.startsWith('comfy-pilot-media:')) {
              thumb = resolveMediaUrlToPath(a.thumbnail) ? a.thumbnail : undefined
            } else if (existsSync(a.thumbnail)) {
              thumb = thumbnailDisplayUrl(a.thumbnail) || undefined
            }
          }
          if (!thumb && a.type === 'image') {
            const generated = await thumbnailService.ensureOutputThumb(a.path)
            if (generated) thumb = thumbnailDisplayUrl(generated) || undefined
          }
          // Only advertise media URLs for files that still exist — a stale DB
          // row for a deleted output must not produce a 403ing <img>/<video>.
          const mediaUrl = existsSync(a.path) ? toMediaUrl(a.path) || undefined : undefined
          return {
            ...a,
            // Images fall back to the full-size URL; videos render <video>
            // directly from mediaUrl (no raster thumb possible without ffmpeg).
            thumbnail: thumb || (a.type === 'image' ? mediaUrl : undefined),
            // Full-resolution media URL — the lightbox must never get a bare fs path.
            mediaUrl
          }
        })
        return { ...result, items }
      }
    )
  )
  ipcMain.handle(
    'output.assetsMatch',
    wrap(async (instanceId: string, fileName: string) => {
      // Read-only assets-system lookup (0.1.14); never throws — null means
      // "assets API unavailable", [] means "no match".
      const { matchAssetsByFileName } = await import('../services/assetsApi')
      return matchAssetsByFileName(instanceId, fileName)
    })
  )
  ipcMain.handle(
    'output.open',
    wrap(async (path: string) => {
      if (!isSafeOpenPath(path)) throw new Error('Blocked opening executable/script file')
      return shell.openPath(path).then((r) => r === '')
    })
  )
  ipcMain.handle(
    'output.reveal',
    wrap(async (path: string) => {
      // Same allow-list as shell.reveal — the outputs library must not become
      // a weaker second door into the filesystem (0.1.9).
      const { resolveInsideAnyRoot } = await import('../services/security')
      const allowed = resolveInsideAnyRoot(path, await collectRevealRoots())
      if (!allowed) throw new Error('Blocked revealing path outside allowed areas')
      shell.showItemInFolder(path)
      return true
    })
  )
  ipcMain.handle(
    'output.favorite',
    wrap((id: string, favorite: boolean) => outputService.favorite(id, favorite))
  )
  ipcMain.handle(
    'output.delete',
    wrap((id: string, deleteFile: boolean) =>
      outputService.remove(sanitizeId(id), Boolean(deleteFile))
    )
  )
  ipcMain.handle(
    'output.batchDelete',
    wrap((ids: string[], deleteFile: boolean) => {
      if (!Array.isArray(ids) || !ids.length) throw new Error('No files selected')
      return outputService.batchRemove(ids.map(String), Boolean(deleteFile))
    })
  )
  ipcMain.handle(
    'output.importToWorkflow',
    wrap(async (path: string, instanceId?: string): Promise<WorkflowRecord | null> => {
      if (!isSafeReadPath(path)) throw new Error('Blocked unsafe image path')
      return outputService.importToWorkflow(path, safeInstanceId(instanceId))
    })
  )
  ipcMain.handle(
    'output.exportZip',
    wrap(async (paths: string[], destDir?: string) => {
      if (!Array.isArray(paths) || !paths.length) throw new Error('No files selected')
      for (const p of paths) {
        if (!isSafeReadPath(p) && !isSafeOpenPath(p))
          throw new Error(`Blocked unsafe path: ${basename(p)}`)
      }
      if (destDir) {
        if (!existsSync(destDir)) throw new Error('Export directory does not exist')
        const { workflowLibraryDir, cacheDir } = await import('../services/db')
        const allowed = [
          join(homedir(), 'Downloads', 'ComfyPilot'),
          workflowLibraryDir(),
          cacheDir(),
          ...loadInstanceConfigs().map((i) => i.path)
        ].filter(Boolean) as string[]
        // resolveInsideAnyRoot collapses `..` (lexical prefix checks let
        // `<allowed>/../Desktop` through on every platform).
        if (!resolveInsideAnyRoot(destDir, allowed)) {
          throw new Error('Export directory is outside the allowed roots')
        }
      }
      return outputService.exportZip(paths, destDir)
    })
  )

  // remote
  ipcMain.handle(
    'remote.list',
    wrap(() => remoteService.list())
  )
  ipcMain.handle(
    'remote.save',
    wrap((config: RemoteInstanceConfig) => {
      if (!config?.baseUrl || !isSafeExternalUrl(config.baseUrl)) {
        throw new Error('Remote baseUrl must be a valid http(s) URL')
      }
      if (config.apiKey && /[\r\n\0]/.test(config.apiKey)) throw new Error('Invalid apiKey')
      return remoteService.save(config)
    })
  )
  ipcMain.handle(
    'remote.remove',
    wrap((id: string) => remoteService.remove(id))
  )
  ipcMain.handle(
    'remote.test',
    wrap((id: string) => remoteService.test(id))
  )
  ipcMain.handle(
    'remote.listStatus',
    wrap(() => remoteService.listStatus())
  )
  ipcMain.handle(
    'remote.freeMemory',
    wrap(async (id: string) => {
      const remote = remoteService.list().find((r) => r.id === sanitizeId(id))
      if (!remote) throw new Error('Remote not found')
      const { ComfyApiClient } = await import('../services/comfyApi')
      const ok = await new ComfyApiClient(remote.baseUrl, {
        headers: remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : undefined
      }).freeMemory()
      return ok ? { ok: true } : { ok: false, error: 'Instance did not accept /free' }
    })
  )
  ipcMain.handle(
    'app.checkUpdate',
    wrap(async () => {
      const { checkAppUpdate } = await import('../services/appUpdate')
      return checkAppUpdate()
    })
  )
  ipcMain.handle(
    'app.updateStatus',
    wrap(async () => {
      const { getLastAppUpdateStatus } = await import('../services/appUpdate')
      return getLastAppUpdateStatus()
    })
  )
  ipcMain.handle(
    'app.installUpdate',
    wrap(async () => {
      const { installAppUpdate } = await import('../services/appUpdate')
      return installAppUpdate()
    })
  )
  ipcMain.handle(
    'app.previousExit',
    wrap(async () => {
      const { getPreviousExitInfo } = await import('../services/session')
      return getPreviousExitInfo()
    })
  )
  ipcMain.handle(
    'app.exportDiagnostics',
    wrap(async () => {
      const { exportAppDiagnostics } = await import('../services/session')
      return { path: exportAppDiagnostics() }
    })
  )

  // market
  ipcMain.handle(
    'market.list',
    wrap(
      (opts?: {
        query?: string
        category?: string
        limit?: number
        page?: number
        instanceId?: string
      }) => marketService.list({ ...opts, instanceId: safeInstanceId(opts?.instanceId) })
    )
  )
  ipcMain.handle(
    'market.install',
    wrap(
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
          instanceId: safeInstanceId(opts.instanceId)
        })
        broadcastNotification({
          type: 'success',
          title: 'Node pack installed',
          titleKey: 'notify.nodeInstalled',
          message: `${rec.displayName || rec.name || opts.id} (${rec.version || '?'})`,
          duration: 5000
        })
        return rec
      }
    )
  )

  // shell
  ipcMain.handle(
    'shell.openExternal',
    wrap(async (url: string) => {
      if (!isSafeExternalUrl(url)) throw new Error(`Blocked unsafe URL: ${url.slice(0, 40)}`)
      await shell.openExternal(url)
      return true
    })
  )
  ipcMain.handle(
    'shell.openPath',
    wrap(async (path: string) => {
      if (!isSafeOpenPath(path)) throw new Error('Blocked opening executable/script file')
      const result = await shell.openPath(path)
      return result === ''
    })
  )
  ipcMain.handle(
    'shell.reveal',
    wrap(async (path: string) => {
      if (!path || path.includes('\0')) throw new Error('Blocked unsafe path')
      // Allow-list with per-segment normalization + resolve: blocks `..` hops
      // and Windows path games (0.1.9). Only locations the app owns/configured.
      const { resolveInsideAnyRoot } = await import('../services/security')
      const allowed = resolveInsideAnyRoot(path, await collectRevealRoots())
      if (!allowed) throw new Error('Blocked revealing path outside allowed areas')
      // Pass the ORIGINAL path — the resolver may normalize UNC prefixes.
      shell.showItemInFolder(path)
      return true
    })
  )
  ipcMain.handle(
    'shell.pickDirectory',
    wrap(async () => {
      const win = getWindow()
      const res = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      const chosen = res.canceled ? null : res.filePaths[0]
      approveReadPath(chosen)
      return chosen
    })
  )
  ipcMain.handle(
    'shell.pickFile',
    wrap(async (opts?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
      const win = getWindow()
      const options = { properties: ['openFile' as const], filters: opts?.filters }
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const chosen = res.canceled ? null : res.filePaths[0]
      approveReadPath(chosen)
      return chosen
    })
  )
  ipcMain.handle(
    'shell.pickFiles',
    wrap(async (opts?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
      const win = getWindow()
      const options = {
        properties: ['openFile' as const, 'multiSelections' as const],
        filters: opts?.filters
      }
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const files = res.canceled ? [] : res.filePaths
      for (const f of files) approveReadPath(f)
      return files
    })
  )
  ipcMain.handle(
    'shell.writeClipboard',
    wrap((text: string) => {
      clipboard.writeText(text)
      return true
    })
  )

  // embed
  ipcMain.handle(
    'embed.open',
    wrap((opts: { url: string; title?: string }) => openEmbedInternal(opts.url, opts.title))
  )

  ipcMain.handle(
    'embed.resize',
    wrap((rect: { x: number; y: number; width: number; height: number }) => {
      if (!embedView) return false
      embedView.setBounds(rect)
      return true
    })
  )

  ipcMain.handle(
    'embed.close',
    wrap(() => {
      const win = getWindow()
      if (embedView && win) {
        win.contentView.removeChildView(embedView)
        embedView.webContents.close()
        embedView = null
      }
      return true
    })
  )
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // A destroyed renderer must never throw into an event emitter — a listener
    // exception would abort batch cleanup and leave stale op state behind.
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, payload)
    } catch {
      /* window died mid-send; drop the frame */
    }
  }
}

/** Roots the app may reveal/open in the OS file manager (0.1.9 allow-list). */
async function collectRevealRoots(): Promise<string[]> {
  const { userDataDir, workflowLibraryDir } = await import('../services/db')
  const { resolveOutputDir } = await import('../services/p1p2')
  const roots: string[] = []
  try {
    roots.push(userDataDir(), workflowLibraryDir())
  } catch {
    /* ignore */
  }
  for (const c of loadInstanceConfigs()) {
    if (!c.path) continue
    roots.push(c.path, resolveOutputDir(c), join(c.path, 'user', 'default', 'workflows'))
  }
  for (const r of loadSettings().modelScanRoots || []) roots.push(r)
  return roots
}

/** Push a global UI notification (long-running task done / failed). */
export function broadcastNotification(n: {
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  duration?: number
  titleKey?: string
  messageKey?: string
  params?: Record<string, string | number>
}): void {
  broadcast(IPC_EVENTS.notification, n)
}

/** Terminal toasts for pip-op results (0.1.12) — ops outlive their originating view. */
function notifyPipResult(result: {
  ok: boolean
  cancelled?: boolean
  requested: string[]
  installed: string[]
  warning?: string
  error?: string
}): void {
  if (result.cancelled) return
  if (result.ok) {
    const names = (result.installed.length ? result.installed : result.requested).join(', ')
    broadcastNotification({
      type: 'success',
      title: 'Packages installed',
      titleKey: 'notify.pipInstalled',
      message: names,
      messageKey: 'notify.pipInstalledMsg',
      params: { names },
      duration: 6000
    })
    if (result.warning) {
      broadcastNotification({
        type: 'warning',
        title: 'Package verification note',
        message: result.warning,
        duration: 8000
      })
    }
  } else {
    const message = (result.error || 'unknown error').slice(0, 220)
    broadcastNotification({
      type: 'error',
      title: 'Package install failed',
      titleKey: 'notify.pipFailed',
      message,
      messageKey: 'notify.pipFailedMsg',
      params: { message },
      duration: 10000
    })
  }
}
