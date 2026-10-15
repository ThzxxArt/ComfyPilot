/**
 * App self-update surface (0.1.11, unified in 0.1.13).
 *
 * The 0.1.11 version had TWO disconnected paths: a background
 * `checkForUpdatesAndNotify` with no visible state (no in-app hint, no
 * install entry) and a manual check that reported only checking/available —
 * download progress, "downloaded" and the install step were invisible.
 *
 * This service is the single owner now:
 * - wires every autoUpdater event (checking / available / not-available /
 *   download-progress / downloaded / error) into ONE broadcast status,
 * - streams download progress so the UI can show percent + speed,
 * - raises an in-app notification when an update is found / downloaded,
 * - exposes `installAppUpdate()` → quitAndInstall with an honest error when
 *   nothing has been downloaded yet.
 *
 * Startup checks are delayed (early-network failures used to vanish without
 * a retry) and retried once — see `initAppUpdate`.
 */
import { app } from 'electron'
import type { AppUpdateStatus } from '@shared/types'
import { APP_VERSION } from '@shared/constants'
import { compareVersions } from '@shared/version'

/** Minimal structural type for electron-updater's autoUpdater. */
type AutoUpdaterLike = {
  checkForUpdates?: () => Promise<{ updateInfo?: { version?: string } } | null>
  quitAndInstall?: (isSilent?: boolean, isForceRunAfter?: boolean) => void
  on?: (event: string, cb: (...args: unknown[]) => void) => void
  autoInstallOnAppQuit?: boolean
  autoDownload?: boolean
}

/** Notification shape accepted by the injected notifier (broadcastNotification). */
export interface AppUpdateNotice {
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  titleKey?: string
  message: string
  messageKey?: string
  params?: Record<string, string | number>
  duration?: number
}

let broadcastFn: ((status: AppUpdateStatus) => void) | null = null
let notifyFn: ((notice: AppUpdateNotice) => void) | null = null

/** Wire the IPC broadcast once the main window plumbing exists. */
export function setAppUpdateBroadcast(fn: (status: AppUpdateStatus) => void): void {
  broadcastFn = fn
}

/** Wire the in-app notifier (toast + OS notification via broadcastNotification). */
export function setAppUpdateNotify(fn: (notice: AppUpdateNotice) => void): void {
  notifyFn = fn
}

let lastStatus: AppUpdateStatus = {
  status: 'unsupported',
  currentVersion: APP_VERSION,
  checkedAt: 0
}

export function getLastAppUpdateStatus(): AppUpdateStatus {
  return lastStatus
}

const finish = (s: AppUpdateStatus): AppUpdateStatus => {
  lastStatus = s
  broadcastFn?.(s)
  return s
}

async function resolveUpdater(): Promise<AutoUpdaterLike | null> {
  try {
    const updater = (await import('electron-updater')) as unknown as {
      autoUpdater?: AutoUpdaterLike
      default?: { autoUpdater?: AutoUpdaterLike }
    }
    return updater.autoUpdater || updater.default?.autoUpdater || null
  } catch {
    return null
  }
}

let wired = false

/**
 * Wire every autoUpdater event into the single status stream. Idempotent —
 * both the startup path and the manual check may call it.
 */
function wireEvents(au: AutoUpdaterLike): void {
  if (wired) return
  wired = true
  au.on?.('checking-for-update', () => {
    finish({
      status: 'checking',
      currentVersion: APP_VERSION,
      availableVersion: lastStatus.availableVersion,
      checkedAt: Date.now()
    })
  })
  au.on?.('update-available', (info) => {
    const version = String((info as { version?: unknown })?.version || '')
    // Direction matters: an older server offering must never read as
    // "available" (0.1.11 semantics kept for the event path too).
    if (version && compareVersions(version, APP_VERSION) <= 0) {
      finish({ status: 'not-available', currentVersion: APP_VERSION, checkedAt: Date.now() })
      return
    }
    finish({
      status: 'available',
      currentVersion: APP_VERSION,
      availableVersion: version || lastStatus.availableVersion,
      checkedAt: Date.now()
    })
    notifyFn?.({
      type: 'info',
      title: 'Update available',
      titleKey: 'notify.appUpdateAvailable',
      message: version ? `Downloading v${version} in the background` : 'Downloading…',
      messageKey: 'notify.appUpdateAvailableMsg',
      params: { version },
      duration: 8000
    })
  })
  au.on?.('update-not-available', () => {
    finish({ status: 'not-available', currentVersion: APP_VERSION, checkedAt: Date.now() })
  })
  au.on?.('download-progress', (p) => {
    const pp = p as {
      percent?: number
      bytesPerSecond?: number
      transferred?: number
      total?: number
    }
    finish({
      status: 'downloading',
      currentVersion: APP_VERSION,
      availableVersion: lastStatus.availableVersion,
      progress: {
        percent: Math.max(0, Math.min(100, Math.round(pp?.percent ?? 0))),
        bytesPerSecond: pp?.bytesPerSecond,
        transferred: pp?.transferred,
        total: pp?.total
      },
      checkedAt: Date.now()
    })
  })
  au.on?.('update-downloaded', (info) => {
    const version = String((info as { version?: unknown })?.version || '')
    const ready = version || lastStatus.availableVersion || ''
    finish({
      status: 'downloaded',
      currentVersion: APP_VERSION,
      availableVersion: ready,
      checkedAt: Date.now()
    })
    notifyFn?.({
      type: 'success',
      title: 'Update ready',
      titleKey: 'notify.appUpdateDownloaded',
      message: ready
        ? `v${ready} downloaded — restart to install`
        : 'Update downloaded — restart to install',
      messageKey: 'notify.appUpdateDownloadedMsg',
      params: { version: ready },
      duration: 10000
    })
  })
  au.on?.('error', (e) => {
    const msg = e instanceof Error ? e.message : String(e)
    finish({
      status: 'error',
      currentVersion: APP_VERSION,
      availableVersion: lastStatus.availableVersion,
      error: msg.slice(0, 300),
      checkedAt: Date.now()
    })
  })
}

