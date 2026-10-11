<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PulseOutline, HardwareChipOutline } from '@vicons/ionicons5'
import { NButton, NSpace, NProgress, NEmpty, NTag, NTabs, NTabPane, NScrollbar, useMessage } from 'naive-ui'
import StatCard from '@/components/StatCard.vue'
import { useAppStore } from '@/stores/app'
import { ipc, onMonitorTick } from '@/composables/useIpc'
import { clampPercent, formatBytes, formatPercent } from '@/utils/format'
import { COLORS } from '@/styles/tokens'
import type { QueueSnapshot, SystemSnapshot } from '@shared/types'

const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const queue = ref<QueueSnapshot | null>(null)
const history = ref<number[]>([])

// monitor.history — task history for the active instance
const historySnapshot = ref<QueueSnapshot | null>(null)
const historyLoading = ref(false)
const queueTab = ref<'queue' | 'history'>('queue')

const cpuHistory = computed(() => history.value.slice(-40))

function pct(used: number, total: number): number {
  if (!total) return 0
  return clampPercent((used / total) * 100)
}

async function refreshQueue(): Promise<void> {
  try {
    const inst = store.activeInstance
    if (!inst?.url) {
      // Switching to an instance without a URL must not show the previous
      // instance's queue.
      queue.value = null
      return
    }
    queue.value = await ipc('monitor.queue', inst.url)
  } catch {
    // Offline: clear stale data instead of leaving the old queue on screen.
    queue.value = null
  }
}

/** Load monitor.history (QueueSnapshot.history) for the active instance. */
async function refreshHistory(): Promise<void> {
  const inst = store.activeInstance
  if (!inst?.url) {
    historySnapshot.value = null
    return
  }
  historyLoading.value = true
  try {
    historySnapshot.value = await ipc('monitor.history', inst.url)
  } catch (err) {
    historySnapshot.value = null
    message.error(t('monitor.historyLoadFailed', { error: err instanceof Error ? err.message : String(err) }))
  } finally {
    historyLoading.value = false
  }
}

function historyStatusLabel(status: string): string {
  const s = String(status || '').toLowerCase()
  if (s === 'success' || s === 'done' || s === 'completed') return t('monitor.historyStatusDone')
  return t('monitor.historyStatusError')
}

function historyStatusType(status: string): 'success' | 'error' | 'default' {
  const s = String(status || '').toLowerCase()
  if (s === 'success' || s === 'done' || s === 'completed') return 'success'
  return 'error'
}

function formatHistoryTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

let off: (() => void) | null = null
let queueTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await store.bootstrap({ keepSelection: true })
  const snap = await ipc('monitor.system').catch(() => null)
  if (snap) {
    store.system = snap
    history.value.push(snap.cpuUsage)
  }
  off = onMonitorTick((s) => {
    const snap = s as SystemSnapshot
    store.system = snap
    history.value.push(snap.cpuUsage)
    if (history.value.length > 60) history.value.shift()
  })
  // WS is owned by the app store (bound to the active instance) — do not
  // connect/disconnect it here or leaving this page would kill other pages' streams.
  await refreshQueue()
  void refreshHistory()
  queueTimer = setInterval(() => void refreshQueue(), 3000)
})

// Re-poll when the user switches the active instance in the header.
watch(
  () => store.instanceSwitchTick,
  () => {
    void refreshQueue()
    void refreshHistory()
  }
)

