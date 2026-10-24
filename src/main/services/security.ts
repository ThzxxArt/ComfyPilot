import { isAbsolute, normalize, resolve, dirname, basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, realpathSync, statSync } from 'fs'

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

/** Win32 reserved device names — must never be used as a file/folder segment. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export function isWinReservedName(segment: string): boolean {
  return WIN_RESERVED.test(normalizePathSegment(segment))
}

/** Strict filename sanitizer for download/rename targets. */
export function assertSafeRelativeFilename(name: string): string {
  const raw = String(name || '').trim()
  if (!raw || /^[.]+$/.test(raw)) throw new Error('Empty filename')
  const cleaned = raw
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/[^\w.\- ]/g, '_')
    .trim()
  if (!cleaned || cleaned === '.' || /^[_]+$/.test(cleaned)) throw new Error('Empty filename')
  if (isWinReservedName(cleaned)) throw new Error(`Reserved filename: ${cleaned}`)
  return cleaned.slice(0, 180)
}

/**
 * Normalize a single path segment (not the whole path):
 * Win32 strips **trailing** spaces & dots at the FS layer.
 * Leading dots MUST be preserved — `.ci` / `.github` are legitimate directory names.
 */
export function normalizePathSegment(segment: string): string {
  return (
    String(segment || '')
      // eslint-disable-next-line no-control-regex -- 剔除控制字符是这里的目的
      .replace(/[\x00-\x1f]/g, '')
      .replace(/[. ]+$/g, '')
      .replace(/^ +/, '')
  )
}

/**
 * Normalize every segment of a relative/absolute path string.
 * Critical: Win32 strips trailing spaces per component, so `.. ` must become `..`
 * BEFORE resolve, or isPathInside will be bypassed.
 */
export function normalizePathEverySegment(pathStr: string): string {
  const raw = String(pathStr || '')
  let prefix = ''
  let rest = raw
  const drive = raw.match(/^([a-zA-Z]:)(.*)$/)
  if (drive) {
    prefix = drive[1]
    rest = drive[2]
  }
  const sep = rest.includes('\\') && !rest.includes('/') ? '\\' : '/'
  const parts = rest.split(/[\\/]+/)
  const cleaned: string[] = []
  for (const p of parts) {
    if (!p) continue
    // Only dot/space-only segments (e.g. `..`, `.. `, `...`) are parent hops —
    // Windows strips trailing dots/spaces, so those collapse onto the parent.
    // Ordinary names like `a..b.png` are preserved.
    if (/^[. ]+$/.test(p) && p.split('.').length - 1 >= 2) {
      cleaned.push('..')
      continue
    }
    const n = normalizePathSegment(p)
    if (!n || n === '.') continue
    cleaned.push(n)
  }
  const joined = cleaned.join(sep)
  const hadRootSep = /^[\\/]/.test(rest)
  if (prefix) {
    // Windows drive: always keep separator after `C:`
    return prefix + sep + joined
  }
  if (hadRootSep) {
    return sep + joined
  }
  return joined
}

/** True if normalized path string still contains parent-directory hops. */
export function hasParentHop(pathStr: string): boolean {
  return normalizePathEverySegment(pathStr)
    .split(/[\\/]+/)
    .some((s) => s === '..')
}

/**
 * Normalize a path for equality/containment comparison.
 *
 * Deliberately does NOT call `path.resolve()` — on POSIX, `resolve('C:\\x')`
 * prepends the cwd (Windows drive paths look relative), and on Windows
 * `resolve('/tmp/x')` prepends the drive of the cwd. Both make cross-platform
 * containment checks fail-closed. We compare normalized string forms instead.
 */
export function normalizeForCompare(p: string): string {
  let s = String(p ?? '').replace(/\\/g, '/')
  // Collapse duplicate separators but keep a leading slash / drive.
  s = s.replace(/\/+/g, '/')
  // Drop trailing slash (except for a bare root like "/" or "C:/")
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '')
  return s
}

