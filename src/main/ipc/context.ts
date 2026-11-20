import { BrowserWindow, WebContentsView, shell } from 'electron'
import { basename, dirname, isAbsolute, resolve } from 'path'
import { homedir } from 'os'
import type {
  AppSettings,
  AppSettingsView,
  IpcResult,
  RemoteInstanceConfig,
  RemoteInstanceSummary
} from '@shared/types'
import { IPC_EVENTS } from '@shared/types'
import {
  assertSafeEndpointSetting,
  isLocalhostUrl,
  isSafeDataReadPath,
  isSafeEmbedUrl,
  isSafeExternalUrl,
  normalizeForCompare,
  resolveInsideAnyRoot
} from '../services/security'
import { loadInstanceConfigs, loadSettings, userDataDir, workflowLibraryDir } from '../services/db'
import { secretStorageBackend } from '../services/secretStorage'
import { remoteService } from '../services/p1p2'
import { resolveOutputDir } from '@shared/outputDir'
import { resolveEffectiveInstance } from '@shared/instanceLayout'
import { pathCapabilities } from '../services/pathCapability'
import { isOwnRendererUrl } from '../services/rendererEntry'
import { safeInstanceId } from './trust'

export interface NotificationInput {
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  duration?: number
  titleKey?: string
  messageKey?: string
  params?: Record<string, string | number>
  dedupeKey?: string
  action?: import('@shared/types').NotificationAction
}

export interface IpcContext {
  getWindow: () => BrowserWindow | null
  broadcast: (channel: string, payload: unknown) => void
  broadcastNotification: (n: NotificationInput) => void
}

export function createIpcContext(getWindow: () => BrowserWindow | null): IpcContext {
  return { getWindow, broadcast, broadcastNotification }
}

export function ok<T>(data: T): IpcResult<T> {
  // Structured-clone safety: never hand a class instance / Response / Proxy
  // back over IPC — reduce to plain JSON data first.
  return { ok: true, data: toPlainIpcData(data) }
}

export function fail(error: unknown): IpcResult<never> {
  if (error && typeof error === 'object') {
    const e = error as Error & {
      code?: string
      suggestedPort?: number
      messageKey?: string
      params?: Record<string, string | number>
      detail?: string
      retryable?: boolean
    }
    return {
      ok: false,
      error: e.message || String(error),
      code: typeof e.code === 'string' ? e.code : undefined,
      suggestedPort: typeof e.suggestedPort === 'number' ? e.suggestedPort : undefined,
      messageKey: typeof e.messageKey === 'string' ? e.messageKey : undefined,
      params: e.params,
      detail: typeof e.detail === 'string' ? e.detail : undefined,
      retryable: typeof e.retryable === 'boolean' ? e.retryable : undefined
    }
  }
  return { ok: false, error: String(error) }
}

/** JSON round-trip keeps IPC payloads structured-clone safe. */
export function toPlainIpcData<T>(data: T): T {
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

/**
 * 0.2.0: every IPC call must originate from this app's own renderer frame.
 * A webview/iframe that somehow received the preload bridge must not be able
 * to drive instance lifecycle or filesystem channels.
 */
export function assertTrustedIpcSender(event: unknown): void {
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)
  if (!event || typeof event !== 'object') {
    if (!isTest) throw new Error('Blocked IPC without a sender frame')
    return
  }
  if (!('senderFrame' in event)) {
    // 0.2.5 WP10: production must fail closed. Direct service tests call the
    // wrapped handler without an Electron event, which is the only exception.
    if (!isTest) throw new Error('Blocked IPC without a sender frame')
    return
  }
  const frame = (event as { senderFrame?: { url?: string } | null }).senderFrame
  if (!frame || !isOwnRendererUrl(String(frame.url || ''))) {
    throw new Error('Blocked IPC from an untrusted frame')
  }
}