onUnmounted(() => {
  off?.()
  if (queueTimer) clearInterval(queueTimer)
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('monitor.title') }}</h1>
        <p class="page-subtitle">{{ $t('monitor.subtitle') }}</p>
      </div>
      <NSpace>
        <NButton secondary @click="refreshQueue">{{ $t('monitor.refreshQueue') }}</NButton>
      </NSpace>
    </div>

    <div class="page-body">
    <div class="grid stats">
      <StatCard
        :label="$t('monitor.cpuUsage')"
        :value="formatPercent(store.system?.cpuUsage ?? 0, 1)"
        :icon="PulseOutline"
        tone="primary"
        :hint="$t('monitor.cpuHint')"
      />
      <StatCard
        :label="$t('monitor.memory')"
        :value="formatBytes(store.system?.ramUsed || 0)"
        :icon="HardwareChipOutline"
        tone="success"
        :hint="`/ ${formatBytes(store.system?.ramTotal || 0)}`"
      />
      <StatCard
        :label="$t('monitor.diskFree')"
        :value="formatBytes(store.system?.diskFree || 0)"
        :icon="HardwareChipOutline"
        tone="warning"
        :hint="$t('monitor.diskTotalHint', { n: formatBytes(store.system?.diskTotal || 0) })"
      />
      <StatCard
        :label="$t('monitor.queueTasks')"
        :value="(queue?.running?.length || 0) + (queue?.pending?.length || 0)"
        :icon="PulseOutline"
        :hint="$t('monitor.queueHint', { running: queue?.running?.length || 0, pending: queue?.pending?.length || 0 })"
      />
    </div>

    <div class="grid lower">
      <section class="card panel">
        <div class="panel-title">{{ $t('monitor.cpuTrend') }}</div>
        <div class="chart">
          <div v-for="(v, i) in cpuHistory" :key="i" class="bar" :style="{ height: `${Math.max(4, v)}%` }" />
        </div>
      </section>

      <section class="card panel">
        <div class="panel-title">{{ $t('monitor.gpuTitle') }}</div>
        <div v-if="store.system?.gpus?.length" class="gpu-list">
          <div v-for="gpu in store.system.gpus" :key="gpu.index" class="gpu-item">
            <div class="gpu-name">{{ gpu.model }}</div>
            <div class="gpu-metrics">
              <NProgress
                type="line"
                :percentage="pct(gpu.vramUsed, gpu.vramTotal)"
                :height="10"
                indicator-placement="inside"
                :color="COLORS.primary"
              />
              <div class="gpu-sub">
                VRAM {{ formatBytes(gpu.vramUsed) }} / {{ formatBytes(gpu.vramTotal) }}
                <span v-if="gpu.utilization"> · GPU {{ formatPercent(gpu.utilization) }}</span>
                <span v-if="gpu.temperature"> · {{ gpu.temperature }}°C</span>
              </div>
            </div>
          </div>
        </div>
        <NEmpty v-else :description="$t('monitor.noGpu')" />
      </section>
    </div>

    <section class="card panel queue-panel">
      <NTabs v-model:value="queueTab" type="line" @update:value="(v: string) => { if (v === 'history') void refreshHistory() }">
        <NTabPane name="queue" :tab="$t('monitor.tabQueue')">
          <div class="panel-title">{{ $t('monitor.queueTitle') }}</div>
          <div v-if="!queue || (!queue.running.length && !queue.pending.length)" class="queue-empty">
            {{ $t('monitor.queueEmpty') }}
          </div>
          <div v-else class="queue-list">
            <div v-for="r in queue.running" :key="r.promptId" class="queue-row">
              <span class="chip chip-success">{{ $t('status.running') }}</span>
              <span class="mono">{{ r.promptId }}</span>
            </div>
            <div v-for="p in queue.pending" :key="p.promptId" class="queue-row">
              <span class="chip chip-warning">{{ $t('monitor.pending') }}</span>
              <span class="mono">{{ p.promptId }}</span>
            </div>
          </div>
        </NTabPane>
        <NTabPane name="history" :tab="$t('monitor.tabHistory')">
          <div class="panel-head">
            <div class="panel-title">{{ $t('monitor.historyTitle') }}</div>
            <NSpace :size="8" align="center">
              <span v-if="historySnapshot?.history?.length" class="meta">
                {{ $t('monitor.historyCount', { n: historySnapshot.history.length }) }}
              </span>
              <NButton size="tiny" secondary :loading="historyLoading" @click="refreshHistory">
                {{ $t('monitor.historyRefresh') }}
              </NButton>
            </NSpace>
          </div>
          <div v-if="!store.activeInstance?.url" class="queue-empty">
            {{ $t('monitor.needInstanceUrl') }}
          </div>
          <div v-else-if="historyLoading && !historySnapshot" class="queue-empty">
            {{ $t('monitor.historyRefresh') }}
          </div>
          <div v-else-if="!historySnapshot?.history?.length" class="queue-empty">
            {{ $t('monitor.historyEmpty') }}
          </div>
          <NScrollbar v-else style="max-height: 320px">
            <div class="queue-list">
              <div v-for="h in historySnapshot.history" :key="h.promptId" class="queue-row history-row">
                <NTag size="small" round :type="historyStatusType(h.status)">
                  {{ historyStatusLabel(h.status) }}
                </NTag>
                <span class="mono history-prompt">{{ h.promptId }}</span>
                <span class="meta history-time">{{ formatHistoryTime(h.completedAt) }}</span>
              </div>
            </div>
          </NScrollbar>
        </NTabPane>
      </NTabs>
    </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.stats {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.lower {
  margin-top: 16px;
  grid-template-columns: 1.2fr 1fr;
}

.panel {
  padding: 20px;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 14px;
}

.chart {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 160px;
  padding: 8px;
  border-radius: 14px;
  background: $gradient-hero;
}

.bar {
  flex: 1;
  border-radius: 6px 6px 2px 2px;
  background: $gradient-primary;
  opacity: 0.85;
  min-width: 4px;
}

.gpu-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.gpu-name {
  font-weight: 700;
  margin-bottom: 8px;
}

.gpu-sub {
  margin-top: 6px;
  font-size: 12px;
  color: $color-text-muted;
}

.queue-panel {
  margin-top: 16px;
}

.queue-empty {
  color: $color-text-muted;
  font-size: 13.5px;
  padding: 12px 0 8px;
}

.queue-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.queue-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: $color-surface-2;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.meta {
  font-size: 12px;
  color: $color-text-muted;
}

.history-row {
  justify-content: flex-start;
}

.history-prompt {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-time {
  flex-shrink: 0;
}
</style>
