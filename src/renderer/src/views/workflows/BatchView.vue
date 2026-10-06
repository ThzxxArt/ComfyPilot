<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { PlayOutline, CloseOutline, TrashOutline, AddOutline } from '@vicons/ionicons5'
import {
  NButton, NIcon, NInput, NInputNumber, NSpace, NSpin, NTag, NEmpty, useMessage,
  NModal, NSelect, NPopconfirm
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import type { BatchJob } from '@shared/types'

const store = useAppStore()
const message = useMessage()
const loading = ref(false)
const jobs = ref<BatchJob[]>([])
const showCreate = ref(false)

const draft = ref({
  name: '批量出图',
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
    message.warning('请选择工作流')
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
  message.success(`已创建任务 ${job.name}`)
  await refresh()
}

async function start(id: string): Promise<void> {
  try {
    await ipc('batch.start', id)
    message.success('批量任务完成')
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    await refresh()
  }
}

onMounted(async () => {
  await store.bootstrap()
  await refresh()
  onIpc(IPC_EVENTS.batchProgress, () => void refresh())
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">批量出图</h1>
        <p class="page-subtitle">选择工作流与实例，批量提交到 ComfyUI 队列。</p>
      </div>
      <NSpace>
        <NButton secondary @click="refresh">刷新</NButton>
        <NButton type="primary" @click="showCreate = true">
          <template #icon><NIcon :component="AddOutline" /></template>新建任务
        </NButton>
      </NSpace>
    </div>

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
              <div class="bar-in" :style="{ width: `${job.count ? (job.completed / job.count) * 100 : 0}%` }" />
            </div>
            <div class="job-meta">{{ job.completed }}/{{ job.count }} · fail {{ job.failed }}</div>
          </div>
          <NSpace>
            <NButton size="small" type="primary" secondary @click="start(job.id)">
              <template #icon><NIcon :component="PlayOutline" /></template>执行
            </NButton>
            <NButton size="small" secondary @click="ipc('batch.cancel', job.id).then(refresh)">
              <template #icon><NIcon :component="CloseOutline" /></template>取消
            </NButton>
            <NPopconfirm @positive-click="ipc('batch.remove', job.id).then(refresh)">
              <template #trigger>
                <NButton size="small" type="error" secondary>
                  <template #icon><NIcon :component="TrashOutline" /></template>
                </NButton>
              </template>
              删除任务？
            </NPopconfirm>
          </NSpace>
        </article>
      </div>
      <NEmpty v-else description="暂无批量任务" class="empty" />
    </NSpin>

    <NModal v-model:show="showCreate" preset="card" title="新建批量任务" style="width: 520px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="draft.name" placeholder="任务名称" />
        <NInput v-model:value="draft.workflowPath" placeholder="工作流路径">
          <template #suffix>
            <NButton size="tiny" secondary @click="pickWorkflow">浏览</NButton>
          </template>
        </NInput>
        <NSelect
          v-model:value="draft.instanceId"
          :options="store.instances.map((i) => ({ label: i.name, value: i.id }))"
          placeholder="目标实例"
        />
        <NInputNumber v-model:value="draft.count" :min="1" :max="100" placeholder="执行次数" />
        <NInput v-model:value="draft.notes" type="textarea" :rows="2" placeholder="备注" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" @click="createJob">创建</NButton>
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
.job-name { font-size: 16px; font-weight: 720; }
.job-meta { font-size: 11.5px; color: $color-text-muted; margin-top: 4px; word-break: break-all; }
.job-progress { margin: 14px 0; }
.bar { height: 8px; border-radius: 999px; background: rgba(79, 110, 247, 0.12); overflow: hidden; }
.bar-in { height: 100%; border-radius: 999px; background: $gradient-primary; transition: width 0.3s ease; }
.empty { padding: 64px 0; }
</style>
