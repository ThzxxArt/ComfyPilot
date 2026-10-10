<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowBackOutline, PlayOutline, StopOutline, OpenOutline, PulseOutline,
  TerminalOutline, CreateOutline, RefreshOutline, CloudDownloadOutline,
  ArrowUpCircleOutline, ConstructOutline
} from '@vicons/ionicons5'
import {
  NButton, NIcon, NTag, NSpace, NScrollbar, NSpin, NDescriptions, NDescriptionsItem,
  NCollapse, NCollapseItem, NPopconfirm, useMessage
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onInstanceStatus, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { useComfyUpdate } from '@/composables/useComfyUpdate'
import ComfyUpdateProgressModal from '@/components/ComfyUpdateProgressModal.vue'
import { useI18n } from 'vue-i18n'
import type {
  ComfyInstanceInfo, ComfyLogLine, ComfyUpdateInfo, LaunchCommandPreview
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
const needInstanceHint = t('common.needRunningInstance')

function openExternalIfRunning(): void {
  if (!instanceRunning.value) {
    message.warning(needInstanceHint)
    return
  }
  if (instance.value?.url) void ipc('shell.openExternal', instance.value.url)
}

function openEmbedIfRunning(): void {
  if (!instanceRunning.value) {
    message.warning(needInstanceHint)
    return
  }
  if (instance.value?.url) {
    void router.push({ path: '/embed', query: { url: instance.value.url } })
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

async function refresh(): Promise<void> {
  try {
    await store.refreshInstances()
    instance.value = store.instances.find((i) => i.id === id.value) || null
    logs.value = await ipc('instance.getLogs', id.value, 400)
    if (!preview.value) {
      try {
        preview.value = await ipc('instance.previewLaunch', id.value)
      } catch {
        /* instance may be missing */
      }
    }
  } catch (err) {
    console.error(err)
  } finally {
    loading.value = false
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
        <h1 class="page-title" style="margin-top: 8px">{{ instance?.name || $t('instance.detailTitle') }}</h1>
        <p class="page-subtitle mono">{{ instance?.path }}</p>
      </div>
      <NSpace>
        <NButton
          v-if="instance?.status !== 'running'"
          type="primary"
          :loading="busy[id]"
          @click="doLaunch('embed')"
        >
          <template #icon>
            <NIcon :component="PlayOutline" />
          </template>
          {{ $t('header.launchAndOpen') }}
        </NButton>
        <NButton v-else type="warning" secondary @click="doStop">
          <template #icon>
            <NIcon :component="StopOutline" />
          </template>
          {{ $t('header.stop') }}
        </NButton>
        <NButton secondary @click="doLaunch('none')">
          <template #icon>
            <NIcon :component="PlayOutline" />
          </template>
          {{ $t('instance.startOnly') }}
        </NButton>
        <NButton
          secondary
          :disabled="!instanceRunning"
          :title="instanceRunning ? '' : needInstanceHint"
          @click="openExternalIfRunning"
        >
          <template #icon>
            <NIcon :component="OpenOutline" />
          </template>
          {{ $t('header.openExternal') }}
        </NButton>
        <NButton
          type="primary"
          secondary
          :disabled="!instanceRunning"
          :title="instanceRunning ? '' : needInstanceHint"
          @click="openEmbedIfRunning"
        >
          <template #icon>
            <NIcon :component="PulseOutline" />
          </template>
          {{ $t('header.embed') }}
        </NButton>
        <NButton secondary @click="router.push('/instances')">
          <template #icon>
            <NIcon :component="CreateOutline" />
          </template>
          {{ $t('common.edit') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
    <NSpin :show="loading">
      <div class="grid layout">
        <section class="card panel">
          <div class="panel-title">{{ $t('instance.basicInfo') }}</div>
          <NDescriptions bordered size="small" :column="2" label-placement="left" class="desc">
            <NDescriptionsItem :label="$t('common.status')">
              <NTag :type="instance?.status === 'running' ? 'success' : instance?.status === 'error' ? 'error' : 'default'" round>
                {{ instance?.status }}
              </NTag>
            </NDescriptionsItem>
            <NDescriptionsItem label="PID">{{ instance?.pid || '—' }}</NDescriptionsItem>
            <NDescriptionsItem :label="$t('instance.listen')">{{ instance?.listen }}:{{ instance?.port }}</NDescriptionsItem>
            <NDescriptionsItem :label="$t('common.version')">{{ instance?.version || '—' }}</NDescriptionsItem>
            <NDescriptionsItem label="Python">{{ instance?.pythonPath || 'system' }}</NDescriptionsItem>
            <NDescriptionsItem label="autoStart">{{ instance?.autoStart ? $t('common.yes') : $t('common.no') }}</NDescriptionsItem>
            <NDescriptionsItem label="URL" :span="2">
              <span class="mono">{{ instance?.url }}</span>
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

          <div v-if="updateInfo" class="update-result">
            <div class="update-result-title">{{ $t('instance.checkUpdate') }}</div>
            <div class="update-result-line">
              <span>{{ $t('instance.versionLabel') }}: {{ updateInfo.current }}</span>
              <span v-if="updateInfo.latest">{{ $t('nodes.hasUpdate', { version: updateInfo.latest }) }}</span>
              <span v-if="typeof updateInfo.behindCount === 'number'">
                {{ $t('instance.behindCount', { n: updateInfo.behindCount }) }}
              </span>
              <span>{{ sourceLabel(updateInfo.source) }}</span>
            </div>
            <NTag
              size="small"
              round
              :type="updateInfo.updatable ? 'warning' : 'success'"
            >
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
            <NButton size="tiny" secondary @click="refresh">
              <template #icon><NIcon :component="RefreshOutline" /></template>
              {{ $t('common.refresh') }}
            </NButton>
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
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.layout {
  grid-template-columns: 1.1fr 1fr;
  align-items: stretch;
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

.confirm-body {
  max-width: 360px;
  line-height: 1.55;
}

.confirm-note {
  margin-top: 6px;
  color: $color-text-muted;
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
  color: $color-text-muted;
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
  color: $color-text-muted;
  margin-bottom: 6px;
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
  color: $color-text-muted;
  flex-shrink: 0;
}

.log-empty {
  color: $color-text-muted;
  font-size: 13px;
  padding: 24px;
  text-align: center;
}
</style>
