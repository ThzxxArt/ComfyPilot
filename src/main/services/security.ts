import { isAbsolute, normalize, resolve, sep } from 'path'
import { randomUUID } from 'crypto'

/** Path traversal + allowlist helpers used across main-process services. */

export function sanitizeId(id: string, fallback = ''): string {
  const cleaned = String(id || '')
    .replace(/[^\w.-]/g, '_')
    .slice(0, 120)
  return cleaned || fallback || randomUUID()
}

export function isPathInside(child: string, parent: string): boolean {
  const resolvedChild = resolve(child)
  const resolvedParent = resolve(parent)
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + sep)
}

export function safeJoin(root: string, ...parts: string[]): string {
  const target = normalize(resolve(root, ...parts))
  if (!isPathInside(target, root) && resolve(root) !== target) {
    throw new Error(`Path escapes root: ${target}`)
  }
  return target
}

export function safeResolveUnder(appRoot: string, relative: string): string | null {
  try {
    const decoded = decodeURIComponent(relative).replace(/^[/\\]+/, '')
    if (decoded.includes('\0')) return null
    const target = resolve(appRoot, decoded)
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
    // Embed only local ComfyUI frontends / http(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function assertSafeRelativeFilename(name: string): string {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/\.\./g, '_')
    .trim()
  if (!cleaned) throw new Error('Empty filename')
  return cleaned
}

export function isAbsoluteOrRelativePath(p: string): boolean {
  return Boolean(p) && (isAbsolute(p) || p.includes('/') || p.includes('\\'))
}
