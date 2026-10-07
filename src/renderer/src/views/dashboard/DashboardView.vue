<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
  PlayOutline,
  CheckmarkCircleOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NIcon,
  NSpace,
  NTag,
  NProgress,
  NSpin,
  useDialog,
  useMessage
} from 'naive-ui'
import StatCard from '@/components/StatCard.vue'
import { useAppStore } from '@/stores/app'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { useI18n } from 'vue-i18n'
import { clampPercent, formatBytes, formatPercent } from '@/utils/format'
import { COLORS } from '@/styles/tokens'
import type {
  NodePackRecord,
  ModelRecord,
  QueueSnapshot,
  ComfyLogLine,
  InstanceStatus
} from '@shared/types'

const router = useRouter()
const store = useAppStore()
const { launch, stop, busy } = useLaunch()
const dialog = useDialog()
const message = useMessage()
const { t } = useI18n()

const loading = ref(true)
const nodePacks = ref<NodePackRecord[]>([])
const models = ref<ModelRecord[]>([])
const queue = ref<QueueSnapshot | null>(null)

/** Seconds since the active instance entered `starting` — ticks only while starting. */
const startElapsed = ref(0)
const tailLogs = ref<ComfyLogLine[]>([])

const hasInstances = computed(() => store.instances.length > 0)
const needsModels = computed(() => hasInstances.value && models.value.length === 0)

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

const activeStatus = computed<InstanceStatus>(
  () => store.activeInstance?.status ?? 'unknown'
)

function statusLabel(s: InstanceStatus | undefined): string {
  return t(`status.${s || 'unknown'}`)
}

function statusTagType(s: InstanceStatus | undefined): 'success' | 'error' | 'warning' | 'default' {
  if (s === 'running') return 'success'
  if (s === 'error') return 'error'
  if (s === 'starting') return 'warning'
  return 'default'
}

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

/** Stop with a confirm when the queue still holds work. */
function stopActive(): void {
  const inst = store.activeInstance
  if (!inst) return
  const pending = (queue.value?.running.length || 0) + (queue.value?.pending.length || 0)
  if (pending > 0) {
    dialog.warning({
      title: t('dashboard.stopConfirmTitle'),
      content: t('dashboard.stopConfirmBody', { n: pending }),
      positiveText: t('common.confirm'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => {
        void stop(inst)
      }
    })
    return
  }
  void stop(inst)
}

async function refreshTailLogs(): Promise<void> {
  const inst = store.activeInstance
  if (!inst?.id) {
    tailLogs.value = []
    return
  }
  try {
    const logs = await ipc('instance.getLogs', inst.id, 20)
    tailLogs.value = logs.slice(-3)
  } catch {
    tailLogs.value = []
  }
}

let queueTimer: ReturnType<typeof setInterval> | null = null
let startTimer: ReturnType<typeof setInterval> | null = null
let offLog: (() => void) | null = null

watch(
  () => [store.activeInstance?.id, store.activeInstance?.status] as const,
  ([id, st], prev) => {
    const prevId = prev?.[0]
    const prevSt = prev?.[1]
    if (id !== prevId) {
      // Switched instances — reset elapsed and tail logs regardless of status.
      startElapsed.value = 0
      if (st === 'starting') void refreshTailLogs()
    }
    if (st === 'starting') {
      if (prevSt !== 'starting' || id !== prevId) {
        startElapsed.value = 0
        void refreshTailLogs()
      }
      if (!startTimer) {
        startTimer = setInterval(() => {
          startElapsed.value += 1
        }, 1000)
      }
    } else if (startTimer) {
      clearInterval(startTimer)
      startTimer = null
    }
  },
  { immediate: true }
)

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
  if (activeStatus.value === 'starting') void refreshTailLogs()
  offLog = onIpc(IPC_EVENTS.instanceLog, (payload) => {
    const p = payload as { id: string; line: ComfyLogLine }
    const inst = store.activeInstance
    if (!inst || p?.id !== inst.id || !p.line) return
    tailLogs.value = [...tailLogs.value, p.line].slice(-3)
  })
})

onUnmounted(() => {
  if (queueTimer) clearInterval(queueTimer)
  if (startTimer) clearInterval(startTimer)
  offLog?.()
})

