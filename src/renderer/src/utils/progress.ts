/**
 * 0.1.18 (WP5 / U2): one honest definition of "how far along is the running
 * step". Three modals each had their own version and all three treated a real
 * 0% as "unknown" (`!step.progress`). A step is indeterminate ONLY when it has
 * no truth to show — never because the true value happens to be zero.
 */
import type { UpdateStep } from '@shared/types'

export function stepPercent(step: UpdateStep | null | undefined): number | null {
  if (!step || step.status !== 'running') return null
  if (typeof step.workTotal === 'number' && step.workTotal > 0) {
    const pct = ((step.workDone || 0) / step.workTotal) * 100
    return Math.max(0, Math.min(100, Math.round(pct)))
  }
  if (typeof step.progress === 'number' && Number.isFinite(step.progress)) {
    return Math.max(0, Math.min(100, Math.round(step.progress * 100)))
  }
  return null
}
