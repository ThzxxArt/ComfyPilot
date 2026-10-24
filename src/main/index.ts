import { app, BrowserWindow, shell, protocol, net, nativeImage, dialog } from 'electron'
import { join, resolve, dirname, relative, isAbsolute } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { registerIpcHandlers, broadcast, broadcastNotification } from './ipc/handlers'
import { instanceService } from './services/instance'
import { modelService } from './services/model'
import { monitorService } from './services/monitor'
import { batchService } from './services/p1p2'
import { installerService } from './services/installer'
import { execDiagnosticsService } from './services/execDiagnostics'
import { proxyAuthFor, syncProxyFromSettings } from './services/proxy'
import { createTray, destroyTray, refreshTray, hasTray } from './services/tray'
import { setLaunchOnBoot } from './services/desktop'
import {
  loadSettings,
  loadInstanceConfigs,
  logsDir,
  migrateLegacyLogs,
  flushPendingWrites
} from './services/db'
import { markSessionStart, markSessionCleanExit, recordCrashDetail } from './services/session'
import { describeRecentSlowOps } from './services/slowOps'
import { flushPromptLinks } from './services/workflow'
import { monitorEventLoopDelay } from 'perf_hooks'
import { IPC_EVENTS } from '@shared/types'
import { APP_NAME } from '@shared/constants'
import { isSafeExternalUrl, safeResolveUnder } from './services/security'
import { bootMark } from './services/bootTiming'

// Custom schemes must be privileged BEFORE app ready so <img src="comfy-pilot-media:...">
// and fetch() work inside the renderer.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'comfy-pilot',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  {
    scheme: 'comfy-pilot-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
])

let mainWindow: BrowserWindow | null = null
/** Set when the user actually quit — close then destroys instead of hiding. */
let forceQuit = false

function crashLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    // Single canonical log root (0.1.16) — <userData>/logs, the dir the
    // Settings "open logs dir" button actually opens.
    appendFileSync(join(logsDir(), 'boot.log'), line)
  } catch {
    try {
      const dir = join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'startup-crash.log'), line)
    } catch {
      /* ignore */
    }
  }
}

process.on('uncaughtException', (err) => {
  const detail = String(err?.stack || err)
  crashLog('uncaughtException: ' + detail)
  // Persist the reason onto the session marker so the NEXT launch can report
  // "last run ended in an uncaught exception" even if this process dies.
  recordCrashDetail('uncaughtException: ' + detail)
  try {
    broadcastNotification({
      type: 'error',
      title: 'ComfyPilot error',
      titleKey: 'notify.appCrash',
      message: detail.slice(0, 220),
      messageKey: 'notify.appCrashMsg',
      params: { message: detail.slice(0, 220) },
      duration: 0
    })
  } catch {
    /* notification is best-effort */
  }
  try {
    dialog.showErrorBox(
      'ComfyPilot error',
      detail +
        '\n\nRestart the app and export diagnostics from Settings to help investigate the crash.'
    )
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (err) => {
  const detail = String(err)
  crashLog('unhandledRejection: ' + detail)
  recordCrashDetail('unhandledRejection: ' + detail)
})

/**
 * Main-process watchdog (0.1.16): sample heap/RSS + event-loop lag so a future
 * "it froze then vanished" leaves a breadcrumb in boot.log. Deliberately
 * log-only — never kills or restarts the app.
 */
function startWatchdog(): void {
  try {
    const loopDelay = monitorEventLoopDelay({ resolution: 20 })
    loopDelay.enable()
    let lastWarn = 0
    const timer = setInterval(() => {
      try {
        const mem = process.memoryUsage()
        const lagMs = loopDelay.max / 1e6
        loopDelay.reset()
        const heapMb = Math.round(mem.heapUsed / 1048576)
        const rssMb = Math.round(mem.rss / 1048576)
        if ((heapMb > 1536 || lagMs > 5000) && Date.now() - lastWarn > 60_000) {
          lastWarn = Date.now()
          // 0.1.17 (WP6): name the IPC channel(s) that blew the budget instead
          // of leaving a bare millisecond number.
          crashLog(
            `watchdog: heap=${heapMb}MB rss=${rssMb}MB eventLoopMax=${Math.round(lagMs)}ms slow=${describeRecentSlowOps(3)}`
          )
        }
      } catch {
        /* sampling must never throw */
      }
    }, 15_000)
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as unknown as { unref: () => void }).unref()
    }
  } catch {
    /* perf_hooks unavailable — watchdog is optional */
  }
}

