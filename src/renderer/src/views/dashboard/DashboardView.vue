<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ServerOutline,
  FolderOpenOutline,
  ExtensionPuzzleOutline,
  PulseOutline,
  MedkitOutline,
  FlashOutline,
  TrendingUpOutline
} from '@vicons/ionicons5'
import { NButton, NIcon, NSpace, NTag, NProgress, NSpin } from 'naive-ui'
import StatCard from '@/components/StatCard.vue'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import { clampPercent, formatBytes, formatPercent } from '@/utils/format'
import type { NodePackRecord, ModelRecord, DoctorReport } from '@shared/types'

const router = useRouter()
const store = useAppStore()
const loading = ref(true)
const nodePacks = ref<NodePackRecord[]>([])
const models = ref<ModelRecord[]>([])
const report = ref<DoctorReport | null>(null)

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

onMounted(async () => {
  try {
    nodePacks.value = await ipc('node.list')
    models.value = await ipc('model.list')
  } catch {
    /* optional in empty state */
  } finally {
    loading.value = false
  }
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

    <NSpin :show="loading">
      <div class="grid stats">
        <StatCard
          label="运行中实例"
          :value="`${stats.running} / ${stats.instances}`"
          :icon="ServerOutline"
          tone="success"
          hint="ComfyUI 进程状态"
        />
        <StatCard label="模型资产" :value="stats.models" :icon="FolderOpenOutline" :hint="formatBytes(storageBytes)" />
        <StatCard label="自定义节点包" :value="stats.nodes" :icon="ExtensionPuzzleOutline" hint="本地 custom_nodes" />
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
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

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
