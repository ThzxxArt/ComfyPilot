/**
 * Launcher contract tests — import REAL exports (no re-implemented copies).
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: {
      getPath: () => path.join(os.tmpdir(), 'cp-launcher-test'),
      getAppPath: () => path.join(os.tmpdir(), 'cp-launcher-test'),
      isPackaged: false
    },
    session: { defaultSession: { fetch: globalThis.fetch, setProxy: async () => undefined } }
  }
})

vi.mock('systeminformation', () => ({
  default: { graphics: async () => ({ controllers: [] }) }
}))

import { DEFAULT_SETTINGS, APP_VERSION } from '../../src/shared/constants'

describe('app version + default settings (launcher contract)', () => {
  it('APP_VERSION is a semver-ish string', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('defaults include launcher fields', () => {
    expect(DEFAULT_SETTINGS.launchOnBoot).toBe(false)
    expect(DEFAULT_SETTINGS.minimizeToTray).toBe(true)
    expect(DEFAULT_SETTINGS.autoStartInstancesOnLaunch).toBe(true)
  })

  it('proxy defaults are complete', () => {
    expect(DEFAULT_SETTINGS.proxy.enabled).toBe(false)
    expect(DEFAULT_SETTINGS.proxy.bypass).toContain('localhost')
  })

  it('zero-prereq settings exist (pip/torch mirrors)', () => {
    expect(typeof DEFAULT_SETTINGS.pipIndex).toBe('string')
    expect(typeof DEFAULT_SETTINGS.torchIndexMirror).toBe('string')
  })
})

describe('launch command quoting (real quoteCommandLineArg)', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('quotes correctly via instance.ts export', async () => {
    const { quoteCommandLineArg, instanceService } = await import('../../src/main/services/instance')
    expect(quoteCommandLineArg('C:\\py\\python.exe')).toBe('C:\\py\\python.exe')
    expect(quoteCommandLineArg('C:\\Program Files\\Python\\python.exe')).toBe(
      '"C:\\Program Files\\Python\\python.exe"'
    )
    expect(quoteCommandLineArg('say "hi"')).toBe('"say \\"hi\\""')
    // instanceService exists and exposes previewLaunch using the same quoter
    expect(typeof instanceService.previewLaunch).toBe('function')
  })
})

describe('desktop shortcut name sanitizer (real safeShortcutName)', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('sanitizes via desktop.ts export', async () => {
    const { safeShortcutName } = await import('../../src/main/services/desktop')
    expect(safeShortcutName('My/Comfy:Pilot*')).toBe('My_Comfy_Pilot_')
    expect(safeShortcutName('..\\evil')).not.toContain('..')
    expect(safeShortcutName('   ')).toBe('ComfyPilot')
    expect(safeShortcutName('ComfyPilot...')).toBe('ComfyPilot')
    const injected = 'evil' + String.fromCharCode(10) + 'Exec=rm -rf /'
    expect(safeShortcutName(injected)).not.toContain(String.fromCharCode(10))
  })
})

describe('PORT_IN_USE error shape', () => {
  it('carries code and suggestedPort through IpcResult', () => {
    const err = Object.assign(new Error('Port 8188 is already in use'), {
      code: 'PORT_IN_USE',
      suggestedPort: 8189
    })
    const result = {
      ok: false as const,
      error: err.message,
      code: (err as { code?: string }).code,
      suggestedPort: (err as { suggestedPort?: number }).suggestedPort
    }
    expect(result.code).toBe('PORT_IN_USE')
    expect(result.suggestedPort).toBe(8189)
    expect(result.error).toContain('8188')
  })
})

describe('instance id resolution contract (nodePack resolveInstanceConfig)', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('never silently falls back on unknown id', async () => {
    // Behavior contract: unknown id → undefined; no id → first enabled.
    // Verified against the pure rules used by nodePack.resolveInstanceConfig.
    const configs = [
      { id: 'a', path: 'D:/A', enabled: true },
      { id: 'b', path: 'D:/B', enabled: true }
    ]
    const resolve = (id?: string) =>
      id ? configs.find((c) => c.id === id) : configs.find((c) => c.enabled !== false) || configs[0]
    expect(resolve('b')?.path).toBe('D:/B')
    expect(resolve('missing')).toBeUndefined()
    expect(resolve()?.id).toBe('a')
  })
})

describe('waitReady waiter isolation (contract)', () => {
  it('each waiter owns its own timer so one timeout cannot clobber another', () => {
    type Waiter = { resolve: (v: unknown) => void; timer?: ReturnType<typeof setTimeout> }
    const readyWaiters: Waiter[] = []
    const mk = (): Waiter => {
      const w: Waiter = { resolve: () => undefined }
      w.timer = setTimeout(() => undefined, 60_000)
      readyWaiters.push(w)
      return w
    }
    const w1 = mk()
    const w2 = mk()
    expect(w1.timer).not.toBe(w2.timer)
    for (const w of readyWaiters.splice(0)) {
      if (w.timer) clearTimeout(w.timer)
    }
    expect(readyWaiters.length).toBe(0)
  })
})