export function wrap<A extends unknown[], R>(
  fn: (...args: A) => Promise<R> | R
): (_event: unknown, ...args: A) => Promise<IpcResult> {
  return async (event, ...args) => {
    try {
      assertTrustedIpcSender(event)
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
    if (!inst.path) continue
    const effective = resolveEffectiveInstance(inst)
    origins.push(effective.url)
    // HTTPS is only a trust convenience for TLS-fronted instances.
    origins.push(effective.url.replace(/^http:/, 'https:'))
  }
  for (const remote of remoteService.list()) {
    if (remote.baseUrl) origins.push(remote.baseUrl)
  }
  return origins
}

/** localhost or a configured instance/remote origin only. */
export function isTrustedComfyUrl(raw: string | undefined | null): boolean {
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
 * Paths the user explicitly chose via the OS picker (0.2.5 WP10).
 * A pick issues read+write+exec capabilities; there is no global set to add to
 * by accident, and every grant expires.
 */
export function approveReadPath(p: string | null | undefined): void {
  if (!p) return
  try {
    pathCapabilities.issueAll(p, 'picker')
  } catch {
    /* ignore invalid path */
  }
}

/** Read-only capability roots (picker + discovery), exposed to old consumers. */
export function approvedReadRootsList(): string[] {
  return pathCapabilities.rootsFor('read')
}

function isSystemPythonPath(p: string): boolean {
  // A bare command name (`python`, `python3`, `py`) is resolved by the OS and
  // is not a renderer-supplied executable path. It is what EnvCreateRequest
  // and the manual instance dialog legitimately use when the user has not
  // chosen a specific interpreter.
  const raw = String(p || '').trim()
  if (!raw.includes('/') && !raw.includes('\\')) {
    return /^(python(3(\.\d+)?)?|py)(\.exe)?$/i.test(raw)
  }
  const name = basename(raw).toLowerCase()
  if (!/^python(3(\.\d+)?)?(\.exe)?$/.test(name)) return false
  const normalized = normalizeForCompare(raw).toLowerCase()
  return (
    normalized.includes('/windows/system32/') ||
    normalized.includes('/program files/') ||
    normalized.includes('/program files (x86)/') ||
    normalized.startsWith('/usr/bin/') ||
    normalized.startsWith('/usr/local/bin/') ||
    normalized.startsWith('/opt/') ||
    normalized.includes('/appdata/local/programs/python/') ||
    normalized.includes('/miniconda') ||
    normalized.includes('/anaconda')
  )
}

/** Executable paths must come from the picker, a known system location, or
 * an instance's own venv. A renderer cannot point the app at a dropped binary. */
export function assertApprovedExecutable(p: string, label: string, instanceRoot?: string): void {
  if (!p) return
  if (p.includes('\0')) throw new Error(`${label} contains an invalid character`)
  const normalized = normalizeForCompare(p)
  // 1) Issued by the OS picker / installer / a validated runtime.
  if (pathCapabilities.covers(p, 'exec')) return
  // 2) A bare `python`/`py` resolved by the OS, or a well-known system Python.
  if (isSystemPythonPath(p)) return
  const lower = normalized.toLowerCase()
  // 3) Only an interpreter-shaped file inside a venv is implicitly trusted.
  // A directory merely NAMED `venv` must not turn an arbitrary dropped binary
  // into an approved executable.
  if (
    /\/(?:\.?venv|venv-[^/]+)\/(?:bin\/python(?:3(?:\.\d+)?)?|scripts\/python(?:\.exe)?)$/.test(
      lower
    )
  ) {
    return
  }
  // 4) Embedded/portable ComfyUI layouts, but ONLY the known interpreter
  // locations — never `<instance>/anything.exe` (0.2.5 WP10 / S1).
  if (instanceRoot) {
    const embedded =
      /(?:^|\/)(?:python_embeded|python_embedded|python)\/(?:python\.exe|bin\/python(?:3(?:\.\d+)?)?)$/
    const inInstance = resolveInsideAnyRoot(p, [instanceRoot])
    if (inInstance && embedded.test(lower)) return
    // AKI / 绘世: `<root>/python/python.exe` BESIDE `<root>/ComfyUI`.
    const beside = resolveInsideAnyRoot(p, [dirname(instanceRoot)])
    if (beside && /(?:^|\/)python\/(?:python\.exe|bin\/python(?:3(?:\.\d+)?)?)$/.test(lower)) {
      return
    }
  }
  throw new Error(`${label} must be chosen with the file picker`)
}

/**
 * A venv may live inside the instance (`<ComfyUI>/.venv`) or beside it
 * (`<root>/.venv`, the repair/installer default). Both are legitimate; an
 * arbitrary directory is not.
 */
export function assertApprovedVenvPath(venvPath: string, instanceRoot?: string): void {
  if (!venvPath) return
  if (venvPath.includes('\0')) throw new Error('venvPath contains an invalid character')
  if (pathCapabilities.covers(venvPath, 'write')) return
  if (isPathInsideInstance(venvPath)) return
  if (instanceRoot && resolveInsideAnyRoot(venvPath, [instanceRoot, dirname(instanceRoot)])) return
  throw new Error('venvPath must be inside the instance or chosen with the picker')
}

/** Base directory for `env.createVenv`: instance-owned, home, or user-picked. */
export function assertApprovedVenvBase(basePath: string): void {
  if (!basePath || basePath.includes('\0')) throw new Error('Invalid venv base path')
  if (!isAbsolute(basePath)) throw new Error('venv base path must be absolute')
  if (pathCapabilities.covers(basePath, 'write')) return
  const normalized = normalizeForCompare(basePath)
  const home = normalizeForCompare(homedir()).toLowerCase()
  const data = normalizeForCompare(userDataDir()).toLowerCase()
  const lower = normalized.toLowerCase()
  if (lower === home || lower.startsWith(`${home}/`)) return
  if (lower === data || lower.startsWith(`${data}/`)) return
  for (const c of loadInstanceConfigs()) {
    if (!c.path) continue
    if (resolveInsideAnyRoot(basePath, [c.path, dirname(c.path)])) return
  }
  throw new Error('venv base path must be inside an instance, home, or chosen with the picker')
}

export function isPathInsideInstance(p: string): boolean {
  return loadInstanceConfigs().some((c) => c.path && resolveInsideAnyRoot(p, [c.path]))
}

/**
 * Install roots are directories chosen through the picker (or the app-owned
 * userData default). 0.2.5 WP10: a renderer can no longer nominate any path
 * under the user's home — that was the entry point of the S1 RCE chain.
 */
export function assertApprovedInstallRoot(p: string): void {
  if (!p || p.includes('\0')) throw new Error('Invalid install root')
  if (!isAbsolute(p)) throw new Error('Install root must be absolute')
  if (pathCapabilities.covers(p, 'write')) return
  throw new Error('Install root must be chosen with the directory picker')
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
      roots.push(c.path, resolveOutputDir(c), resolveEffectiveInstance(c).dirs.workflows)
    } catch {
      /* malformed config — skip */
    }
  }
  for (const r of loadSettings().modelScanRoots || []) roots.push(r)
  return roots
}

