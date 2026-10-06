import { isAbsolute, normalize, resolve, sep, dirname, basename, extname, join } from 'path'
import { randomUUID } from 'crypto'

/** Path traversal + allowlist helpers used across main-process services. */

export function sanitizeId(id: string, fallback = ''): string {
  const cleaned = String(id || '')
    .replace(/[^\w.-]/g, '_')
    .replace(/\.\.+/g, '_')
    .slice(0, 120)
  // Refuse pure dot sequences and empty
  if (!cleaned || /^\.+$/.test(cleaned)) return fallback || randomUUID()
  return cleaned
}

/** Strict filename sanitizer for download/rename targets. */
export function assertSafeRelativeFilename(name: string): string {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/[^\w.\- ]/g, '_')
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('Empty filename')
  return cleaned.slice(0, 180)
}

/**
 * Normalize a single path segment (not the whole path):
 * strip control chars, trailing/leading spaces & dots (Win32 does this at FS layer).
 */
export function normalizePathSegment(segment: string): string {
  return String(segment || '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/, '')
}

/**
 * Normalize every segment of a relative/absolute path string.
 * Critical: Win32 strips trailing spaces per component, so `.. ` must become `..`
 * BEFORE resolve, or isPathInside will be bypassed.
 */
export function normalizePathEverySegment(pathStr: string): string {
  const raw = String(pathStr || '')
  // Preserve drive prefix like `C:` on Windows
  let prefix = ''
  let rest = raw
  const drive = raw.match(/^([a-zA-Z]:)(.*)$/)
  if (drive) {
    prefix = drive[1]
    rest = drive[2]
  }
  const sep = rest.includes('\\') && !rest.includes('/') ? '\\' : '/'
  const parts = rest.split(/[\\/]+/).filter((p) => p.length > 0)
  const cleaned = parts.map((p) => normalizePathSegment(p)).filter((p) => p.length > 0)
  // If any segment collapsed to empty after normalize, reject later via ..
  const joined = cleaned.join(sep)
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    return prefix + sep + joined
  }
  return prefix + joined
}

export function isPathInside(child: string, parent: string): boolean {
  const resolvedChild = resolve(child)
  const resolvedParent = resolve(parent)
  if (resolvedChild === resolvedParent) return true
  return resolvedChild.startsWith(resolvedParent.endsWith(sep) ? resolvedParent : resolvedParent + sep)
}

export function safeJoin(root: string, ...parts: string[]): string {
  const cleaned = parts.map((p) => normalizePathEverySegment(String(p)))
  const target = normalize(resolve(root, ...cleaned))
  if (!isPathInside(target, root) && resolve(root) !== target) {
    throw new Error(`Path escapes root: ${target}`)
  }
  return target
}

export function safeResolveUnder(appRoot: string, relative: string): string | null {
  try {
    // Decode repeatedly to defeat double-encoding; reject any remaining %
    let decoded = String(relative || '')
    for (let i = 0; i < 4 && decoded.includes('%'); i++) {
      decoded = decodeURIComponent(decoded)
    }
    decoded = decoded.replace(/^[/\\]+/, '')
    if (decoded.includes('\0') || decoded.includes('%')) return null
    if (/^[a-zA-Z]:/.test(decoded)) return null // absolute drive not allowed as relative
    // Per-segment normalize THEN resolve — blocks `.. ` Win32 trailing-space hops
    const normalized = normalizePathEverySegment(decoded)
    if (!normalized) return null
    // After per-segment clean, no empty or `.` `..` may remain as meaningful hops
    const segs = normalized.split(/[\\/]+/).filter(Boolean)
    for (const s of segs) {
      if (s === '..') return null
    }
    const target = resolve(appRoot, normalized)
    return isPathInside(target, appRoot) ? target : null
  } catch {
    return null
  }
}

const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isSafeExternalUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return SAFE_EXTERNAL_PROTOCOLS.has(u.protocol)
  } catch {
    return false
  }
}

export function isSafeEmbedUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    // Prefer local ComfyUI; allow https for LAN/remote instances
    return true
  } catch {
    return false
  }
}

/** Exact host match — avoids startsWith('http://localhost') matching localhost.evil.com */
export function isLocalhostUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    return u.protocol === 'http:' || u.protocol === 'https:'
      ? host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
      : false
  } catch {
    return false
  }
}

const BLOCKED_OPEN_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.mst', '.hta', '.jar',
  '.cpl', '.reg', '.lnk', '.url', '.pif', '.application', '.gadget'
])

export function isSafeOpenPath(path: string): boolean {
  if (!path) return false
  const ext = extname(path).toLowerCase()
  if (BLOCKED_OPEN_EXTENSIONS.has(ext)) return false
  if (path.includes('\0')) return false
  return true
}

export function safeJoinFile(root: string, fileName: string): string {
  const safeName = assertSafeRelativeFilename(basename(fileName))
  const target = join(root, safeName)
  if (!isPathInside(target, root)) throw new Error('Path escapes download dir')
  return target
}

export function isAbsoluteOrRelativePath(p: string): boolean {
  return Boolean(p) && (isAbsolute(p) || p.includes('/') || p.includes('\\'))
}

export { dirname, basename, extname }

