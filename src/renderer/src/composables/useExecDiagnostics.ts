/**
 * Runtime failure diagnostics composable (0.1.12).
 * Loads recorded failures for one instance and follows live `event:exec-error`
 * pushes. Failures from OTHER instances are ignored while a different instance
 * is loaded — the same cross-instance rule as the node-op logs.
 */
import { ref } from 'vue'
import type { ExecFailure } from '@shared/types'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'

const failures = ref<ExecFailure[]>([])
const loadedFor = ref('')
let off: (() => void) | null = null

function ensureSubscribed(): void {
  if (off) return
  off = onIpc(IPC_EVENTS.execError, (payload) => {
    const f = payload as ExecFailure
    if (!f?.instanceId || !f.id) return
    if (loadedFor.value !== f.instanceId) return
    const rest = failures.value.filter((x) => x.id !== f.id)
    failures.value = [f, ...rest].slice(0, 20)
  })
}

export function useExecDiagnostics() {
  ensureSubscribed()

  /** Monotonic request id — a stale response after switching instances must
   *  not clobber the new instance's list (0.1.13). */
  let loadSeq = 0

  async function load(instanceId: string): Promise<void> {
    if (!instanceId) return
    const seq = ++loadSeq
    loadedFor.value = instanceId
    try {
      const list = await ipc('instance.execFailures', instanceId)
      if (seq !== loadSeq || loadedFor.value !== instanceId) return
      // A late live push may already be newer than the snapshot — merge, keep order.
      const live = failures.value.filter((f) => f.instanceId === instanceId)
      const seen = new Set(list.map((f) => f.id))
      const extra = live.filter((f) => !seen.has(f.id))
      failures.value = (extra.length ? [...extra, ...list] : list)
        .sort((a, b) => b.at - a.at)
        .slice(0, 20)
    } catch {
      if (seq === loadSeq) failures.value = []
    }
  }

  async function clear(instanceId: string): Promise<void> {
    try {
      await ipc('instance.clearExecFailures', instanceId)
    } catch {
      /* clearing is best-effort */
    }
    failures.value = []
  }

  return { failures, load, clear }
}

/** Dispose subscription (tests / HMR). */
export function disposeExecDiagnosticsSubscription(): void {
  off?.()
  off = null
}