/**
 * Startup wiring (packaged builds only): configure auto-download, wire the
 * event stream and run the startup check when the setting allows it.
 * The check is delayed (early DNS/proxy is often not ready yet) and retried
 * once after 30s — the old fire-and-forget vanished into a crash log.
 */
export async function initAppUpdate(opts?: { enableAutoCheckUpdates?: boolean }): Promise<void> {
  if (!app.isPackaged) return
  const au = await resolveUpdater()
  if (!au) return
  wireEvents(au)
  try {
    au.autoDownload = true
  } catch {
    /* older updaters may not expose the flag — default is true anyway */
  }
  try {
    au.autoInstallOnAppQuit = true
  } catch {
    /* default is true anyway */
  }
  if (opts?.enableAutoCheckUpdates === false) return
  const attempt = (n: number): void => {
    const check = au.checkForUpdates?.()
    if (!check || typeof check.catch !== 'function') return
    check.catch((e) => {
      // Retry once — a first-attempt network failure at boot is common and
      // used to be the end of it (0.1.13: "started with the setting on and
      // nothing ever happened").
      if (n < 2) {
        setTimeout(() => attempt(n + 1), 30_000)
        return
      }
      finish({
        status: 'error',
        currentVersion: APP_VERSION,
        availableVersion: lastStatus.availableVersion,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        checkedAt: Date.now()
      })
    })
  }
  setTimeout(() => attempt(1), 4000)
}

/** Manual self-update check. Dev builds report `unsupported` (no updater). */
export async function checkAppUpdate(): Promise<AppUpdateStatus> {
  const checking: AppUpdateStatus = {
    status: 'checking',
    currentVersion: APP_VERSION,
    availableVersion: lastStatus.availableVersion,
    checkedAt: Date.now()
  }
  lastStatus = checking
  broadcastFn?.(checking)

  if (!app.isPackaged) {
    return finish({
      status: 'unsupported',
      currentVersion: APP_VERSION,
      error: 'Auto-update checks run in packaged builds only',
      checkedAt: Date.now()
    })
  }

  const updater = await resolveUpdater()
  if (!updater || typeof updater.checkForUpdates !== 'function') {
    return finish({
      status: 'unsupported',
      currentVersion: APP_VERSION,
      error: 'Updater API unavailable',
      checkedAt: Date.now()
    })
  }
  // A manual check must not lose the wired event stream (progress /
  // downloaded / errors all arrive as events now).
  wireEvents(updater)

  try {
    const result = await updater.checkForUpdates()
    // The event stream is authoritative; this fallback covers updaters that
    // return a result without emitting events.
    if (lastStatus.status === 'checking') {
      const latest = result?.updateInfo?.version
      const available = Boolean(latest && compareVersions(latest, APP_VERSION) > 0)
      return finish({
        status: available ? 'available' : 'not-available',
        currentVersion: APP_VERSION,
        availableVersion: latest,
        checkedAt: Date.now()
      })
    }
    return lastStatus
  } catch (err) {
    return finish({
      status: 'error',
      currentVersion: APP_VERSION,
      error: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now()
    })
  }
}

/**
 * Quit and run the installer for a DOWNLOADED update (0.1.13). Honest error
 * when nothing is ready — the UI only shows the button in `downloaded`.
 */
export async function installAppUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (lastStatus.status !== 'downloaded') {
    return { ok: false, error: 'No downloaded update is ready to install' }
  }
  const au = await resolveUpdater()
  if (!au || typeof au.quitAndInstall !== 'function') {
    return { ok: false, error: 'Updater API unavailable' }
  }
  try {
    // isSilent=false keeps the NSIS installer UI visible (oneClick:false
    // build); isForceRunAfter=true relaunches ComfyPilot when it's done.
    au.quitAndInstall(false, true)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
