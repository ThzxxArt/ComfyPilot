/**
 * App self-update surface (0.1.11).
 *
 * Before this, auto-update was a silent background call with no user-visible
 * result — the auto-update channel could not be verified or surfaced. This module
 * exposes a manual check (IPC) + status broadcast (event:app-update) while the
 * existing background `checkForUpdatesAndNotify` stays untouched.
 */
import { app } from 'electron'
import type { AppUpdateStatus } from '@shared/types'
import { APP_VERSION } from '@shared/constants'
import { compareVersions } from '@shared/version'

type UpdaterLike = {
  checkForUpdates?: () => Promise<{ updateInfo?: { version?: string } } | null>
}

let broadcastFn: ((status: AppUpdateStatus) => void) | null = null

/** Wire the IPC broadcast once the main window plumbing exists. */
export function setAppUpdateBroadcast(fn: (status: AppUpdateStatus) => void): void {
  broadcastFn = fn
}

let lastStatus: AppUpdateStatus = {
  status: 'unsupported',
  currentVersion: APP_VERSION,
  checkedAt: 0
}

export function getLastAppUpdateStatus(): AppUpdateStatus {
  return lastStatus
}

async function resolveUpdater(): Promise<UpdaterLike | null> {
  try {
    const updater = (await import('electron-updater')) as unknown as {
      autoUpdater?: UpdaterLike
      default?: { autoUpdater?: UpdaterLike }
    }
    return updater.autoUpdater || updater.default?.autoUpdater || null
  } catch {
    return null
  }
}

/** Manual self-update check. Dev builds report `unsupported` (no updater). */
export async function checkAppUpdate(): Promise<AppUpdateStatus> {
  const checking: AppUpdateStatus = {
    status: 'checking',
    currentVersion: APP_VERSION,
    checkedAt: Date.now()
  }
  lastStatus = checking
  broadcastFn?.(checking)

  const finish = (s: AppUpdateStatus): AppUpdateStatus => {
    lastStatus = s
    broadcastFn?.(s)
    return s
  }

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

  try {
    const result = await updater.checkForUpdates()
    const latest = result?.updateInfo?.version
    // Direction matters: an older server offering must never read as
    // "available" (0.1.11).
    const available = Boolean(latest && compareVersions(latest, APP_VERSION) > 0)
    return finish({
      status: available ? 'available' : 'not-available',
      currentVersion: APP_VERSION,
      availableVersion: latest,
      checkedAt: Date.now()
    })
  } catch (err) {
    return finish({
      status: 'error',
      currentVersion: APP_VERSION,
      error: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now()
    })
  }
}