/**
 * 0.2.5 WP10 / S2: model scan roots may only be ADDED by the OS picker.
 * A renderer calling `settings.set({ modelScanRoots: ['/'] })` must be
 * rejected even though `/` exists and is a directory.
 */
export function assertModelScanRootsPatch(roots: unknown): void {
  if (roots === undefined) return
  if (!Array.isArray(roots)) throw new Error('modelScanRoots must be an array')
  const existing = new Set(
    (loadSettings().modelScanRoots || []).map((r) => normalizeForCompare(r))
  )
  for (const raw of roots) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('modelScanRoots entries must be paths')
    }
    if (raw.includes('\0')) throw new Error('modelScanRoots contains an invalid path')
    const normalized = normalizeForCompare(resolve(raw))
    // A filesystem root is never a model scan root.
    if (normalized === '/' || /^[a-z]:\/?$/i.test(normalized)) {
      throw new Error(`Refusing to add a filesystem root to modelScanRoots: ${raw}`)
    }
    if (existing.has(normalized)) continue
    if (!pathCapabilities.covers(raw, 'read')) {
      throw new Error(
        `modelScanRoots can only be added through the directory picker: ${raw}`
      )
    }
  }
}

/** Settings fields that must be http(s) URLs when set (0.1.17 WP8). */
const URL_SETTING_KEYS = [
  'githubEndpoint',
  'hfEndpoint',
  'civitaiEndpoint',
  'pipIndex',
  'torchIndexMirror'
] as const

export function assertSafeEndpointSettings(patch: Partial<AppSettings>): void {
  for (const key of URL_SETTING_KEYS) {
    assertSafeEndpointSetting(key, (patch as Record<string, unknown>)[key])
  }
}

/** Renderer-safe settings projection: never leak the proxy password. */
export function settingsView(settings: AppSettings): AppSettingsView {
  const { password, ...proxy } = settings.proxy
  return {
    ...settings,
    proxy: {
      ...proxy,
      hasPassword: Boolean(password),
      backend: secretStorageBackend()
    }
  }
}

export function remoteSummary(remote: RemoteInstanceConfig): RemoteInstanceSummary {
  const { apiKey, ...rest } = remote
  return { ...rest, apiKeySet: Boolean(apiKey) && !rest.apiKeyLocked }
}