function resolveAppIcon(): string {
  // Prefer .ico on Windows, fallback to PNG elsewhere / in dev
  const candidates =
    process.platform === 'win32'
      ? ['ComfyPilot.ico', 'comfypilot-windows-256.png', 'comfypilot-windows-1024.png']
      : process.platform === 'darwin'
        ? ['ComfyPilot.icns', 'comfypilot-macos-512.png', 'comfypilot-macos-1024.png']
        : ['comfypilot-appstore-512.png', 'comfypilot-appstore-1024.png', 'ComfyPilot.ico']
  const bases = [
    join(process.resourcesPath || '', 'resources'),
    join(app.getAppPath(), 'resources'),
    join(__dirname, '../../resources')
  ]
  for (const base of bases) {
    for (const name of candidates) {
      const p = join(base, name)
      try {
        if (existsSync(p)) return p
      } catch {
        /* ignore */
      }
    }
  }
  return candidates[0]
}

/** Only the renderer entry we load (dev server or our index.html) may navigate. */
function isOwnRendererEntry(url: string): boolean {
  if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) {
    return true
  }
  if (!url.startsWith('file:')) return false
  try {
    const target = resolve(fileURLToPath(url))
    const htmlReal = join(process.resourcesPath || '', 'renderer', 'index.html')
    const htmlAsar = join(__dirname, '../renderer/index.html')
    const entry = resolve(existsSync(htmlReal) ? htmlReal : htmlAsar)
    if (target === entry) return true
    const rendererDir = dirname(entry)
    const rel = relative(rendererDir, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
    return Boolean(safeResolveUnder(rendererDir, rel))
  } catch {
    return false
  }
}

function revealWindow(): void {
  try {
    mainWindow?.show()
    mainWindow?.focus()
  } catch {
    /* ignore */
  }
}

// Monitor cadence: full rate while the window is on screen, backed off while
// hidden (tray close / hide) so a backgrounded app stops burning CPU every 2s.
const MONITOR_TICK_VISIBLE_MS = 2000
const MONITOR_TICK_HIDDEN_MS = 10000
let monitorTimer: ReturnType<typeof setInterval> | undefined

function scheduleMonitorTicks(ms: number): void {
  if (monitorTimer) clearInterval(monitorTimer)
  monitorTimer = setInterval(() => {
    void monitorService
      .systemSnapshot()
      .then((snap) => broadcast(IPC_EVENTS.monitorTick, snap))
      .catch(() => {})
  }, ms)
}

