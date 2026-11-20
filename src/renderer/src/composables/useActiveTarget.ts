/**
 * 0.2.5 WP7 — one descriptor for "what is the user acting on right now".
 *
 * The header can point at a local instance, a configured remote, or nothing.
 * Pages that mutate local assets (nodes, models, outputs, migrations) must ask
 * this composable instead of re-deriving `isRemoteActive`/`localTargetId`
 * ad hoc; otherwise a page shows a target banner but leaves the buttons live.
 */
import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'

export interface ActiveTargetState {
  kind: 'local' | 'remote' | 'none'
  localId: string | null
  remoteId: string | null
  url: string | null
  ready: boolean
  /** Local mutations are legal only when a local instance is the target. */
  canLocalMutate: boolean
}

export function useActiveTarget(): {
  target: ComputedRef<ActiveTargetState>
  /** Tooltip for a disabled local-only action ('' when not disabled). */
  localOnlyHint: ComputedRef<string>
} {
  const store = useAppStore()
  const { t } = useI18n()

  const target = computed<ActiveTargetState>(() => {
    const kind = store.activeTarget.kind
    return {
      kind,
      localId: store.localTargetId,
      remoteId: store.activeRemoteId,
      url: store.activeTargetUrl,
      ready: kind === 'remote' ? Boolean(store.activeRemote) : kind === 'local',
      canLocalMutate: kind === 'local' && Boolean(store.localTargetId)
    }
  })

  const localOnlyHint = computed(() => {
    if (target.value.kind === 'remote') return t('target.remoteBanner')
    if (target.value.kind === 'none') return t('target.noneBanner')
    return ''
  })

  return { target, localOnlyHint }
}
