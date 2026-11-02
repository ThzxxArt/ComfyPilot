/**
 * Per-instance environment operation lock (0.2.0).
 *
 * Dependency audit, pip installs and node-pack operations mutate or inspect
 * the same venv. The old code only guarded pip-vs-pip, so an audit could read
 * a half-written package list while a node install was running. This is the
 * single lock every environment writer/auditor must take.
 */
const active = new Map<string, string>()

export function acquireEnvLock(instanceId: string, owner: string): () => void {
  const key = String(instanceId || 'default')
  const current = active.get(key)
  if (current) {
    const e = new Error(
      `Environment is busy (${current}) — wait for the current operation to finish`
    ) as Error & { code?: string }
    e.code = 'ENV_BUSY'
    throw e
  }
  active.set(key, owner)
  let released = false
  return () => {
    if (released) return
    released = true
    if (active.get(key) === owner) active.delete(key)
  }
}

export function envLockOwner(instanceId: string): string | undefined {
  return active.get(String(instanceId || 'default'))
}

export function isEnvLocked(instanceId: string): boolean {
  return active.has(String(instanceId || 'default'))
}

/** Test-only: drop all locks. Never call from production code. */
export function resetEnvLocksForTest(): void {
  active.clear()
}
