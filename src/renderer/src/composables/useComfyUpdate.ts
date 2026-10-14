import { computed, ref } from 'vue'
import type {
  ComfyUpdateInfo,
  ComfyUpdateOptions,
  EnvProbe,
  NodeCheckProgressEvent,
  NodeOpLogEvent,
  NodeUpdateBatchEvent,
  RepairEnvOptions,
  UpdateProgress,
  UpdateStep,
  UpdateStepId
} from '@shared/types'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'

/** UpdateStepId → i18n key for the step title. */
export const UPDATE_STEP_KEY: Record<UpdateStepId, string> = {
  preflight: 'update.stepPreflight',
  venv: 'update.stepVenv',
  stop: 'update.stepStop',
  backup: 'update.stepBackup',
  fetch: 'update.stepFetch',
  download: 'update.stepDownload',
  clone: 'update.stepClone',
  unpack: 'update.stepUnpack',
  requirements: 'update.stepRequirements',
  torch: 'update.stepTorch',
  verify: 'update.stepVerify',
  rollback: 'update.stepRollback',
  done: 'update.stepDone'
}

type TranslateFn = (key: string, params?: Record<string, string | number>) => string

/** Prefer the i18n detailKey emitted by main; fall back to the English detail. */
export function updateDetailOf(
  t: TranslateFn,
  item: { detail?: string; detailKey?: string; detailParams?: Record<string, string | number> }
): string {
  if (item.detailKey) {
    try {
      const msg = t(item.detailKey, item.detailParams || {})
      // Unsubstituted named placeholders mean detailParams were not supplied —
      // show the raw detail instead of a literal `{path}` token.
      if (!(item.detail && /\{[a-zA-Z0-9_]+\}/.test(msg))) return msg
    } catch {
      /* fall through to detail */
    }
  }
  return item.detail || ''
}

export function updateStepTitle(t: TranslateFn, step: UpdateStep | UpdateStepId): string {
  const id = typeof step === 'string' ? step : step.id
  const key = UPDATE_STEP_KEY[id]
  if (key) {
    try {
      return t(key)
    } catch {
      /* fall through */
    }
  }
  return typeof step === 'string' ? id : step.title
}

const progress = ref<UpdateProgress | null>(null)
/**
 * Which operation currently owns the shared progress modal.
 * Prevents ComfyUI-update / repair / node-op streams from overwriting
 * each other when two long tasks run concurrently.
 */
const progressKind = ref<'comfy-update' | 'repair' | 'node-op' | null>(null)
/** True once the current stream reached a terminal state — a new op may then claim the slot. */
const progressFinished = ref(false)
/** ComfyUI update in flight (own flag — repair must not clear it). */
const updatingComfy = ref(false)
/** Environment repair in flight. */
const repairing = ref(false)
/** Any long-running update/repair — kept for existing consumers (spinners, modal). */
const updating = computed(() => updatingComfy.value || repairing.value)
/** Instance id of the active update/repair — lets per-instance spinners stay correct. */
const updatingInstanceId = ref<string | null>(null)
const cancelling = ref(false)
let offProgress: (() => void) | null = null
let offRepair: (() => void) | null = null
let offNode: (() => void) | null = null
let offInstall: (() => void) | null = null
let offNodeOp: (() => void) | null = null
let offBatch: (() => void) | null = null
let offOpLog: (() => void) | null = null
let offCheck: (() => void) | null = null

/** Write into the shared progress slot only when this kind owns it (or slot is free/finished). */
function writeProgress(kind: 'comfy-update' | 'repair' | 'node-op', payload: unknown): void {
  if (progressKind.value === null || progressKind.value === kind || progressFinished.value) {
    progressKind.value = kind
    progressFinished.value = false
    progress.value = payload as UpdateProgress
    const status = (payload as UpdateProgress | null)?.status
    // `cancelled` is terminal too (0.1.11) — leaving it out kept the slot
    // "busy" forever and blocked later streams from claiming it.
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      progressFinished.value = true
    }
  }
}

function ensureSubscribed(): void {
  if (offProgress) return
  offProgress = onIpc(IPC_EVENTS.comfyUpdateProgress, (payload) => {
    writeProgress('comfy-update', payload)
  })
}

function ensureRepairSubscribed(): void {
  if (offRepair) return
  offRepair = onIpc(IPC_EVENTS.repairProgress, (payload) => {
    // Repair runs reuse the same progress stream / modal as ComfyUI updates.
    writeProgress('repair', payload)
  })
}

