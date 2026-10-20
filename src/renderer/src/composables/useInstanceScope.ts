/**
 * 0.1.17 (WP9): one place that says "the active instance changed".
 *
 * Views kept their own watchers (or none at all), so switching instances left
 * stale drafts, selections and reports on screen — and some actions then ran
 * against the new instance using the old instance's data. `useInstanceScope`
 * centralises the subscription so views cannot forget it.
 */
import { watch } from 'vue'
import { useAppStore } from '@/stores/app'

/**
 * Subscribe to instance switches for the current component.
 * `onSwitch` runs AFTER the store has updated, on every real change.
 */
export function useInstanceScope(onSwitch: () => void): void {
  const store = useAppStore()
  watch(
    () => store.instanceSwitchTick,
    () => onSwitch()
  )
}

/**
 * 0.1.17 (WP9): a doctor report is only actionable for the instance it was
 * produced for. Applying "fix" from a report of another instance could modify
 * the wrong installation, so the view refuses and asks for a re-run.
 */
export function reportMatchesInstance(
  reportInstanceId: string | null | undefined,
  activeInstanceId: string | null | undefined
): boolean {
  return Boolean(reportInstanceId && activeInstanceId && reportInstanceId === activeInstanceId)
}