export function isPathInside(child: string, parent: string): boolean {
  let resolvedChild = normalizeForCompare(child)
  let resolvedParent = normalizeForCompare(parent)
  // Win32 paths are case-insensitive; without folding, `C:\Out` vs `c:\out\img`
  // fails containment (fail-closed) and breaks media thumbnails.
  if (process.platform === 'win32') {
    resolvedChild = resolvedChild.toLowerCase()
    resolvedParent = resolvedParent.toLowerCase()
  }
  if (resolvedChild === resolvedParent) return true
  return resolvedChild.startsWith(
    resolvedParent.endsWith('/') ? resolvedParent : resolvedParent + '/'
  )
}

export function safeJoin(root: string, ...parts: string[]): string {
  for (const p of parts) {
    if (hasParentHop(p)) throw new Error(`Path escapes root: ${p}`)
  }
  const cleaned = parts.map((p) => normalizePathEverySegment(String(p)))
  const target = normalize(resolve(root, ...cleaned))
  if (!isPathInside(target, root) && resolve(root) !== target) {
    throw new Error(`Path escapes root: ${target}`)
  }
  return target
}

export function safeResolveUnder(appRoot: string, relative: string): string | null {
  try {
    let decoded = String(relative || '')
    for (let i = 0; i < 4 && decoded.includes('%'); i++) {
      decoded = decodeURIComponent(decoded)
    }
    decoded = decoded.replace(/^[/\\]+/, '')
    if (decoded.includes('\0') || decoded.includes('%')) return null
    if (/^[a-zA-Z]:/.test(decoded)) return null
    if (hasParentHop(decoded)) return null
    const normalized = normalizePathEverySegment(decoded)
    if (!normalized) return null
    const target = resolve(appRoot, normalized)
    return isPathInside(target, appRoot) ? target : null
  } catch {
    return null
  }
}

/**
 * Resolve a user-supplied path and require it to stay under one of the
 * allowed roots. Uses `path.resolve` (which collapses real `..` hops while
 * preserving UNC prefixes and names that merely contain dots), guarded by the
 * per-segment hop check so Windows trailing-dot/space variants (`.. `, `... `)
 * can never slip through as lexical prefixes.
 */
export function resolveInsideAnyRoot(candidate: string, roots: string[]): string | null {
  if (!candidate || candidate.includes('\0')) return null
  // Reject dot/space-only segments (Win32 strips trailing dots/spaces, so
  // `.. ` and `... ` resolve to the parent directory).
  if (hasParentHop(candidate)) return null
  try {
    const target = resolve(candidate)
    // Defensive: a leading `..` beyond the root can survive on relative inputs.
    if (target.split(/[\\/]+/).includes('..')) return null
    for (const root of roots) {
      if (!root) continue
      const r = resolve(root)
      if (target === r || isPathInside(target, r)) return target
    }
    return null
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

/**
 * Scheme gate for embeddable URLs (0.1.16).
 *
 * Named "isSafe…" for symmetry with `isSafeExternalUrl`, but it only asserts
 * a web scheme — it does NOT decide trust. Callers MUST additionally require
 * the host to be an allowed ComfyUI origin (see `handlers.ts`
 * `isAllowedEmbedUrl`, which ANDs this with `isTrustedComfyUrl`). The scheme
 * check is separated out so a future caller can never embed a `file:`/`data:`
 * URL by accident.
 */
export function isSafeEmbedUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
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
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.msi',
  '.msp',
  '.mst',
  '.hta',
  '.jar',
  '.cpl',
  '.reg',
  '.lnk',
  '.url',
  '.pif',
  '.application',
  '.gadget',
  // 0.1.17 (WP8): the macOS/Linux launcher and bundle formats were missing —
  // `foo.command`, `Foo.app/…`, `x.desktop` and `x.AppImage` all execute on
  // the platforms that understand them, and `shell.openPath` delegates to the
  // desktop environment.
  '.desktop',
  '.command',
  '.app',
  '.appimage'
])

