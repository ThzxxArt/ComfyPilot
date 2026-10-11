import { ref } from 'vue'
import type {
  ComfyUpdateInfo,
  ComfyUpdateOptions,
  EnvProbe,
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

// eslint-disable-next-line no-unused-vars
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
const updating = ref(false)
/** Instance id of the active update/repair — lets per-instance spinners stay correct. */
const updatingInstanceId = ref<string | null>(null)
const cancelling = ref(false)
let offProgress: (() => void) | null = null
let offRepair: (() => void) | null = null
let offNode: (() => void) | null = null
let offInstall: (() => void) | null = null
let offNodeOp: (() => void) | null = null

/** Write into the shared progress slot only when this kind owns it (or slot is free). */
function writeProgress(kind: 'comfy-update' | 'repair' | 'node-op', payload: unknown): void {
  if (progressKind.value === null || progressKind.value === kind) {
    progressKind.value = kind
    progress.value = payload as UpdateProgress
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
}

const nodeUpdatingPack = ref<string | null>(null)
const nodeInstallingPack = ref<string | null>(null)
const nodeUpdateMessage = ref('')
const nodeInstallMessage = ref('')
const lastNodeOpAt = ref(0)

function ensureNodeSubscribed(): void {
  if (!offNode) {
    offNode = onIpc(IPC_EVENTS.nodeUpdateProgress, (payload) => {
      const p = payload as NodeUpdateProgressEvent
      if (!p) return
      lastNodeOpAt.value = Date.now()
      if (p.phase === 'done' || p.phase === 'error') {
        // Clear BOTH — afterInstall emits op:'install' even during updates,
        // so nodeInstallingPack may have been set by a sub-step.
        nodeUpdatingPack.value = null
        nodeUpdateMessage.value = ''
        nodeInstallingPack.value = null
        nodeInstallMessage.value = ''
      } else {
        nodeUpdatingPack.value = p.packName
        nodeUpdateMessage.value = p.message || ''
      }
    })
  }
  if (!offInstall) {
    offInstall = onIpc(IPC_EVENTS.nodeInstallProgress, (payload) => {
      const p = payload as NodeUpdateProgressEvent
      if (!p) return
      lastNodeOpAt.value = Date.now()
      if (p.phase === 'done' || p.phase === 'error') {
        nodeInstallingPack.value = null
        nodeInstallMessage.value = ''
        nodeUpdatingPack.value = null
        nodeUpdateMessage.value = ''
      } else {
        nodeInstallingPack.value = p.packName
        nodeInstallMessage.value = p.message || ''
      }
    })
  }
  if (!offNodeOp) {
    offNodeOp = onIpc(IPC_EVENTS.nodeOperationProgress, (payload) => {
      // Node install/update streams into the SAME progress ref the shared
      // ComfyUpdateProgressModal renders — live steps + pip log lines.
      writeProgress('node-op', payload)
    })
  }
}

export function useComfyUpdate() {
  ensureSubscribed()
  ensureRepairSubscribed()
  ensureNodeSubscribed()

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
    updating.value = true
    updatingInstanceId.value = instanceId
    cancelling.value = false
    try {
      const result = await ipc('instance.updateComfy', instanceId, opts)
      progressKind.value = 'comfy-update'
      progress.value = result
      return result
    } finally {
      updating.value = false
      updatingInstanceId.value = null
      cancelling.value = false
      // Release the slot so a subsequent node-op can claim it.
      if (progressKind.value === 'comfy-update') progressKind.value = null
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
    updating.value = true
    updatingInstanceId.value = instanceId
    try {
      return await ipc('instance.repairEnv', instanceId, opts)
    } finally {
      updating.value = false
      updatingInstanceId.value = null
      if (progressKind.value === 'repair') progressKind.value = null
    }
  }

  function clearProgress(): void {
    progress.value = null
    progressKind.value = null
  }

  return {
    progress,
    progressKind,
    updating,
    updatingInstanceId,
    cancelling,
    nodeUpdatingPack,
    nodeUpdateMessage,
    nodeInstallingPack,
    nodeInstallMessage,
    checkComfyUpdate,
    startUpdate,
    cancelUpdate,
    repairEnv,
    clearProgress
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
}
