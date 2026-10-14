<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CheckmarkCircleOutline,
  CloseCircleOutline,
  EllipsisHorizontalCircleOutline,
  PlayCircleOutline,
  RemoveCircleOutline
} from '@vicons/ionicons5'
import { NButton, NIcon, NModal, NProgress, NScrollbar, NSpace, NTag } from 'naive-ui'
import type { InstallStepStatus, UpdateStep } from '@shared/types'
import { updateDetailOf, updateStepTitle, useComfyUpdate } from '@/composables/useComfyUpdate'

const props = defineProps<{ show: boolean; title?: string }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const { t } = useI18n()
const { progress, updating, cancelling, cancelUpdate, hydrateActiveOp } = useComfyUpdate()

// 0.1.12: restore the live snapshot after a renderer reload (main process
// keeps running; without this the modal showed an empty shell).
watch(
  () => props.show,
  (v) => {
    if (v) void hydrateActiveOp()
  }
)

const modalTitle = computed(() => props.title || t('instance.updateComfy'))

/**
 * 0.1.11: the modal is fully closable WHILE RUNNING and the progress stream
 * survives — closing only hides the view; the "view progress" banner reopens
 * it. Matches the node-op modal contract; long updates no longer lock the UI.
 */
const visible = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v)
})

/** Steps whose full log is expanded (terminal-style pane). */
const expandedLogs = ref<Set<string>>(new Set())
function toggleStepLog(id: string): void {
  const next = new Set(expandedLogs.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedLogs.value = next
}

const percent = computed(() => Math.max(0, Math.min(100, Math.round(progress.value?.percent || 0))))
const steps = computed<UpdateStep[]>(() => progress.value?.steps || [])
const failed = computed(() => progress.value?.status === 'failed')
const done = computed(() => progress.value?.status === 'done' && progress.value?.step === 'done')
/** Cancel button stays visible while cancelling (shows its loading state) — it must not vanish. */
const cancelVisible = computed(() => updating.value && !failed.value && !done.value)
const cancelDisabled = computed(() => cancelling.value)

function statusIcon(status: InstallStepStatus): Component {
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

/** Step label — named stepTitle to avoid colliding with the `title` prop. */
function stepTitle(s: UpdateStep): string {
  return updateStepTitle(t, s)
}

async function onCancel(): Promise<void> {
  await cancelUpdate()
}
</script>

<template>
  <NModal
    v-model:show="visible"
    preset="card"
    :title="modalTitle"
    style="width: 640px; border-radius: 20px"
    mask-closable
    closable
  >
    <div class="upd-head">
      <NProgress
        type="line"
        :percentage="percent"
        :height="10"
        :status="failed ? 'error' : done ? 'success' : 'default'"
        :processing="updating && !failed"
      />
      <div class="upd-msg">
        <NTag v-if="failed" size="small" type="error" round
          >{{ t('common.status') }}: {{ t('status.error') }}</NTag
        >
        <NTag v-else-if="done" size="small" type="success" round>{{ t('update.stepDone') }}</NTag>
        <NTag v-else-if="updating" size="small" type="info" round>{{
          t('instance.updating')
        }}</NTag>
        <span class="upd-message-text">{{ progress?.message || '' }}</span>
      </div>
    </div>

    <NScrollbar class="upd-steps">
      <div v-for="s in steps" :key="s.id" class="upd-step" :class="statusClass(s.status)">
        <NIcon :size="18" :component="statusIcon(s.status)" class="st-icon" />
        <div class="st-body">
          <div class="st-title">{{ stepTitle(s) }}</div>
          <div v-if="detail(s)" class="st-detail">{{ detail(s) }}</div>
          <div
            v-if="s.log?.length"
            class="st-log mono"
            :class="{ 'can-expand': s.log.length > 1, expanded: expandedLogs.has(s.id) }"
            :title="s.log.length > 1 ? t('nodes.terminalTitle') : undefined"
            @click="s.log.length > 1 && toggleStepLog(s.id)"
          >
            <template v-if="expandedLogs.has(s.id)">
              <div v-for="(line, li) in s.log.slice(-300)" :key="li" class="st-log-line">
                {{ line }}
              </div>
            </template>
            <template v-else>{{ s.log[s.log.length - 1] }}</template>
          </div>
        </div>
      </div>
    </NScrollbar>

    <div v-if="progress?.backupPath" class="upd-backup mono">
      {{ t('instance.preserveNote') }} · {{ progress.backupPath }}
    </div>
    <div v-if="progress?.error" class="upd-error">{{ progress.error }}</div>

    <template #footer>
      <NSpace justify="end">
        <NButton
          v-if="cancelVisible"
          secondary
          type="warning"
          :loading="cancelling"
          :disabled="cancelDisabled"
          @click="onCancel"
        >
          {{ t('common.cancel') }}
        </NButton>
        <NButton type="primary" @click="visible = false">
          {{ t('common.close') }}
        </NButton>
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

.upd-steps {
  max-height: 320px;
  border: 1px solid $color-border;
  border-radius: 12px;
  padding: 6px 10px;
  background: $color-bg-soft;
}

.upd-step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 4px;
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

.st-log {
  font-size: 11px;
  color: $color-text-muted-ink;
  margin-top: 2px;
  word-break: break-all;

  &.can-expand:not(.expanded) {
    cursor: zoom-in;
  }

  &.expanded {
    background: $term-bg;
    color: $term-text;
    border-radius: 8px;
    padding: 6px 8px;
    max-height: 180px;
    overflow: auto;
    cursor: zoom-out;
  }
}

.st-log-line {
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
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
