/**
 * Pip-op stream composable (0.1.12) — one shared modal state for every
 * package-install entry point (missing-module fix, recipe apply, pack deps).
 *
 * Mirrors the node-op pattern: NEVER auto-closes, closing only hides, the
 * stream is per instance and switching views cannot leak another instance's
 * logs. `start*` helpers hydrate from main first (covers page reloads while
 * an op is still running).
 */
import { ref } from 'vue'
import type { PipOpResult, UpdateProgress } from '@shared/types'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'

interface PipOpView {
  progress?: UpdateProgress
  logs: Array<{ line: string; ts: number }>
}

const views = new Map<string, PipOpView>()
const viewedInstanceId = ref('')
const progress = ref<UpdateProgress | null>(null)
const logs = ref<Array<{ line: string; ts: number }>>([])
const logSeq = ref(0)
const modalVisible = ref(false)
const busy = ref(false)
/** Instances with a RUNNING pip op (any view may re-open the modal). */
const activeInstances = ref<string[]>([])
let offProgress: (() => void) | null = null
let offLog: (() => void) | null = null

function setActiveInstance(instanceId: string, active: boolean): void {
  const set = new Set(activeInstances.value)
  if (active) set.add(instanceId)
  else set.delete(instanceId)
  activeInstances.value = [...set]
}

function getView(instanceId: string): PipOpView {
  let v = views.get(instanceId)
  if (!v) {
    v = { logs: [] }
    views.set(instanceId, v)
  }
  return v
}

function mirror(instanceId: string): void {
  if (viewedInstanceId.value !== instanceId) return
  const v = views.get(instanceId)
  progress.value = v?.progress || null
  logs.value = v ? v.logs : []
}

function ensureSubscribed(): void {
  if (!offProgress) {
    offProgress = onIpc(IPC_EVENTS.pipOpProgress, (payload) => {
      const p = payload as UpdateProgress
      if (!p?.instanceId || !p.runId) return
      const v = getView(p.instanceId)
      v.progress = p
      setActiveInstance(p.instanceId, p.status === 'running')
      if (!viewedInstanceId.value || viewedInstanceId.value === p.instanceId) {
        viewedInstanceId.value = p.instanceId
        busy.value = p.status === 'running'
        mirror(p.instanceId)
      }
    })
  }
  if (!offLog) {
    offLog = onIpc(IPC_EVENTS.pipOpLog, (payload) => {
      const l = payload as { instanceId?: string; line?: string; ts?: number }
      if (!l?.line) return
      const iid = l.instanceId || 'default'
      const v = getView(iid)
      v.logs.push({ line: l.line, ts: l.ts || Date.now() })
      if (v.logs.length > 3000) v.logs.splice(0, v.logs.length - 3000)
      if (viewedInstanceId.value === iid) {
        logs.value = v.logs
        logSeq.value += 1
      }
    })
  }
}

export function usePipOps() {
  ensureSubscribed()

  /**
   * Resync one instance's op state from main (0.1.12): covers renderer
   * reloads, view switches and the settle race after an op promise resolves.
   * Returns true when an op is still running.
   */
  async function refreshStatus(instanceId: string): Promise<boolean> {
    if (!instanceId) return false
    try {
      const snap = await ipc('instance.pipStatus', instanceId)
      const v = getView(instanceId)
      v.progress = snap || undefined
      const active = Boolean(snap && snap.status === 'running')
      setActiveInstance(instanceId, active)
      if (!viewedInstanceId.value || viewedInstanceId.value === instanceId) {
        viewedInstanceId.value = instanceId
        busy.value = active
        mirror(instanceId)
      }
      return active
    } catch {
      setActiveInstance(instanceId, false)
      if (viewedInstanceId.value === instanceId) busy.value = false
      return false
    }
  }

  /** Start a fresh op stream for the given instance, then run `fn`. */
  async function run(instanceId: string, fn: () => Promise<PipOpResult>): Promise<PipOpResult> {
    const v = getView(instanceId)
    v.logs = []
    v.progress = undefined
    viewedInstanceId.value = instanceId
    progress.value = null
    logs.value = v.logs
    logSeq.value += 1
    modalVisible.value = true
    busy.value = true
    setActiveInstance(instanceId, true)
    // Hydrate in case the first progress event raced ahead of this call.
    try {
      const snap = await ipc('instance.pipStatus', instanceId)
      if (snap && snap.instanceId === instanceId) {
        v.progress = snap
        mirror(instanceId)
      }
    } catch {
      /* status probe is best-effort */
    }
    try {
      return await fn()
    } finally {
      // The op settled (success/failure/cancel) — resync so banner state can
      // never go stale even if the terminal event was missed.
      await refreshStatus(instanceId)
    }
  }

  async function startInstall(instanceId: string, spec: string): Promise<PipOpResult> {
    return run(instanceId, () => ipc('instance.pipInstall', instanceId, spec))
  }

  async function startRecipe(instanceId: string, recipeId: string): Promise<PipOpResult> {
    return run(instanceId, () => ipc('instance.applyRecipe', instanceId, recipeId))
  }

  async function startPackDeps(instanceId: string, packId: string): Promise<PipOpResult> {
    return run(instanceId, () => ipc('node.installDeps', packId, instanceId))
  }

  async function cancel(instanceId: string): Promise<boolean> {
    try {
      return await ipc('instance.pipCancel', instanceId)
    } catch {
      return false
    }
  }

  function open(): void {
    modalVisible.value = true
  }

  function close(): void {
    modalVisible.value = false
  }

  async function selectInstance(instanceId: string): Promise<void> {
    viewedInstanceId.value = instanceId
    await refreshStatus(instanceId)
  }

  /** Re-open the modal for an instance's (possibly still running) op. */
  async function openFor(instanceId: string): Promise<void> {
    await selectInstance(instanceId)
    modalVisible.value = true
  }

  return {
    progress,
    logs,
    logSeq,
    modalVisible,
    busy,
    viewedInstanceId,
    activeInstances,
    startInstall,
    startRecipe,
    startPackDeps,
    cancel,
    open,
    close,
    selectInstance,
    refreshStatus,
    openFor
  }
}

/** Dispose stream subscriptions (tests / HMR). */
export function disposePipOpSubscriptions(): void {
  offProgress?.()
  offProgress = null
  offLog?.()
  offLog = null
}