export function isSafeReadPath(path: string): boolean {
  return isSafeDataReadPath(path, {
    approvedRoots: pathCapabilities.rootsFor('read'),
    allowedRoots: allowedReadRoots()
  })
}

let embedView: WebContentsView | null = null

/** Open (or replace) the embedded ComfyUI Frontend. Bounds come from renderer via embed.resize. */
export async function openEmbedInternal(
  ctx: IpcContext,
  url: string,
  title?: string
): Promise<boolean> {
  const win = ctx.getWindow()
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
    ctx.broadcast(IPC_EVENTS.embedState, { state: 'ready', url })
  })
  view.webContents.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      ctx.broadcast(IPC_EVENTS.embedState, {
        state: 'failed',
        url,
        errorCode,
        errorDescription,
        validatedURL
      })
    }
  )
  void view.webContents.loadURL(url).catch((err: unknown) => {
    ctx.broadcast(IPC_EVENTS.embedState, {
      state: 'failed',
      url,
      errorDescription: err instanceof Error ? err.message : String(err)
    })
  })
  return true
}

export function resizeEmbed(rect: {
  x: number
  y: number
  width: number
  height: number
}): boolean {
  if (!embedView) return false
  embedView.setBounds(rect)
  return true
}

export function closeEmbed(ctx: IpcContext): boolean {
  const win = ctx.getWindow()
  if (embedView && win) {
    win.contentView.removeChildView(embedView)
    embedView.webContents.close()
    embedView = null
  }
  return true
}

/** Roots the app may reveal/open in the OS file manager (0.1.9 allow-list). */
export async function collectRevealRoots(): Promise<string[]> {
  const { userDataDir, workflowLibraryDir } = await import('../services/db')
  const { resolveOutputDir } = await import('@shared/outputDir')
  const roots: string[] = []
  try {
    roots.push(userDataDir(), workflowLibraryDir())
  } catch {
    /* ignore */
  }
  for (const c of loadInstanceConfigs()) {
    if (!c.path) continue
    const effective = resolveEffectiveInstance(c)
    roots.push(
      c.path,
      resolveOutputDir(c),
      effective.dirs.workflows,
      effective.dirs.customNodes,
      effective.dirs.manager,
      effective.dirs.models
    )
  }
  for (const r of loadSettings().modelScanRoots || []) roots.push(r)
  // 0.2.5 WP10: a symlinked root authorises its target implicitly; drop it.
  const { lstatSync } = await import('fs')
  return roots.filter((r) => {
    try {
      return !lstatSync(r).isSymbolicLink()
    } catch {
      return false
    }
  })
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

/** Push a global UI notification (long-running task done / failed). */
export function broadcastNotification(n: NotificationInput): void {
  broadcast(IPC_EVENTS.notification, n)
}

/**
 * ComfyUI must already be up. ComfyPilot NEVER starts an instance on its
 * own — the user starts it from the Instances page. Anything that needs a
 * live backend gets a clear refusal instead of a silent auto-launch.
 */
export async function requireRunningInstance(instanceId?: string): Promise<{
  id: string
  name: string
  url: string
}> {
  const instances = loadInstanceConfigs()
  const wanted = instanceId ? safeInstanceId(instanceId) : ''
  // Explicit instanceId must resolve — and an absent one must NOT fall back
  // to instances[0] (0.1.18 regression): an untargeted run used to execute on
  // whatever instance happened to be first.
  if (!wanted) {
    const e = new Error('Select a local instance before running') as Error & { code?: string }
    e.code = 'TARGET_REQUIRED'
    throw e
  }
  const inst = instances.find((i) => i.id === wanted)
  if (!inst) throw new Error(`Instance not found: ${wanted}`)
  // Effective URL — an argv `--port 9999` must not fall back to config.port.
  const url = resolveEffectiveInstance(inst).url
  const { ComfyApiClient } = await import('../services/comfyApi')
  const stats = await new ComfyApiClient(url).systemStats()
  if (!stats) {
    throw new Error('Instance is not running — start it on the Instances page first')
  }
  return { id: inst.id, name: inst.name, url }
}

/** Terminal toasts for pip-op results (0.1.12) — ops outlive their originating view. */
export function notifyPipResult(result: {
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
    // 0.2.0: a successful receipt is verified per requirement. There is no
    // generic "verify with the dependency audit" caveat any more; if something
    // is unresolved, `ok` is false and the failure branch reports it.
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
