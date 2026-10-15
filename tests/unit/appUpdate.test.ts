/**
 * App self-update service (0.1.11 base paths, unified 0.1.13):
 * - dev builds report unsupported; packaged builds surface
 *   available / not-available / error honestly (and never an older
 *   server version as available);
 * - the autoUpdater EVENT stream drives one status (checking → available →
 *   downloading(progress) → downloaded), with in-app notices;
 * - installAppUpdate refuses before a download and calls
 *   quitAndInstall(false, true) once downloaded;
 * - initAppUpdate schedules a delayed startup check with ONE retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { APP_VERSION } from '@shared/constants'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  packaged: false,
  latest: '9.9.9',
  fail: false,
  emitOnCheck: true,
  listeners: new Map<string, Array<(...a: unknown[]) => void>>(),
  quitCalls: [] as Array<[boolean?, boolean?]>,
  checkCalls: 0
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    }
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      const arr = h.listeners.get(ev) || []
      arr.push(cb)
      h.listeners.set(ev, arr)
    },
    checkForUpdates: async () => {
      h.checkCalls += 1
      if (h.fail) throw new Error('net down')
      if (h.emitOnCheck) {
        emit('checking-for-update')
        if (h.latest === APP_VERSION) emit('update-not-available')
        else emit('update-available', { version: h.latest })
      }
      return { updateInfo: { version: h.latest } }
    },
    quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => {
      h.quitCalls.push([isSilent, isForceRunAfter])
    }
  }
}))

function emit(ev: string, ...args: unknown[]): void {
  for (const cb of h.listeners.get(ev) || []) cb(...args)
}

function reset(): void {
  vi.resetModules()
  h.packaged = false
  h.latest = '9.9.9'
  h.fail = false
  h.emitOnCheck = true
  h.listeners.clear()
  h.quitCalls = []
  h.checkCalls = 0
}

describe('checkAppUpdate (0.1.11 base paths)', () => {
  beforeEach(reset)

  it('reports unsupported and streams checking → terminal in dev builds', async () => {
    const mod = await import('../../src/main/services/appUpdate')
    const seen: Array<{ status: string }> = []
    mod.setAppUpdateBroadcast((s) => seen.push(s))
    const r = await mod.checkAppUpdate()
    expect(r.status).toBe('unsupported')
    expect(r.currentVersion).toBeTruthy()
    expect(seen.map((s) => s.status)).toEqual(['checking', 'unsupported'])
    expect(mod.getLastAppUpdateStatus().status).toBe('unsupported')
  })

  it('reports available when the updater offers a newer version', async () => {
    h.packaged = true
    h.latest = '9.9.9'
    const mod = await import('../../src/main/services/appUpdate')
    const r = await mod.checkAppUpdate()
    expect(r.status).toBe('available')
    expect(r.availableVersion).toBe('9.9.9')
  })

  it('reports not-available when the offered version equals the current one', async () => {
    h.packaged = true
    h.latest = APP_VERSION
    const mod = await import('../../src/main/services/appUpdate')
    const r = await mod.checkAppUpdate()
    expect(r.status).toBe('not-available')
  })

  it('reports error (never throws) when the updater check fails', async () => {
    h.packaged = true
    h.fail = true
    const mod = await import('../../src/main/services/appUpdate')
    const r = await mod.checkAppUpdate()
    expect(r.status).toBe('error')
    expect(r.error).toContain('net down')
  })

  it('never reports an OLDER server version as available (0.1.11, event path too)', async () => {
    h.packaged = true
    h.latest = '0.0.1'
    const mod = await import('../../src/main/services/appUpdate')
    const r = await mod.checkAppUpdate()
    expect(r.status).toBe('not-available')
  })
})

describe('self-update stream & install (0.1.13)', () => {
  beforeEach(reset)

  it('streams download-progress and downloaded, with in-app notices', async () => {
    h.packaged = true
    const mod = await import('../../src/main/services/appUpdate')
    const seen: any[] = []
    const notices: any[] = []
    mod.setAppUpdateBroadcast((s: any) => seen.push(s))
    mod.setAppUpdateNotify((n: any) => notices.push(n))
    await mod.checkAppUpdate()

    emit('download-progress', {
      percent: 42.4,
      bytesPerSecond: 1024 * 1024,
      transferred: 4 * 1024 * 1024,
      total: 10 * 1024 * 1024
    })
    emit('update-downloaded', { version: '9.9.9' })

    // The manual path broadcasts `checking` and the updater's own
    // checking-for-update event confirms it — collapse adjacent dupes but
    // keep the order contract.
    const statuses = seen.map((s) => s.status).filter((s, i, arr) => s !== arr[i - 1])
    expect(statuses).toEqual(['checking', 'available', 'downloading', 'downloaded'])
    const progressFrame = seen.find((s) => s.status === 'downloading')
    expect(progressFrame?.progress?.percent).toBe(42)
    expect(progressFrame?.progress?.total).toBe(10 * 1024 * 1024)
    const final = mod.getLastAppUpdateStatus()
    expect(final.status).toBe('downloaded')
    expect(final.availableVersion).toBe('9.9.9')
    // An in-app notice for BOTH milestones — the missing user hint of the
    // old silent background check.
    expect(notices.map((n) => n.titleKey)).toEqual([
      'notify.appUpdateAvailable',
      'notify.appUpdateDownloaded'
    ])
  })

  it('installAppUpdate refuses before a download and calls quitAndInstall after', async () => {
    h.packaged = true
    const mod = await import('../../src/main/services/appUpdate')
    const early = await mod.installAppUpdate()
    expect(early.ok).toBe(false)
    expect(String(early.error)).toContain('No downloaded update')

    await mod.checkAppUpdate()
    emit('update-downloaded', { version: '9.9.9' })
    const r = await mod.installAppUpdate()
    expect(r.ok).toBe(true)
    // Show the NSIS installer UI, relaunch after install.
    expect(h.quitCalls).toEqual([[false, true]])
  })

  it('initAppUpdate schedules a delayed startup check with one retry', async () => {
    vi.useFakeTimers()
    try {
      h.packaged = true
      h.fail = true
      const mod = await import('../../src/main/services/appUpdate')
      await mod.initAppUpdate({ enableAutoCheckUpdates: true })
      expect(h.checkCalls).toBe(0)
      await vi.advanceTimersByTimeAsync(4000)
      expect(h.checkCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(h.checkCalls).toBe(2)
      // No third attempt — the second failure lands as an honest error.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(h.checkCalls).toBe(2)
      expect(mod.getLastAppUpdateStatus().status).toBe('error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('initAppUpdate respects the disabled setting (no check scheduled)', async () => {
    vi.useFakeTimers()
    try {
      h.packaged = true
      const mod = await import('../../src/main/services/appUpdate')
      await mod.initAppUpdate({ enableAutoCheckUpdates: false })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(h.checkCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('initAppUpdate does nothing in dev builds', async () => {
    vi.useFakeTimers()
    try {
      h.packaged = false
      const mod = await import('../../src/main/services/appUpdate')
      await mod.initAppUpdate({ enableAutoCheckUpdates: true })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(h.checkCalls).toBe(0)
      expect(h.listeners.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the check RESULT when the updater emits no events', async () => {
    h.packaged = true
    h.emitOnCheck = false
    h.latest = '9.9.9'
    const mod = await import('../../src/main/services/appUpdate')
    const r = await mod.checkAppUpdate()
    expect(r.status).toBe('available')
    expect(r.availableVersion).toBe('9.9.9')

    h.latest = APP_VERSION
    const r2 = await mod.checkAppUpdate()
    expect(r2.status).toBe('not-available')
  })

  it('tolerates an update-available event without a version', async () => {
    h.packaged = true
    const mod = await import('../../src/main/services/appUpdate')
    await mod.checkAppUpdate() // establishes availableVersion 9.9.9
    emit('update-available', {})
    const s = mod.getLastAppUpdateStatus()
    expect(s.status).toBe('available')
    expect(s.availableVersion).toBe('9.9.9')
  })
})
