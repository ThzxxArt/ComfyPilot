<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { PulseOutline, HardwareChipOutline } from '@vicons/ionicons5'
import {
  NAlert,
  NButton,
  NSpace,
  NProgress,
  NEmpty,
  NModal,
  NTag,
  NTabs,
  NTabPane,
  NScrollbar,
  useMessage
} from 'naive-ui'
import StatCard from '@/components/StatCard.vue'
import ListSkeleton from '@/components/ListSkeleton.vue'
import { useAppStore } from '@/stores/app'
import { ipc, onIpc, onMonitorTick, IPC_EVENTS } from '@/composables/useIpc'
import { useExecDiagnostics } from '@/composables/useExecDiagnostics'
import { clampPercent, formatBytes, formatPercent } from '@/utils/format'
import { buildQueueSections } from '@/utils/queueView'
import { formatExecErrorReport } from '@shared/execError'
import { COLORS } from '@/styles/tokens'
import type {
  ComfyJobSummary,
  ExecFailure,
  ExecNodeProgress,
  ExecProgressEvent,
  QueueSnapshot,
  SystemSnapshot
} from '@shared/types'

const store = useAppStore()
const { t, te } = useI18n()
const message = useMessage()
const router = useRouter()
const queue = ref<QueueSnapshot | null>(null)
const queueError = ref(false)
const history = ref<number[]>([])
/** /api/jobs snapshot (0.39+); null when the endpoint is unavailable. */
const jobs = ref<ComfyJobSummary[] | null>(null)

/**
 * De-duplicated queue view (0.1.11): /queue running/pending + terminal jobs
 * from /api/jobs. The same task used to render twice — once「运行中」and once
 * 「执行中」— because both sources were painted side by side.
 */
const queueSections = computed(() => buildQueueSections(queue.value, jobs.value))

/** Open the active target's frontend (local embed or remote URL). */
function openFrontend(): void {
  const url = store.isRemoteActive ? store.activeRemote?.baseUrl : store.activeInstance?.url
  if (url) void router.push({ path: '/embed', query: { url } })
}

// monitor.history — task history for the active instance
const historySnapshot = ref<QueueSnapshot | null>(null)
const historyLoading = ref(false)
const queueTab = ref<'queue' | 'history'>('queue')

// ---------- Live generation preview + node-level progress (0.1.10) ----------
const lastPreview = ref('')
const nodeProgress = ref<Record<string, ExecNodeProgress>>({})
const currentNodeId = ref('')

const runningNodes = computed(() =>
  Object.values(nodeProgress.value).filter((n) => n.state === 'running')
)
const finishedNodeCount = computed(
  () => Object.values(nodeProgress.value).filter((n) => n.state === 'finished').length
)

function onWsEvent(payload: unknown): void {
  const evt = payload as ExecProgressEvent
  if (!evt?.type) return
  if (evt.type === 'preview' && evt.image) {
    lastPreview.value = evt.image
    return
  }
  if (evt.type === 'progress_state' && evt.nodes) {
    nodeProgress.value = evt.nodes
    if (evt.nodeId) currentNodeId.value = evt.nodeId
    return
  }
  if (evt.type === 'executing') {
    currentNodeId.value = evt.nodeId || ''
    return
  }
  if (evt.type === 'execution_start') {
    // New run — reset stale state.
    nodeProgress.value = {}
    currentNodeId.value = ''
  }
}

const cpuHistory = computed(() => history.value.slice(-40))

function pct(used: number, total: number): number {
  if (!total) return 0
  return clampPercent((used / total) * 100)
}

// 0.1.10: the monitor follows the ACTIVE TARGET — a configured remote's
// baseUrl when one is selected, otherwise the local instance. Remote targets
// are read-only (queue/history/system only).
const targetUrl = computed(() => store.activeTargetUrl)
const targetReady = computed(() =>
  store.isRemoteActive ? Boolean(store.activeRemote) : store.activeInstance?.status === 'running'
)

