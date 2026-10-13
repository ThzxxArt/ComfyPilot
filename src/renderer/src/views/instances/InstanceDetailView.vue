<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowBackOutline,
  PlayOutline,
  StopOutline,
  OpenOutline,
  PulseOutline,
  TerminalOutline,
  CreateOutline,
  RefreshOutline,
  CloudDownloadOutline,
  ArrowUpCircleOutline,
  ConstructOutline,
  ArrowDownOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NIcon,
  NTag,
  NSpace,
  NSpin,
  NSwitch,
  NDescriptions,
  NDescriptionsItem,
  NCollapse,
  NCollapseItem,
  NPopconfirm,
  NModal,
  NSelect,
  NTooltip,
  NTabs,
  NTabPane,
  useMessage
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onInstanceStatus, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { useComfyUpdate } from '@/composables/useComfyUpdate'
import { useAutoFollow } from '@/composables/useAutoFollow'
import ComfyUpdateProgressModal from '@/components/ComfyUpdateProgressModal.vue'
import { useI18n } from 'vue-i18n'
import type {
  ComfyInstanceInfo,
  ComfyLogLine,
  ComfyUpdateInfo,
  EnvCreateRequest,
  InstanceCapabilities,
  LaunchCommandPreview,
  LaunchProfile
} from '@shared/types'
import LaunchProfileEditor from '@/components/LaunchProfileEditor.vue'
import { LAUNCH_ARG_ERROR_KEYS, launchArgWarningKey } from '@shared/launchArgs'
import { versionMismatch } from '@/utils/versionDisplay'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const message = useMessage()
const { t } = useI18n()
const { launch, stop, restart, busy } = useLaunch()
const loading = ref(true)
const logs = ref<ComfyLogLine[]>([])
const instance = ref<ComfyInstanceInfo | null>(null)
const preview = ref<LaunchCommandPreview | null>(null)
/** Online facts from /system_stats + /features (0.1.10, running instances only). */
const capabilities = ref<InstanceCapabilities | null>(null)

/** Tab layout (0.1.11): basic info / launch tuning / terminal logs. */
type DetailTab = 'basic' | 'profile' | 'logs'
const TAB_NAMES: readonly DetailTab[] = ['basic', 'profile', 'logs']

