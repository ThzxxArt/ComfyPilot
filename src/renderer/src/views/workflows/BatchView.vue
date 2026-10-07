<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PlayOutline, CloseOutline, TrashOutline, AddOutline } from '@vicons/ionicons5'
import {
  NButton, NIcon, NInput, NInputNumber, NSpace, NSpin, NTag, NEmpty, useMessage,
  NModal, NSelect, NPopconfirm
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { clampPercent } from '@/utils/format'
import type { BatchJob } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const loading = ref(false)
const jobs = ref<BatchJob[]>([])
const showCreate = ref(false)

const draft = ref({
  name: t('batch.defaultName'),
  workflowPath: '',
  instanceId: '',
  count: 4,
  notes: ''
})

async function refresh(): Promise<void> {
  loading.value = true
  try {
    jobs.value = await ipc('batch.list')
    if (!draft.value.instanceId) draft.value.instanceId = store.activeInstanceId || ''
  } finally {
    loading.value = false
  }
}

async function pickWorkflow(): Promise<void> {
  const p = await ipc('shell.pickFile', {
    filters: [{ name: 'Workflow', extensions: ['json', 'png'] }]
  })
  if (p) draft.value.workflowPath = p
}

async function createJob(): Promise<void> {
  if (!draft.value.workflowPath) {
    message.warning(t('batch.selectWorkflow'))
    return
  }
  const job = await ipc('batch.create', {
    name: draft.value.name,
    workflowPath: draft.value.workflowPath,
    instanceId: draft.value.instanceId || store.activeInstanceId || '',
    count: draft.value.count,
    notes: draft.value.notes
  })
  showCreate.value = false
  message.success(t('batch.created', { name: job.name }))
  await refresh()
}

async function start(id: string): Promise<void> {
  try {
    await ipc('batch.start', id)
    message.success(t('batch.jobDone'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    await refresh()
  }
}

async function cancelJob(id: string): Promise<void> {
  try {
    await ipc('batch.cancel', id)
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
        <NButton type="primary" @click="showCreate = true">
          <template #icon><NIcon :component="AddOutline" /></template>{{ $t('batch.newJob') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
    <NSpin :show="loading">
      <div v-if="jobs.length" class="grid cards">
        <article v-for="job in jobs" :key="job.id" class="card job">
          <div class="job-head">
            <div>
              <div class="job-name">{{ job.name }}</div>
              <div class="job-meta mono">{{ job.workflowPath }}</div>
            </div>
            <NTag
              size="small"
              round
              :type="job.status === 'done' ? 'success' : job.status === 'error' ? 'error' : job.status === 'running' ? 'info' : 'default'"
            >
              {{ job.status }}
            </NTag>
          </div>
          <div class="job-progress">
            <div class="bar">
              <div class="bar-in" :style="{ width: `${job.count ? clampPercent((job.completed / job.count) * 100) : 0}%` }" />
            </div>
            <div class="job-meta">{{ job.completed }}/{{ job.count }} · fail {{ job.failed }}</div>
          </div>
          <NSpace>
            <NButton size="small" type="primary" secondary @click="start(job.id)">
              <template #icon><NIcon :component="PlayOutline" /></template>{{ $t('batch.run') }}
            </NButton>
            <NButton size="small" secondary @click="cancelJob(job.id)">
              <template #icon><NIcon :component="CloseOutline" /></template>{{ $t('batch.cancel') }}
            </NButton>
            <NPopconfirm @positive-click="removeJob(job.id)">
              <template #trigger>
                <NButton size="small" type="error" secondary>
                  <template #icon><NIcon :component="TrashOutline" /></template>
                </NButton>
              </template>
              {{ $t('batch.removeJobConfirm') }}
            </NPopconfirm>
          </NSpace>
        </article>
      </div>
      <NEmpty v-else :description="$t('batch.empty')" class="empty" />
    </NSpin>
    </div>

    <NModal v-model:show="showCreate" preset="card" :title="$t('batch.createTitle')" style="width: 520px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="draft.name" :placeholder="$t('batch.namePlaceholder')" />
        <NInput v-model:value="draft.workflowPath" :placeholder="$t('batch.workflowPlaceholder')">
          <template #suffix>
            <NButton size="tiny" secondary @click="pickWorkflow">{{ $t('batch.browse') }}</NButton>
          </template>
        </NInput>
        <NSelect
          v-model:value="draft.instanceId"
          :options="store.instances.map((i) => ({ label: i.name, value: i.id }))"
          :placeholder="$t('batch.instancePlaceholder')"
        />
        <NInputNumber v-model:value="draft.count" :min="1" :max="100" :placeholder="$t('batch.countPlaceholder')" />
        <NInput v-model:value="draft.notes" type="textarea" :rows="2" :placeholder="$t('batch.notesPlaceholder')" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">{{ $t('batch.cancel') }}</NButton>
          <NButton type="primary" @click="createJob">{{ $t('batch.create') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.job { padding: 18px; }
.job-head { display: flex; justify-content: space-between; gap: 12px; }
.job-name { font-size: 16px; font-weight: 700; }
.job-meta { font-size: 11.5px; color: $color-text-muted; margin-top: 4px; word-break: break-all; }
.job-progress { margin: 14px 0; }
.bar { height: 8px; border-radius: 999px; background: rgba(79, 110, 247, 0.12); overflow: hidden; }
.bar-in { height: 100%; border-radius: 999px; background: $gradient-primary; transition: width 0.3s ease; }
.empty { padding: 64px 0; }
</style>
