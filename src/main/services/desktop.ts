import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const execFileAsync = promisify(execFile)

export interface ShortcutRequest {
  /** Absolute path of the executable to launch */
  targetPath: string
  /** Shortcut display name (no extension) */
  name: string
  cwd?: string
  iconPath?: string
  args?: string[]
}

function desktopDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.USERPROFILE || homedir(), 'Desktop')
  }
  return join(homedir(), 'Desktop')
}

function safeShortcutName(name: string): string {
  const cleaned = String(name || 'ComfyPilot')
    // Control chars (incl. newlines) must never reach .desktop / .lnk / AppleScript
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    // Strip Win32-significant trailing/leading dots & spaces BEFORE collapsing `..`
    // so "ComfyPilot..." stays "ComfyPilot" and is not turned into "ComfyPilot_".
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '')
    .replace(/\.{2,}/g, '_')
    .trim()
  return cleaned || 'ComfyPilot'
}

/** Escape a string for an AppleScript double-quoted literal. */
function applescriptQuote(s: string): string {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Current app executable (packaged) or throw in dev — a shortcut to bare electron.exe cannot launch the app. */
export function appExecutablePath(): string {
  if (app.isPackaged) return app.getPath('exe')
  throw new Error('Desktop shortcut requires a packaged build (dev electron.exe cannot launch ComfyPilot alone)')
}

export function appIconPath(): string | undefined {
  const resources = process.resourcesPath || ''
  const candidates =
    process.platform === 'win32'
      ? ['ComfyPilot.ico', 'comfypilot-windows-256.png']
      : process.platform === 'darwin'
        ? ['ComfyPilot.icns', 'comfypilot-macos-512.png']
        : ['comfypilot-appstore-512.png']
  for (const base of [join(resources, 'resources'), join(app.getAppPath(), 'resources')]) {
    for (const name of candidates) {
      const p = join(base, name)
      if (existsSync(p)) return p
    }
  }
  return undefined
}

/**
 * Create a desktop shortcut that launches ComfyPilot.
 * Windows: .lnk via WScript.Shell; macOS: .app bundle via osascript; Linux: .desktop.
 */
export async function createDesktopShortcut(req: ShortcutRequest): Promise<string> {
  const name = safeShortcutName(req.name)
  const target = req.targetPath
  if (!target || !existsSync(target)) {
    throw new Error(`Shortcut target not found: ${target}`)
  }
  const dir = desktopDir()
  mkdirSync(dir, { recursive: true })

  if (process.platform === 'win32') {
    const lnk = join(dir, `${name}.lnk`)
    const icon = req.iconPath || appIconPath() || target
    // Escape for PowerShell single-quoted string ('' → escaped quote)
    const q = (s: string): string => `'${String(s).replace(/'/g, "''")}'`
    const argsPart = (req.args || []).map((a) => q(a)).join(',')
    const script = [
      `$W = New-Object -ComObject WScript.Shell`,
      `$S = $W.CreateShortcut(${q(lnk)})`,
      `$S.TargetPath = ${q(target)}`,
      `$S.WorkingDirectory = ${q(req.cwd || dir)}`,
      `$S.IconLocation = ${q(icon)}`,
      argsPart ? `$S.Arguments = ${q((req.args || []).join(' '))}` : `$S.Arguments = ''`,
      `$S.Save()`,
      `Write-Output ${q(lnk)}`
    ].join('; ')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000, windowsHide: true }
    )
    return stdout.trim() || lnk
  }

  if (process.platform === 'darwin') {
    const appBundle = join(dir, `${name}.app`)
    const script = [
      `set appPath to POSIX file ${applescriptQuote(target)}`,
      'tell application "Finder"',
      `  make alias file to appPath at POSIX file ${applescriptQuote(dir)} with properties {name:${applescriptQuote(name)}}`,
      'end tell'
    ].join('\n')
    await execFileAsync('osascript', ['-e', script], { timeout: 15000 })
    return appBundle
  }

  // Linux freedesktop
  const desktopFile = join(dir, `${name}.desktop`)
  const icon = req.iconPath || appIconPath() || ''
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Exec="${target}" ${(req.args || []).map((a) => `"${a}"`).join(' ')}`.trim(),
    `Path=${req.cwd || dir}`,
    icon ? `Icon=${icon}` : '',
    'Terminal=false',
    'Categories=Utility;Development;'
  ]
    .filter(Boolean)
    .join('\n')
  writeFileSync(desktopFile, content + '\n', { mode: 0o755 })
  return desktopFile
}

export function removeDesktopShortcut(name: string): boolean {
  const safe = safeShortcutName(name)
  const dir = desktopDir()
  const candidates =
    process.platform === 'win32'
      ? [join(dir, `${safe}.lnk`)]
      : process.platform === 'darwin'
        ? [join(dir, `${safe}.app`)]
        : [join(dir, `${safe}.desktop`)]
  let removed = false
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        unlinkSync(p)
        removed = true
      }
    } catch {
      /* ignore */
    }
  }
  return removed
}

/** Toggle "launch ComfyPilot when I sign in". */
export function setLaunchOnBoot(enabled: boolean): void {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: app.getPath('exe'),
      args: []
    })
  }
}

export function isLaunchOnBoot(): boolean {
  try {
    return Boolean(app.getLoginItemSettings().openAtLogin)
  } catch {
    return false
  }
}
