<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CheckmarkCircleOutline,
  CloseCircleOutline,
  EllipsisHorizontalCircleOutline,
  PlayCircleOutline,
  RemoveCircleOutline
} from '@vicons/ionicons5'
import { NButton, NIcon, NModal, NProgress, NSpace, NSwitch, NTag, NText } from 'naive-ui'
import type { InstallStepStatus, UpdateStep } from '@shared/types'
import { updateDetailOf, updateStepTitle } from '@/composables/useComfyUpdate'
import { usePipOps } from '@/composables/usePipOps'

/**
 * Pip-op modal (0.1.12) — install missing packages / apply fix recipes /
 * reinstall pack dependencies. Same contract as NodeOpProgressModal:
 * never auto-closes; closing hides only.
 */
const { progress, logs, logSeq, modalVisible, busy, viewedInstanceId, cancel } = usePipOps()

const { t } = useI18n()

const visible = computed({
  get: () => modalVisible.value,
  set: (v: boolean) => (modalVisible.value = v)
})

const running = computed(() => {
  if (busy.value) return true
  const s = progress.value?.status
  return s === 'running'
})
const failed = computed(() => progress.value?.status === 'failed')
const cancelled = computed(() => progress.value?.status === 'cancelled')
const done = computed(() => progress.value?.status === 'done' && !busy.value && !failed.value)

const percent = computed(() => Math.max(0, Math.min(100, Math.round(progress.value?.percent || 0))))
const steps = computed<UpdateStep[]>(() => progress.value?.steps || [])

const cancelling = ref(false)
async function onCancel(): Promise<void> {
  cancelling.value = true
  try {
    await cancel(viewedInstanceId.value || progress.value?.instanceId || '')
  } finally {
    cancelling.value = false
  }
}