function createWindow(): void {
  crashLog('createWindow enter')
  const iconPath = resolveAppIcon()
  crashLog('icon: ' + iconPath)
  let windowIcon: Electron.NativeImage | undefined
  try {
    if (iconPath && existsSync(iconPath)) {
      windowIcon = nativeImage.createFromPath(iconPath)
      if (windowIcon.isEmpty()) windowIcon = undefined
    }
  } catch {
    windowIcon = undefined
  }
  crashLog('before new BrowserWindow')
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    title: APP_NAME,
    backgroundColor: '#F2F6FC',
    autoHideMenuBar: true,
    icon: process.platform === 'darwin' ? undefined : windowIcon || iconPath,
    webPreferences: {
      // Sandbox preload MUST live outside asar (real filesystem path)
      preload: (() => {
        const candidates = [
          join(process.resourcesPath || '', 'preload', 'index.js'),
          join(__dirname, '../preload/index.js'),
          join(__dirname, '../../preload/index.js')
        ]
        for (const c of candidates) {
          if (existsSync(c)) return c
        }
        return candidates[0]
      })(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  mainWindow.webContents.once('did-finish-load', () => bootMark('renderer-loaded'))
  mainWindow.on('ready-to-show', () => {
    bootMark('window-ready-to-show')
    crashLog('ready-to-show')
    mainWindow?.show()
    bootMark('window-shown')
  })

  // Close button hides to tray when minimizeToTray is on (launcher-friendly).
  app.on('before-quit', () => {
    forceQuit = true
  })
  mainWindow.on('close', (e) => {
    if (forceQuit) return
    let minimizeToTray = true
    try {
      minimizeToTray = loadSettings().minimizeToTray !== false
    } catch {
      minimizeToTray = true
    }
    // Only hide when a tray icon can bring the window back — otherwise close for real.
    if (minimizeToTray && hasTray() && mainWindow) {
      e.preventDefault()
      mainWindow.hide()
      void refreshTray()
    }
  })

  // Back off the monitor snapshot loop while the window is not on screen.
  mainWindow.on('hide', () => scheduleMonitorTicks(MONITOR_TICK_HIDDEN_MS))
  mainWindow.on('show', () => scheduleMonitorTicks(MONITOR_TICK_VISIBLE_MS))

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    crashLog('did-fail-load ' + code + ' ' + desc)
    revealWindow()
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    crashLog('RENDERER GONE reason=' + details.reason + ' code=' + details.exitCode)
  })
  mainWindow.webContents.on('preload-error', (_e, path, err) => {
    crashLog('PRELOAD ERROR ' + path + ' ' + err)
  })
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) crashLog('renderer console: ' + message)
  })
  crashLog('window constructed')

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isOwnRendererEntry(url)) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    }
  })

  const bootProbe = process.env.COMFYPILOT_BOOT_PROBE
  const probeMap: Record<string, string> = {
    '5': 'probe-css.html',
    '6': 'probe-js.html',
    '7': 'probe-main.html',
    '4': 'index-test.html'
  }
  if (bootProbe && probeMap[bootProbe]) {
    const p = join(process.resourcesPath || '', 'renderer', probeMap[bootProbe])
    const p2 = join(__dirname, '../renderer', probeMap[bootProbe])
    const use = existsSync(p) ? p : p2
    crashLog('probe ' + bootProbe + ' ' + use)
    void mainWindow
      .loadFile(use)
      .then(() => crashLog('probe ' + bootProbe + ' ok'))
      .catch((e) => {
        crashLog('probe fail ' + e)
        revealWindow()
      })
    return
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    crashLog('loadURL ' + process.env.ELECTRON_RENDERER_URL)
    void mainWindow
      .loadURL(process.env.ELECTRON_RENDERER_URL)
      .then(() => crashLog('loadURL ok'))
      .catch((e) => {
        crashLog('loadURL fail ' + e)
        revealWindow()
      })
  } else if (process.env.COMFYPILOT_BOOT_PROBE === '1') {
    crashLog('probe data url')
    void mainWindow
      .loadURL('data:text/html,<html><body><h1>ComfyPilot</h1></body></html>')
      .then(() => crashLog('probe ok'))
      .catch((e) => {
        crashLog('probe fail ' + e)
        revealWindow()
      })
  } else {
    // Prefer unpacked renderer (module scripts + native fs are happier outside asar)
    const htmlReal = join(process.resourcesPath || '', 'renderer', 'index.html')
    const htmlAsar = join(__dirname, '../renderer/index.html')
    const html = existsSync(htmlReal) ? htmlReal : htmlAsar
    crashLog('loadFile ' + html + ' exists=' + existsSync(html))
    void mainWindow
      .loadFile(html)
      .then(() => crashLog('loadFile ok'))
      .catch((e) => {
        crashLog('loadFile fail ' + e)
        revealWindow()
      })
  }
}

crashLog('module body done, registering whenReady')

// 0.1.17 (WP8): a second copy of the app used to start alongside the first,
// both writing settings/instances/logs and both driving child ComfyUI
// processes. The lock makes the second launch focus the existing window.
// Escape hatch for support/debug: `--allow-multiple-instances` (or env).
const allowMultipleInstances =
  process.argv.includes('--allow-multiple-instances') ||
  process.env.COMFYPILOT_ALLOW_MULTIPLE === '1'