/** Node-install/update event payload (shared shape). */
export interface NodeUpdateProgressEvent {
  phase: 'start' | 'download' | 'unzip' | 'pip' | 'done' | 'error'
  packName: string
  message?: string
  ts: number
  op?: 'install' | 'update' | 'uninstall'
  /** Stream owner — banner state is kept per instance. */
  instanceId?: string
}

const nodeUpdatingPack = ref<string | null>(null)
const nodeInstallingPack = ref<string | null>(null)
const nodeUpdateMessage = ref('')
const nodeInstallMessage = ref('')
const lastNodeOpAt = ref(0)
/** Banner state per instance so switching instances never shows another's pack. */
const nodeBanners = new Map<
  string,
  { updating: string | null; updateMsg: string; installing: string | null; installMsg: string }
>()
function bannerFor(iid: string): {
  updating: string | null
  updateMsg: string
  installing: string | null
  installMsg: string
} {
  let b = nodeBanners.get(iid)
  if (!b) {
    b = { updating: null, updateMsg: '', installing: null, installMsg: '' }
    nodeBanners.set(iid, b)
  }
  return b
}

// ---------- 0.1.9: batch update + streaming logs + check progress ----------
export interface NodeBatchEntry {
  name: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
}
const nodeBatch = ref<NodeUpdateBatchEvent | null>(null)
const nodeBatchActive = ref(false)
const nodeBatchEntries = ref<NodeBatchEntry[]>([])
const nodeCheck = ref<NodeCheckProgressEvent | null>(null)
/** Check-progress per instance (0.1.11) — switching instances must not show
 *  another instance's "checking x/y" counter. */
const nodeCheckByInstance = new Map<string, NodeCheckProgressEvent>()

/**
 * Per-instance node-op state. Two instances can run ops simultaneously; the
 * modal views ONE stream at a time (`viewedNodeInstanceId`) and switching
 * instances must never leak the other stream's logs/terminal state.
 */
interface NodeOpView {
  progress?: UpdateProgress
  logs: Array<{ packName?: string; line: string; ts: number }>
}
const nodeOpViews = new Map<string, NodeOpView>()
const viewedNodeInstanceId = ref('')
const nodeOpLogs = ref<Array<{ packName?: string; line: string; ts: number }>>([])
/** Monotonic counter so the modal's auto-scroll watcher fires even when the
 *  array length is pinned at the 3000-line cap. */
const nodeOpLogSeq = ref(0)

/** Batch state is ALSO per instance — a queue on A must survive viewing B. */
interface NodeBatchView {
  event: NodeUpdateBatchEvent
  entries: NodeBatchEntry[]
  active: boolean
}
const nodeBatchViews = new Map<string, NodeBatchView>()

function getOpView(instanceId: string): NodeOpView {
  let view = nodeOpViews.get(instanceId)
  if (!view) {
    view = { logs: [] }
    nodeOpViews.set(instanceId, view)
  }
  return view
}

function mirrorBatchView(instanceId: string): void {
  if (viewedNodeInstanceId.value !== instanceId) return
  const view = nodeBatchViews.get(instanceId)
  nodeBatch.value = view ? view.event : null
  nodeBatchEntries.value = view ? view.entries : []
  nodeBatchActive.value = view ? view.active : false
}

function appendNodeOpLog(
  instanceId: string,
  entry: { packName?: string; line: string; ts: number }
): void {
  // The very first op-log line may arrive before any op-progress event —
  // create the bucket rather than leaking into another instance's array.
  const view = getOpView(instanceId)
  view.logs.push(entry)
  if (view.logs.length > 3000) view.logs.splice(0, view.logs.length - 3000)
  if (viewedNodeInstanceId.value === instanceId) {
    nodeOpLogs.value = view.logs
    nodeOpLogSeq.value += 1
  }
}

/** Point the modal at one instance's stream ('' = follow the newest). */
function selectNodeOpInstance(instanceId: string): void {
  viewedNodeInstanceId.value = instanceId
  // Banner + check state follow the viewed instance too. An EMPTY id must
  // reset them — keeping the previous instance's values produced a ghost
  // "updating…" banner after the instance was removed (0.1.11).
  const b = bannerFor(instanceId || 'default')
  nodeUpdatingPack.value = instanceId ? b.updating : null
  nodeUpdateMessage.value = instanceId ? b.updateMsg : ''
  nodeInstallingPack.value = instanceId ? b.installing : null
  nodeInstallMessage.value = instanceId ? b.installMsg : ''
  nodeCheck.value = nodeCheckByInstance.get(instanceId || 'default') || null
  const view = instanceId ? nodeOpViews.get(instanceId) : undefined
  if (view) {
    nodeOpLogs.value = view.logs
    nodeOpLogSeq.value += 1
    if (view.progress) writeProgress('node-op', view.progress)
    mirrorBatchView(instanceId)
    return
  }
  // Instance has no tracked node-op stream — show nothing rather than a stale
  // payload/batch from a different instance.
  nodeOpLogs.value = []
  nodeBatch.value = null
  nodeBatchEntries.value = []
  nodeBatchActive.value = false
  if (progressKind.value === 'node-op') clearProgressInternal()
}

