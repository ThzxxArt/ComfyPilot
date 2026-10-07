<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { DocumentTextOutline, PlayOutline, OpenOutline, RefreshOutline, SendOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NInput, NSpace, NSpin, NTag, NEmpty, useMessage, NModal, NSelect, NInputNumber } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import type { WorkflowRecord } from '@shared/types'

const store = useAppStore()
const message = useMessage()
const loading = ref(false)
const items = ref<WorkflowRecord[]>([])
const keyword = ref('')
const showQueue = ref(false)
const queueTarget = ref<WorkflowRecord | null>(null)
const seed = ref<number | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    items.value = await ipc('workflow.list')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function importFile(): Promise<void> {
  try {
    const path = await ipc('shell.pickFile', {
      filters: [{ name: 'Workflow', extensions: ['json', 'png'] }]
    })
    if (!path) return
    const rec = await ipc('workflow.import', path)
    message.success(`已导入 ${rec.name}`)
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function launch(row: WorkflowRecord): Promise<void> {
  try {
    await ipc('workflow.launch', row.path)
    message.success('已请求打开工作流')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openPath(path: string): Promise<void> {
  try {
    await ipc('shell.openPath', path)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function doQueue(): Promise<void> {
  if (!queueTarget.value) return
  try {
    const promptId = await ipc('workflow.queue', {
      workflowPath: queueTarget.value.path,
      instanceId: store.activeInstanceId || '',
      seed: seed.value ?? undefined
    })
    message.success(promptId ? `已入队 ${promptId}` : '入队失败')
    showQueue.value = false
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function filtered(): WorkflowRecord[] {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return items.value
  return items.value.filter((w) => w.name.toLowerCase().includes(k))
}

onMounted(() => void refresh())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">工作流库</h1>
        <p class="page-subtitle">JSON/PNG 解析、标签、参数还原、一键排队到 ComfyUI。</p>
      </div>
      <NSpace>
        <NInput v-model:value="keyword" clearable placeholder="搜索工作流" style="width: 200px" />
        <NButton secondary :loading="loading" @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>刷新
        </NButton>
        <NButton type="primary" @click="importFile">导入工作流</NButton>
      </NSpace>
    </div>

    <div class="page-body">
    <NSpin :show="loading">
      <div v-if="filtered().length" class="grid cards">
        <article v-for="wf in filtered()" :key="wf.id" class="card card-interactive wf">
          <div class="wf-top">
            <div class="wf-icon"><NIcon :size="22" :component="DocumentTextOutline" /></div>
            <div>
              <div class="wf-name">{{ wf.name }}</div>
              <div class="wf-meta">{{ wf.nodeCount }} nodes · {{ wf.format }} · v{{ wf.version }}</div>
            </div>
          </div>
          <div class="wf-path mono">{{ wf.path }}</div>
          <div class="wf-tags">
            <NTag v-for="t in wf.tags" :key="t" size="tiny" round>{{ t }}</NTag>
            <NTag v-if="wf.seed != null" size="tiny" round type="info">seed {{ wf.seed }}</NTag>
            <NTag v-if="wf.missingNodes.length" size="tiny" round type="warning">
              缺 {{ wf.missingNodes.length }} 节点
            </NTag>
          </div>
          <div class="wf-actions">
            <NButton size="small" type="primary" secondary @click="launch(wf)">
              <template #icon><NIcon :component="PlayOutline" /></template>打开
            </NButton>
            <NButton size="small" secondary @click="queueTarget = wf; showQueue = true">
              <template #icon><NIcon :component="SendOutline" /></template>排队
            </NButton>
            <NButton size="small" secondary @click="openPath(wf.path)">
              <template #icon><NIcon :component="OpenOutline" /></template>
            </NButton>
          </div>
        </article>
      </div>
      <NEmpty v-else description="暂无工作流，可导入 JSON/PNG" class="empty" />
    </NSpin>
    </div>

    <NModal v-model:show="showQueue" preset="card" title="排队执行工作流" style="width: 480px; border-radius: 20px">
      <NSpace vertical>
        <div>{{ queueTarget?.name }}</div>
        <NSelect
          :options="store.instances.map((i) => ({ label: i.name, value: i.id }))"
          :value="store.activeInstanceId"
          placeholder="选择实例"
          @update:value="(v: string) => (store.activeInstanceId = v)"
        />
        <NInputNumber v-model:value="seed" placeholder="Seed（可选）" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showQueue = false">取消</NButton>
          <NButton type="primary" @click="doQueue">入队</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.cards { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.wf { padding: 18px; }
.wf-top { display: flex; gap: 12px; align-items: center; }
.wf-icon { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: $gradient-soft; color: $color-primary; }
.wf-name { font-size: 15px; font-weight: 720; }
.wf-meta { font-size: 12px; color: $color-text-muted; margin-top: 2px; }
.wf-path { margin: 12px 0; font-size: 11.5px; color: $color-text-muted; word-break: break-all; }
.wf-tags { display: flex; flex-wrap: wrap; gap: 6px; min-height: 24px; }
.wf-actions { display: flex; gap: 8px; margin-top: 14px; }
.empty { padding: 64px 0; }
</style>
