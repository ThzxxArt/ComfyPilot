/**
 * Single definition of "which local instance does this operate on" (0.1.18 WP2).
 *
 * Before this file every service grew its own `instances.find(...) || instances[0]`
 * fallback. With a remote target selected the renderer sent no id, so those
 * fallbacks silently pointed destructive work at the first *local* instance.
 *
 * Policy:
 *   - an explicit id must resolve, otherwise INSTANCE_NOT_FOUND;
 *   - no id is only acceptable when exactly one instance exists;
 *   - otherwise TARGET_REQUIRED — callers must ask the user.
 */
import type { ComfyInstanceConfig } from '@shared/types'
import { loadInstanceConfigs, loadSettings } from './db'

function codedError(code: string, message: string): Error & { code?: string } {
  const e = new Error(message) as Error & { code?: string }
  e.code = code
  return e
}

export function findLocalInstance(instanceId?: string | null): ComfyInstanceConfig | null {
  const configs = loadInstanceConfigs()
  if (instanceId) {
    return configs.find((c) => c.id === instanceId) || null
  }
  return configs.length === 1 ? configs[0] : null
}

/**
 * Strict resolver for anything that writes, launches or installs.
 * Throws instead of guessing when the target is ambiguous.
 */
export function resolveLocalInstance(instanceId?: string | null): ComfyInstanceConfig {
  const configs = loadInstanceConfigs()
  if (instanceId) {
    const found = configs.find((c) => c.id === instanceId)
    if (!found) throw codedError('INSTANCE_NOT_FOUND', `Instance not found: ${instanceId}`)
    return found
  }
  if (configs.length === 0) {
    throw codedError('INSTANCE_NOT_FOUND', 'No ComfyUI instance is configured')
  }
  if (configs.length > 1) {
    throw codedError(
      'TARGET_REQUIRED',
      'Multiple instances are configured — an explicit instance target is required'
    )
  }
  return configs[0]
}

/** Resolve an already-validated instance id to its config, or null. */
export function instanceById(instanceId: string): ComfyInstanceConfig | null {
  return loadInstanceConfigs().find((c) => c.id === instanceId) || null
}

/**
 * Read-only resolution. THE single place a missing target may fall back
 * (first enabled instance, else first registered). Writes/launches must use
 * `resolveLocalInstance` (or the IPC `requireLocalTarget` guard) instead —
 * this fallback exists so dashboards can render one instance's data before the
 * user has chosen a target, never so a destructive action can pick one.
 */
/**
 * Read-only resolution for flows opened from the shell (open frontend, queue
 * links): the user's active instance wins, then the same fallback as
 * `resolveReadTarget`. Explicit ids still must resolve.
 */
export function resolveActiveTarget(instanceId?: string | null): ComfyInstanceConfig | undefined {
  const configs = loadInstanceConfigs()
  if (instanceId) return configs.find((c) => c.id === instanceId)
  const active = (loadSettings() as { activeInstance?: string }).activeInstance
  return (
    configs.find((c) => c.id === active) || configs.find((c) => c.enabled !== false) || configs[0]
  )
}

export function resolveReadTarget(instanceId?: string | null): ComfyInstanceConfig | undefined {
  const configs = loadInstanceConfigs()
  if (instanceId) return configs.find((c) => c.id === instanceId)
  return configs.find((c) => c.enabled !== false) || configs[0]
}