async function refreshQueue(): Promise<void> {
  try {
    if (!targetUrl.value || !targetReady.value) {
      // No target / not ready: show the empty state, not a scary error banner.
      queue.value = null
      queueError.value = false
      return
    }
    queue.value = await ipc('monitor.queue', targetUrl.value)
    queueError.value = false
  } catch {
    // Offline: clear stale data instead of leaving the old queue on screen.
    queue.value = null
    queueError.value = true
  }
}

/** Job list (0.39+); unsupported endpoints yield null and the section hides. */
async function refreshJobs(): Promise<void> {
  if (!targetUrl.value || !targetReady.value) {
    jobs.value = null
    return
  }
  try {
    jobs.value = await ipc('monitor.jobs', targetUrl.value)
  } catch {
    jobs.value = null
  }
}

function jobStatusLabel(status: string): string {
  const key = `monitor.job.${status}`
  return te(key) ? t(key) : status
}

// ---------- 0.1.12: recorded execution failures (detail + jump) ----------
const { failures: execFailures, load: loadExecFailures } = useExecDiagnostics()
const showFailureDetail = ref(false)
const selectedFailure = ref<ExecFailure | null>(null)

function failureFor(promptId?: string): ExecFailure | undefined {
  if (!promptId) return undefined
  return execFailures.value.find((f) => f.promptId === promptId)
}

async function refreshFailures(): Promise<void> {
  // Failures are recorded for LOCAL instances only (remote runs never reach
  // our diagnosis pipeline — honest boundary).
  if (store.isRemoteActive) return
  const instId = store.activeInstanceId
  if (!instId) return
  await loadExecFailures(instId)
}

function openFailure(f: ExecFailure | undefined): void {
  if (!f) return
  selectedFailure.value = f
  showFailureDetail.value = true
}

