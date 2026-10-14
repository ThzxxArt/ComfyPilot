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
import {
  NButton,
  NIcon,
  NModal,
  NProgress,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage
} from 'naive-ui'
import type { InstallStepStatus, UpdateStep } from '@shared/types'
import { updateDetailOf, updateStepTitle, useComfyUpdate } from '@/composables/useComfyUpdate'

/**
 * Node pack operation modal (install / update / batch update).
 *
 * 0.1.9 contract (mirrors ComfyUI-Manager's terminal UX):
 * - NEVER auto-closes on success or failure — the user reviews the log and
 *   closes it manually.
 * - Closing only hides the modal; progress state stays so the banner can
 *   reopen it while an operation is still running.
 * - Batch mode shows queue position (第 N/M), per-pack status and a monotonic
 *   aggregate progress bar fed by `aggregatePercent`.
 */
const props = defineProps<{ show: boolean; title?: string; mode?: 'single' | 'batch' }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const { t } = useI18n()
const message = useMessage()
const {
  progress,
  progressKind,
  nodeBatch,
  nodeBatchActive,
  nodeBatchEntries,
  nodeOpLogs,
  nodeOpLogSeq,
  updatingInstanceId,
  viewedNodeInstanceId,
  cancelNodeOp,
  cancelNodeBatch,
  hydrateNodeOp
} = useComfyUpdate()

// Mode is DERIVED: a live/retained batch always renders as batch, even after
// this view is unmounted and remounted (props default to 'single').
const mode = computed<'single' | 'batch'>(() =>
  nodeBatch.value ? 'batch' : props.mode || 'single'
)
/** Only a node-op payload may drive the single-op display (never comfy/repair). */
const ownProgress = computed(() => (progressKind.value === 'node-op' ? progress.value : null))
const visible = computed({
  get: () => props.show,
  // Closing is a pure hide — state is preserved for reopening.
  set: (v: boolean) => emit('update:show', v)
})

// 0.1.12: a reopen after a renderer reload restores the authoritative node-op
// snapshot from main; the terminal falls back to the per-step logs it carries.
watch(
  () => props.show,
  (v) => {
    if (v && !ownProgress.value) void hydrateNodeOp(viewedNodeInstanceId.value || undefined)
  }
)

const running = computed(() => {
  if (mode.value === 'batch') return nodeBatchActive.value && nodeBatch.value != null
  // No payload at all means there is nothing to run/cancel.
  if (ownProgress.value == null) return false
  const s = ownProgress.value.status
  return s !== 'done' && s !== 'failed' && s !== 'cancelled'
})
const failed = computed(() => {
  if (mode.value === 'batch') {
    if (nodeBatch.value?.summary?.cancelled) return false
    return (
      nodeBatch.value?.phase === 'batch-error' ||
      (nodeBatch.value?.phase === 'batch-done' && nodeBatch.value?.ok === false)
    )
  }
  return ownProgress.value?.status === 'failed'
})
const done = computed(() => {
  if (mode.value === 'batch') {
    if (nodeBatch.value?.summary?.cancelled) return false
    return nodeBatch.value?.phase === 'batch-done' && nodeBatch.value?.ok === true
  }
  return ownProgress.value?.status === 'done'
})
const cancelled = computed(() => {
  if (mode.value !== 'batch' && ownProgress.value?.status === 'cancelled') return true
  return nodeBatch.value?.phase === 'batch-done' && Boolean(nodeBatch.value?.summary?.cancelled)
})

const percent = computed(() => {
  if (mode.value === 'batch') {
    const b = nodeBatch.value
    const queuePct = b && b.total > 0 ? Math.round((Math.max(0, b.index) / b.total) * 100) : 0
    if (b?.phase === 'batch-done') {
      if (cancelled.value) return Math.max(0, Math.min(99, queuePct))
      if (failed.value) {
        const agg = progressKind.value === 'node-op' ? progress.value?.aggregatePercent : undefined
        return agg != null ? Math.max(0, Math.min(100, Math.round(agg))) : queuePct
      }
      return 100
    }
    const agg = progressKind.value === 'node-op' ? progress.value?.aggregatePercent : undefined
    if (agg != null) return Math.max(0, Math.min(100, Math.round(agg)))
    // No stream payload yet (or claimed by another op) — derive a conservative
    // queue-position percentage instead of showing a stale 100%.
    return Math.max(
      0,
      Math.min(100, Math.round(((b ? Math.max(0, b.index - 1) : 0) / (b?.total || 1)) * 100))
    )
  }
  return Math.max(0, Math.min(100, Math.round(ownProgress.value?.percent || 0)))
})

const steps = computed<UpdateStep[]>(() => ownProgress.value?.steps || [])
/** Terminal lines: the live stream when present; otherwise the per-step logs
 *  a hydrated snapshot carries (state restored after a renderer reload). */
const terminalLines = computed(() => {
  if (nodeOpLogs.value.length) return nodeOpLogs.value
  const acc: Array<{ packName?: string; line: string; ts: number }> = []
  for (const s of ownProgress.value?.steps || []) {
    for (const line of s.log || []) acc.push({ packName: s.title, line, ts: 0 })
  }
  return acc.slice(-400)
})
const currentLabel = computed(() => {
  if (mode.value === 'batch') {
    const b = nodeBatch.value
    if (!b) return ''
    if (b.phase === 'checking') return t('nodes.batchChecking')
    if (!b.total) return ''
    return t('nodes.batchProgress', {
      index: b.index || 0,
      total: b.total,
      name: b.packName || ''
    })
  }
  return ownProgress.value?.message || ''
})

