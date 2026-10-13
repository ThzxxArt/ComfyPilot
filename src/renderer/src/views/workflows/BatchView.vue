<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import {
  PlayOutline,
  CloseOutline,
  TrashOutline,
  AddOutline,
  ImagesOutline,
  FolderOpenOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NIcon,
  NInput,
  NInputNumber,
  NSpace,
  NSpin,
  NTag,
  NEmpty,
  useMessage,
  useDialog,
  NModal,
  NSelect,
  NPopconfirm,
  NCard,
  NText,
  NTooltip
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { clampPercent } from '@/utils/format'
import ListSkeleton from '@/components/ListSkeleton.vue'
import type { BatchJob, WorkflowRecord, SeedMode } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const dialog = useDialog()
const router = useRouter()
const route = useRoute()
const loading = ref(false)
const jobs = ref<BatchJob[]>([])
const workflows = ref<WorkflowRecord[]>([])
const showCreate = ref(false)
const startingId = ref('')
const creating = ref(false)
/** Job id from route.query.jobId — highlighted + scrolled into view. */
const highlightId = ref('')

function isBusy(status: string): boolean {
  return status === 'submitting' || status === 'running'
}

/** Local target needs a running instance; remote targets are checked in main
 *  (0.1.11 — remote batch submission is now supported). */
const localTargetRunning = computed(() => store.activeInstance?.status === 'running')

/** Instance options incl. configured remotes (`remote:<id>`). */
const instanceOptions = computed(() => [
  ...store.instances.map((i) => ({ label: i.name, value: i.id })),
  ...store.remotes.map((r) => ({ label: `☁ ${r.name}`, value: `remote:${r.id}` }))
])

/** Can this job start now: local instance running, or a remote target. */
function canStartJob(job: BatchJob): boolean {
  if (job.instanceId?.startsWith('remote:')) return true
  return localTargetRunning.value
}

const needInstanceHint = computed(() => t('batch.needRunningInstance'))
// Hoisted to setup scope — calling useLaunch() inside a dialog callback would
// lose the router injection.
const { launch } = useLaunch()

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

/** Target for new jobs — draft pick, else the header's active target. */
function resolvedInstanceId(): string {
  return (
    draft.value.instanceId ||
    (store.activeRemoteId ? `remote:${store.activeRemoteId}` : store.activeInstanceId) ||
    ''
  )
}

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

/** Lightweight refresh: only batch.list (no workflow.list disk walk). */
async function refreshJobs(): Promise<void> {
  try {
    jobs.value = await ipc('batch.list')
    if (!draft.value.instanceId) {
      draft.value.instanceId = store.activeRemoteId
        ? `remote:${store.activeRemoteId}`
        : store.activeInstanceId || ''
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    jobs.value = await ipc('batch.list')
    // workflow.list is a full disk walk — only fetch it when the create modal
    // actually needs it (openCreate calls loadWorkflows).
    if (!draft.value.instanceId) {
      draft.value.instanceId = store.activeRemoteId
        ? `remote:${store.activeRemoteId}`
        : store.activeInstanceId || ''
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function loadWorkflows(): Promise<void> {
  try {
    workflows.value = await ipc('workflow.list', { includeMissing: true })
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openCreate(): Promise<void> {
  await loadWorkflows()
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
  const targetInstance = resolvedInstanceId()
  if (!targetInstance) {
    message.warning(t('common.needRunningInstance'))
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
      instanceId: targetInstance,
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
  const job = jobs.value.find((j) => j.id === id)
  if (job && isBusy(job.status)) {
    message.warning(t('batch.alreadyRunning'))
    return
  }
  const target = job?.instanceId || ''
  if (!target.startsWith('remote:') && !localTargetRunning.value) {
    message.warning(needInstanceHint.value)
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
    const msg = err instanceof Error ? err.message : String(err)
    // Instance not running — offer a one-click start instead of a dead-end toast.
    if (/not running|is not running/i.test(msg)) {
      dialog.warning({
        title: t('batch.instanceNotRunning'),
        content: msg,
        positiveText: t('batch.startInstance'),
        negativeText: t('common.cancel'),
        onPositiveClick: () => {
          void (async () => {
            try {
              const inst = store.activeInstance
              if (!inst) return
              await launch(inst, { open: 'none' })
            } catch (e) {
              message.error(e instanceof Error ? e.message : String(e))
            }
          })()
        }
      })
    } else {
      message.error(msg)
    }
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

/** Per-item cancel - dequeue just this workflow leg's pending prompts. */
async function cancelItem(job: BatchJob, workflowPath: string): Promise<void> {
  try {
    await ipc('batch.cancelItem', job.id, workflowPath)
    message.info(t('batch.itemCancelled'))
    await refreshJobs()
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

/** Scroll a job card into view + highlight it briefly. */
function highlightJob(id: string): void {
  highlightId.value = id
  // Scroll only after the DOM has the card — callers must await data first.
  void nextTick(() => {
    const el = document.querySelector(`[data-job-id="${id}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  // Clear the highlight after a few seconds.
  window.setTimeout(() => {
    if (highlightId.value === id) highlightId.value = ''
  }, 4000)
}

// Capture the target id immediately, but only scroll after refresh() has
// rendered the cards (immediate watch runs before jobs are loaded).
let pendingHighlight = ''
watch(
  () => route.query.jobId,
  (v) => {
    if (typeof v === 'string' && v) {
      pendingHighlight = v
      highlightId.value = v
    }
  },
  { immediate: true }
)

onMounted(async () => {
  await store.bootstrap({ keepSelection: true })
  await refresh()
  if (pendingHighlight) {
    highlightJob(pendingHighlight)
    pendingHighlight = ''
  }
  // On progress: only re-fetch batch.list — never trigger a workflow.list
  // disk walk on every progress tick.
  offBatch = onIpc(IPC_EVENTS.batchProgress, () => void refreshJobs())
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
      <NSpin :show="loading && jobs.length > 0">
        <ListSkeleton v-if="loading && !jobs.length" :rows="4" variant="card" />
        <div v-else-if="jobs.length" class="grid cards">
          <article
            v-for="job in jobs"
            :key="job.id"
            class="card job"
            :class="{ highlighted: highlightId === job.id }"
            :data-job-id="job.id"
          >
            <div class="job-head">
              <div class="job-title">
                <div class="job-name" :title="job.name">{{ job.name }}</div>
                <div class="job-meta mono job-path" :title="job.workflowPath">
                  {{ job.workflowPath }}
                </div>
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
                  :style="{
                    width: `${job.count ? clampPercent(((job.completed + job.failed) / job.count) * 100) : 0}%`
                  }"
                />
              </div>
              <div class="job-meta">
                {{
                  $t('batch.progressLine', {
                    submitted: job.submitted ?? 0,
                    count: job.count,
                    completed: job.completed,
                    produced: job.produced,
                    failed: job.failed
                  })
                }}
              </div>
            </div>

            <!-- per-item legs: always visible so each workflow row shows its own progress -->
            <div v-if="job.items.length" class="job-items">
              <div v-for="(it, idx) in job.items" :key="idx" class="job-item">
                <div class="job-item-line">
                  <span class="mono job-item-name" :title="it.workflowName">{{
                    it.workflowName
                  }}</span>
                  <span class="mono">
                    {{
                      $t('batch.itemProgress', {
                        submitted: it.submitted,
                        count: it.count,
                        completed: it.completed,
                        failed: it.failed
                      })
                    }}
                  </span>
                  <span v-if="it.failed" class="item-fail">
                    · {{ $t('batch.itemFailed', { n: it.failed }) }}</span
                  >
                  <span
                    v-if="it.submitted && it.completed + it.failed < it.submitted && !it.cancelled"
                    class="item-pending"
                  >
                    · {{ $t('batch.itemPending', { n: it.submitted - it.completed - it.failed }) }}
                  </span>
                  <NTag v-if="it.cancelled" size="tiny" round type="warning">{{
                    $t('batch.itemCancelled')
                  }}</NTag>
                  <NButton
                    v-if="isBusy(job.status) && !it.cancelled"
                    size="tiny"
                    quaternary
                    type="error"
                    @click.stop="cancelItem(job, it.workflowPath)"
                  >
                    {{ $t('batch.cancelItem') }}
                  </NButton>
                </div>
                <div class="bar item-bar">
                  <div
                    class="bar-in"
                    :style="{
                      width: `${it.count ? clampPercent(((it.completed + it.failed) / it.count) * 100) : 0}%`
                    }"
                  />
                </div>
              </div>
            </div>

            <!-- error / notes surfacing -->
            <div v-if="job.errorSummary" class="job-error">
              {{ job.errorSummary }}
            </div>
            <div v-if="job.notes" class="job-notes">
              {{ job.notes }}
            </div>

            <div v-if="job.params?.seedMode" class="job-meta">
              {{ $t('batch.seedMode') }}: {{ seedModeLabel(job.params.seedMode) }}
              <template v-if="job.params.baseSeed != null && job.params.seedMode !== 'random'">
                · {{ job.params.baseSeed }}
              </template>
              <template v-if="job.params.width && job.params.height">
                · {{ job.params.width }}×{{ job.params.height }}
              </template>
              <template v-if="job.params.steps">
                · {{ $t('batch.steps') }} {{ job.params.steps }}</template
              >
              <template v-if="job.params.cfg">
                · {{ $t('batch.cfg') }} {{ job.params.cfg }}</template
              >
            </div>

            <NSpace class="job-actions">
              <NTooltip trigger="hover" :disabled="canStartJob(job)">
                <template #trigger>
                  <span class="btn-wrap">
                    <NButton
                      size="small"
                      type="primary"
                      secondary
                      :disabled="isBusy(job.status) || startingId === job.id || !canStartJob(job)"
                      :loading="startingId === job.id"
                      @click="start(job.id)"
                    >
                      <template #icon><NIcon :component="PlayOutline" /></template
                      >{{ $t('batch.run') }}
                    </NButton>
                  </span>
                </template>
                {{ needInstanceHint }}
              </NTooltip>
              <NButton
                size="small"
                secondary
                :disabled="!isBusy(job.status) && job.status !== 'queued'"
                @click="cancelJob(job.id)"
              >
                <template #icon><NIcon :component="CloseOutline" /></template
                >{{ $t('batch.cancel') }}
              </NButton>
              <NButton size="small" secondary @click="viewOutputs(job)">
                <template #icon><NIcon :component="ImagesOutline" /></template
                >{{ $t('batch.viewOutputs') }}
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

    <NModal
      v-model:show="showCreate"
      preset="card"
      :title="$t('batch.createTitle')"
      style="width: 580px; border-radius: 20px"
    >
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
          :options="instanceOptions"
          :placeholder="$t('batch.instancePlaceholder')"
        />
        <div v-if="draft.instanceId.startsWith('remote:')" class="meta remote-note-inline">
          {{ $t('batch.remoteOutputsNote') }}
        </div>
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
            <div v-if="draft.seedMode !== 'random'" class="matrix-cell">
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
              <NInputNumber
                v-model:value="draft.height"
                :min="64"
                :max="4096"
                :step="8"
                clearable
              />
            </div>
            <div class="matrix-cell">
              <NText depth="3">{{ $t('batch.steps') }}</NText>
              <NInputNumber v-model:value="draft.steps" :min="1" :max="150" clearable />
            </div>
            <div class="matrix-cell">
              <NText depth="3">{{ $t('batch.cfg') }}</NText>
              <NInputNumber v-model:value="draft.cfg" :min="1" :max="30" :step="0.5" clearable />
            </div>
          </div>
        </div>
        <NInput
          v-model:value="draft.notes"
          type="textarea"
          :rows="2"
          :placeholder="$t('batch.notesPlaceholder')"
        />
        <NCard size="small">
          <NText depth="3">{{ $t('batch.hintQueueVsDone') }}</NText>
        </NCard>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">{{ $t('batch.cancel') }}</NButton>
          <NButton type="primary" :loading="creating" @click="createJob">{{
            $t('batch.create')
          }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.cards {
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  grid-auto-rows: 1fr;
}
.job {
  padding: 18px;
  display: flex;
  flex-direction: column;
}
.job-actions {
  margin-top: auto;
  padding-top: 10px;
}
.btn-wrap {
  display: inline-flex;
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
.job-title > .n-tag,
.job-head > .n-tag {
  flex-shrink: 0;
}
.job-name {
  font-size: 16px;
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-meta {
  font-size: 11.5px;
  color: $color-text-muted-ink;
  margin-top: 4px;
  word-break: break-all;
}
/* 路径固定单行省略，避免长路径把卡片撑高 */
.job-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-progress {
  margin: 14px 0;
}
.bar {
  height: 8px;
  border-radius: 999px;
  background: rgba($color-primary, 0.12);
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
  color: $color-text-muted-ink;
}
.item-fail {
  color: $color-danger;
  font-weight: 600;
}
.item-pending {
  color: $color-warning;
}
.job-item-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.job-item-name {
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-bar {
  margin-top: 6px;
}
.job-error {
  margin: 8px 0 4px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba($color-danger, 0.1);
  border: 1px solid rgba($color-danger, 0.35);
  color: $color-danger;
  font-size: 11.5px;
  word-break: break-all;
}
.job-notes {
  margin: 4px 0 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: $color-surface-2;
  color: $color-text-muted-ink;
  font-size: 11px;
  word-break: break-all;
  max-height: 80px;
  overflow: auto;
}
.job.highlighted {
  outline: 2px solid $color-primary;
  box-shadow: 0 0 0 4px rgba($color-primary, 0.25);
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
.remote-note-inline {
  margin-top: 6px;
  color: $color-warning;
  line-height: 1.55;
}
</style>