async function copyFailureReportM(f: ExecFailure): Promise<void> {
  try {
    await ipc('shell.writeClipboard', formatExecErrorReport(f))
    message.success(t('exec.reportCopied'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function goInstanceLogs(f: ExecFailure): void {
  showFailureDetail.value = false
  void router.push({ path: `/instances/${f.instanceId}`, hash: '#logs' })
}

function jobChip(status: string): string {
  const s = String(status || '').toLowerCase()
  if (s === 'completed' || s === 'success' || s === 'done') return 'chip-success'
  if (s === 'failed' || s === 'error') return 'chip-danger'
  if (s === 'cancelled') return 'chip-warning'
  if (s === 'in_progress' || s === 'running') return 'chip-warning'
  return 'chip-muted'
}

/** Load monitor.history (QueueSnapshot.history) for the active target. */
async function refreshHistory(): Promise<void> {
  if (!targetUrl.value || !targetReady.value) {
    historySnapshot.value = null
    historyLoading.value = false
    return
  }
  historyLoading.value = true
  try {
    historySnapshot.value = await ipc('monitor.history', targetUrl.value)
  } catch (err) {
    historySnapshot.value = null
    message.error(
      t('monitor.historyLoadFailed', { error: err instanceof Error ? err.message : String(err) })
    )
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
let offWs: (() => void) | null = null
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
  offWs = onIpc(IPC_EVENTS.monitorWs, onWsEvent)
  // WS is owned by the app store (bound to the active instance) — do not
  // connect/disconnect it here or leaving this page would kill other pages' streams.
  await refreshQueue()
  void refreshHistory()
  void refreshJobs()
  void refreshFailures()
  queueTimer = setInterval(() => {
    void refreshQueue()
    void refreshJobs()
  }, 3000)
})

// Re-poll when the user switches the active instance in the header.
watch(
  () => store.instanceSwitchTick,
  () => {
    void refreshQueue()
    void refreshHistory()
    void refreshJobs()
    void refreshFailures()
  }
)

onUnmounted(() => {
  off?.()
  offWs?.()
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
      <NAlert
        v-if="store.isRemoteActive && store.activeRemote"
        type="info"
        class="remote-note"
        :title="$t('monitor.remoteReadonlyTitle')"
      >
        {{ $t('monitor.remoteReadonlyBody', { name: store.activeRemote.name }) }}
      </NAlert>
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
          :hint="
            $t('monitor.queueHint', {
              running: queue?.running?.length || 0,
              pending: queue?.pending?.length || 0
            })
          "
        />
      </div>

      <div class="grid lower">
        <section class="card panel">
          <div class="panel-title">{{ $t('monitor.cpuTrend') }}</div>
          <div class="chart">
            <div
              v-for="(v, i) in cpuHistory"
              :key="i"
              class="bar"
              :style="{ height: `${Math.max(4, v)}%` }"
            />
          </div>
        </section>

        <section class="card panel">
          <div class="panel-title">{{ $t('monitor.gpuTitle') }}</div>
          <div v-if="store.system?.gpus?.length" class="gpu-list">
            <div v-for="gpu in store.system.gpus" :key="gpu.index" class="gpu-item">
              <div class="gpu-name">
                <span class="gpu-index">GPU {{ gpu.index }}</span> {{ gpu.model }}
              </div>
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
                <div v-if="gpu.sharedTotal" class="gpu-sub">
                  {{
                    $t('monitor.sharedLabel', {
                      used: formatBytes(gpu.sharedUsed || 0),
                      total: formatBytes(gpu.sharedTotal)
                    })
                  }}
                </div>
              </div>
            </div>
          </div>
          <NEmpty v-else :description="$t('monitor.noGpu')" />
        </section>
      </div>

      <section class="card panel preview-panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">{{ $t('monitor.previewTitle') }}</div>
            <div class="panel-sub">{{ $t('monitor.previewSub') }}</div>
          </div>
        </div>
        <div class="preview-box">
          <img v-if="lastPreview" :src="lastPreview" class="preview-img" alt="" />
          <div v-else class="preview-empty">
            <div>{{ $t('monitor.previewEmpty') }}</div>
            <NButton
              v-if="targetReady"
              size="small"
              secondary
              style="margin-top: 10px"
              @click="openFrontend"
            >
              {{ $t('monitor.openFrontend') }}
            </NButton>
          </div>
        </div>
        <div v-if="runningNodes.length || finishedNodeCount" class="node-progress">
          <div v-for="n in runningNodes" :key="n.nodeId" class="node-progress-row">
            <span class="mono node-id" :title="n.nodeId">{{ n.nodeId }}</span>
            <NProgress
              type="line"
              :percentage="n.max ? Math.min(100, Math.round((n.value / n.max) * 100)) : 0"
              :height="8"
              indicator-placement="inside"
            />
          </div>
          <div v-if="finishedNodeCount" class="meta">
            {{ $t('monitor.nodeDoneCount', { n: finishedNodeCount }) }}
          </div>
        </div>
      </section>

      <section class="card panel queue-panel">
        <NTabs
          v-model:value="queueTab"
          type="line"
          @update:value="
            (v: string) => {
              if (v === 'history') void refreshHistory()
            }
          "
        >
          <NTabPane key="queue" name="queue" :tab="$t('monitor.tabQueue')">
            <div class="panel-title">{{ $t('monitor.queueTitle') }}</div>
            <ListSkeleton v-if="!queue && !jobs && !queueError && targetReady" :rows="3" />
            <div v-else-if="!queueSections.length" class="queue-empty">
              {{ queueError ? $t('monitor.queueLoadFailed') : $t('monitor.queueEmpty') }}
            </div>
            <div v-else class="queue-list">
              <template v-for="sec in queueSections" :key="sec.key">
                <div class="queue-section-label">
                  <span>{{
                    sec.key === 'running'
                      ? $t('status.running')
                      : sec.key === 'pending'
                        ? $t('monitor.pending')
                        : $t('monitor.jobsRecent')
                  }}</span>
                  <span class="meta">· {{ sec.items.length }}</span>
                </div>
                <div v-for="it in sec.items" :key="`${sec.key}:${it.id}`" class="queue-row">
                  <span
                    class="chip"
                    :class="
                      sec.key === 'running'
                        ? 'chip-success'
                        : sec.key === 'pending'
                          ? 'chip-warning'
                          : jobChip(it.status)
                    "
                  >
                    {{
                      sec.key === 'running'
                        ? $t('status.running')
                        : sec.key === 'pending'
                          ? $t('monitor.pending')
                          : jobStatusLabel(it.status)
                    }}
                  </span>
                  <span class="mono history-prompt">{{ it.id }}</span>
                  <span
                    v-if="failureFor(it.id)"
                    class="queue-fail-msg"
                    :title="failureFor(it.id)?.message"
                  >
                    {{ failureFor(it.id)?.errorType }}: {{ failureFor(it.id)?.message }}
                  </span>
                  <span v-if="it.at" class="meta history-time">
                    {{ new Date(it.at).toLocaleTimeString() }}
                  </span>
                  <NButton
                    v-if="failureFor(it.id)"
                    size="tiny"
                    type="error"
                    secondary
                    @click="openFailure(failureFor(it.id))"
                  >
                    {{ $t('monitor.failDetail') }}
                  </NButton>
                </div>
              </template>
            </div>
          </NTabPane>
          <NTabPane key="history" name="history" :tab="$t('monitor.tabHistory')">
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
            <div v-if="!targetUrl" class="queue-empty">
              {{ $t('monitor.needInstanceUrl') }}
            </div>
            <div v-else-if="historyLoading && !historySnapshot" class="queue-empty">
              {{ $t('monitor.loading') }}
            </div>
            <div v-else-if="!historySnapshot?.history?.length" class="queue-empty">
              {{ $t('monitor.historyEmpty') }}
            </div>
            <NScrollbar v-else style="max-height: 320px">
              <div class="queue-list">
                <div
                  v-for="h in historySnapshot.history"
                  :key="h.promptId"
                  class="queue-row history-row"
                >
                  <NTag size="small" round :type="historyStatusType(h.status)">
                    {{ historyStatusLabel(h.status) }}
                  </NTag>
                  <span class="mono history-prompt">{{ h.promptId }}</span>
                  <span
                    v-if="failureFor(h.promptId)"
                    class="queue-fail-msg"
                    :title="failureFor(h.promptId)?.message"
                  >
                    {{ failureFor(h.promptId)?.errorType }}: {{ failureFor(h.promptId)?.message }}
                  </span>
                  <span class="meta history-time">{{ formatHistoryTime(h.completedAt) }}</span>
                  <NButton
                    v-if="failureFor(h.promptId)"
                    size="tiny"
                    type="error"
                    secondary
                    @click="openFailure(failureFor(h.promptId))"
                  >
                    {{ $t('monitor.failDetail') }}
                  </NButton>
                </div>
              </div>
            </NScrollbar>
          </NTabPane>
        </NTabs>
      </section>
    </div>

    <!-- 0.1.12: failure detail (recorded from WS payloads / log parsing) -->
    <NModal
      v-model:show="showFailureDetail"
      preset="card"
      :title="$t('exec.detailTitle')"
      style="width: 640px; border-radius: 20px"
    >
      <div v-if="selectedFailure" class="detail-grid">
        <div class="detail-kv">
          <b>{{ $t('exec.typeLabel') }}</b
          ><span class="mono">{{ selectedFailure.errorType }}</span>
        </div>
        <div class="detail-kv">
          <b>{{ $t('exec.msgLabel') }}</b
          ><span>{{ selectedFailure.message }}</span>
        </div>
        <div v-if="selectedFailure.nodeType" class="detail-kv">
          <b>{{ $t('exec.nodeLabel') }}</b>
          <span class="mono">
            {{ selectedFailure.nodeType
            }}<template v-if="selectedFailure.nodeId"> · {{ selectedFailure.nodeId }}</template>
          </span>
        </div>
        <div v-if="selectedFailure.packFolder" class="detail-kv">
          <b>{{ $t('exec.packLabel') }}</b>
          <span class="mono">{{ selectedFailure.packFolder }}</span>
        </div>
        <div v-if="selectedFailure.missingModule" class="detail-kv">
          <b>{{ $t('exec.missingLabel') }}</b>
          <span class="mono">{{ selectedFailure.missingModule }}</span>
        </div>
        <div v-if="selectedFailure.promptId" class="detail-kv">
          <b>{{ $t('exec.promptLabel') }}</b>
          <span class="mono">{{ selectedFailure.promptId }}</span>
        </div>
        <div class="detail-kv">
          <b>{{ $t('exec.timeLabel') }}</b>
          <span>{{ new Date(selectedFailure.at).toLocaleString() }}</span>
        </div>
      </div>
      <div v-if="selectedFailure?.traceback?.length" class="detail-tb mono">
        {{ selectedFailure.traceback.join('\n') }}
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton secondary @click="selectedFailure && copyFailureReportM(selectedFailure)">
            {{ $t('exec.copyReport') }}
          </NButton>
          <NButton type="primary" @click="selectedFailure && goInstanceLogs(selectedFailure)">
            {{ $t('exec.openLogs') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.stats {
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.lower {
  margin-top: 16px;
  grid-template-columns: 1.2fr 1fr;
}

@media (max-width: 1280px) {
  .lower {
    grid-template-columns: 1fr;
  }
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gpu-index {
  display: inline-block;
  padding: 0 6px;
  margin-right: 4px;
  border-radius: 6px;
  background: rgba($color-primary, 0.12);
  color: $color-primary;
  font-size: 10.5px;
  font-weight: 700;
  vertical-align: 1px;
}

.gpu-sub {
  margin-top: 6px;
  font-size: 12px;
  color: $color-text-muted-ink;
}

.queue-panel {
  margin-top: 16px;
}

.preview-panel {
  margin-top: 16px;
}

.remote-note {
  margin-bottom: 14px;
  border-radius: 14px;
}

.preview-box {
  border-radius: 12px;
  overflow: hidden;
  background: $color-bg-soft;
  border: 1px solid $color-border;
  display: grid;
  place-items: center;
  min-height: 160px;
}

.preview-img {
  max-width: 100%;
  max-height: 360px;
  display: block;
}

.preview-empty {
  color: $color-text-muted-ink;
  font-size: 13px;
  padding: 40px 12px;
  text-align: center;
}

.node-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.node-progress-row {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 10px;
  align-items: center;
}

.node-id {
  font-size: 11px;
  color: $color-text-muted-ink;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: $color-text-secondary;
  margin: 8px 0 2px;
}

.jobs-block {
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px dashed $color-border;
}

.jobs-block .panel-head {
  margin-bottom: 8px;
}

.queue-empty {
  color: $color-text-muted-ink;
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
  color: $color-text-muted-ink;
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

/* 0.1.12: failure row + detail modal */
.queue-fail-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: $color-danger;
}

.detail-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-kv {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 10px;
  font-size: 13px;
  align-items: baseline;

  b {
    color: $color-text-secondary;
    font-weight: 600;
    font-size: 12.5px;
  }

  span {
    min-width: 0;
    word-break: break-all;
  }
}

.detail-tb {
  margin-top: 12px;
  max-height: 240px;
  overflow: auto;
  border: 1px solid $color-border;
  border-radius: 12px;
  background: $term-bg;
  color: $term-text;
  font-size: 11.5px;
  line-height: 1.6;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
