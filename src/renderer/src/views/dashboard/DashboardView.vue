<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ServerOutline,
  FolderOpenOutline,
  ExtensionPuzzleOutline,
  PulseOutline,
  MedkitOutline,
  FlashOutline,
  TrendingUpOutline,
  RocketOutline,
  StopOutline,
  PlayOutline
} from '@vicons/ionicons5'
import { NButton, NIcon, NSpace, NTag, NProgress, NSpin } from 'naive-ui'
import StatCard from '@/components/StatCard.vue'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { clampPercent, formatBytes, formatPercent } from '@/utils/format'
import type { NodePackRecord, ModelRecord, DoctorReport, QueueSnapshot } from '@shared/types'

const router = useRouter()
const store = useAppStore()
const { launch, stop, busy } = useLaunch()
const loading = ref(true)
const nodePacks = ref<NodePackRecord[]>([])
const models = ref<ModelRecord[]>([])
const report = ref<DoctorReport | null>(null)
const queue = ref<QueueSnapshot | null>(null)

const stats = computed(() => {
  const sys = store.system
  const running = store.instances.filter((i) => i.status === 'running').length
  return {
    running,
    instances: store.instances.length,
    models: models.value.length,
    nodes: nodePacks.value.length,
    cpu: clampPercent(sys ? sys.cpuUsage : 0),
    ram: clampPercent(sys && sys.ramTotal ? (sys.ramUsed / sys.ramTotal) * 100 : 0)
  }
})

const storageBytes = computed(() => models.value.reduce((s, m) => s + m.size, 0))

function vramPercent(gpu: { vramUsed: number; vramTotal: number; utilization?: number }): number {
  if (gpu.vramTotal > 0) return clampPercent((gpu.vramUsed / gpu.vramTotal) * 100)
  return clampPercent(gpu.utilization || 0)
}

async function refreshQueue(): Promise<void> {
  try {
    const inst = store.activeInstance
    if (!inst?.url || inst.status !== 'running') {
      queue.value = null
      return
    }
    queue.value = await ipc('monitor.queue', inst.url)
  } catch {
    queue.value = null
  }
}

/** Launcher hero: one click to ready + frontend. */
async function launchActive(): Promise<void> {
  const inst = store.activeInstance
  if (!inst) return
  await launch(inst, { open: 'embed' })
}

let queueTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  try {
    nodePacks.value = await ipc('node.list', store.activeInstanceId || undefined)
    models.value = await ipc('model.list')
  } catch {
    /* optional in empty state */
  } finally {
    loading.value = false
  }
  await refreshQueue()
  queueTimer = setInterval(() => void refreshQueue(), 5000)
})

onUnmounted(() => {
  if (queueTimer) clearInterval(queueTimer)
})