const cancelling = ref(false)
/** Instance that owns the stream the modal is showing — never "active now". */
const streamOwnerId = computed(() => {
  if (mode.value === 'batch') {
    return nodeBatch.value?.instanceId || viewedNodeInstanceId.value || undefined
  }
  if (progressKind.value === 'node-op') {
    return progress.value?.instanceId || viewedNodeInstanceId.value || undefined
  }
  return viewedNodeInstanceId.value || undefined
})
async function onCancel(): Promise<void> {
  cancelling.value = true
  try {
    const id = streamOwnerId.value || updatingInstanceId.value || undefined
    const ok =
      mode.value === 'batch'
        ? await cancelNodeBatch(id || undefined)
        : await cancelNodeOp(id || undefined)
    if (!ok) message.info(t('nodes.cancelNothing'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    cancelling.value = false
  }
}

const autoscroll = ref(true)
const logBox = ref<HTMLElement | null>(null)
watch(
  () => nodeOpLogSeq.value,
  () => {
    if (!autoscroll.value) return
    void nextTick(() => {
      const el = logBox.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
)
// Reset autoscroll each time the modal opens so new output is visible.
watch(
  () => props.show,
  (v) => {
    if (v) {
      autoscroll.value = true
      void nextTick(() => {
        const el = logBox.value
        if (el) el.scrollTop = el.scrollHeight
      })
    }
  }
)

const copyState = ref('')
async function copyLogs(): Promise<void> {
  const text = terminalLines.value
    .map((l) => (l.packName ? `[${l.packName}] ${l.line}` : l.line))
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    copyState.value = t('common.copied')
    setTimeout(() => (copyState.value = ''), 1500)
  } catch {
    copyState.value = ''
  }
}

function statusIcon(status: InstallStepStatus | NodeBatchEntryStatus) {
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

type NodeBatchEntryStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

function statusClass(status: InstallStepStatus | NodeBatchEntryStatus): string {
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
    :title="title || t('nodes.updating')"
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
        <NTag v-if="cancelled" size="small" round>
          {{ mode === 'batch' ? t('nodes.batchCancelled') : t('nodes.opCancelled') }}
        </NTag>
        <NTag v-else-if="failed" size="small" type="error" round
          >{{ t('common.status') }}: {{ t('status.error') }}</NTag
        >
        <NTag v-else-if="done" size="small" type="success" round>{{ t('update.stepDone') }}</NTag>
        <NTag v-else-if="running" size="small" type="info" round>{{ t('instance.updating') }}</NTag>
        <span class="upd-message-text">{{ currentLabel }}</span>
      </div>
    </div>

    <!-- Batch queue: one chip per pack -->
    <div v-if="mode === 'batch' && nodeBatchEntries.length" class="op-batch">
      <div
        v-for="(e, i) in nodeBatchEntries"
        :key="`${e.name}-${i}`"
        class="batch-entry"
        :class="statusClass(e.status)"
      >
        <NIcon :size="15" :component="statusIcon(e.status)" />
        <span class="batch-name mono">{{ e.name }}</span>
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

    <!-- Terminal-style streaming log (never auto-cleared on close) -->
    <div class="op-log-head">
      <span class="op-log-title">{{ t('nodes.terminalTitle') }}</span>
      <NSpace align="center" size="small">
        <NText depth="3" style="font-size: 12px">{{ t('nodes.autoScroll') }}</NText>
        <NSwitch v-model:value="autoscroll" size="small" />
        <NButton size="tiny" secondary :disabled="!terminalLines.length" @click="copyLogs">
          {{ copyState || t('nodes.copyLogs') }}
        </NButton>
      </NSpace>
    </div>
    <div ref="logBox" class="op-log mono">
      <div v-if="!terminalLines.length" class="op-log-empty">{{ t('nodes.noLogs') }}</div>
      <div v-for="(l, i) in terminalLines" :key="i" class="op-log-line">
        <span v-if="l.packName" class="op-log-pack">[{{ l.packName }}]</span>
        <span>{{ l.line }}</span>
      </div>
    </div>

    <div v-if="ownProgress?.backupPath" class="upd-backup mono">
      {{ t('instance.preserveNote') }} · {{ ownProgress.backupPath }}
    </div>
    <div v-if="ownProgress?.error && !terminalLines.length" class="upd-error">
      {{ ownProgress.error }}
    </div>

    <template #footer>
      <NSpace justify="space-between" align="center" style="width: 100%">
        <NText depth="3" style="font-size: 12px">
          {{ running ? t('nodes.opKeepOpenHint') : t('nodes.opFinishedKeepOpenHint') }}
        </NText>
        <NSpace>
          <NButton v-if="running" secondary type="warning" :loading="cancelling" @click="onCancel">
            {{ mode === 'batch' ? t('nodes.batchCancelRemaining') : t('common.cancel') }}
          </NButton>
          <NButton type="primary" @click="visible = false">
            {{ t('common.close') }}
          </NButton>
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

.op-batch {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
  max-height: 96px;
  overflow: auto;
}

.batch-entry {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid $color-border;
  font-size: 12px;
  color: $color-text-secondary;

  &.st-done {
    color: $color-success;
    border-color: $color-success;
  }
  &.st-run {
    color: $color-primary;
    border-color: $color-primary;
  }
  &.st-fail {
    color: $color-danger;
    border-color: $color-danger;
  }
}

.batch-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.op-log-pack {
  color: $term-accent;
  margin-right: 6px;
}

.upd-backup {
  margin-top: 10px;
  font-size: 11px;
  color: $color-text-muted-ink;
  word-break: break-all;
}

.upd-error {
  margin-top: 8px;
  font-size: 12px;
  color: $color-danger;
  word-break: break-all;
}
</style>
