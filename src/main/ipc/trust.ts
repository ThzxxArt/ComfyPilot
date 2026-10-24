/**
 * 0.1.18 (WP8): pure trust decisions for renderer-supplied IPC arguments.
 *
 * These used to live as closures inside `handlers.ts` (which needs a live
 * `ipcMain`) so they could not be unit-tested: only the wiring was covered by
 * the channel-set contract test. Extracted here so every rule is table-driven.
 */
import { sanitizeId } from '../services/security'

function codedError(code: string, message: string): Error & { code?: string } {
  const e = new Error(message) as Error & { code?: string }
  e.code = code
  return e
}

/**
 * Renderer-supplied instance id. MUST be an opaque id — never a filesystem
 * path. `nodePack.detectCustomNodesRoot` accepts path-form input for internal
 * callers; allowing that from IPC would be a path-injection surface.
 */
export function safeInstanceId(instanceId?: string | null): string | undefined {
  if (instanceId == null || instanceId === '') return undefined
  const raw = String(instanceId)
  // A whitespace-only id sanitizes to '' → randomUUID(), which would BYPASS
  // the explicit-target gate with a fabricated id.
  if (!raw.trim()) throw new Error('Invalid instance id')
  if (raw.includes('/') || raw.includes('\\') || raw.includes('\0') || raw.includes('..')) {
    throw new Error('Invalid instance id')
  }
  return sanitizeId(raw)
}

/**
 * Instance target id or `remote:<id>`. `sanitizeId` would rewrite the `:`
 * separator, so the remote prefix is stripped, sanitized, and re-attached.
 */
export function safeInstanceTarget(instanceId?: string | null): string | undefined {
  if (instanceId == null || instanceId === '') return undefined
  const raw = String(instanceId)
  if (raw.startsWith('remote:')) {
    const id = safeInstanceId(raw.slice('remote:'.length))
    return id ? `remote:${id}` : undefined
  }
  return safeInstanceId(raw)
}

/** True when the (already sanitized) target points at a remote instance. */
export function isRemoteTarget(target?: string | null): boolean {
  return Boolean(target && String(target).startsWith('remote:'))
}

/** `remote:<id>` → `<id>`, otherwise null. */
export function remoteIdOf(target?: string | null): string | null {
  if (!isRemoteTarget(target)) return null
  return String(target).slice('remote:'.length) || null
}

/**
 * Package/environment channels only make sense for LOCAL instances (the venv
 * lives on this machine). Refuse `remote:*` with a coded, localizable error
 * instead of sanitizing it into a bogus id (`remote:x` → `remote_x` used to
 * surface as an inexplicable INSTANCE_NOT_FOUND — 0.1.13).
 */
export function requireLocalInstanceId(instanceId?: string | null): string | undefined {
  const target = safeInstanceTarget(instanceId ?? undefined)
  if (isRemoteTarget(target)) {
    throw codedError(
      'REMOTE_NOT_SUPPORTED',
      'Package operations are only available for local instances'
    )
  }
  return target
}

/**
 * Destructive local-asset operations must name their target. `undefined` used
 * to mean "instances[0]", so a remote view could silently update/delete the
 * local machine's node packs, models or doctor state (0.1.18 / P0-3).
 */
export function requireLocalTarget(instanceId?: string | null): string {
  const target = requireLocalInstanceId(instanceId ?? undefined)
  if (!target) {
    throw codedError('TARGET_REQUIRED', 'This operation needs an explicit local instance target')
  }
  return target
}
