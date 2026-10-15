/**
 * Monitor runtime-action orchestration (0.1.15).
 *
 * The three standard ComfyUI operations (clear queue / interrupt / free
 * memory) share one contract: run → honest result → refresh the live view on
 * success → surface the REAL error otherwise. Extracted as an injectable pure
 * function so the branch behaviour is unit-testable without a DOM.
 */

export interface MonitorOpResult {
  ok: boolean
  error?: string
}

/** Minimal shape of an `ipc()` call for one operation. */
export type MonitorOpRun = () => Promise<MonitorOpResult>

export interface MonitorOpDeps {
  run: MonitorOpRun
  /** Re-read live state (queue/jobs) after a successful operation. */
  refresh: () => Promise<void>
  onSuccess: () => void
  onError: (message: string) => void
}

/**
 * Execute one runtime operation.
 * - success → refresh live state, then report success (refresh first so the
 *   UI never shows "done" against stale queue data)
 * - rejection / `ok:false` → report the real error, do NOT refresh (the
 *   state did not change)
 * Returns true when the operation was accepted by the server.
 */
export async function runMonitorOp(deps: MonitorOpDeps): Promise<boolean> {
  try {
    const result = await deps.run()
    if (result.ok) {
      await deps.refresh()
      deps.onSuccess()
      return true
    }
    deps.onError(result.error || 'operation was not accepted')
    return false
  } catch (err) {
    deps.onError(err instanceof Error ? err.message : String(err))
    return false
  }
}
