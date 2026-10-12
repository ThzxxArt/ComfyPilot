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
  ConstructOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NIcon,
  NTag,
  NSpace,
  NScrollbar,
  NSpin,
  NDescriptions,
  NDescriptionsItem,
  NCollapse,
  NCollapseItem,
  NPopconfirm,
  NModal,
  NSelect,
  NTooltip,
  useMessage
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onInstanceStatus, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { useComfyUpdate } from '@/composables/useComfyUpdate'
import ComfyUpdateProgressModal from '@/components/ComfyUpdateProgressModal.vue'
import { useI18n } from 'vue-i18n'
import type {
  ComfyInstanceInfo,
  ComfyLogLine,
  ComfyUpdateInfo,
  EnvCreateRequest,
  LaunchCommandPreview
} from '@shared/types'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const message = useMessage()
const { t } = useI18n()
const { launch, stop, busy } = useLaunch()
const loading = ref(true)
const logs = ref<ComfyLogLine[]>([])
const instance = ref<ComfyInstanceInfo | null>(null)
const preview = ref<LaunchCommandPreview | null>(null)

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
    const logsResult = await ipc('instance.getLogs', forId, 400)
    if (seq !== refreshSeq || forId !== id.value) return
    logs.value = logsResult
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
const { startUpdate, checkComfyUpdate, repairEnv, updating } = useComfyUpdate()
const showUpdateModal = ref(false)
const updateModalTitle = ref('')
const updateInfo = ref<ComfyUpdateInfo | null>(null)
const checkingUpdate = ref(false)
const repairing = ref(false)

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

let off: (() => void) | null = null
let offLog: (() => void) | null = null

onMounted(() => {
  void refresh()
  off = onInstanceStatus(() => {
    void refresh()
  })
  // Live log tail — append without full refresh
  offLog = onIpc(IPC_EVENTS.instanceLog, (payload) => {
    const p = payload as { id: string; line: ComfyLogLine }
    if (p?.id === id.value && p.line) {
      logs.value = [...logs.value.slice(-499), p.line]
    }
  })
})

onUnmounted(() => {
  off?.()
  offLog?.()
})

// /instances/A → /instances/B reuses this component — reset per-instance state.
watch(
  () => route.params.id,
  () => {
    loading.value = true
    instance.value = null
    logs.value = []
    preview.value = null
    updateInfo.value = null
    showUpdateModal.value = false
    updateModalTitle.value = ''
    checkingUpdate.value = false
    repairing.value = false
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
      <NSpin :show="loading">
        <div v-if="notFound" class="card not-found">
          <div class="not-found-title">{{ $t('instance.notFoundTitle') }}</div>
          <div class="not-found-hint">{{ $t('instance.notFoundHint') }}</div>
          <NButton type="primary" @click="router.push('/instances')">
            <template #icon><NIcon :component="ArrowBackOutline" /></template>
            {{ $t('instance.backToList') }}
          </NButton>
        </div>
        <div v-else class="grid layout">
          <section class="card panel">
            <div class="panel-title">{{ $t('instance.basicInfo') }}</div>
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
              <NDescriptionsItem :label="$t('common.version')">{{
                instance?.version || '—'
              }}</NDescriptionsItem>
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
                  <NButton size="tiny" secondary @click="copyCommand">
                    <template #icon><NIcon :component="TerminalOutline" /></template>
                    {{ $t('instance.copyCmd') }}
                  </NButton>
                </div>
              </NCollapseItem>
            </NCollapse>
          </section>

          <section class="card panel logs">
            <div class="panel-head">
              <div class="panel-title">{{ $t('instance.liveLogs') }}</div>
              <NSpace :size="6">
                <NButton size="tiny" secondary @click="clearLogs">
                  {{ $t('instance.clearLogs') }}
                </NButton>
                <NButton size="tiny" secondary @click="refresh">
                  <template #icon><NIcon :component="RefreshOutline" /></template>
                  {{ $t('common.refresh') }}
                </NButton>
              </NSpace>
            </div>
            <NScrollbar class="log-scroll" style="height: 420px">
              <div class="log-inner">
                <div v-if="!logs.length" class="log-empty">{{ $t('instance.logEmptyHint') }}</div>
                <div v-for="(line, idx) in logs" :key="idx" class="log-line" :class="line.level">
                  <span class="log-time">{{ new Date(line.ts).toLocaleTimeString() }}</span>
                  <span class="log-msg">{{ line.message }}</span>
                </div>
              </div>
            </NScrollbar>
          </section>
        </div>
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

.layout {
  grid-template-columns: 1.1fr 1fr;
  align-items: stretch;
}

/* 窄窗口下双栏挤成一团，退化为单栏（日志区在下方完整展示） */
@media (max-width: 1280px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.detail-title {
  margin-top: 8px;
}

.btn-wrap {
  display: inline-flex;
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

.log-scroll {
  height: 420px;
  background: $color-bg-soft;
  border: 1px solid $color-border;
  border-radius: 14px;
  /* no padding here — padding on NScrollbar breaks its own height calc
     and the outer page ends up scrolling instead of the log */
  overflow: hidden;
}

.log-inner {
  padding: 12px;
}

.log-line {
  display: flex;
  gap: 10px;
  font-family: $font-mono;
  font-size: 12px;
  line-height: 1.65;
  padding: 2px 0;

  &.error {
    color: $color-danger;
  }
  &.warn {
    color: $color-warning;
  }
  &.info {
    color: $color-text-secondary;
  }
}

.log-time {
  color: $color-text-muted-ink;
  flex-shrink: 0;
}

.log-msg {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-empty {
  color: $color-text-muted-ink;
  font-size: 13px;
  padding: 24px;
  text-align: center;
}

.url-line {
  word-break: break-all;
}
</style>