const gotSingleInstanceLock = allowMultipleInstances || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  crashLog('another instance owns the lock — quitting this one')
  app.quit()
} else {
  app.on('second-instance', () => {
    crashLog('second-instance: focusing existing window')
    revealWindow()
  })
}

// 0.1.18 (WP0): Windows uses this id for toast/taskbar identity. Without it the
// identity derives from the exe path and shifts between install locations.
app.setAppUserModelId('com.comfy-pilot.app')

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
  const e2e = process.env.COMFYPILOT_E2E === '1' || process.argv.includes('--e2e-smoke')
  crashLog('whenReady start')
  bootMark('app-ready')

  /**
   * 0.1.18 (WP1 / S2): `setProxy` deliberately carries no credentials, so an
   * authenticated proxy answered every session.fetch with 407 and the UI
   * reported "network unreachable". Chromium asks through this event; we only
   * ever answer PROXY challenges — never a site's own login.
   */
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    try {
      const creds = proxyAuthFor(authInfo, loadSettings())
      if (!creds) return
      event.preventDefault()
      callback(creds.username, creds.password)
    } catch {
      /* malformed settings — let Chromium fail the request normally */
    }
  })

  // Log-root consolidation + session liveness + watchdog (0.1.16).
  try {
    migrateLegacyLogs()
  } catch {
    /* best effort */
  }
  try {
    const prev = markSessionStart()
    if (!prev.clean) {
      crashLog(
        `previous session did not exit cleanly (started=${prev.startedAt ?? '?'}${
          prev.detail ? ' detail=' + prev.detail.slice(0, 200) : ''
        })`
      )
    }
  } catch {
    /* best effort */
  }
  startWatchdog()

  // Window first: renderer must boot even if a service module is toxic.
  try {
    createWindow()
    crashLog('createWindow returned')
  } catch (err) {
    crashLog('createWindow fail: ' + (err instanceof Error ? err.stack : String(err)))
  }

  const probe = process.env.COMFYPILOT_BOOT_PROBE
  if (!probe) {
    try {
      protocol.handle('comfy-pilot', (request) => {
        const appRoot = app.getAppPath()
        const raw = request.url.replace(/^comfy-pilot:/, '')
        const safePath = safeResolveUnder(appRoot, raw)
        if (!safePath) {
          return new Response('Forbidden', { status: 403 })
        }
        return net.fetch(pathToFileURL(resolve(safePath)).href)
      })
      // Controlled media for <img> tags: thumbnails + output previews only.
      // Never a general file:// passthrough — roots are explicit allow-lists.
      protocol.handle('comfy-pilot-media', async (request) => {
        const { resolveMediaUrlToPath } = await import('./services/media')
        const abs = resolveMediaUrlToPath(request.url)
        if (!abs) return new Response('Forbidden', { status: 403 })
        return net.fetch(pathToFileURL(abs).href)
      })
      crashLog('protocol ok')
    } catch (err) {
      crashLog('protocol fail ' + err)
    }
    try {
      registerIpcHandlers(() => mainWindow)
      crashLog('ipc ok')
    } catch (err) {
      crashLog('ipc register fail ' + err)
    }
    try {
      syncProxyFromSettings()
    } catch (err) {
      crashLog('proxy fail ' + err)
    }
    try {
      // Thumbs are pure cache: bound disk growth from long-deleted outputs and
      // clear DB pointers whose thumb AND source are both gone.
      const { pruneOldOutputThumbs, pruneDeadOutputThumbRows } = await import('./services/media')
      const removed = pruneOldOutputThumbs()
      const cleared = pruneDeadOutputThumbRows()
      if (removed || cleared) {
        crashLog(`thumbs pruned: files=${removed} deadRows=${cleared}`)
      }
    } catch (err) {
      crashLog('thumb prune fail ' + err)
    }
    crashLog('services ready')
  }

  if (e2e) {
    // 0.1.18 (WP8): the smoke test must prove more than "a window appeared".
    // It now checks the preload bridge, performs one REAL IPC round-trip, and
    // fails the run on any renderer console error / unhandled rejection.
    const quitE2e = (): void => app.quit()
    mainWindow?.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) console.log(`[e2e] console-error: ${message}`)
    })
    mainWindow?.webContents.on('preload-error', (_e, path, err) => {
      console.log(`[e2e] preload-error: ${path} ${err?.message || ''}`)
    })
    setTimeout(() => {
      try {
        mainWindow?.webContents.once('did-finish-load', () => {
          void mainWindow?.webContents
            .executeJavaScript(
              `(async () => {
                const app = document.getElementById('app')
                const mounted = Boolean(app && app.childElementCount > 0)
                const api = window.comfyPilot
                const bridgeOk = Boolean(api && typeof api.invoke === 'function' && typeof api.on === 'function' && Boolean(api.events) && typeof api.events === 'object')
                let ipcOk = false
                let version = ''
                try {
                  const res = await api.invoke('app.previousExit')
                  ipcOk = Boolean(res && res.ok)
                  const v = await api.invoke('settings.get')
                  version = String(v && v.data && v.data.locale || '')
                } catch { ipcOk = false }
                return { mounted, bridgeOk, ipcOk, version }
              })()`
            )
            .then(
              (r: { mounted?: boolean; bridgeOk?: boolean; ipcOk?: boolean; version?: string }) => {
                console.log(r?.mounted ? '[e2e] renderer-mounted' : '[e2e] renderer-empty')
                console.log(
                  r?.bridgeOk ? '[e2e] preload-bridge-ok' : '[e2e] preload-bridge-missing'
                )
                console.log(r?.ipcOk ? '[e2e] ipc-ok' : '[e2e] ipc-failed')
              }
            )
            .catch(() => console.log('[e2e] renderer-probe-failed'))
            .finally(() => setTimeout(quitE2e, 300))
        })
      } catch {
        /* ignore */
      }
      setTimeout(quitE2e, 3000)
    }, 150)
  }

  if (app.isPackaged) {
    try {
      const settings = loadSettings()
      // Sync OS login item with the persisted preference
      try {
        setLaunchOnBoot(Boolean(settings.launchOnBoot))
      } catch (e) {
        crashLog('launchOnBoot sync: ' + String(e))
      }
      // NOTE (0.1.13): the self-update wiring moved to the END of whenReady —
      // it must run AFTER setAppUpdateBroadcast is registered, or the startup
      // check's first status broadcast would be dropped. See below.
    } catch (err) {
      crashLog('launchOnBoot skipped: ' + String(err))
    }
  } else {
    // Dev: still honour the login-item preference so the feature is testable
    try {
      const settings = loadSettings()
      if (settings.launchOnBoot) setLaunchOnBoot(true)
    } catch {
      /* ignore */
    }
  }

  // System tray (launcher shell)
  try {
    createTray({ onShowWindow: revealWindow })
    crashLog('tray ok')
  } catch (err) {
    crashLog('tray fail: ' + String(err))
  }

  // Auto-start instances flagged with autoStart (consumes the previously dead field)
  // 0.1.18 (review): the orphan sweep below runs concurrently with auto-start;
  // it could see a freshly adopted pid and kill it. Auto-start now waits for the
  // sweep to finish (the promise is assigned when the sweep is launched).
  let sweepDone: Promise<void> = Promise.resolve()
  try {
    const settings = loadSettings()
    if (settings.autoStartInstancesOnLaunch !== false) {
      const auto = loadInstanceConfigs().filter((c) => c.autoStart && c.enabled !== false)
      if (auto.length) {
        crashLog(`autoStart: ${auto.length} instance(s)`)
        void (async () => {
          await sweepDone
          for (const c of auto) {
            try {
              await instanceService.start(c.id)
              crashLog(`autoStart ok: ${c.name}`)
            } catch (e) {
              crashLog(`autoStart fail ${c.name}: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          void refreshTray()
        })()
      }
    }
  } catch (err) {
    crashLog('autoStart skipped: ' + String(err))
  }

  instanceService.on('status', (info) => {
    broadcast(IPC_EVENTS.instanceStatus, info)
    void refreshTray()
  })
  instanceService.on('log', (id, line) => {
    broadcast(IPC_EVENTS.instanceLog, { id, line })
    // 0.1.12: runtime-failure watcher — a `!!! Exception during processing`
    // banner schedules a parse of the traceback that follows (covers runs
    // started from the ComfyUI frontend, which never reach our WS).
    try {
      execDiagnosticsService.noteLogLine(id, line?.message || '')
    } catch {
      /* diagnosis must never break log streaming */
    }
  })
  // 0.1.17 (WP3): an unexpected exit carries a classified reason and a toast, so
  // a crashed instance is visible without keeping the log panel open.
  instanceService.on(
    'exit',
    (evt: { instanceId: string; report: { kind: string; hint: string } }) => {
      crashLog(`instance ${evt.instanceId} crashed: ${evt.report.kind} — ${evt.report.hint}`)
      broadcastNotification({
        type: 'error',
        title: 'ComfyUI stopped unexpectedly',
        titleKey: 'notify.instanceCrash',
        message: evt.report.hint,
        messageKey: 'notify.instanceCrashMsg',
        params: { kind: evt.report.kind, hint: evt.report.hint },
        duration: 10000
      })
    }
  )
  // Orphan sweep (0.1.17 WP3): a ComfyUI we started that survived an app crash
  // keeps tens of GB of VRAM. Terminate only when the command line proves the
  // pid is ours; anything unverifiable is reported, never killed.
  void (sweepDone = instanceService
    .sweepStaleProcesses()
    .then((res) => {
      if (res.killed.length) {
        crashLog(`orphan sweep: terminated ${res.killed.join(', ')}`)
        broadcastNotification({
          type: 'warning',
          title: 'Orphan ComfyUI terminated',
          titleKey: 'notify.orphanKilled',
          message: res.killed.join(', '),
          duration: 8000
        })
      }
      if (res.unverified.length) {
        crashLog(`orphan sweep: unverified ${res.unverified.join(', ')}`)
        broadcastNotification({
          type: 'warning',
          title: 'A previous ComfyUI may still be running',
          titleKey: 'notify.orphanUnverified',
          message: res.unverified.join(', '),
          duration: 10000
        })
      }
    })
    .catch((e) => crashLog('orphan sweep failed: ' + String(e))))
  // Record WS execution_error payloads for ComfyPilot-submitted runs and
  // surface every failure as an event + one toast/notification.
  monitorService.on('ws', (evt) => {
    broadcast(IPC_EVENTS.monitorWs, evt)
    if (evt?.type === 'execution_error' && evt.baseUrl) {
      void (async () => {
        try {
          let id = execDiagnosticsService.instanceIdForBaseUrl(evt.baseUrl)
          if (!id) {
            // Remote instances (0.1.13): record their execution failures too,
            // under a `remote:<id>` key the monitor page can load.
            const { remoteService } = await import('./services/p1p2')
            let origin: string | null = null
            try {
              origin = new URL(evt.baseUrl as string).origin
            } catch {
              origin = null
            }
            if (origin) {
              const hit = remoteService.list().find((r) => {
                try {
                  return new URL(r.baseUrl).origin === origin
                } catch {
                  return false
                }
              })
              if (hit) id = `remote:${hit.id}`
            }
          }
          if (id) execDiagnosticsService.recordWs(id, evt)
        } catch {
          /* diagnosis must never break the monitor stream */
        }
      })()
    }
  })
  execDiagnosticsService.on('failure', (f) => broadcast(IPC_EVENTS.execError, f))
  execDiagnosticsService.on('notify', (f) => {
    const summary = `${f.errorType}: ${f.message}`.slice(0, 220)
    broadcastNotification({
      type: 'error',
      title: 'Execution failed',
      titleKey: 'notify.execFailed',
      message: summary,
      messageKey: 'notify.execFailedMsg',
      params: { message: summary },
      duration: 10000
    })
    // System notification too (0.1.12): failures may happen while the window
    // is hidden to tray — the OS toast keeps them visible.
    void import('./services/tray')
      .then(({ showSystemNotification }) => {
        let zh = true
        try {
          zh = (loadSettings().locale || 'zh-CN') === 'zh-CN'
        } catch {
          /* default zh */
        }
        showSystemNotification(
          zh ? 'ComfyPilot — 运行失败' : 'ComfyPilot — Execution failed',
          summary
        )
      })
      .catch(() => undefined)
  })
  modelService.on('progress', (p) => broadcast(IPC_EVENTS.modelScanProgress, p))
  modelService.on('download', (t) => broadcast(IPC_EVENTS.downloadProgress, t))
  batchService.on('progress', (job) => broadcast(IPC_EVENTS.batchProgress, job))
  installerService.on('progress', (p) => broadcast(IPC_EVENTS.installProgress, p))
  // Resume interrupted model downloads so Range continues where we left off.
  import('./services/model')
    .then(({ modelService }) => {
      const n = modelService.resumeInterruptedOnBoot?.() ?? 0
      if (n > 0) console.log(`resumed ${n} interrupted download(s) on boot`)
    })
    .catch(() => undefined)
  // Wire previously-declared-but-dead events + bootstrap progress.
  import('./services/bootstrap')
    .then(({ bootstrapService }) => {
      bootstrapService.on('progress', (p) => broadcast(IPC_EVENTS.runtimeProgress, p))
    })
    .catch(() => undefined)
  import('./services/nodePack')
    .then(({ nodePackService }) => {
      nodePackService.on('install-progress', (p: { op?: string }) => {
        // Install/uninstall goes to nodeInstallProgress; updates go to BOTH so
        // the NodesView "updating" banner and Market loading state both react.
        // Previously everything hit nodeUpdateProgress — installs showed as
        // "Updating…" and never cleared (install never emitted done).
        if (p?.op === 'update') {
          broadcast(IPC_EVENTS.nodeUpdateProgress, p)
        } else {
          broadcast(IPC_EVENTS.nodeInstallProgress, p)
        }
      })
      // UpdateProgress-shaped stream — feeds the shared progress modal.
      nodePackService.on('op-progress', (p) => broadcast(IPC_EVENTS.nodeOperationProgress, p))
      // Streaming log lines (terminal panel in the node-op modal).
      nodePackService.on('op-log', (p) => broadcast(IPC_EVENTS.nodeOpLog, p))
      // Batch update lifecycle (queue position + final summary).
      nodePackService.on('update-batch', (p) => broadcast(IPC_EVENTS.nodeUpdateBatch, p))
      // Check-updates pass progress (N/M packs).
      nodePackService.on('check-progress', (p) => broadcast(IPC_EVENTS.nodeCheckProgress, p))
    })
    .catch(() => undefined)
  import('./services/updater')
    .then(({ comfyUpdaterService }) => {
      comfyUpdaterService.on('progress', (p) => broadcast(IPC_EVENTS.comfyUpdateProgress, p))
    })
    .catch(() => undefined)
  import('./services/env')
    .then(({ envService }) => {
      envService.on('progress', (p) => broadcast(IPC_EVENTS.repairProgress, p))
    })
    .catch(() => undefined)
  // 0.1.12: pip-op stream (install missing packages / recipes / pack deps).
  import('./services/pipOps')
    .then(({ pipOpsService }) => {
      pipOpsService.on('progress', (p) => broadcast(IPC_EVENTS.pipOpProgress, p))
      pipOpsService.on('log', (p) => broadcast(IPC_EVENTS.pipOpLog, p))
    })
    .catch(() => undefined)
  import('./services/doctor')
    .then(({ doctorService }) => {
      // doctorProgress is emitted as 'progress' from DoctorService when running
      if (typeof (doctorService as unknown as { on?: unknown }).on === 'function') {
        ;(doctorService as unknown as { on: (e: string, cb: (p: unknown) => void) => void }).on(
          'progress',
          (p) => broadcast(IPC_EVENTS.doctorProgress, p)
        )
      }
    })
    .catch(() => undefined)
  // 0.1.18 (WP5): the task center aggregator subscribes to every long-task
  // stream, then republishes normalized ops to the shell.
  void import('./services/ops')
    .then(async ({ operationRegistry }) => {
      operationRegistry.on('changed', (op) => broadcast(IPC_EVENTS.opChanged, op))
      await operationRegistry.init()
    })
    .catch(() => undefined)
  void import('./services/registryIndex')
    .then(({ registryIndex }) => {
      registryIndex.on('progress', (p) => broadcast(IPC_EVENTS.registryIndexProgress, p))
      // `ready` must reach the renderer: without it MarketView's indexing
      // banner never clears after a search-triggered rebuild.
      registryIndex.on('ready', (status) => {
        const s = status as { pages?: number; count?: number; total?: number }
        const pages = s.pages || 1
        broadcast(IPC_EVENTS.registryIndexProgress, {
          done: pages,
          total: pages,
          count: s.count || 0,
          ready: true
        })
      })
    })
    .catch(() => undefined)
  // Self-update stream (0.1.11 manual checks, unified in 0.1.13): every
  // autoUpdater event (available / download-progress / downloaded / error)
  // reaches the renderer, and the startup check runs here — AFTER the
  // broadcast is registered, so its first status is never dropped.
  void import('./services/appUpdate')
    .then(({ setAppUpdateBroadcast, setAppUpdateNotify, initAppUpdate }) => {
      setAppUpdateBroadcast((status) => broadcast(IPC_EVENTS.appUpdate, status))
      // In-app toast + OS notification for found/downloaded updates — the
      // missing user-visible hint of the old background check.
      setAppUpdateNotify((notice) => broadcastNotification(notice))
      let autoCheck = true
      try {
        autoCheck = loadSettings().enableAutoCheckUpdates !== false
      } catch {
        /* default on */
      }
      void initAppUpdate({ enableAutoCheckUpdates: autoCheck }).catch((e) =>
        crashLog('updater init: ' + String(e))
      )
    })
    .catch(() => undefined)

  scheduleMonitorTicks(MONITOR_TICK_VISIBLE_MS)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else revealWindow()
  })

  let quitInProgress = false
  app.on('before-quit', (event) => {
    // 0.1.18 (review): a second quit request used to fall through to the default
    // quit and exit before pending writes were flushed. Always intercept; the
    // first handler finishes the cleanup and calls app.exit(0) itself.
    event.preventDefault()
    if (quitInProgress) return
    quitInProgress = true
    // 0.1.18 (WP3): wait for the process trees to actually die before exiting.
    // The old synchronous handler returned while grandchildren (ComfyUI, pip)
    // were still alive, so ports/VRAM stayed occupied after "quit".
    if (monitorTimer) clearInterval(monitorTimer)
    monitorService.disconnectWs()
    try {
      destroyTray()
    } catch {
      /* ignore */
    }
    void (async () => {
      try {
        await instanceService.killAllForQuit(5000)
      } catch {
        /* ignore */
      }
      try {
        markSessionCleanExit()
      } catch {
        /* ignore */
      }
      try {
        flushPendingWrites()
        // 0.1.17 (WP7): the prompt→workflow sidecar is debounced too.
        flushPromptLinks()
        // 0.1.18 (regression): batch progress is coalesced for 400 ms; flush it
        // before exit or the last accepted promptIds are lost on quit.
        batchService.flushBatchWrites()
      } catch {
        /* ignore */
      }
      app.exit(0)
    })()
  })
})

// A crashed renderer/GPU/utility child used to leave no trace. Record every
// child-process termination so a future unexpected exit is diagnosable (0.1.16).
app.on('child-process-gone', (_event, details) => {
  try {
    crashLog(
      `CHILD PROCESS GONE type=${details.type} reason=${details.reason} exit=${details.exitCode}`
    )
  } catch {
    /* ignore */
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