function clearProgressInternal(): void {
  progress.value = null
  progressKind.value = null
  progressFinished.value = false
}

function upsertBatchEntry(
  view: NodeBatchView,
  index: number,
  name: string,
  status: NodeBatchEntry['status']
): void {
  const arr = view.entries
  const i = Math.max(0, index - 1)
  while (arr.length <= i) arr.push({ name: '…', status: 'pending' })
  const entry = arr[i]
  if (name) entry.name = name
  entry.status = status
}

function ensureNodeSubscribed(): void {
  if (!offNode) {
    offNode = onIpc(IPC_EVENTS.nodeUpdateProgress, (payload) => {
      const p = payload as NodeUpdateProgressEvent
      if (!p) return
      lastNodeOpAt.value = Date.now()
      const iid = p.instanceId || 'default'
      const b = bannerFor(iid)
      if (p.phase === 'done' || p.phase === 'error') {
        // Clear BOTH — afterInstall emits op:'install' even during updates,
        // so the install banner may have been set by a sub-step.
        b.updating = null
        b.updateMsg = ''
        b.installing = null
        b.installMsg = ''
      } else {
        b.updating = p.packName
        b.updateMsg = p.message || ''
      }
      if (viewedNodeInstanceId.value === iid) {
        nodeUpdatingPack.value = b.updating
        nodeUpdateMessage.value = b.updateMsg
        nodeInstallingPack.value = b.installing
        nodeInstallMessage.value = b.installMsg
      }
    })
  }
  if (!offInstall) {
    offInstall = onIpc(IPC_EVENTS.nodeInstallProgress, (payload) => {
      const p = payload as NodeUpdateProgressEvent
      if (!p) return
      lastNodeOpAt.value = Date.now()
      const iid = p.instanceId || 'default'
      const b = bannerFor(iid)
      if (p.phase === 'done' || p.phase === 'error') {
        b.installing = null
        b.installMsg = ''
        b.updating = null
        b.updateMsg = ''
      } else {
        b.installing = p.packName
        b.installMsg = p.message || ''
      }
      if (viewedNodeInstanceId.value === iid) {
        nodeUpdatingPack.value = b.updating
        nodeUpdateMessage.value = b.updateMsg
        nodeInstallingPack.value = b.installing
        nodeInstallMessage.value = b.installMsg
      }
    })
  }
  if (!offNodeOp) {
    offNodeOp = onIpc(IPC_EVENTS.nodeOperationProgress, (payload) => {
      const next = payload as UpdateProgress
      const iid = next?.instanceId
      if (!iid || !next.runId) return
      const view = getOpView(iid)
      const isNewRun = !view.progress || view.progress.runId !== next.runId
      view.progress = next
      // Only the viewed instance owns the shared slot (the first stream while
      // idle claims it). Other instances keep their own view for later.
      if (!viewedNodeInstanceId.value || viewedNodeInstanceId.value === iid) {
        viewedNodeInstanceId.value = iid
        if (isNewRun) {
          // A brand-new single op supersedes this instance's previous batch
          // display/log (a running batch is preserved via its own view).
          const bv = nodeBatchViews.get(iid)
          if (!bv?.active) {
            nodeBatchViews.delete(iid)
            view.logs = []
            mirrorBatchView(iid)
          }
        }
        nodeOpLogs.value = view.logs
        writeProgress('node-op', { ...next })
      }
    })
  }
  if (!offBatch) {
    offBatch = onIpc(IPC_EVENTS.nodeUpdateBatch, (payload) => {
      const e = payload as NodeUpdateBatchEvent
      if (!e?.phase) return
      lastNodeOpAt.value = Date.now()
      const iid = e.instanceId || viewedNodeInstanceId.value || 'default'
      if (!viewedNodeInstanceId.value) viewedNodeInstanceId.value = iid
      let view = nodeBatchViews.get(iid)
      if (!view) {
        view = { event: e, entries: [], active: false }
        nodeBatchViews.set(iid, view)
      }
      view.event = e
      if (e.phase === 'checking' || e.phase === 'start') {
        view.active = true
        view.entries = []
        // A fresh batch starts a fresh log for its instance (runId stays the
        // same across packs by design, so runId alone cannot reset it).
        const opView = getOpView(iid)
        opView.logs = []
        if (viewedNodeInstanceId.value === iid) nodeOpLogs.value = opView.logs
      } else if (e.phase === 'pack-start') {
        view.active = true
        upsertBatchEntry(view, e.index, e.packName || '', 'running')
      } else if (e.phase === 'pack-done') {
        upsertBatchEntry(view, e.index, e.packName || '', e.ok ? 'done' : 'failed')
      } else if (e.phase === 'batch-done' || e.phase === 'batch-error') {
        view.active = false
        for (const entry of view.entries) {
          if (entry.status === 'running') {
            entry.status = e.summary?.cancelled ? 'cancelled' : 'done'
          }
        }
      }
      mirrorBatchView(iid)
    })
  }
  if (!offOpLog) {
    offOpLog = onIpc(IPC_EVENTS.nodeOpLog, (payload) => {
      const line = payload as NodeOpLogEvent
      if (!line?.line) return
      appendNodeOpLog(line.instanceId || '', {
        packName: line.packName,
        line: line.line,
        ts: line.ts
      })
    })
  }
  if (!offCheck) {
    offCheck = onIpc(IPC_EVENTS.nodeCheckProgress, (payload) => {
      const p = payload as NodeCheckProgressEvent
      const iid = p?.instanceId || 'default'
      nodeCheckByInstance.set(iid, p)
      // Mirror only for the viewed instance; others keep their own counter.
      if (viewedNodeInstanceId.value === iid || !viewedNodeInstanceId.value) {
        nodeCheck.value = p
      }
    })
  }
}

