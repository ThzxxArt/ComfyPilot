<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { PulseOutline, HardwareChipOutline } from '@vicons/ionicons5'
import { NButton, NSpace, NProgress, NEmpty } from 'naive-ui'
import StatCard from '@/components/StatCard.vue'
import { useAppStore } from '@/stores/app'
import { ipc, onMonitorTick } from '@/composables/useIpc'
import { clampPercent, formatBytes, formatPercent } from '@/utils/format'
import { COLORS } from '@/styles/tokens'
import type { QueueSnapshot, SystemSnapshot } from '@shared/types'

const store = useAppStore()
const queue = ref<QueueSnapshot | null>(null)
const history = ref<number[]>([])

const cpuHistory = computed(() => history.value.slice(-40))

function pct(used: number, total: number): number {
  if (!total) return 0
  return clampPercent((used / total) * 100)
}

async function refreshQueue(): Promise<void> {
  try {
    const inst = store.activeInstance
    if (!inst?.url) return
    queue.value = await ipc('monitor.queue', inst.url)
  } catch {
    /* instance offline */
  }
}

let off: (() => void) | null = null
let queueTimer: ReturnType<typeof setInterval> | null = null

async function connectLiveWs(): Promise<void> {
  const inst = store.activeInstance
  if (!inst?.url) return
  try {
    await ipc('monitor.connectWs', inst.url)
  } catch {
    /* offline — polling still covers queue */
  }
}

onMounted(async () => {
  await store.bootstrap({ keepSelection: true })
  const snap = await ipc('monitor.system')
  store.system = snap
  history.value.push(snap.cpuUsage)
  off = onMonitorTick((s) => {
    const snap = s as SystemSnapshot
    store.system = snap
    history.value.push(snap.cpuUsage)
    if (history.value.length > 60) history.value.shift()
  })
  await connectLiveWs()
  await refreshQueue()
  queueTimer = setInterval(() => void refreshQueue(), 3000)
})

onUnmounted(() => {
  off?.()
  if (queueTimer) clearInterval(queueTimer)
  void ipc('monitor.disconnectWs').catch(() => undefined)
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
        <div class="panel-title">GPU</div>
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
      <div class="panel-title">{{ $t('monitor.queueTitle') }}</div>
      <div v-if="!queue || (!queue.running.length && !queue.pending.length)" class="queue-empty">
        {{ $t('monitor.queueEmpty') }}
      </div>
      <div v-else class="queue-list">
        <div v-for="r in queue.running" :key="r.promptId" class="queue-row">
          <span class="chip chip-success">running</span>
          <span class="mono">{{ r.promptId }}</span>
        </div>
        <div v-for="p in queue.pending" :key="p.promptId" class="queue-row">
          <span class="chip chip-warning">pending</span>
          <span class="mono">{{ p.promptId }}</span>
        </div>
      </div>
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
</style>
