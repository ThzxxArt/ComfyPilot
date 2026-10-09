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
const updating = ref(false)
const cancelling = ref(false)
let offProgress: (() => void) | null = null
let offRepair: (() => void) | null = null
let offNode: (() => void) | null = null
let offInstall: (() => void) | null = null

function ensureSubscribed(): void {
  if (offProgress) return
  offProgress = onIpc(IPC_EVENTS.comfyUpdateProgress, (payload) => {
    progress.value = payload as UpdateProgress
  })
}

function ensureRepairSubscribed(): void {
  if (offRepair) return
  offRepair = onIpc(IPC_EVENTS.repairProgress, (payload) => {
    // Repair runs reuse the same progress stream / modal as ComfyUI updates.
    progress.value = payload as UpdateProgress
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
        nodeUpdatingPack.value = null
        nodeUpdateMessage.value = ''
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
      } else {
        nodeInstallingPack.value = p.packName
        nodeInstallMessage.value = p.message || ''
      }
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
        progress.value = running
      }
    } catch {
      /* updateStatus is best-effort */
    }
    updating.value = true
    cancelling.value = false
    try {
      const result = await ipc('instance.updateComfy', instanceId, opts)
      progress.value = result
      return result
    } finally {
      updating.value = false
      cancelling.value = false
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
    updating.value = true
    try {
      return await ipc('instance.repairEnv', instanceId, opts)
    } finally {
      updating.value = false
    }
  }

  function clearProgress(): void {
    progress.value = null
  }

  return {
    progress,
    updating,
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
}