export function isSafeOpenPath(path: string): boolean {
  if (!path) return false
  if (path.includes('\0')) return false
  // Normalize segment so `evil.exe ` / `evil.EXE` are caught
  const seg = normalizePathSegment(basename(path))
  const ext = extname(seg).toLowerCase()
  if (BLOCKED_OPEN_EXTENSIONS.has(ext)) return false
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

/**
 * Data file extensions the renderer may ask the main process to read
 * (workflow JSON, media for import, manifests). Everything else is refused
 * before any filesystem call.
 */
export const READ_DATA_EXTS = new Set([
  '.json',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.yaml',
  '.yml',
  '.txt'
])

/**
 * Read gate for renderer-supplied data paths (0.1.16 policy, hardened 0.1.17).
 *
 * Allowed when the path:
 *   1. has a data extension and is not a blocked executable/script type,
 *   2. resolves under a root the user explicitly picked this session, or
 *   3. exists and resolves under an app-owned root.
 *
 * Containment MUST use `resolveInsideAnyRoot` (real hop collapsing). The 0.1.16
 * implementation compared normalized strings, so `D:\picked\..\..\Windows\…`
 * passed while `D:\picked` was approved.
 */
export function isSafeDataReadPath(
  path: string,
  opts: { approvedRoots: string[]; allowedRoots: string[] }
): boolean {
  if (!path || path.includes('\0')) return false
  const ext = extname(basename(path)).toLowerCase()
  if (!READ_DATA_EXTS.has(ext)) return false
  if (!isSafeOpenPath(path)) return false
  const approved = opts.approvedRoots.filter(Boolean)
  if (resolveInsideAnyRoot(path, approved)) {
    return realpathInsideAnyRoot(path, approved)
  }
  if (!existsSync(path)) return false
  const allowed = opts.allowedRoots.filter(Boolean)
  return Boolean(resolveInsideAnyRoot(path, allowed)) && realpathInsideAnyRoot(path, allowed)
}

/**
 * 0.1.17 (review fix): the lexical check above cannot see symlinks.
 * A link dropped inside an approved folder could point at any readable file and
 * still pass containment, so an existing target is resolved to its real path and
 * re-checked against the roots' real paths.
 *
 * Non-existent targets return true: the lexical check already succeeded and
 * there is no link to follow (the caller's read will simply fail).
 */
function realpathInsideAnyRoot(candidate: string, roots: string[]): boolean {
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    return true
  }
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      realRoot = resolve(root)
    }
    if (real === realRoot || isPathInside(real, realRoot)) return true
  }
  return false
}

/**
 * Settings endpoints (mirrors, indexes) must be http(s) URLs or empty.
 * They flow into installers and network probes, so a `file:`/`javascript:`
 * value turns a settings write into a local-file/scheme injection primitive.
 */
