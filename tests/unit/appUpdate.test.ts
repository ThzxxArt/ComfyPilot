/**
 * App self-update check (0.1.11) — dev builds report unsupported; packaged
 * builds surface available / not-available / error honestly and stream each
 * state to the renderer (the auto-update channel is now visible).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { APP_VERSION } from '@shared/constants'

const h = vi.hoisted(() => ({ packaged: false, latest: '9.9.9', fail: false }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    }
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates: async () => {
      if (h.fail) throw new Error('net down')
      return { updateInfo: { version: h.latest } }
    }
  }
}))

describe('checkAppUpdate (0.1.11)', () => {
  beforeEach(() => {
    vi.resetModules()
    h.packaged = false
    h.latest = '9.9.9'
    h.fail = false
  })

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

  it('never reports an OLDER server version as available (0.1.11)', async () => {
    h.packaged = true
    h.latest = '0.0.1'
    const mod = await import('../../src/main/services/appUpdate')
    const r = await mod.checkAppUpdate()
    expect(r.status).toBe('not-available')
  })
})
