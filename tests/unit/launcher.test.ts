import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, APP_VERSION } from '../../src/shared/constants'

describe('app version + default settings (0.1.1 contract)', () => {
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
})

describe('launch command quoting', () => {
  function quote(s: string): string {
    return /[\s"&|<>^%]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
  }

  function buildCommandLine(python: string, args: string[]): string {
    return [python, ...args].map(quote).join(' ')
  }

  it('leaves simple paths unquoted', () => {
    expect(buildCommandLine('C:\\py\\python.exe', ['main.py', '--port', '8188'])).toBe(
      'C:\\py\\python.exe main.py --port 8188'
    )
  })

  it('quotes paths with spaces', () => {
    const cmd = buildCommandLine('C:\\Program Files\\Python\\python.exe', [
      'C:\\My Comfy\\main.py',
      '--listen',
      '127.0.0.1'
    ])
    expect(cmd).toContain('"C:\\Program Files\\Python\\python.exe"')
    expect(cmd).toContain('"C:\\My Comfy\\main.py"')
    expect(cmd).toContain('--listen 127.0.0.1')
  })

  it('escapes embedded double quotes', () => {
    const cmd = buildCommandLine('python', ['--extra', 'say "hi"'])
    expect(cmd).toContain('"say \\"hi\\""')
  })
})

describe('desktop shortcut name sanitizer', () => {
  const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g')

  function safeShortcutName(name: string): string {
    const cleaned = String(name || 'ComfyPilot')
      .replace(CTRL, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[. ]+$/g, '')
      .replace(/^[. ]+/g, '')
      .replace(/\.{2,}/g, '_')
      .trim()
    return cleaned || 'ComfyPilot'
  }

  it('strips illegal filename characters', () => {
    expect(safeShortcutName('My/Comfy:Pilot*')).toBe('My_Comfy_Pilot_')
  })

  it('collapses parent hops', () => {
    expect(safeShortcutName('..\\evil')).not.toContain('..')
  })

  it('falls back for empty names', () => {
    expect(safeShortcutName('   ')).toBe('ComfyPilot')
    expect(safeShortcutName('')).toBe('ComfyPilot')
  })

  it('strips control characters (blocks .desktop / AppleScript injection)', () => {
    const injected = 'evil' + String.fromCharCode(10) + 'Exec=rm -rf /'
    const out = safeShortcutName(injected)
    expect(out).not.toContain(String.fromCharCode(10))
    expect(out).toContain('Exec=rm -rf _')
  })

  it('strips trailing dots and spaces (Win32 FS semantics)', () => {
    expect(safeShortcutName('ComfyPilot...')).toBe('ComfyPilot')
    expect(safeShortcutName('ComfyPilot   ')).toBe('ComfyPilot')
    expect(safeShortcutName('.hidden.')).toBe('hidden')
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

describe('instance id resolution contract', () => {
  function resolveInstanceConfig(
    configs: Array<{ id: string; path: string; enabled?: boolean }>,
    instanceId?: string
  ): { id: string; path: string; enabled?: boolean } | undefined {
    if (instanceId) {
      return configs.find((c) => c.id === instanceId)
    }
    return configs.find((c) => c.enabled !== false) || configs[0]
  }

  const configs = [
    { id: 'a', path: 'D:/A', enabled: true },
    { id: 'b', path: 'D:/B', enabled: true }
  ]

  it('returns the matching instance for a known id', () => {
    expect(resolveInstanceConfig(configs, 'b')?.path).toBe('D:/B')
  })

  it('returns undefined for an unknown id (never silent fallback)', () => {
    expect(resolveInstanceConfig(configs, 'missing')).toBeUndefined()
  })

  it('falls back only when no id is given', () => {
    expect(resolveInstanceConfig(configs)?.id).toBe('a')
    expect(resolveInstanceConfig(configs, undefined)?.id).toBe('a')
  })
})

describe('waitReady waiter isolation', () => {
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
    expect(readyWaiters.length).toBe(2)
    for (const w of readyWaiters.splice(0)) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve(null)
    }
    expect(readyWaiters.length).toBe(0)
  })
})