/** Restore the tab from the URL hash so deep links / refreshes keep it. */
function initialTab(): DetailTab {
  const h = String(route.hash || '').replace(/^#/, '')
  return (TAB_NAMES as readonly string[]).includes(h) ? (h as DetailTab) : 'basic'
}

const tab = ref<DetailTab>(initialTab())

/** Terminal log pane — deeper history + auto-follow (0.1.11). */
const LOG_FETCH_LIMIT = 2000
const LOG_KEEP_MAX = 2000
const {
  el: logBox,
  follow: logFollow,
  showJump: logShowJump,
  onScroll: onLogScroll,
  requestScroll: requestLogScroll,
  jumpToBottom: logJumpToBottom
} = useAutoFollow()

// `logBox` is consumed by the template's ref="logBox" binding, which this
// ESLint config's template-ref detection does not see — keep an explicit use.
void logBox

/** The server-reported version wins over the install stamp while running. */
const onlineVersion = computed(() => instance.value?.onlineVersion || '')
/** Install record vs running version drift (0.1.11 — yellow badge + tooltip).
 *  Only comparable when BOTH sides are dotted versions; a commit-sha install
 *  stamp must never produce a false mismatch against `0.39.0` (0.1.11.1). */
const onlineVersionMismatch = computed(() =>
  versionMismatch(instance.value?.version, instance.value?.onlineVersion)
)
const runtimeLine = computed(() => {
  const caps = capabilities.value
  if (!caps) return ''
  const parts: string[] = []
  if (caps.pythonVersion) parts.push(caps.pythonVersion)
  if (caps.pytorchVersion) parts.push(`torch ${caps.pytorchVersion}`)
  return parts.join(' · ')
})
/** Frontend package drift between installed and required (yellow badge). */
const frontendPkg = computed(() => {
  const caps = capabilities.value
  if (!caps) return null
  const pkg = caps.packages.find((p) => p.name === 'comfyui-frontend-package')
  const installed = pkg?.installed || ''
  const required = pkg?.required || caps.requiredFrontendVersion || ''
  if (!installed && !required) return null
  return {
    installed: installed || '—',
    required: required || '—',
    mismatch: Boolean(installed && required && installed !== required)
  }
})
// ---------- 0.1.9: structured launch tuning (detail-page panel) ----------
const profileDraft = ref<LaunchProfile>({})
const savingProfile = ref(false)
let profileSyncedFor = ''

function warningText(w: { code: string; flag: string }): string {
  return t(launchArgWarningKey(w.code), { flag: w.flag })
}

function errorCodeLabel(e: { code: string; flag?: string }): string {
  if (e.code === 'invalid-number') return t('launchArgs.errInvalidNumber', { flag: e.flag || '' })
  return t(LAUNCH_ARG_ERROR_KEYS[e.code] || 'launchArgs.errGeneric', { flag: e.flag || '' })
}

async function saveProfile(): Promise<boolean> {
  const target = instance.value
  if (!target) return false
  savingProfile.value = true
  try {
    const profile = Object.keys(profileDraft.value).length ? { ...profileDraft.value } : undefined
    await ipc('instance.save', { ...target, launchProfile: profile })
    // The route may have switched during the await — only touch the view state
    // when we're still on the instance this save belongs to.
    if (instance.value?.id === target.id) {
      instance.value = { ...instance.value, launchProfile: profile }
      profileSyncedFor = target.id
      message.success(t('instance.configSaved'))
      if (instanceRunning.value) message.info(t('launchArgs.restartToApply'))
    }
    await refresh()
    return true
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    return false
  } finally {
    savingProfile.value = false
  }
}

async function restartWithProfile(): Promise<void> {
  const target = instance.value
  if (!target) return
  const saved = await saveProfile()
  // Never restart with stale config after a failed save, and never restart the
  // wrong instance when the route switched mid-flight.
  if (!saved || instance.value?.id !== target.id) return
  await restart(target)
  await refresh()
  void store.syncWs()
}

const id = computed(() => String(route.params.id || ''))
const instanceRunning = computed(() => instance.value?.status === 'running')
/** Starting counts as "stop-able" for button semantics; opening the frontend still needs ready. */
const canStop = computed(
  () => instance.value?.status === 'running' || instance.value?.status === 'starting'
)
const notFound = computed(() => !loading.value && !instance.value)
// Computed (not a one-shot t()) so the hint follows locale switches.
const needInstanceHint = computed(() => t('common.needRunningInstance'))

function openExternalIfRunning(): void {
  if (!instanceRunning.value) {
    message.warning(needInstanceHint.value)
    return
  }
  if (instance.value?.url) void ipc('shell.openExternal', instance.value.url)
}

function openEmbedIfRunning(): void {
  if (!instanceRunning.value) {
    message.warning(needInstanceHint.value)
    return
  }
  if (instance.value?.url) {
    void router.push({ path: '/embed', query: { url: instance.value.url } })
  }
}

function statusLabel(s: string | undefined): string {
  return t(`status.${s || 'unknown'}`)
}

function goEdit(): void {
  // Deep-link into the instances list so its edit modal opens for this id.
  void router.push({ path: '/instances', query: { edit: id.value } })
}

async function clearLogs(): Promise<void> {
  if (!id.value) return
  try {
    await ipc('instance.clearLogs', id.value)
    logs.value = []
    message.success(t('instance.logsCleared'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function copyLogs(): Promise<void> {
  if (!logs.value.length) return
  try {
    const text = logs.value
      .map((l) => `[${new Date(l.ts).toLocaleString()}] ${l.level.toUpperCase()} ${l.message}`)
      .join('\n')
    await ipc('shell.writeClipboard', text)
    message.success(t('instance.logCopied', { n: logs.value.length }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** Export the full log to a file (0.1.11) — the main process writes + reveals. */
const exportingLogs = ref(false)
async function exportLogs(): Promise<void> {
  if (!id.value) return
  exportingLogs.value = true
  try {
    const r = await ipc('instance.exportLogs', id.value)
    message.success(t('instance.logExported', { path: r.path }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    exportingLogs.value = false
  }
}

async function doLaunch(open: 'embed' | 'browser' | 'none' = 'none'): Promise<void> {
  if (!instance.value) return
  await launch(instance.value, { open })
  await refresh()
}

async function doStop(): Promise<void> {
  if (!instance.value) return
  await stop(instance.value)
  await refresh()
}

let refreshSeq = 0
let errorNotifiedFor: string | null = null

async function refresh(): Promise<void> {
  const seq = ++refreshSeq
  const forId = id.value
  try {
    await store.refreshInstances()
    // Ignore stale responses after the route switched to another instance.
    if (seq !== refreshSeq || forId !== id.value) return
    instance.value = store.instances.find((i) => i.id === forId) || null
    // Sync the profile draft only when the route switches to another instance,
    // so background refreshes can never clobber unsaved edits.
    if (profileSyncedFor !== forId) {
      profileSyncedFor = forId
      profileDraft.value = { ...(instance.value?.launchProfile || {}) }
    }
    const logsResult = await ipc('instance.getLogs', forId, LOG_FETCH_LIMIT)
    if (seq !== refreshSeq || forId !== id.value) return
    logs.value = logsResult
    requestLogScroll()
    // Online capabilities (0.1.10): only meaningful while running; failures are
    // silent (the panel simply shows dashes).
    if (instance.value?.status === 'running') {
      try {
        const caps = await ipc('instance.capabilities', forId)
        if (seq !== refreshSeq || forId !== id.value) return
        capabilities.value = caps
      } catch {
        if (seq === refreshSeq && forId === id.value) capabilities.value = null
      }
    } else if (seq === refreshSeq && forId === id.value) {
      capabilities.value = null
    }
    // Always re-fetch the preview — config (port/args/path) can change under us.
    try {
      const p = await ipc('instance.previewLaunch', forId)
      if (seq !== refreshSeq || forId !== id.value) return
      preview.value = p
    } catch {
      if (seq === refreshSeq && forId === id.value) preview.value = null
    }
  } catch (err) {
    if (seq === refreshSeq && forId === id.value && errorNotifiedFor !== forId) {
      errorNotifiedFor = forId
      message.error(err instanceof Error ? err.message : String(err))
    }
  } finally {
    if (seq === refreshSeq) loading.value = false
  }
}

async function copyCommand(): Promise<void> {
  if (!preview.value) return
  await ipc('shell.writeClipboard', preview.value.commandLine)
  message.success(t('instance.launchCmdCopied'))
}

// ---------- ComfyUI update / repair (0.1.4) ----------
const {
  startUpdate,
  checkComfyUpdate,
  repairEnv,
  updating,
  repairing: repairInFlight,
  progress
} = useComfyUpdate()
const showUpdateModal = ref(false)
const updateModalTitle = ref('')
const updateInfo = ref<ComfyUpdateInfo | null>(null)
const checkingUpdate = ref(false)
const repairing = ref(false)

/** Reopen the (now closable) progress modal after the user hid it (0.1.11). */
function reopenUpdateModal(): void {
  // Repair and update share the stream — label by what actually runs.
  updateModalTitle.value = repairInFlight.value
    ? t('instance.repairEnv')
    : t('instance.updateComfy')
  showUpdateModal.value = true
}

function sourceLabel(source: ComfyUpdateInfo['source']): string {
  if (source === 'git') return t('instance.sourceGit')
  if (source === 'zip') return t('instance.sourceZip')
  return t('instance.sourceUnknown')
}

async function doCheckUpdate(): Promise<void> {
  if (!instance.value) return
  checkingUpdate.value = true
  try {
    updateInfo.value = await checkComfyUpdate(instance.value.id)
  } catch (err) {
    message.error(
      t('instance.updateCheckFailed', { error: err instanceof Error ? err.message : String(err) })
    )
  } finally {
    checkingUpdate.value = false
  }
}

async function runUpdateComfy(): Promise<void> {
  if (!instance.value) return
  updateModalTitle.value = t('instance.updateComfy')
  showUpdateModal.value = true
  try {
    const result = await startUpdate(instance.value.id, { updateDeps: true })
    if (result.status === 'done') {
      message.success(t('update.msgDone'))
      await refresh()
    } else if (result.error) {
      message.error(result.error)
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function runRepairEnv(): Promise<void> {
  if (!instance.value) return
  repairing.value = true
  // Show the shared progress modal so the user can watch venv/torch/requirements.
  updateModalTitle.value = t('instance.repairEnv')
  showUpdateModal.value = true
  try {
    await repairEnv(instance.value.id)
    message.success(t('instance.repairDone'))
  } catch (err) {
    message.error(
      t('instance.repairFailed', { error: err instanceof Error ? err.message : String(err) })
    )
  } finally {
    repairing.value = false
  }
}

// ---------- env.createVenv / env.installTorch / instance.copyDiagnostics ----------
const recreatingVenv = ref(false)
const reinstallingTorch = ref(false)
const copyingDiag = ref(false)

/** Basename of a path (renderer has no Node path module). */
function baseName(p: string): string {
  const norm = String(p || '').replace(/[\\/]+$/, '')
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return i >= 0 ? norm.slice(i + 1) : norm
}

/** Dirname of a path (renderer has no Node path module). Empty when there is no separator. */
function dirName(p: string): string {
  const norm = String(p || '').replace(/[\\/]+$/, '')
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return i >= 0 ? norm.slice(0, i) : ''
}

/** Where this instance's venv lives — mirrors env.repairEnv's default. */
function venvLocationOf(inst: ComfyInstanceInfo): { basePath: string; name: string } {
  const venv = String(inst.venvPath || '').trim()
  if (venv) return { basePath: dirName(venv) || '.', name: baseName(venv) || 'venv' }
  return { basePath: dirName(inst.path) || '.', name: '.venv' }
}

/**
 * env.createVenv — recreate the instance's virtualenv.
 * basePath/name follow the instance's venvPath (or repairEnv's default sibling .venv).
 */
async function recreateVenv(): Promise<void> {
  const inst = instance.value
  if (!inst) return
  recreatingVenv.value = true
  try {
    const { basePath, name } = venvLocationOf(inst)
    // uv is optional — createVenv(useUv:true) runs `uv venv` and hard-fails without it.
    const boot = await ipc('bootstrap.status')
    const useUv = boot.components.some((c) => c.kind === 'uv' && c.installed)
    const pythonPath =
      String(inst.pythonPath || '').trim() ||
      (boot.pythonPath && boot.pythonPath !== 'python' ? boot.pythonPath : 'python')
    const req: EnvCreateRequest = {
      basePath,
      name,
      pythonPath,
      useUv
    }
    await ipc('env.createVenv', req)
    message.success(t('instance.recreateVenvDone'))
  } catch (err) {
    message.error(
      t('instance.recreateVenvFailed', { error: err instanceof Error ? err.message : String(err) })
    )
  } finally {
    recreatingVenv.value = false
  }
}

/**
 * env.installTorch — reinstall torch/torchvision/torchaudio into the instance venv.
 * Opens a channel picker first: the IPC needs a full PEP 503 index URL, and the
 * correct one depends on the GPU (settings.torchIndexMirror is only a prefix).
 */
const showTorchModal = ref(false)
const torchIndexChoice = ref<string>('https://download.pytorch.org/whl/cpu/')

// Official per-channel indices — mirrors main TORCH_INDEX (installer.ts).
// Labels reuse the existing install.torchChannels.* i18n keys.
const TORCH_INDEX_OPTIONS = [
  { labelKey: 'install.torchChannels.cu130', value: 'https://download.pytorch.org/whl/cu130/' },
  { labelKey: 'install.torchChannels.cu126', value: 'https://download.pytorch.org/whl/cu126/' },
  { labelKey: 'install.torchChannels.cu124', value: 'https://download.pytorch.org/whl/cu124/' },
  { labelKey: 'install.torchChannels.rocm', value: 'https://download.pytorch.org/whl/rocm6.2/' },
  { labelKey: 'install.torchChannels.xpu', value: 'https://download.pytorch.org/whl/xpu/' },
  { labelKey: 'install.torchChannels.mps', value: 'https://download.pytorch.org/whl/cpu/' },
  { labelKey: 'install.torchChannels.cpu', value: 'https://download.pytorch.org/whl/cpu/' }
]

const torchIndexSelectOptions = computed(() =>
  TORCH_INDEX_OPTIONS.map((o) => ({ label: t(o.labelKey), value: o.value }))
)

function openTorchModal(): void {
  torchIndexChoice.value = 'https://download.pytorch.org/whl/cpu/'
  showTorchModal.value = true
}

async function reinstallTorch(): Promise<void> {
  const inst = instance.value
  if (!inst) return
  showTorchModal.value = false
  reinstallingTorch.value = true
  try {
    const probe = await ipc('env.probe', {
      pythonPath: String(inst.pythonPath || '').trim() || 'python',
      venvPath: String(inst.venvPath || '').trim() || undefined
    })
    await ipc('env.installTorch', {
      pythonPath: probe.pythonPath,
      index: torchIndexChoice.value
    })
    message.success(t('instance.reinstallTorchDone'))
  } catch (err) {
    message.error(
      t('instance.reinstallTorchFailed', {
        error: err instanceof Error ? err.message : String(err)
      })
    )
  } finally {
    reinstallingTorch.value = false
  }
}

/** instance.copyDiagnostics — build a diagnostics package and copy its path. */
async function copyDiagPath(): Promise<void> {
  const inst = instance.value
  if (!inst) return
  copyingDiag.value = true
  try {
    const path = await ipc('instance.copyDiagnostics', inst.id)
    message.success(t('instance.copyDiagPathDone', { path }))
  } catch (err) {
    message.error(
      t('instance.copyDiagPathFailed', { error: err instanceof Error ? err.message : String(err) })
    )
  } finally {
    copyingDiag.value = false
  }
}

/**
 * Startup self-check (0.1.10 / concurrency 0.1.11): loads every custom node
 * with `--quick-test-for-ci --cpu`. A running instance no longer blocks it —
 * the check runs on its own ephemeral port; results stream into this log.
 */
const selfChecking = ref(false)
async function runSelfCheck(): Promise<void> {
  const inst = instance.value
  if (!inst) return
  if (inst.status === 'running' || inst.status === 'starting') {
    message.info(t('nodes.selfCheckConcurrent'))
  }
  selfChecking.value = true
  try {
    const r = await ipc('instance.runStartupSelfCheck', inst.id)
    if (r.ok) message.success(t('nodes.selfCheckPassed'))
    else message.error(t('nodes.selfCheckFailed', { code: r.exitCode ?? '?' }))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    selfChecking.value = false
  }
}

let off: (() => void) | null = null
let offLog: (() => void) | null = null

onMounted(() => {
  void refresh()
  off = onInstanceStatus(() => {
    void refresh()
  })
  // Live log tail — append without full refresh (bounded, with auto-follow).
  offLog = onIpc(IPC_EVENTS.instanceLog, (payload) => {
    const p = payload as { id: string; line: ComfyLogLine }
    if (p?.id === id.value && p.line) {
      logs.value = [...logs.value.slice(-(LOG_KEEP_MAX - 1)), p.line]
      requestLogScroll()
    }
  })
})

onUnmounted(() => {
  off?.()
  offLog?.()
})

// Entering the logs tab re-pins the terminal to the bottom (the pane is not
// mounted while hidden, so scroll metrics only exist after activation) and
// the URL hash mirrors the active tab (0.1.11 — refresh keeps the tab).
watch(tab, (v) => {
  void router.replace({ hash: `#${v}` })
  if (v === 'logs') requestLogScroll()
})

// /instances/A → /instances/B reuses this component — reset per-instance state.
watch(
  () => route.params.id,
  () => {
    loading.value = true
    instance.value = null
    logs.value = []
    preview.value = null
    capabilities.value = null
    updateInfo.value = null
    showUpdateModal.value = false
    updateModalTitle.value = ''
    checkingUpdate.value = false
    repairing.value = false
    tab.value = initialTab()
    void refresh()
  }
)
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <NButton text @click="router.push('/instances')">
          <template #icon>
            <NIcon :component="ArrowBackOutline" />
          </template>
          {{ $t('instance.backToList') }}
        </NButton>
        <h1 class="page-title detail-title">{{ instance?.name || $t('instance.detailTitle') }}</h1>
        <p class="page-subtitle mono" :title="instance?.path">{{ instance?.path }}</p>
      </div>
      <NSpace>
        <NButton v-if="!canStop" type="primary" :loading="busy[id]" @click="doLaunch('embed')">
          <template #icon>
            <NIcon :component="PlayOutline" />
          </template>
          {{ $t('header.launchAndOpen') }}
        </NButton>
        <NButton v-else type="warning" secondary :loading="busy[`stop:${id}`]" @click="doStop">
          <template #icon>
            <NIcon :component="StopOutline" />
          </template>
          {{ $t('header.stop') }}
        </NButton>
        <NButton secondary :disabled="canStop" :loading="busy[id]" @click="doLaunch('none')">
          <template #icon>
            <NIcon :component="PlayOutline" />
          </template>
          {{ $t('instance.startOnly') }}
        </NButton>
        <NTooltip trigger="hover" :disabled="instanceRunning">
          <template #trigger>
            <span class="btn-wrap">
              <NButton secondary :disabled="!instanceRunning" @click="openExternalIfRunning">
                <template #icon>
                  <NIcon :component="OpenOutline" />
                </template>
                {{ $t('header.openExternal') }}
              </NButton>
            </span>
          </template>
          {{ needInstanceHint }}
        </NTooltip>
        <NTooltip trigger="hover" :disabled="instanceRunning">
          <template #trigger>
            <span class="btn-wrap">
              <NButton
                type="primary"
                secondary
                :disabled="!instanceRunning"
                @click="openEmbedIfRunning"
              >
                <template #icon>
                  <NIcon :component="PulseOutline" />
                </template>
                {{ $t('header.embed') }}
              </NButton>
            </span>
          </template>
          {{ needInstanceHint }}
        </NTooltip>
        <NButton secondary @click="goEdit">
          <template #icon>
            <NIcon :component="CreateOutline" />
          </template>
          {{ $t('common.edit') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
      <!-- The progress modal is closable while running (0.1.11); this banner
           keeps the operation reachable until it settles. -->
      <div v-if="updating" class="update-running-banner card">
        <NTag size="small" type="info" round>{{ $t('update.inProgress') }}</NTag>
        <span class="meta update-running-msg mono">{{ progress?.message || '' }}</span>
        <NButton size="tiny" secondary @click="reopenUpdateModal">{{
          $t('nodes.viewProgress')
        }}</NButton>
      </div>
      <NSpin :show="loading" content-class="page-body-spin-fill">
        <div v-if="notFound" class="card not-found">
          <div class="not-found-title">{{ $t('instance.notFoundTitle') }}</div>
          <div class="not-found-hint">{{ $t('instance.notFoundHint') }}</div>
          <NButton type="primary" @click="router.push('/instances')">
            <template #icon><NIcon :component="ArrowBackOutline" /></template>
            {{ $t('instance.backToList') }}
          </NButton>
        </div>
        <NTabs v-else v-model:value="tab" type="line" class="detail-tabs">
          <NTabPane name="basic" key="basic" :tab="$t('instance.tabBasic')">
            <section class="card panel">
              <NDescriptions bordered size="small" :column="2" label-placement="left" class="desc">
                <NDescriptionsItem :label="$t('common.status')" :span="2">
                  <NSpace align="center" :size="8">
                    <NTag
                      :type="
                        instance?.status === 'running'
                          ? 'success'
                          : instance?.status === 'error'
                            ? 'error'
                            : 'default'
                      "
                      round
                    >
                      {{ statusLabel(instance?.status) }}
                    </NTag>
                    <span
                      v-if="instance?.status === 'error' && instance?.lastError"
                      class="last-error"
                    >
                      {{ instance.lastError }}
                    </span>
                  </NSpace>
                </NDescriptionsItem>
                <NDescriptionsItem :label="$t('instance.metaPid')">{{
                  instance?.pid || '—'
                }}</NDescriptionsItem>
                <NDescriptionsItem :label="$t('instance.listen')"
                  >{{ instance?.listen }}:{{ instance?.port }}</NDescriptionsItem
                >
                <NDescriptionsItem :label="$t('common.version')">
                  <NSpace align="center" :size="6">
                    <span>{{ instance?.onlineVersion || instance?.version || '—' }}</span>
                    <NTag
                      v-if="onlineVersion"
                      size="tiny"
                      round
                      :type="onlineVersionMismatch ? 'warning' : 'success'"
                      :title="
                        onlineVersionMismatch
                          ? $t('instance.onlineVersionMismatch', {
                              installed: instance?.version || '—',
                              online: onlineVersion
                            })
                          : $t('instance.onlineVersionTip')
                      "
                    >
                      {{
                        onlineVersionMismatch
                          ? $t('instance.onlineVersionBadgeWarn')
                          : $t('instance.onlineBadge')
                      }}
                    </NTag>
                  </NSpace>
                </NDescriptionsItem>
                <NDescriptionsItem :label="$t('instance.runtimeLabel')">{{
                  runtimeLine || '—'
                }}</NDescriptionsItem>
                <NDescriptionsItem :label="$t('instance.frontendLabel')">
                  <NTag
                    v-if="frontendPkg"
                    size="tiny"
                    round
                    :type="frontendPkg.mismatch ? 'warning' : 'success'"
                    :title="
                      frontendPkg.mismatch
                        ? $t('instance.frontendMismatch', {
                            installed: frontendPkg.installed,
                            required: frontendPkg.required
                          })
                        : $t('instance.frontendMatch', { version: frontendPkg.installed })
                    "
                  >
                    {{
                      frontendPkg.mismatch
                        ? `${frontendPkg.installed} → ${frontendPkg.required}`
                        : frontendPkg.installed
                    }}
                  </NTag>
                  <template v-else>—</template>
                </NDescriptionsItem>
                <NDescriptionsItem label="Python">{{
                  instance?.pythonPath || $t('instance.pythonSystem')
                }}</NDescriptionsItem>
                <NDescriptionsItem :label="$t('instance.metaAutoStart')">{{
                  instance?.autoStart ? $t('common.yes') : $t('common.no')
                }}</NDescriptionsItem>
                <NDescriptionsItem label="URL" :span="2">
                  <span class="mono url-line">{{ instance?.url }}</span>
                </NDescriptionsItem>
              </NDescriptions>

              <div class="update-actions">
                <NSpace>
                  <NButton secondary :loading="checkingUpdate" @click="doCheckUpdate">
                    <template #icon><NIcon :component="CloudDownloadOutline" /></template>
                    {{ $t('instance.checkUpdate') }}
                  </NButton>
                  <NPopconfirm @positive-click="runUpdateComfy">
                    <template #trigger>
                      <NButton type="primary" secondary :loading="updating">
                        <template #icon><NIcon :component="ArrowUpCircleOutline" /></template>
                        {{ $t('instance.updateComfy') }}
                      </NButton>
                    </template>
                    <div class="confirm-body">
                      <div>{{ $t('instance.confirmUpdateComfyBody') }}</div>
                      <div class="confirm-note">{{ $t('instance.preserveNote') }}</div>
                    </div>
                  </NPopconfirm>
                  <NPopconfirm @positive-click="runRepairEnv">
                    <template #trigger>
                      <NButton secondary :loading="repairing">
                        <template #icon><NIcon :component="ConstructOutline" /></template>
                        {{ $t('instance.repairEnv') }}
                      </NButton>
                    </template>
                    {{ $t('install.repairConfirm', { name: instance?.name || '' }) }}
                  </NPopconfirm>
                </NSpace>
              </div>

              <div class="update-actions env-actions">
                <div class="update-result-title">{{ $t('instance.diagnostics') }}</div>
                <NSpace>
                  <NPopconfirm @positive-click="recreateVenv">
                    <template #trigger>
                      <NButton secondary :loading="recreatingVenv" :disabled="!instance">
                        {{ $t('instance.recreateVenv') }}
                      </NButton>
                    </template>
                    {{ $t('instance.recreateVenvConfirm') }}
                  </NPopconfirm>
                  <NButton
                    secondary
                    :loading="reinstallingTorch"
                    :disabled="!instance"
                    @click="openTorchModal"
                  >
                    {{ $t('instance.reinstallTorch') }}
                  </NButton>
                  <NButton
                    secondary
                    :loading="copyingDiag"
                    :disabled="!instance"
                    @click="copyDiagPath"
                  >
                    {{ $t('instance.copyDiagPath') }}
                  </NButton>
                  <NTooltip trigger="hover">
                    <template #trigger>
                      <NButton
                        secondary
                        :loading="selfChecking"
                        :disabled="!instance"
                        @click="runSelfCheck"
                      >
                        {{ $t('nodes.selfCheck') }}
                      </NButton>
                    </template>
                    {{ $t('nodes.selfCheckTip') }}
                  </NTooltip>
                </NSpace>
              </div>

              <div v-if="updateInfo" class="update-result">
                <div class="update-result-title">{{ $t('instance.checkUpdate') }}</div>
                <div class="update-result-line">
                  <span>{{ $t('instance.versionLabel') }}: {{ updateInfo.current }}</span>
                  <span v-if="updateInfo.latest">{{
                    $t('nodes.hasUpdate', { version: updateInfo.latest })
                  }}</span>
                  <span v-if="typeof updateInfo.behindCount === 'number'">
                    {{ $t('instance.behindCount', { n: updateInfo.behindCount }) }}
                  </span>
                  <span>{{ sourceLabel(updateInfo.source) }}</span>
                </div>
                <NTag size="small" round :type="updateInfo.updatable ? 'warning' : 'success'">
                  {{
                    updateInfo.updatable
                      ? $t('instance.updateAvailable', {
                          latest: updateInfo.latest || updateInfo.current,
                          current: updateInfo.current
                        })
                      : $t('instance.updateNone')
                  }}
                </NTag>
                <div v-if="updateInfo.error" class="update-error">
                  {{ $t('instance.updateCheckFailed', { error: updateInfo.error }) }}
                </div>
              </div>

              <NCollapse v-if="preview" class="cmd-collapse">
                <NCollapseItem :title="$t('instance.launchCmdTitle')" name="cmd">
                  <div class="cmd-box">
                    <div class="mono cmd-cwd">cwd: {{ preview.cwd }}</div>
                    <pre class="mono cmd-line">{{ preview.commandLine }}</pre>
                    <div v-if="preview.validationErrors?.length" class="cmd-errs">
                      <div v-for="(e, i) in preview.validationErrors" :key="i" class="cmd-err">
                        • {{ errorCodeLabel(e) }}
                      </div>
                    </div>
                    <div v-if="preview.validationWarnings?.length" class="cmd-warns">
                      <div v-for="(w, i) in preview.validationWarnings" :key="i" class="cmd-warn">
                        • {{ warningText(w) }}
                      </div>
                    </div>
                    <NButton size="tiny" secondary @click="copyCommand">
                      <template #icon><NIcon :component="TerminalOutline" /></template>
                      {{ $t('instance.copyCmd') }}
                    </NButton>
                  </div>
                </NCollapseItem>
              </NCollapse>
            </section>
          </NTabPane>

          <NTabPane name="profile" key="profile" :tab="$t('instance.tabProfile')">
            <section class="card panel">
              <!-- Flat editor (0.1.11): no nested same-name collapse. -->
              <LaunchProfileEditor
                v-model="profileDraft"
                :extra-args="instance?.extraArgs || []"
                :gpus="store.system?.gpus"
                :version="instance?.onlineVersion || ''"
                :baseline="instance?.launchProfile"
              />
              <NSpace justify="end" style="margin-top: 12px">
                <NButton
                  size="small"
                  secondary
                  :disabled="!instanceRunning"
                  @click="restartWithProfile"
                >
                  {{ $t('instance.restart') }}
                </NButton>
                <NButton size="small" type="primary" :loading="savingProfile" @click="saveProfile">
                  {{ $t('common.save') }}
                </NButton>
              </NSpace>
            </section>
          </NTabPane>

          <NTabPane
            name="logs"
            key="logs"
            :tab="$t('instance.tabLogs')"
            display-directive="show"
          >
            <section class="card panel logs">
              <div class="panel-head log-head">
                <div class="panel-title">{{ $t('instance.liveLogs') }}</div>
                <NSpace :size="10" align="center">
                  <NSpace :size="6" align="center">
                    <NSwitch v-model:value="logFollow" size="small" />
                    <span class="log-follow-label">{{ $t('instance.logAutoFollow') }}</span>
                  </NSpace>
                  <NButton size="tiny" secondary :disabled="!logs.length" @click="copyLogs">
                    {{ $t('instance.logCopy') }}
                  </NButton>
                  <NButton
                    size="tiny"
                    secondary
                    :disabled="!logs.length"
                    :loading="exportingLogs"
                    @click="exportLogs"
                  >
                    {{ $t('instance.logExport') }}
                  </NButton>
                  <NButton size="tiny" secondary @click="clearLogs">
                    {{ $t('instance.clearLogs') }}
                  </NButton>
                  <NButton size="tiny" secondary @click="refresh">
                    <template #icon><NIcon :component="RefreshOutline" /></template>
                    {{ $t('common.refresh') }}
                  </NButton>
                </NSpace>
              </div>
              <div class="term-wrap">
                <div ref="logBox" class="term" @scroll.passive="onLogScroll">
                  <div v-if="!logs.length" class="term-empty">
                    {{ $t('instance.logEmptyHint') }}
                  </div>
                  <div v-for="(line, idx) in logs" :key="idx" class="term-line" :class="line.level">
                    <span class="term-time">{{ new Date(line.ts).toLocaleTimeString() }}</span>
                    <span class="term-msg">{{ line.message }}</span>
                  </div>
                </div>
                <button v-if="logShowJump" type="button" class="term-jump" @click="logJumpToBottom">
                  <NIcon :size="14" :component="ArrowDownOutline" />
                  {{ $t('instance.logJumpBottom') }}
                </button>
              </div>
            </section>
          </NTabPane>
        </NTabs>
      </NSpin>
    </div>

    <!-- ComfyUI update progress -->
    <ComfyUpdateProgressModal v-model:show="showUpdateModal" :title="updateModalTitle" />

    <!-- env.installTorch channel picker -->
    <NModal
      v-model:show="showTorchModal"
      preset="card"
      :title="$t('instance.reinstallTorch')"
      style="width: 480px; border-radius: 20px"
    >
      <div class="confirm-body">
        <div>{{ $t('instance.reinstallTorchConfirm') }}</div>
      </div>
      <div class="torch-field">
        <div class="update-result-title">{{ $t('instance.torchIndexLabel') }}</div>
        <NSelect v-model:value="torchIndexChoice" :options="torchIndexSelectOptions" />
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showTorchModal = false">{{ $t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="reinstallingTorch" @click="reinstallTorch">
            {{ $t('common.confirm') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.detail-tabs {
  margin-top: 4px;
}

/* ---------- Definite-height layout chain (0.1.11.1) ----------
   .page-body → .n-spin-container → [.n-spin-content] → .n-tabs must all be
   flex so the tab pane gets a definite height. NSpin injects .n-spin-content
   (a naive internal, not reachable from scoped CSS) — it is chained via
   content-class="page-body-spin-fill" in index.scss. Without the FULL chain
   the PAGE (.page-body) owned the scrollbar — the terminal could never own
   its own scrollbar and auto-follow scrolled an element the user was not
   looking at. */
.page-body {
  display: flex;
  flex-direction: column;
}

.page-body > .n-spin-container {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* The logs pane fills the pane box exactly; the terminal inside owns the
   scrollbar (never the pane, never the page). */
.logs {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.detail-title {
  margin-top: 8px;
}

.btn-wrap {
  display: inline-flex;
}

.update-running-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  margin-bottom: 12px;
}

.update-running-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.not-found {
  padding: 48px 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
}

.not-found-title {
  font-size: 18px;
  font-weight: 700;
}

.not-found-hint {
  font-size: 13px;
  color: $color-text-muted-ink;
  max-width: 480px;
}

.panel {
  padding: 20px;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 12px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.log-head {
  margin-bottom: 10px;

  .panel-title {
    margin-bottom: 0;
  }
}

.log-follow-label {
  font-size: 12px;
  color: $color-text-secondary;
}

.desc {
  --n-td-color: transparent;
}

.update-actions {
  margin-top: 14px;
}

.env-actions {
  padding-top: 4px;
  border-top: 1px dashed $color-border;
}

.env-actions .update-result-title {
  margin-bottom: 8px;
}

.torch-field {
  margin-top: 14px;
}

.torch-field .update-result-title {
  margin-bottom: 6px;
}

.confirm-body {
  max-width: 360px;
  line-height: 1.55;
}

.confirm-note {
  margin-top: 6px;
  color: $color-text-muted-ink;
  font-size: 12px;
}

.update-result {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: $color-surface-2;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.update-result-title {
  font-size: 12px;
  font-weight: 700;
  color: $color-text-muted-ink;
}

.update-result-line {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12.5px;
  color: $color-text-secondary;
}

.update-error {
  font-size: 12px;
  color: $color-danger;
  word-break: break-all;
}

.last-error {
  font-size: 12px;
  color: $color-danger;
  word-break: break-all;
  line-height: 1.5;
}

.cmd-collapse {
  margin-top: 14px;
}

.cmd-box {
  background: $color-surface-2;
  border-radius: 12px;
  padding: 12px;
}

.cmd-cwd {
  font-size: 11px;
  color: $color-text-muted-ink;
  margin-bottom: 6px;
  word-break: break-all;
}

.cmd-line {
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0 0 10px;
  line-height: 1.55;
}

/* ---------- Terminal log pane (0.1.11) ---------- */
.term-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

.term {
  flex: 1;
  min-width: 0;
  /* Usable floor on tiny viewports — beyond this the PANE scrolls (acceptable
     degradation) instead of squeezing the terminal to nothing. */
  min-height: 160px;
  background: $term-bg;
  border: 1px solid $term-border;
  border-radius: 14px;
  padding: 12px 14px;
  overflow-y: auto;
  font-family: $font-mono;
  font-size: 12px;
  line-height: 1.65;
}

.term-empty {
  color: $term-dim;
  font-size: 13px;
  padding: 24px;
  text-align: center;
}

.term-line {
  display: flex;
  gap: 10px;
  padding: 1px 0;

  &.info {
    color: $term-text;
  }
  &.warn {
    color: $term-warn;
  }
  &.error {
    color: $term-error;
  }
  &.debug {
    color: $term-dim;
  }
}

.term-time {
  color: $term-dim;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.term-msg {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.term-jump {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid rgba($color-primary, 0.4);
  background: $color-surface;
  color: $color-primary;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: $shadow-md;

  &:hover {
    background: rgba($color-primary, 0.08);
  }
}

.url-line {
  word-break: break-all;
}
.cmd-warns {
  margin-top: 6px;
}
.cmd-errs {
  margin-top: 6px;
}
.cmd-err {
  font-size: 12px;
  color: $color-danger;
  line-height: 1.7;
}
.cmd-warn {
  font-size: 12px;
  color: $color-warning;
  line-height: 1.7;
}
</style>
