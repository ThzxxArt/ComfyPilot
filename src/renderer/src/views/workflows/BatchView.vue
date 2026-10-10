<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  PlayOutline,
  CloseOutline,
  TrashOutline,
  AddOutline,
  ImagesOutline,
  FolderOpenOutline
} from '@vicons/ionicons5'
import {
  NButton, NIcon, NInput, NInputNumber, NSpace, NSpin, NTag, NEmpty, useMessage,
  NModal, NSelect, NPopconfirm, NCard, NText
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { clampPercent } from '@/utils/format'
import type { BatchJob, WorkflowRecord, SeedMode } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const router = useRouter()
const loading = ref(false)
const jobs = ref<BatchJob[]>([])
const workflows = ref<WorkflowRecord[]>([])
const showCreate = ref(false)
const startingId = ref('')
const creating = ref(false)

function isBusy(status: string): boolean {
  return status === 'submitting' || status === 'running'
}

/** ComfyPilot never auto-starts an instance — batch run is gated on this. */
const instanceRunning = computed(() => store.activeInstance?.status === 'running')
const needInstanceHint = t('batch.needRunningInstance')

const draft = ref({
  name: t('batch.defaultName'),
  instanceId: '',
  notes: '',
  selected: [] as string[],
  count: 4,
  seedMode: 'random' as SeedMode,
  baseSeed: 0,
  width: null as number | null,
  height: null as number | null,
  steps: null as number | null,
  cfg: null as number | null
})

const seedModeOptions = computed(() => [
  { label: t('batch.seedRandom'), value: 'random' },
  { label: t('batch.seedIncrement'), value: 'increment' },
  { label: t('batch.seedFixed'), value: 'fixed' }
])

const workflowOptions = computed(() =>
  workflows.value
    .filter((w) => !w.missing)
    .map((w) => ({
      label: `${w.name}${w.origin === 'library' ? ' ★' : ''}`,
      value: w.id
    }))
)

function statusLabel(status: string): string {
  const key = `batch.status.${status}`
  const s = t(key)
  return s === key ? status : s
}

function statusType(status: string): 'success' | 'error' | 'info' | 'default' | 'warning' {
  if (status === 'done') return 'success'
  if (status === 'error') return 'error'
  if (status === 'running' || status === 'submitting') return 'info'
  if (status === 'cancelled') return 'warning'
  return 'default'
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    jobs.value = await ipc('batch.list')
    workflows.value = await ipc('workflow.list', { includeMissing: true })
    if (!draft.value.instanceId) draft.value.instanceId = store.activeInstanceId || ''
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function openCreate(): Promise<void> {
  if (!workflows.value.length) {
    await refresh()
  }
  draft.value.selected = []
  draft.value.name = t('batch.defaultName')
  draft.value.count = 4
  draft.value.seedMode = 'random'
  draft.value.baseSeed = 0
  draft.value.width = null
  draft.value.height = null
  draft.value.steps = null
  draft.value.cfg = null
  showCreate.value = true
}

async function createJob(): Promise<void> {
  if (!draft.value.selected.length) {
    message.warning(t('batch.selectWorkflow'))
    return
  }
  if (creating.value) return
  creating.value = true
  try {
    const items = draft.value.selected.map((id) => {
      const w = workflows.value.find((x) => x.id === id)
      if (!w) throw new Error('Workflow missing')
      return {
        workflowId: w.id,
        workflowName: w.name,
        workflowPath: w.path,
        count: draft.value.count
      }
    })
    const job = await ipc('batch.create', {
      name: draft.value.name,
      instanceId: draft.value.instanceId || store.activeInstanceId || '',
      items,
      notes: draft.value.notes,
      params: {
        seedMode: draft.value.seedMode,
        baseSeed: draft.value.seedMode === 'random' ? undefined : draft.value.baseSeed,
        width: draft.value.width ?? undefined,
        height: draft.value.height ?? undefined,
        steps: draft.value.steps ?? undefined,
        cfg: draft.value.cfg ?? undefined
      }
    })
    showCreate.value = false
    message.success(t('batch.created', { name: job.name }))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    creating.value = false
  }
}

async function start(id: string): Promise<void> {
  if (startingId.value) return
  if (!instanceRunning.value) {
    message.warning(needInstanceHint)
    return
  }
  const job = jobs.value.find((j) => j.id === id)
  if (job && isBusy(job.status)) {
    message.warning(t('batch.alreadyRunning'))
    return
  }
  startingId.value = id
  try {
    // start() submits every prompt, then waits until outputs settle.
    const result = await ipc('batch.start', id)
    if (result.status === 'done') {
      message.success(
        t('batch.jobDone', {
          submitted: result.submitted ?? 0,
          completed: result.completed,
          produced: result.produced,
          failed: result.failed
        })
      )
    } else if (result.status === 'cancelled') {
      message.warning(t('batch.jobCancelled'))
    } else {
      message.warning(
        t('batch.jobFinishedPartial', {
          submitted: result.submitted ?? 0,
          completed: result.completed,
          failed: result.failed
        })
      )
    }
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    await refresh()
  } finally {
    startingId.value = ''
  }
}

async function cancelJob(id: string): Promise<void> {
  try {
    await ipc('batch.cancel', id)
    message.info(t('batch.cancelled'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeJob(id: string): Promise<void> {
  try {
    await ipc('batch.remove', id)
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function viewOutputs(job: BatchJob): void {
  void router.push({ path: '/output', query: { batchJobId: job.id } })
}

async function safeReveal(path: string): Promise<void> {
  try {
    await ipc('shell.reveal', path)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function seedModeLabel(mode?: string): string {
  const hit = seedModeOptions.value.find((o) => o.value === mode)
  return hit ? hit.label : String(mode || '')
}

let offBatch: (() => void) | null = null

onMounted(async () => {
  await store.bootstrap({ keepSelection: true })
  await refresh()
  offBatch = onIpc(IPC_EVENTS.batchProgress, () => void refresh())
})

onUnmounted(() => offBatch?.())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('batch.title') }}</h1>
        <p class="page-subtitle">{{ $t('batch.subtitle') }}</p>
      </div>
      <NSpace>
        <NButton secondary @click="refresh">{{ $t('batch.refresh') }}</NButton>
        <NButton type="primary" @click="openCreate">
          <template #icon><NIcon :component="AddOutline" /></template>{{ $t('batch.newJob') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
      <NSpin :show="loading">
        <div v-if="jobs.length" class="grid cards">
          <article v-for="job in jobs" :key="job.id" class="card job">
            <div class="job-head">
              <div class="job-title">
                <div class="job-name">{{ job.name }}</div>
                <div class="job-meta mono">{{ job.workflowPath }}</div>
                <div v-if="job.items.length > 1" class="job-meta">
                  {{ $t('batch.multiWorkflow', { n: job.items.length }) }}
                </div>
              </div>
              <NTag size="small" round :type="statusType(job.status)">
                {{ statusLabel(job.status) }}
              </NTag>
            </div>

            <div class="job-progress">
              <div class="bar">
                <div
                  class="bar-in"
                  :style="{ width: `${job.count ? clampPercent(((job.completed + job.failed) / job.count) * 100) : 0}%` }"
                />
              </div>
              <div class="job-meta">
                {{ $t('batch.progressLine', {
                  submitted: job.submitted ?? 0,
                  count: job.count,
                  completed: job.completed,
                  produced: job.produced,
                  failed: job.failed
                }) }}
              </div>
            </div>

            <!-- per-item legs -->
            <div v-if="job.items.length > 1" class="job-items">
              <div v-for="(it, idx) in job.items" :key="idx" class="job-item mono">
                {{ it.workflowName }} · {{ it.completed }}/{{ it.count }} · fail {{ it.failed }}
              </div>
            </div>

            <div v-if="job.params?.seedMode" class="job-meta">
              {{ $t('batch.seedMode') }}: {{ seedModeLabel(job.params.seedMode) }}
              <template v-if="job.params.baseSeed != null && job.params.seedMode !== 'random'">
                · {{ job.params.baseSeed }}
              </template>
              <template v-if="job.params.width && job.params.height">
                · {{ job.params.width }}×{{ job.params.height }}
              </template>
              <template v-if="job.params.steps"> · {{ $t('batch.steps') }} {{ job.params.steps }}</template>
              <template v-if="job.params.cfg"> · CFG {{ job.params.cfg }}</template>
            </div>

            <NSpace>
              <NButton
                size="small"
                type="primary"
                secondary
                :disabled="isBusy(job.status) || startingId === job.id || !instanceRunning"
                :loading="startingId === job.id"
                :title="instanceRunning ? '' : needInstanceHint"
                @click="start(job.id)"
              >
                <template #icon><NIcon :component="PlayOutline" /></template>{{ $t('batch.run') }}
              </NButton>
              <NButton
                size="small"
                secondary
                :disabled="!isBusy(job.status) && job.status !== 'queued'"
                @click="cancelJob(job.id)"
              >
                <template #icon><NIcon :component="CloseOutline" /></template>{{ $t('batch.cancel') }}
              </NButton>
              <NButton size="small" secondary @click="viewOutputs(job)">
                <template #icon><NIcon :component="ImagesOutline" /></template>{{ $t('batch.viewOutputs') }}
              </NButton>
              <NButton
                size="small"
                secondary
                @click="job.workflowPath && safeReveal(job.workflowPath)"
              >
                <template #icon><NIcon :component="FolderOpenOutline" /></template>
              </NButton>
              <NPopconfirm @positive-click="removeJob(job.id)">
                <template #trigger>
                  <NButton size="small" type="error" secondary :disabled="isBusy(job.status)">
                    <template #icon><NIcon :component="TrashOutline" /></template>
                  </NButton>
                </template>
                {{ $t('batch.removeJobConfirm') }}
              </NPopconfirm>
            </NSpace>
          </article>
        </div>
        <NEmpty v-else :description="$t('batch.empty')" class="empty">
          <template #extra>
            <NButton type="primary" @click="openCreate">{{ $t('batch.newJob') }}</NButton>
          </template>
        </NEmpty>
      </NSpin>
    </div>

    <NModal v-model:show="showCreate" preset="card" :title="$t('batch.createTitle')" style="width: 580px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="draft.name" :placeholder="$t('batch.namePlaceholder')" />
        <div>
          <NText depth="3">{{ $t('batch.pickFromLibrary') }}</NText>
          <NSelect
            v-model:value="draft.selected"
            multiple
            :options="workflowOptions"
            :placeholder="$t('batch.workflowPlaceholder')"
            filterable
          />
        </div>
        <NSelect
          v-model:value="draft.instanceId"
          :options="store.instances.map((i) => ({ label: i.name, value: i.id }))"
          :placeholder="$t('batch.instancePlaceholder')"
        />
        <div class="matrix">
          <div class="matrix-row">
            <div class="matrix-cell">
              <NText depth="3">{{ $t('batch.countPlaceholder') }}</NText>
              <NInputNumber v-model:value="draft.count" :min="1" :max="500" />
            </div>
            <div class="matrix-cell">
              <NText depth="3">{{ $t('batch.seedMode') }}</NText>
              <NSelect v-model:value="draft.seedMode" :options="seedModeOptions" />
            </div>
            <div class="matrix-cell" v-if="draft.seedMode !== 'random'">
              <NText depth="3">{{ $t('batch.baseSeed') }}</NText>
              <NInputNumber v-model:value="draft.baseSeed" :min="0" :max="4294967295" />
            </div>
          </div>
          <div class="matrix-row">
            <div class="matrix-cell">
              <NText depth="3">{{ $t('batch.width') }}</NText>
              <NInputNumber v-model:value="draft.width" :min="64" :max="4096" :step="8" clearable />
            </div>
            <div class="matrix-cell">
              <NText depth="3">{{ $t('batch.height') }}</NText>
              <NInputNumber v-model:value="draft.height" :min="64" :max="4096" :step="8" clearable />
            </div>
            <div class="matrix-cell">
              <NText depth="3">{{ $t('batch.steps') }}</NText>
              <NInputNumber v-model:value="draft.steps" :min="1" :max="150" clearable />
            </div>
            <div class="matrix-cell">
              <NText depth="3">CFG</NText>
              <NInputNumber v-model:value="draft.cfg" :min="1" :max="30" :step="0.5" clearable />
            </div>
          </div>
        </div>
        <NInput v-model:value="draft.notes" type="textarea" :rows="2" :placeholder="$t('batch.notesPlaceholder')" />
        <NCard size="small">
          <NText depth="3">{{ $t('batch.hintQueueVsDone') }}</NText>
        </NCard>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">{{ $t('batch.cancel') }}</NButton>
          <NButton type="primary" :loading="creating" @click="createJob">{{ $t('batch.create') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.cards {
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
}
.job {
  padding: 18px;
}
.job-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.job-title {
  min-width: 0;
  flex: 1;
}
.job-name {
  font-size: 16px;
  font-weight: 700;
}
.job-meta {
  font-size: 11.5px;
  color: $color-text-muted;
  margin-top: 4px;
  word-break: break-all;
}
.job-progress {
  margin: 14px 0;
}
.bar {
  height: 8px;
  border-radius: 999px;
  background: rgba(79, 110, 247, 0.12);
  overflow: hidden;
}
.bar-in {
  height: 100%;
  border-radius: 999px;
  background: $gradient-primary;
  transition: width 0.3s ease;
}
.job-items {
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.job-item {
  font-size: 11px;
  color: $color-text-muted;
}
.matrix {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.matrix-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.matrix-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 110px;
}
.empty {
  padding: 64px 0;
}
</style>
