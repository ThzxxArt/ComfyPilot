/**
 * 0.2.5 WP8 — desktop service: shortcut escaping, autostart and packaged-only
 * executable resolution. These paths were previously almost untested (4.41%
 * lines) even though they write `.lnk` / `.desktop` and registry login items.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  desktop: '',
  packaged: true,
  execCalls: [] as Array<{ cmd: string; args: string[] }>,
  execStdout: 'C:/Desktop/ComfyPilot.lnk',
  login: { openAtLogin: false }
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged
    },
    getPath: (name: string) => {
      if (name === 'desktop') return h.desktop
      if (name === 'exe') return join(h.root, 'ComfyPilot.exe')
      return h.root
    },
    getAppPath: () => h.root,
    setLoginItemSettings: (v: { openAtLogin: boolean }) => {
      h.login = v
    },
    getLoginItemSettings: () => h.login
  }
}))

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb?: unknown) => {
    h.execCalls.push({ cmd, args })
    const done = typeof _opts === 'function' ? _opts : cb
    if (typeof done === 'function') {
      queueMicrotask(() =>
        (done as (...a: unknown[]) => void)(
          null,
          // promisify(execFile) expects `{ stdout, stderr }`; a plain string
          // resolves to `undefined.stdout`.
          { stdout: h.execStdout, stderr: '' },
          ''
        )
      )
    }
    return { pid: 1 }
  }
}))

import {
  appExecutablePath,
  createDesktopShortcut,
  isLaunchOnBoot,
  removeDesktopShortcut,
  safeShortcutName,
  setLaunchOnBoot
} from '../../src/main/services/desktop'

function forcePlatform(value: NodeJS.Platform): () => void {
  const real = process.platform
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => Object.defineProperty(process, 'platform', { value: real, configurable: true })
}

let restorePlatform: (() => void) | null = null

beforeEach(() => {
  h.root = mkdtempSync(join(tmpdir(), 'cp-desktop-'))
  h.desktop = join(h.root, 'Desktop')
  mkdirSync(h.desktop, { recursive: true })
  h.packaged = true
  h.execCalls = []
  h.execStdout = 'C:/Desktop/ComfyPilot.lnk'
  h.login = { openAtLogin: false }
})

afterEach(() => {
  restorePlatform?.()
  restorePlatform = null
  rmSync(h.root, { recursive: true, force: true })
})

describe('desktop shortcuts (0.2.5 WP8)', () => {
  it('sanitizes Windows-significant characters, control chars and dot tricks', () => {
    expect(safeShortcutName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(safeShortcutName('ComfyPilot...')).toBe('ComfyPilot')
    expect(safeShortcutName('  ..hidden..  ')).toBe('hidden')
    expect(safeShortcutName('bad\nname\t')).toBe('badname')
    expect(safeShortcutName('')).toBe('ComfyPilot')
  })

  it('escapes the .lnk path and every argument for PowerShell single quotes', async () => {
    restorePlatform = forcePlatform('win32')
    const target = join(h.root, 'ComfyPilot.exe')
    writeFileSync(target, '')
    const result = await createDesktopShortcut({
      targetPath: target,
      name: "Dad's Comfy/Core",
      cwd: h.desktop,
      args: ['--rescue', "O'Brien"]
    })
    expect(result).toBe('C:/Desktop/ComfyPilot.lnk')
    const call = h.execCalls[0]
    expect(call.cmd).toBe('powershell.exe')
    const script = call.args[call.args.length - 1]
    // Path and arguments are single-quoted; apostrophes must be doubled.
    expect(script).toContain("Dad''s Comfy_Core.lnk")
    expect(script).toContain("O''Brien")
    expect(script).toContain("$S.Arguments = '--rescue O''Brien'")
  })

  it('refuses a missing shortcut target before touching the desktop', async () => {
    restorePlatform = forcePlatform('win32')
    await expect(
      createDesktopShortcut({ targetPath: join(h.root, 'missing.exe'), name: 'X' })
    ).rejects.toThrow(/target not found/i)
    expect(h.execCalls).toHaveLength(0)
  })

  it('uses osascript on macOS with a quoted POSIX path', async () => {
    restorePlatform = forcePlatform('darwin')
    const target = join(h.root, 'ComfyPilot.app')
    writeFileSync(target, '')
    const result = await createDesktopShortcut({ targetPath: target, name: 'Comfy' })
    expect(result).toBe(join(h.desktop, 'Comfy.app'))
    expect(h.execCalls[0].cmd).toBe('osascript')
    expect(h.execCalls[0].args.join(' ')).toContain('POSIX file')
  })

  it('writes an executable .desktop file on Linux and removes it again', async () => {
    restorePlatform = forcePlatform('linux')
    const target = join(h.root, 'ComfyPilot')
    writeFileSync(target, '')
    const file = await createDesktopShortcut({
      targetPath: target,
      name: 'ComfyPilot',
      args: ['--rescue', 'i1']
    })
    expect(file).toBe(join(h.desktop, 'ComfyPilot.desktop'))
    const body = readFileSync(file, 'utf-8')
    expect(body).toContain('Type=Application')
    expect(body).toContain(`Exec="${target}" "--rescue" "i1"`)
    expect(statSync(file).mode & 0o777).toBe(0o755)
    expect(removeDesktopShortcut('ComfyPilot')).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(removeDesktopShortcut('ComfyPilot')).toBe(false)
  })

  it('creates and removes the Linux XDG autostart entry', () => {
    restorePlatform = forcePlatform('linux')
    const xdg = join(h.root, 'xdg')
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = xdg
    try {
      setLaunchOnBoot(true)
      const file = join(xdg, 'autostart', 'comfypilot.desktop')
      expect(existsSync(file)).toBe(true)
      expect(statSync(file).mode & 0o777).toBe(0o755)
      expect(readFileSync(file, 'utf-8')).toContain('X-GNOME-Autostart-enabled=true')
      expect(isLaunchOnBoot()).toBe(true)
      setLaunchOnBoot(false)
      expect(existsSync(file)).toBe(false)
      expect(isLaunchOnBoot()).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
  })

  it('uses Electron login items on Windows/macOS', () => {
    restorePlatform = forcePlatform('win32')
    setLaunchOnBoot(true)
    expect(h.login.openAtLogin).toBe(true)
    expect(isLaunchOnBoot()).toBe(true)
    setLaunchOnBoot(false)
    expect(h.login.openAtLogin).toBe(false)
  })

  it('refuses to point a shortcut at the dev electron binary', () => {
    h.packaged = false
    expect(() => appExecutablePath()).toThrow(/packaged build/i)
    h.packaged = true
    expect(appExecutablePath()).toBe(join(h.root, 'ComfyPilot.exe'))
  })
})
