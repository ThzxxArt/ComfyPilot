<script setup lang="ts">
/**
 * 0.1.18 (WP5): shell-level "background tasks" center.
 *
 * Before this, closing a progress modal hid the only evidence that an install,
 * update, scan or batch was still running, and there was no single place to
 * stop one. This subscribes to the normalized `event:op-changed` stream from
 * the main process and lists every live/recent operation.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NBadge,
  NButton,
  NDrawer,
  NDrawerContent,
  NIcon,
  NProgress,
  NSpace,
  NTag,
  useMessage
} from 'naive-ui'
import { LayersOutline, StopCircleOutline } from '@vicons/ionicons5'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import IndeterminateBar from '@/components/IndeterminateBar.vue'
import type { BackgroundOp, BackgroundOpKind } from '@shared/types'

const { t } = useI18n()
const message = useMessage()

const ops = ref<BackgroundOp[]>([])
const show = ref(false)
const cancelling = ref('')
let off: (() => void) | null = null

const running = computed(() => ops.value.filter((o) => o.status === 'running'))
const runningCount = computed(() => running.value.length)

function upsert(op: BackgroundOp | null | undefined): void {
  if (!op?.id) return
  const idx = ops.value.findIndex((o) => o.id === op.id)
  if (idx >= 0) ops.value[idx] = op
  else ops.value = [op, ...ops.value]
  sortOps()
}

/** Newest first, running always above finished. */
function sortOps(): void {
  ops.value = [...ops.value].sort((a, b) => {
    const ar = a.status === 'running' ? 0 : 1
    const br = b.status === 'running' ? 0 : 1
    return ar - br || b.startedAt - a.startedAt
  })
}

// Literal maps (not template strings) so check-i18n can verify both locales.
const KIND_KEYS: Record<BackgroundOpKind, string> = {
  install: 'ops.kind_install',
  'comfy-update': 'ops.kind_comfy-update',
  'env-repair': 'ops.kind_env-repair',
  'node-op': 'ops.kind_node-op',
  'node-batch': 'ops.kind_node-batch',
  batch: 'ops.kind_batch',
  'output-scan': 'ops.kind_output-scan',
  'registry-index': 'ops.kind_registry-index'
}
const STATUS_KEYS: Record<BackgroundOp['status'], string> = {
  running: 'ops.status_running',
  done: 'ops.status_done',
  failed: 'ops.status_failed',
  cancelled: 'ops.status_cancelled'
}

function kindLabel(kind: BackgroundOpKind): string {
  return t(KIND_KEYS[kind])
}

function statusLabel(op: BackgroundOp): string {
  return t(STATUS_KEYS[op.status])
}

function statusType(op: BackgroundOp): 'success' | 'error' | 'warning' | 'info' | 'default' {
  if (op.status === 'done') return 'success'
  if (op.status === 'failed') return 'error'
  if (op.status === 'cancelled') return 'warning'
  return 'info'
}

function elapsed(op: BackgroundOp): string {
  const end = op.finishedAt || Date.now()
  const secs = Math.max(0, Math.round((end - op.startedAt) / 1000))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  return `${m}m ${secs % 60}s`
}

async function cancelOp(op: BackgroundOp): Promise<void> {
  if (!op.cancellable) return
  cancelling.value = op.id
  try {
    // false = it finished (or stopped being cancellable) between render and
    // click. Say so instead of leaving a "running" row behind.
    const ok = (await ipc('ops.cancel', op.id)) as boolean
    if (!ok) {
      await load()
      message.info(t('ops.alreadyFinished'))
    }
  } catch {
    await load()
  } finally {
    cancelling.value = ''
  }
}

async function load(): Promise<void> {
  try {
    const list = (await ipc('ops.list')) as BackgroundOp[]
    // Merge instead of clobbering: an op-changed event can land while this
    // request is in flight, and the older list must not resurrect it.
    for (const live of ops.value) {
      const inList = list.find((o) => o.id === live.id)
      if (!inList) list.push(live)
      else if (inList.status === 'running' && live.status !== 'running') {
        Object.assign(inList, live)
      }
    }
    ops.value = list
    sortOps()
  } catch {
    /* keep whatever live events already delivered */
  }
}

onMounted(() => {
  void load()
  off = onIpc(IPC_EVENTS.opChanged, (p) => upsert(p as BackgroundOp | null))
})
onUnmounted(() => {
  off?.()
  off = null
})
</script>

<template>
  <NBadge :value="runningCount" :show="runningCount > 0" :max="99" type="info">
    <NButton
      text
      class="task-center-btn"
      :title="t('ops.open')"
      :aria-label="t('ops.open')"
      @click="show = true"
    >
      <template #icon>
        <NIcon :component="LayersOutline" />
      </template>
      <span class="task-center-label">{{ t('ops.open') }}</span>
    </NButton>
  </NBadge>

  <NDrawer v-model:show="show" :width="420" placement="right">
    <NDrawerContent :title="t('ops.title')" closable>
      <div v-if="!ops.length" class="ops-empty">{{ t('ops.empty') }}</div>
      <div v-for="op in ops" :key="op.id" class="ops-row">
        <div class="ops-head">
          <div class="ops-title">
            <NTag size="tiny" :type="statusType(op)">{{ statusLabel(op) }}</NTag>
            <span class="ops-kind">{{ kindLabel(op.kind) }}</span>
            <span v-if="op.title" class="ops-name">{{ op.title }}</span>
          </div>
          <span class="ops-time">{{ elapsed(op) }}</span>
        </div>
        <NProgress
          v-if="op.percent !== null"
          type="line"
          :percentage="Math.max(0, Math.min(100, op.percent))"
          :height="8"
          :status="op.status === 'failed' ? 'error' : op.status === 'done' ? 'success' : 'default'"
        />
        <IndeterminateBar v-else-if="op.status === 'running'" :height="8" />
        <div class="ops-detail">
          <span class="mono">{{ op.detail }}</span>
          <span v-if="op.error" class="ops-error">{{ op.error }}</span>
        </div>
        <div class="ops-foot">
          <span class="ops-target mono">{{ op.target }}</span>
          <NSpace>
            <NButton
              v-if="op.cancellable && op.status === 'running'"
              size="tiny"
              secondary
              type="warning"
              :loading="cancelling === op.id"
              @click="cancelOp(op)"
            >
              <template #icon><NIcon :component="StopCircleOutline" /></template>
              {{ t('ops.cancel') }}
            </NButton>
          </NSpace>
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.task-center-btn {
  color: $color-text-secondary;
  font-size: 12px;
}
.task-center-label {
  margin-left: 4px;
}
.ops-empty {
  color: $color-text-muted-ink;
  font-size: 13px;
  padding: 12px 0;
}
.ops-row {
  padding: 12px 0;
  border-bottom: 1px solid $color-border;
  display: flex;
  flex-direction: column;
  gap: 6px;
  &:last-child {
    border-bottom: none;
  }
}
.ops-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ops-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ops-kind {
  font-size: 12.5px;
  color: $color-text-secondary;
}
.ops-name {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ops-time {
  font-size: 11.5px;
  color: $color-text-muted-ink;
}
.ops-detail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: $color-text-secondary;
  word-break: break-all;
}
.ops-error {
  color: $color-danger;
}
.ops-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ops-target {
  font-size: 11px;
  color: $color-text-muted-ink;
}
</style>