const autoscroll = ref(true)
const logBox = ref<HTMLElement | null>(null)
watch(
  () => logSeq.value,
  () => {
    if (!autoscroll.value) return
    void nextTick(() => {
      const el = logBox.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
)
watch(modalVisible, (v) => {
  if (v) {
    autoscroll.value = true
    void nextTick(() => {
      const el = logBox.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
})

const copyState = ref('')
async function copyLogs(): Promise<void> {
  try {
    await navigator.clipboard.writeText(logs.value.map((l) => l.line).join('\n'))
    copyState.value = t('common.copied')
    setTimeout(() => (copyState.value = ''), 1500)
  } catch {
    copyState.value = ''
  }
}

function statusIcon(status: InstallStepStatus) {
  switch (status) {
    case 'done':
      return CheckmarkCircleOutline
    case 'running':
      return PlayCircleOutline
    case 'failed':
      return CloseCircleOutline
    case 'cancelled':
    case 'skipped':
      return RemoveCircleOutline
    default:
      return EllipsisHorizontalCircleOutline
  }
}

function statusClass(status: InstallStepStatus): string {
  switch (status) {
    case 'done':
      return 'st-done'
    case 'running':
      return 'st-run'
    case 'failed':
      return 'st-fail'
    case 'cancelled':
    case 'skipped':
      return 'st-skip'
    default:
      return 'st-pending'
  }
}

function detail(s: UpdateStep): string {
  return updateDetailOf(t, s)
}
function stepTitle(s: UpdateStep): string {
  return updateStepTitle(t, s)
}
</script>

<template>
  <NModal
    v-model:show="visible"
    preset="card"
    :title="t('deps.pipOpTitle')"
    style="width: 720px; border-radius: 20px"
    :mask-closable="true"
    :closable="true"
  >
    <div class="upd-head">
      <NProgress
        type="line"
        :percentage="percent"
        :height="10"
        :status="failed ? 'error' : done ? 'success' : 'default'"
        :processing="running && !failed"
      />
      <div class="upd-msg">
        <NTag v-if="cancelled" size="small" round>{{ t('nodes.opCancelled') }}</NTag>
        <NTag v-else-if="failed" size="small" type="error" round>{{ t('status.error') }}</NTag>
        <NTag v-else-if="done" size="small" type="success" round>{{ t('update.stepDone') }}</NTag>
        <NTag v-else-if="running" size="small" type="info" round>{{ t('deps.pipOpRunning') }}</NTag>
        <span class="upd-message-text">{{ progress?.message || '' }}</span>
      </div>
    </div>

    <div v-if="steps.length" class="op-steps">
      <div v-for="s in steps" :key="s.id" class="upd-step" :class="statusClass(s.status)">
        <NIcon :size="18" :component="statusIcon(s.status)" class="st-icon" />
        <div class="st-body">
          <div class="st-title">{{ stepTitle(s) }}</div>
          <div v-if="detail(s)" class="st-detail">{{ detail(s) }}</div>
        </div>
      </div>
    </div>

    <div class="op-log-head">
      <span class="op-log-title">{{ t('nodes.terminalTitle') }}</span>
      <NSpace align="center" size="small">
        <NText depth="3" style="font-size: 12px">{{ t('nodes.autoScroll') }}</NText>
        <NSwitch v-model:value="autoscroll" size="small" />
        <NButton size="tiny" secondary :disabled="!logs.length" @click="copyLogs">
          {{ copyState || t('nodes.copyLogs') }}
        </NButton>
      </NSpace>
    </div>
    <div ref="logBox" class="op-log mono">
      <div v-if="!logs.length" class="op-log-empty">{{ t('nodes.noLogs') }}</div>
      <div v-for="(l, i) in logs" :key="i" class="op-log-line">{{ l.line }}</div>
    </div>

    <div v-if="progress?.error && !logs.length" class="upd-error">{{ progress.error }}</div>

    <template #footer>
      <NSpace justify="space-between" align="center" style="width: 100%">
        <NText depth="3" style="font-size: 12px">
          {{ running ? t('nodes.opKeepOpenHint') : t('nodes.opFinishedKeepOpenHint') }}
        </NText>
        <NSpace>
          <NButton v-if="running" secondary type="warning" :loading="cancelling" @click="onCancel">
            {{ t('common.cancel') }}
          </NButton>
          <NButton type="primary" @click="visible = false">{{ t('common.close') }}</NButton>
        </NSpace>
      </NSpace>
    </template>
  </NModal>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.upd-head {
  margin-bottom: 12px;
}

.upd-msg {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12.5px;
  color: $color-text-secondary;
  min-height: 22px;
}

.upd-message-text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.op-steps {
  border: 1px solid $color-border;
  border-radius: 12px;
  padding: 4px 10px;
  background: $color-bg-soft;
  margin-bottom: 10px;
  max-height: 180px;
  overflow: auto;
}

.upd-step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 6px 4px;
  border-bottom: 1px solid transparent;

  &:not(:last-child) {
    border-bottom-color: $color-border;
  }

  .st-icon {
    margin-top: 2px;
    flex-shrink: 0;
  }

  &.st-done .st-icon {
    color: $color-success;
  }
  &.st-run .st-icon {
    color: $color-primary;
  }
  &.st-fail .st-icon {
    color: $color-danger;
  }
  &.st-skip .st-icon,
  &.st-pending .st-icon {
    color: $color-text-muted;
  }
}

.st-body {
  flex: 1;
  min-width: 0;
}

.st-title {
  font-size: 13px;
  font-weight: 600;
  color: $color-text;
}

.st-detail {
  font-size: 12px;
  color: $color-text-secondary;
  margin-top: 2px;
  word-break: break-all;
}

.op-log-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.op-log-title {
  font-size: 13px;
  font-weight: 600;
  color: $color-text;
}

.op-log {
  height: 220px;
  overflow: auto;
  border: 1px solid $color-border;
  border-radius: 12px;
  background: $term-bg;
  color: $term-text;
  font-size: 11.5px;
  line-height: 1.6;
  padding: 8px 10px;
}

.op-log-empty {
  color: rgba(215, 227, 244, 0.5);
}

.op-log-line {
  white-space: pre-wrap;
  word-break: break-all;
}

.upd-error {
  margin-top: 8px;
  font-size: 12px;
  color: $color-danger;
  word-break: break-all;
}
</style>