export function assertSafeEndpointSetting(field: string, raw: unknown): void {
  if (raw === undefined || raw === null || raw === '') return
  if (typeof raw !== 'string') throw new Error(`${field} must be a URL`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${field} must be a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${field} must use http(s)`)
  }
  // 0.1.17 (review fix): `https://user:token@host/` parses fine but persists the
  // credential in plaintext and leaks it into installer/probe URLs.
  if (parsed.username || parsed.password) {
    throw new Error(`${field} must not embed credentials`)
  }
}

/**
 * 0.1.18 (WP1): settings validation moved next to the other trust boundaries.
 *
 * `settings.set` used to validate only the five URL fields. Everything else was
 * persisted verbatim, including `securityLevel` — an unknown value silently
 * weakened the node-pack install gate (`nodePack.ts` only recognises the four
 * documented levels) and `modelScanRoots` could become an arbitrary read root.
 * `backup.restore` accepted the same object from a file, so the validator is
 * shared by both writers.
 */
export const SETTINGS_URL_KEYS = [
  'githubEndpoint',
  'hfEndpoint',
  'civitaiEndpoint',
  'pipIndex',
  'torchIndexMirror'
] as const

const SETTINGS_ENUM_KEYS: Record<string, readonly string[]> = {
  locale: ['zh-CN', 'en-US'],
  securityLevel: ['strong', 'normal', 'normal-', 'weak'],
  networkMode: ['public', 'private', 'offline', 'personal_cloud'],
  stopMode: ['fast', 'graceful']
}

const SETTINGS_BOOLEAN_KEYS = [
  'enableAutoCheckUpdates',
  'embedFrontend',
  'allowGitUrlInstall',
  'allowPipInstall',
  'useAria2',
  'launchOnBoot',
  'minimizeToTray',
  'autoStartInstancesOnLaunch',
  'allowUnverifiedRuntime'
] as const

/**
 * Validate the subset of `AppSettings` that is attacker-reachable (settings.set
 * from the renderer, settings.json from a backup). Unknown keys are ignored —
 * `saveSettings` strips them; this function only rejects unsafe *values*.
 */
export function assertSafeSettingsPatch(patch: Record<string, unknown>): void {
  for (const key of SETTINGS_URL_KEYS) {
    assertSafeEndpointSetting(key, patch[key])
  }
  for (const [key, allowed] of Object.entries(SETTINGS_ENUM_KEYS)) {
    const value = patch[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new Error(`${key} must be one of: ${allowed.join(', ')}`)
    }
  }
  for (const key of SETTINGS_BOOLEAN_KEYS) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
  }
  if (patch.modelScanRoots !== undefined) {
    const roots = patch.modelScanRoots
    if (!Array.isArray(roots)) throw new Error('modelScanRoots must be an array')
    for (const raw of roots) {
      if (typeof raw !== 'string' || !raw.trim())
        throw new Error('modelScanRoots entries must be paths')
      if (raw.includes('\0')) throw new Error('modelScanRoots contains an invalid path')
      if (!existsSync(raw)) throw new Error(`modelScanRoots entry does not exist: ${raw}`)
    }
  }
  if (patch.outputScanDepth !== undefined) {
    const depth = Number(patch.outputScanDepth)
    if (!Number.isInteger(depth) || depth < 2 || depth > 10) {
      throw new Error('outputScanDepth must be an integer between 2 and 10')
    }
  }
  if (patch.proxy !== undefined) {
    const proxy = patch.proxy as Record<string, unknown>
    if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) {
      throw new Error('proxy must be an object')
    }
    if (proxy.port !== undefined) {
      const port = Number(proxy.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('proxy.port must be between 1 and 65535')
      }
    }
    for (const key of ['host', 'username', 'password', 'bypass'] as const) {
      if (proxy[key] !== undefined && typeof proxy[key] !== 'string') {
        throw new Error(`proxy.${key} must be a string`)
      }
    }
    if (proxy.enabled !== undefined && typeof proxy.enabled !== 'boolean') {
      throw new Error('proxy.enabled must be a boolean')
    }
    // 0.1.18 (regression): protocol was the one field interpolated verbatim
    // into Chromium proxyRules. An unknown value silently disabled the proxy
    // (traffic went direct) or injected extra rules.
    if (proxy.protocol !== undefined) {
      const allowed = ['http', 'https', 'socks5']
      if (typeof proxy.protocol !== 'string' || !allowed.includes(proxy.protocol)) {
        throw new Error(`proxy.protocol must be one of: ${allowed.join(', ')}`)
      }
    }
    if (proxy.enabled === true) {
      const host = String(proxy.host || '').trim()
      if (!host) throw new Error('proxy.host is required when enabled')
      if (/[;@\s\\/]/.test(host)) throw new Error('proxy.host contains illegal characters')
    }
  }
  if (patch.aria2Path !== undefined) {
    const raw = String(patch.aria2Path || '').trim()
    if (raw) {
      if (raw.includes('\0')) throw new Error('aria2Path contains an invalid character')
      if (!isAbsolute(raw)) throw new Error('aria2Path must be an absolute path')
      if (!existsSync(raw) || !statSync(raw).isFile()) {
        throw new Error('aria2Path must point to an existing file')
      }
    }
  }
}

/**
 * 0.1.18 (regression fix): prepare an imported settings file for `saveSettings`.
 *
 * Two rules:
 *  - credentials are never imported: the `proxy.password` KEY is removed, not
 *    set to ''. Setting it to '' looked equivalent but flowed through
 *    `saveSettings` and wiped the already-stored proxy password.
 *  - the runtime-integrity escape hatch is local security state, not something
 *    a downloaded config file may flip.
 */
export function stripImportedSettingsSecrets(raw: Record<string, unknown>): {
  patch: Record<string, unknown>
  applied: string[]
} {
  const patch: Record<string, unknown> = { ...raw }
  if (patch.proxy && typeof patch.proxy === 'object' && !Array.isArray(patch.proxy)) {
    const proxy = { ...(patch.proxy as Record<string, unknown>) }
    delete proxy.password
    patch.proxy = proxy
  }
  delete patch.allowUnverifiedRuntime
  return { patch, applied: Object.keys(patch) }
}

export { dirname, basename, extname }