async function runDoctor(): Promise<void> {
  const id = store.activeInstanceId || 'default'
  try {
    store.doctorReport = await ipc('doctor.run', id)
    void router.push('/doctor')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('dashboard.title') }}</h1>
        <p class="page-subtitle">{{ $t('dashboard.subtitle') }}</p>
      </div>
      <NSpace>
        <NButton type="primary" secondary @click="router.push('/instances')">
          <template #icon>
            <NIcon :component="ServerOutline" />
          </template>
          {{ $t('dashboard.switchInstance') }}
        </NButton>
        <NButton type="primary" @click="runDoctor">
          <template #icon>
            <NIcon :component="FlashOutline" />
          </template>
          {{ $t('dashboard.runDoctor') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
    <NSpin :show="loading">
      <!-- Onboarding: no instance yet -->
      <section v-if="!hasInstances" class="card onboarding">
        <div class="onboard-title">{{ $t('dashboard.onboarding.title') }}</div>
        <ol class="onboard-steps">
          <li class="onboard-step">
            <span class="step-num">1</span>
            <div class="step-body">
              <div class="step-text">{{ $t('dashboard.onboarding.step1') }}</div>
            </div>
            <NButton type="primary" size="small" @click="router.push('/install')">
              {{ $t('dashboard.onboarding.goInstall') }}
            </NButton>
          </li>
          <li class="onboard-step">
            <span class="step-num">2</span>
            <div class="step-body">
              <div class="step-text">{{ $t('dashboard.onboarding.step2') }}</div>
            </div>
            <NButton size="small" secondary @click="router.push('/instances')">
              {{ $t('dashboard.onboarding.goLaunch') }}
            </NButton>
          </li>
          <li class="onboard-step">
            <span class="step-num">3</span>
            <div class="step-body">
              <div class="step-text">{{ $t('dashboard.onboarding.step3') }}</div>
            </div>
            <NButton size="small" secondary @click="router.push('/models')">
              {{ $t('dashboard.onboarding.goModels') }}
            </NButton>
          </li>
        </ol>
      </section>

      <!-- Launcher hero -->
      <section v-else class="card hero">
        <div class="hero-left">
          <div class="hero-kicker">{{ $t('dashboard.currentInstance') }}</div>
          <div class="hero-name">{{ store.activeInstance?.name || $t('dashboard.noInstance') }}</div>
          <div class="hero-meta">
            <NTag size="small" round :type="statusTagType(activeStatus)">
              {{ statusLabel(activeStatus) }}
            </NTag>
            <span v-if="store.activeInstance" class="mono hero-url">{{ store.activeInstance.url }}</span>
            <span v-if="store.activeInstance" class="hero-port">
              {{ $t('dashboard.portLabel', { port: store.activeInstance.port }) }}
            </span>
          </div>
          <div v-if="queue" class="hero-queue">
            {{ $t('dashboard.queueStatus', { running: queue.running.length, pending: queue.pending.length }) }}
          </div>
          <div v-if="activeStatus === 'starting'" class="hero-starting">
            <div class="hero-starting-label">
              <NIcon :size="14" :component="PulseOutline" class="spin-slow" />
              {{ $t('dashboard.starting', { s: startElapsed }) }}
            </div>
            <div v-if="tailLogs.length" class="hero-logs mono">
              <div class="hero-logs-title">{{ $t('dashboard.startingLogs') }}</div>
              <div v-for="(line, i) in tailLogs" :key="i" class="hero-log-line">{{ line.message }}</div>
            </div>
          </div>
        </div>
        <div class="hero-actions">
          <NButton
            v-if="activeStatus !== 'running'"
            type="primary"
            size="large"
            :loading="busy[store.activeInstance?.id || '']"
            @click="launchActive"
          >
            <template #icon><NIcon :component="RocketOutline" /></template>
            {{ $t('header.launchAndOpen') }}
          </NButton>
          <NButton
            v-else
            type="primary"
            size="large"
            @click="store.activeInstance?.url && router.push({ path: '/embed', query: { url: store.activeInstance.url } })"
          >
            <template #icon><NIcon :component="PlayOutline" /></template>
            {{ $t('dashboard.openFrontend') }}
          </NButton>
          <NButton
            v-if="activeStatus === 'running' || activeStatus === 'starting'"
            secondary
            size="large"
            @click="stopActive"
          >
            <template #icon><NIcon :component="StopOutline" /></template>
            {{ $t('header.stop') }}
          </NButton>
          <NButton secondary size="large" @click="router.push('/instances')">
            {{ $t('dashboard.switchInstance') }}
          </NButton>
        </div>
      </section>

      <!-- Instances exist but no model yet — keep the step-3 hint visible -->
      <section v-if="needsModels" class="card model-hint">
        <NIcon :size="18" :component="CheckmarkCircleOutline" class="model-hint-icon" />
        <div class="model-hint-text">{{ $t('dashboard.onboarding.step3') }}</div>
        <NButton type="primary" size="small" @click="router.push('/models')">
          {{ $t('dashboard.onboarding.goModels') }}
        </NButton>
      </section>

      <div class="grid stats">
        <StatCard
          :label="$t('dashboard.runningInstances')"
          :value="`${stats.running} / ${stats.instances}`"
          :icon="ServerOutline"
          tone="success"
          :hint="$t('dashboard.instancesHint')"
        />
        <StatCard
          :label="$t('dashboard.modelAssets')"
          :value="stats.models"
          :icon="FolderOpenOutline"
          :hint="formatBytes(storageBytes)"
        />
        <StatCard
          :label="$t('dashboard.nodePacks')"
          :value="stats.nodes"
          :icon="ExtensionPuzzleOutline"
          :hint="$t('dashboard.nodesHint')"
        />
        <StatCard
          :label="$t('dashboard.systemLoad')"
          :value="formatPercent(stats.cpu)"
          :icon="PulseOutline"
          tone="warning"
          :hint="$t('dashboard.memUsage', { pct: formatPercent(stats.ram) })"
        />
      </div>

      <div class="grid lower">
        <section class="panel card">
          <div class="panel-head">
            <div>
              <div class="panel-title">{{ $t('dashboard.resourcePulse') }}</div>
              <div class="panel-sub">{{ $t('dashboard.resourceSub') }}</div>
            </div>
            <NButton text type="primary" @click="router.push('/monitor')">
              {{ $t('dashboard.viewMonitor') }}
            </NButton>
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
                  {{ $t('dashboard.vramLabel', { used: formatBytes(gpu.vramUsed), total: formatBytes(gpu.vramTotal) }) }}
                </span>
              </div>
              <NProgress
                type="line"
                :percentage="vramPercent(gpu)"
                :height="10"
                indicator-placement="inside"
                :color="COLORS.primary2"
              />
            </div>
            <div v-if="!(store.system?.gpus || []).length" class="empty-gpu">
              <TrendingUpOutline style="opacity: 0.5" />
              {{ $t('dashboard.waitingGpu') }}
            </div>
          </div>
        </section>

        <section class="panel card">
          <div class="panel-head">
            <div>
              <div class="panel-title">{{ $t('dashboard.quickLinks') }}</div>
              <div class="panel-sub">{{ $t('dashboard.quickSub') }}</div>
            </div>
          </div>
          <div class="quick-grid">
            <button class="quick" @click="router.push('/models')">
              <NIcon :size="22" :component="FolderOpenOutline" />
              <span>{{ $t('dashboard.modelLibrary') }}</span>
            </button>
            <button class="quick" @click="router.push('/nodes')">
              <NIcon :size="22" :component="ExtensionPuzzleOutline" />
              <span>{{ $t('dashboard.nodeManage') }}</span>
            </button>
            <button class="quick" @click="router.push('/workflows')">
              <NIcon :size="22" :component="FlashOutline" />
              <span>{{ $t('nav.workflows') }}</span>
            </button>
            <button class="quick" @click="router.push('/doctor')">
              <NIcon :size="22" :component="MedkitOutline" />
              <span>{{ $t('dashboard.healthCheck') }}</span>
            </button>
          </div>
          <div class="tip card">
            <NTag type="info" round size="small">{{ $t('dashboard.proTip') }}</NTag>
            <div class="tip-text">
              {{ $t('dashboard.embedTipText') }}
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

.hero-port {
  color: $color-text-secondary;
}

.hero-queue {
  margin-top: 8px;
  font-size: 12px;
  color: $color-text-secondary;
}

.hero-starting {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hero-starting-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: $color-primary;
}

.hero-logs {
  background: $color-surface-2;
  border: 1px solid $color-border;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 11.5px;
  color: $color-text-secondary;
  max-width: 520px;
}

.hero-logs-title {
  font-family: $font-sans;
  font-size: 10.5px;
  font-weight: 600;
  color: $color-text-muted;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 4px;
}

.hero-log-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.55;
}

.spin-slow {
  animation: pulse-soft 1.6s ease-in-out infinite;
}

.hero-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* Onboarding checklist */
.onboarding {
  padding: 22px 24px;
  margin-bottom: 16px;
  background: $gradient-soft;
  border: 1px solid rgba(79, 110, 247, 0.22);
}

.onboard-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 14px;
}

.onboard-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.onboard-step {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: $color-surface;
  border: 1px solid $color-border;
  border-radius: 14px;
}

.step-num {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  font-size: 12.5px;
  font-weight: 700;
  color: $color-primary;
  background: rgba(79, 110, 247, 0.12);
}

.step-body {
  flex: 1;
  min-width: 0;
}

.step-text {
  font-size: 13.5px;
  font-weight: 500;
  color: $color-text;
}

/* Step-3 model hint */
.model-hint {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 16px;
  border: 1px dashed rgba(79, 110, 247, 0.28);
  background: $color-surface;
}

.model-hint-icon {
  color: $color-primary;
  flex-shrink: 0;
}

.model-hint-text {
  flex: 1;
  font-size: 13px;
  color: $color-text-secondary;
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
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    transform: translateY(-2px);
    border-color: rgba(79, 110, 247, 0.35);
    color: $color-primary;
    box-shadow: $shadow-md;
    background: $color-surface;
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
