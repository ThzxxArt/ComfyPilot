<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { PulseOutline, HardwareChipOutline } from '@vicons/ionicons5'
import { NButton, NSpace, NProgress, NEmpty } from 'naive-ui'
import StatCard from '@/components/StatCard.vue'
import { useAppStore } from '@/stores/app'
import { ipc, onMonitorTick } from '@/composables/useIpc'
import type { QueueSnapshot, SystemSnapshot } from '@shared/types'

const store = useAppStore()
const queue = ref<QueueSnapshot | null>(null)
const history = ref<number[]>([])

const cpuHistory = computed(() => history.value.slice(-40))

function formatBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

function pct(used: number, total: number): number {
  if (!total) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

async function refreshQueue(): Promise<void> {
  const inst = store.activeInstance
  if (!inst?.url) return
  queue.value = await ipc('monitor.queue', inst.url)
}

let off: (() => void) | null = null

onMounted(async () => {
  await store.bootstrap()
  const snap = await ipc('monitor.system')
  store.system = snap
  history.value.push(snap.cpuUsage)
  off = onMonitorTick((s) => {
    const snap = s as SystemSnapshot
    store.system = snap
    history.value.push(snap.cpuUsage)
    if (history.value.length > 60) history.value.shift()
  })
  await refreshQueue()
  const timer = setInterval(() => void refreshQueue(), 3000)
  onUnmounted(() => {
    off?.()
    clearInterval(timer)
  })
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">运行监控</h1>
        <p class="page-subtitle">系统资源、GPU 与 ComfyUI 队列实时状态。</p>
      </div>
      <NSpace>
        <NButton secondary @click="refreshQueue">刷新队列</NButton>
      </NSpace>
    </div>

    <div class="grid stats">
      <StatCard
        label="CPU 使用率"
        :value="`${(store.system?.cpuUsage ?? 0).toFixed(1)}%`"
        :icon="PulseOutline"
        tone="primary"
        hint="采样周期 2s"
      />
      <StatCard
        label="内存"
        :value="formatBytes(store.system?.ramUsed || 0)"
        :icon="HardwareChipOutline"
        tone="success"
        :hint="`/ ${formatBytes(store.system?.ramTotal || 0)}`"
      />
      <StatCard
        label="磁盘剩余"
        :value="formatBytes(store.system?.diskFree || 0)"
        :icon="HardwareChipOutline"
        tone="warning"
        :hint="`共 ${formatBytes(store.system?.diskTotal || 0)}`"
      />
      <StatCard
        label="队列任务"
        :value="(queue?.running?.length || 0) + (queue?.pending?.length || 0)"
        :icon="PulseOutline"
        :hint="`运行中 ${queue?.running?.length || 0} · 等待 ${queue?.pending?.length || 0}`"
      />
    </div>

    <div class="grid lower">
      <section class="card panel">
        <div class="panel-title">CPU 趋势</div>
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
                color="#4f6ef7"
              />
              <div class="gpu-sub">
                VRAM {{ formatBytes(gpu.vramUsed) }} / {{ formatBytes(gpu.vramTotal) }}
                <span v-if="gpu.utilization"> · GPU {{ gpu.utilization }}%</span>
                <span v-if="gpu.temperature"> · {{ gpu.temperature }}°C</span>
              </div>
            </div>
          </div>
        </div>
        <NEmpty v-else description="未检测到 GPU 信息（部分平台需要管理员权限）" />
      </section>
    </div>

    <section class="card panel queue-panel">
      <div class="panel-title">ComfyUI 队列</div>
      <div v-if="!queue || (!queue.running.length && !queue.pending.length)" class="queue-empty">
        当前实例没有排队中的任务。启动 ComfyUI 并提交工作流后，这里会实时更新。
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
  background: linear-gradient(180deg, #f8faff 0%, #eef3ff 100%);
}

.bar {
  flex: 1;
  border-radius: 6px 6px 2px 2px;
  background: linear-gradient(180deg, #7c5cfc 0%, #4f6ef7 100%);
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