export function useComfyUpdate() {
  ensureSubscribed()
  ensureRepairSubscribed()
  ensureNodeSubscribed()

  /**
   * Hydration after a renderer reload / remount while an op still runs
   * (0.1.12): main keeps the authoritative snapshot; the modal restores it
   * instead of showing an empty shell. Order: comfy-update → repair.
   */
  async function hydrateActiveOp(): Promise<void> {
    if (progressKind.value !== null && !progressFinished.value) return
    try {
      const upd = await ipc('instance.updateStatus')
      if (upd && upd.status === 'running') {
        progressKind.value = 'comfy-update'
        progressFinished.value = false
        progress.value = upd
        updatingComfy.value = true
        updatingInstanceId.value = upd.instanceId
        return
      }
    } catch {
      /* best-effort */
    }
    try {
      const rep = await ipc('instance.repairStatus')
      if (rep && rep.status === 'running') {
        progressKind.value = 'repair'
        progressFinished.value = false
        progress.value = rep
        repairing.value = true
        updatingInstanceId.value = rep.instanceId
      }
    } catch {
      /* best-effort */
    }
  }

  /**
   * Node-op hydration for one instance (modal reopen after reload). Node ops
   * are per-instance; the caller passes the instance the modal shows.
   */
  async function hydrateNodeOp(instanceId?: string): Promise<void> {
    if (progressKind.value === 'node-op' && !progressFinished.value) return
    const target = instanceId || viewedNodeInstanceId.value || ''
    try {
      const snap = await ipc('node.opStatus', target || undefined)
      if (!snap || !snap.runId) return
      if (snap.status !== 'running' && progressKind.value !== 'node-op') return
      const iid = snap.instanceId || target || 'default'
      const view = getOpView(iid)
      view.progress = snap
      if (!viewedNodeInstanceId.value || viewedNodeInstanceId.value === iid) {
        viewedNodeInstanceId.value = iid
        nodeOpLogs.value = view.logs
      }
      writeProgress('node-op', { ...snap })
    } catch {
      /* best-effort */
    }
  }

  async function checkComfyUpdate(instanceId: string): Promise<ComfyUpdateInfo> {
    return ipc('instance.checkComfyUpdate', instanceId)
  }

  /** Run the full ComfyUI update, tracking live progress into `progress`. */
  async function startUpdate(
    instanceId: string,
    opts?: ComfyUpdateOptions
  ): Promise<UpdateProgress> {
    ensureSubscribed()
    // Resume banner if an update is already running for this machine.
    try {
      const running = await ipc('instance.updateStatus')
      if (running && running.status === 'running') {
        progressKind.value = 'comfy-update'
        progress.value = running
      }
    } catch {
      /* updateStatus is best-effort */
    }
    progressKind.value = 'comfy-update'
    progressFinished.value = false
    updatingComfy.value = true
    updatingInstanceId.value = instanceId
    cancelling.value = false
    try {
      const result = await ipc('instance.updateComfy', instanceId, opts)
      progressKind.value = 'comfy-update'
      progress.value = result
      progressFinished.value = result.status === 'done' || result.status === 'failed'
      return result
    } finally {
      updatingComfy.value = false
      updatingInstanceId.value = null
      cancelling.value = false
      // Release the slot so a subsequent node-op can claim it.
      if (progressKind.value === 'comfy-update' && !progressFinished.value)
        progressKind.value = null
    }
  }

  async function cancelUpdate(): Promise<boolean> {
    cancelling.value = true
    try {
      return await ipc('instance.cancelUpdate')
    } finally {
      cancelling.value = false
    }
  }

  async function repairEnv(instanceId: string, opts?: RepairEnvOptions): Promise<EnvProbe> {
    ensureRepairSubscribed()
    progressKind.value = 'repair'
    progressFinished.value = false
    repairing.value = true
    updatingInstanceId.value = instanceId
    try {
      return await ipc('instance.repairEnv', instanceId, opts)
    } finally {
      repairing.value = false
      updatingInstanceId.value = null
      if (progressKind.value === 'repair' && !progressFinished.value) progressKind.value = null
    }
  }

  function clearProgress(): void {
    clearProgressInternal()
  }

  /** Abort the in-flight single node op for an instance. */
  async function cancelNodeOp(instanceId?: string): Promise<boolean> {
    return ipc('node.cancelOp', instanceId || undefined)
  }

  /** Stop a running "update all" queue (abort current + skip the rest). */
  async function cancelNodeBatch(instanceId?: string): Promise<boolean> {
    return ipc('node.cancelBatch', instanceId || undefined)
  }

  return {
    progress,
    progressKind,
    updating,
    updatingComfy,
    repairing,
    updatingInstanceId,
    cancelling,
    nodeUpdatingPack,
    nodeUpdateMessage,
    nodeInstallingPack,
    nodeInstallMessage,
    nodeBatch,
    nodeBatchActive,
    nodeBatchEntries,
    nodeOpLogs,
    nodeCheck,
    checkComfyUpdate,
    startUpdate,
    cancelUpdate,
    repairEnv,
    clearProgress,
    cancelNodeOp,
    cancelNodeBatch,
    selectNodeOpInstance,
    hydrateActiveOp,
    hydrateNodeOp,
    nodeOpLogSeq,
    viewedNodeInstanceId
  }
}

