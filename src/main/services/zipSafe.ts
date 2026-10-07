import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, isAbsolute, normalize, resolve, sep } from 'path'
import { existsSync, readdirSync, lstatSync, realpathSync, rmSync } from 'fs'
import { isPathInside, isWinReservedName, normalizePathEverySegment, normalizePathSegment } from './security'

const execFileAsync = promisify(execFile)
const EXEC = { timeout: 60000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 } as const

/** List zip entry names without extracting. */
export async function listZipEntries(zipPath: string): Promise<string[]> {
  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')`,
      '$z.Entries | ForEach-Object { $_.FullName }',
      '$z.Dispose()'
    ].join(';')
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', ps],
      EXEC
    )
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], EXEC)
    return stdout.split(/\n/).map((s) => s.trim()).filter(Boolean)
  } catch {
    const { stdout } = await execFileAsync('zipinfo', ['-1', zipPath], EXEC)
    return stdout.split(/\n/).map((s) => s.trim()).filter(Boolean)
  }
}

/** Returns null if safe, otherwise the offending entry. */
export function findZipSlipEntry(entries: string[]): string | null {
  for (const entry of entries) {
    if (!entry) continue
    if (entry.includes('\0')) return entry
    if (isAbsolute(entry)) return entry
    if (/^[a-zA-Z]:/.test(entry)) return entry
    // Raw parent hops including `.. ` / `..` / `../`
    if (/(^|[\\/])\.\.[\\/]*/.test(entry)) return entry

    // Per-segment Win32 checks: reserved device names, trailing dot/space, empties
    const segments = entry.split(/[\\/]/)
    while (segments.length && segments[segments.length - 1] === '') segments.pop()
    for (const seg of segments) {
      if (seg === '.') continue
      if (seg === '') return entry
      if (normalizePathSegment(seg) !== seg) return entry
      if (isWinReservedName(seg)) return entry
    }

    // After per-segment normalize any remaining `..` is a hop
    const normalized = normalizePathEverySegment(entry)
    if (normalized.split(/[\\/]+/).some((s) => s === '..')) return entry
  }
  return null
}

export async function assertZipSafe(zipPath: string): Promise<void> {
  const entries = await listZipEntries(zipPath)
  const bad = findZipSlipEntry(entries)
  if (bad) {
    throw new Error(`Zip-slip blocked (entry: ${bad.slice(0, 120)})`)
  }
}

/** Extract after validating every entry; post-check tree containment. */
export async function safeUnzip(zipPath: string, destDir: string): Promise<void> {
  await assertZipSafe(zipPath)

  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}','${destDir.replace(/'/g, "''")}', $true)`
    ].join(';')
    await execFileAsync('powershell', ['-NoProfile', '-Command', ps], EXEC)
  } else {
    await execFileAsync('unzip', ['-o', zipPath, '-d', destDir], EXEC)
  }

  // Post-extract containment walk (defense in depth)
  const stack = [destDir]
  const visited = new Set<string>()
  const markReal = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  visited.add(markReal(destDir))
  while (stack.length) {
    const dir = stack.pop()!
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (!isPathInside(full, destDir)) {
        try {
          rmSync(destDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
        throw new Error(`Zip-slip blocked (escaped: ${full.slice(0, 120)})`)
      }
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      // Symlinks can escape the tree or form directory loops — treat as unsafe
      if (st.isSymbolicLink()) {
        try {
          rmSync(destDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
        throw new Error(`Zip-slip blocked (symlink: ${full.slice(0, 120)})`)
      }
      if (st.isDirectory()) {
        const key = markReal(full)
        if (visited.has(key)) continue
        visited.add(key)
        stack.push(full)
      }
    }
  }
}

export function joinInside(root: string, ...parts: string[]): string {
  const target = normalize(resolve(root, ...parts.map((p) => normalizePathEverySegment(p))))
  if (!isPathInside(target, root)) throw new Error('Path escapes root')
  return target
}

export { existsSync, sep }