async function runDoctor(): Promise<void> {
  const id = store.activeInstanceId || 'default'
  report.value = await ipc('doctor.run', id)
  void router.push('/doctor')
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">生产线总览</h1>
        <p class="page-subtitle">实例、模型、节点与运行状态，一屏掌握。</p>
      </div>
      <NSpace>
        <NButton type="primary" secondary @click="router.push('/instances')">
          <template #icon>
            <NIcon :component="ServerOutline" />
          </template>
          管理实例
        </NButton>
        <NButton type="primary" @click="runDoctor">
          <template #icon>
            <NIcon :component="FlashOutline" />
          </template>
          一键体检
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
    <NSpin :show="loading">
      <!-- Launcher hero -->
      <section class="card hero">
        <div class="hero-left">
          <div class="hero-kicker">当前实例</div>
          <div class="hero-name">{{ store.activeInstance?.name || '尚未添加实例' }}</div>
          <div class="hero-meta">
            <NTag
              size="small"
              round
              :type="store.activeInstance?.status === 'running' ? 'success' : store.activeInstance?.status === 'error' ? 'error' : 'default'"
            >
              {{ store.activeInstance?.status || '—' }}
            </NTag>
            <span v-if="store.activeInstance" class="mono hero-url">{{ store.activeInstance.url }}</span>
            <span v-if="store.activeInstance" class="hero-port">端口 {{ store.activeInstance.port }}</span>
          </div>
          <div v-if="queue" class="hero-queue">
            运行中 {{ queue.running.length }} · 等待 {{ queue.pending.length }}
          </div>
        </div>
        <div class="hero-actions">
          <NButton
            v-if="!store.activeInstance"
            type="primary"
            size="large"
            @click="router.push('/install')"
          >
            <template #icon><NIcon :component="RocketOutline" /></template>
            一键装机
          </NButton>
          <template v-else>
            <NButton
              v-if="store.activeInstance.status !== 'running'"
              type="primary"
              size="large"
              :loading="busy[store.activeInstance.id]"
              @click="launchActive"
            >
              <template #icon><NIcon :component="RocketOutline" /></template>
              启动并打开 Frontend
            </NButton>
            <NButton
              v-else
              type="primary"
              size="large"
              @click="store.activeInstance.url && router.push({ path: '/embed', query: { url: store.activeInstance.url } })"
            >
              <template #icon><NIcon :component="PlayOutline" /></template>
              打开 Frontend
            </NButton>
            <NButton
              v-if="store.activeInstance.status === 'running'"
              secondary
              size="large"
              @click="stop(store.activeInstance)"
            >
              <template #icon><NIcon :component="StopOutline" /></template>
              停止
            </NButton>
            <NButton secondary size="large" @click="router.push('/instances')">切换实例</NButton>
          </template>
        </div>
      </section>

      <div class="grid stats">
        <StatCard
          label="运行中实例"
          :value="`${stats.running} / ${stats.instances}`"
          :icon="ServerOutline"
          tone="success"
          hint="ComfyUI 进程状态"
        />
        <StatCard label="模型资产" :value="stats.models" :icon="FolderOpenOutline" :hint="formatBytes(storageBytes)" />
        <StatCard label="自定义节点包" :value="stats.nodes" :icon="ExtensionPuzzleOutline" hint="当前实例 custom_nodes" />
        <StatCard label="系统负载" :value="formatPercent(stats.cpu)" :icon="PulseOutline" tone="warning" :hint="`内存占用 ${formatPercent(stats.ram)}`" />
      </div>

      <div class="grid lower">
        <section class="panel card">
          <div class="panel-head">
            <div>
              <div class="panel-title">资源脉搏</div>
              <div class="panel-sub">实时 CPU / 内存 / GPU</div>
            </div>
            <NButton text type="primary" @click="router.push('/monitor')">查看监控</NButton>
          </div>
          <div class="meter-rows">
            <div class="meter">
              <div class="meter-label">CPU</div>
              <NProgress type="line" :percentage="stats.cpu" :height="10" indicator-placement="inside" processing />
            </div>
            <div class="meter">
              <div class="meter-label">Memory</div>
              <NProgress type="line" :percentage="stats.ram" :height="10" indicator-placement="inside" />
            </div>
            <div v-for="gpu in store.system?.gpus || []" :key="gpu.index" class="meter">
              <div class="meter-label">
                {{ gpu.model }}
                <span v-if="gpu.vramTotal" class="meter-sub">
                  显存 {{ formatBytes(gpu.vramUsed) }} / {{ formatBytes(gpu.vramTotal) }}
                </span>
              </div>
              <NProgress
                type="line"
                :percentage="vramPercent(gpu)"
                :height="10"
                indicator-placement="inside"
                color="#7c5cfc"
              />
            </div>
            <div v-if="!(store.system?.gpus || []).length" class="empty-gpu">
              <TrendingUpOutline style="opacity: 0.5" />
              等待 GPU 信息…
            </div>
          </div>
        </section>

        <section class="panel card">
          <div class="panel-head">
            <div>
              <div class="panel-title">快捷入口</div>
              <div class="panel-sub">常用操作直达</div>
            </div>
          </div>
          <div class="quick-grid">
            <button class="quick" @click="router.push('/models')">
              <NIcon :size="22" :component="FolderOpenOutline" />
              <span>模型库</span>
            </button>
            <button class="quick" @click="router.push('/nodes')">
              <NIcon :size="22" :component="ExtensionPuzzleOutline" />
              <span>节点管理</span>
            </button>
            <button class="quick" @click="router.push('/workflows')">
              <NIcon :size="22" :component="FlashOutline" />
              <span>工作流</span>
            </button>
            <button class="quick" @click="router.push('/doctor')">
              <NIcon :size="22" :component="MedkitOutline" />
              <span>健康诊断</span>
            </button>
          </div>
          <div class="tip card">
            <NTag type="info" round size="small">Pro Tip</NTag>
            <div class="tip-text">
              支持一键内嵌官方 ComfyUI Frontend，也可外链浏览器打开，互不干扰。
            </div>
          </div>
        </section>
      </div>
    </NSpin>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 24px;
  margin-bottom: 16px;
  background: $gradient-soft;
  border: 1px solid rgba(79, 110, 247, 0.22);
}

.hero-kicker {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: $color-primary;
}

.hero-name {
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin-top: 4px;
}

.hero-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  font-size: 12.5px;
  color: $color-text-secondary;
  flex-wrap: wrap;
}

.hero-url {
  color: $color-text-muted;
  font-size: 12px;
}

.hero-queue {
  margin-top: 8px;
  font-size: 12px;
  color: $color-text-secondary;
}

.hero-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.stats {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.lower {
  margin-top: 16px;
  grid-template-columns: 1.35fr 1fr;
}

.panel {
  padding: 20px;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}

.panel-title {
  font-size: 16px;
  font-weight: 700;
}

.panel-sub {
  margin-top: 4px;
  font-size: 12.5px;
  color: $color-text-muted;
}

.meter-rows {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.meter-label {
  font-size: 12px;
  font-weight: 600;
  color: $color-text-secondary;
  margin-bottom: 6px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.meter-sub {
  font-weight: 500;
  color: $color-text-muted;
  font-variant-numeric: tabular-nums;
}

.empty-gpu {
  color: $color-text-muted;
  font-size: 13px;
  display: flex;
  gap: 8px;
  align-items: center;
}

.quick-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.quick {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid $color-border;
  background: $color-surface-2;
  color: $color-text-secondary;
  font-weight: 650;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    transform: translateY(-2px);
    border-color: rgba(79, 110, 247, 0.35);
    color: $color-primary;
    box-shadow: $shadow-md;
    background: white;
  }
}

.tip {
  margin-top: 14px;
  padding: 12px 14px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: $gradient-soft;
  border: 1px dashed rgba(79, 110, 247, 0.28);
}

.tip-text {
  font-size: 12.5px;
  color: $color-text-secondary;
  line-height: 1.55;
}
</style>