/**
 * Translate a main-process error into an actionable user message.
 * Setting-blocked errors carry `code` so we can say exactly which switch to
 * flip — never show a raw English stack line when we know better.
 */
export function describeNodeError(t: TranslateFn, err: unknown): string {
  const e = err as Error & { code?: string }
  const msg = e?.message || String(err)
  const code = e?.code
  if (code === 'SETTING_OFFLINE') return t('nodes.blockedOffline')
  if (code === 'SETTING_GIT_INSTALL') return t('nodes.blockedGitInstall')
  if (code === 'SETTING_SECURITY_STRONG') return t('nodes.blockedSecurityStrong')
  if (code === 'NODE_DISABLED') return t('nodes.packDisabledUpdate')
  if (code === 'OP_BUSY') return t('nodes.opBusy')
  if (code === 'OP_CANCELLED') return t('nodes.opCancelled')
  if (code === 'DISABLE_CONFLICT') return t('nodes.disableConflict')
  if (code === 'ENABLE_CONFLICT') return t('nodes.enableConflict')
  return msg
}

/** True when a just-installed pack skipped its deps because of a setting. */
export function hasDepsSkippedIssue(issues?: Array<{ code?: string }>): boolean {
  return Boolean(issues?.some((i) => i.code === 'pip-disabled'))
}

/** Dispose event subscriptions (used by tests / HMR teardown). */
export function disposeComfyUpdateSubscriptions(): void {
  offProgress?.()
  offProgress = null
  offRepair?.()
  offRepair = null
  offNode?.()
  offNode = null
  offInstall?.()
  offInstall = null
  offNodeOp?.()
  offNodeOp = null
  offBatch?.()
  offBatch = null
  offOpLog?.()
  offOpLog = null
  offCheck?.()
  offCheck = null
}
