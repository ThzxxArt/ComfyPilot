<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { AddOutline, TrashOutline, RefreshOutline, DownloadOutline } from '@vicons/ionicons5'
import {
  NButton, NIcon, NInput, NSpace, NSpin, NEmpty, useMessage, NModal, NPopconfirm, NList, NListItem
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import type { BackupManifest } from '@shared/types'

const message = useMessage()
const loading = ref(false)
const items = ref<BackupManifest[]>([])
const showCreate = ref(false)
const name = ref('')
const notes = ref('')

function formatBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${u[i]}`
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    items.value = await ipc('backup.list')
  } finally {
    loading.value = false
  }
}

async function create(): Promise<void> {
  try {
    const b = await ipc('backup.create', { name: name.value || `backup-${Date.now()}`, notes: notes.value })
    showCreate.value = false
    name.value = ''
    notes.value = ''
    message.success(`已创建备份 ${b.name}`)
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function restore(id: string): Promise<void> {
  try {
    await ipc('backup.restore', id)
    message.success('备份已恢复（配置/实例/节点清单/模型清单/工作流/远程）')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openFolder(id: string): Promise<void> {
  try {
    await ipc('backup.openFolder', id)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeBackup(id: string): Promise<void> {
  try {
    await ipc('backup.delete', id)
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(() => void refresh())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">备份与恢复</h1>
        <p class="page-subtitle">备份配置、实例、节点清单与模型清单（不含大模型本体）。</p>
      </div>
      <NSpace>
        <NButton secondary @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>刷新
        </NButton>
        <NButton type="primary" @click="showCreate = true">
          <template #icon><NIcon :component="AddOutline" /></template>创建备份
        </NButton>
      </NSpace>
    </div>

    <NSpin :show="loading">
      <NList v-if="items.length" bordered>
        <NListItem v-for="b in items" :key="b.id">
          <div class="row">
            <div>
              <div class="name">{{ b.name }}</div>
              <div class="meta">{{ new Date(b.createdAt).toLocaleString() }} · {{ formatBytes(b.size) }}</div>
              <div class="meta mono">{{ b.path }}</div>
            </div>
            <NSpace>
              <NButton size="small" type="primary" secondary @click="restore(b.id)">
                <template #icon><NIcon :component="DownloadOutline" /></template>恢复
              </NButton>
              <NButton size="small" secondary @click="openFolder(b.id)">打开目录</NButton>
              <NPopconfirm @positive-click="removeBackup(b.id)">
                <template #trigger>
                  <NButton size="small" type="error" secondary>
                    <template #icon><NIcon :component="TrashOutline" /></template>
                  </NButton>
                </template>
                删除备份？
              </NPopconfirm>
            </NSpace>
          </div>
        </NListItem>
      </NList>
      <NEmpty v-else description="暂无备份" class="empty" />
    </NSpin>

    <NModal v-model:show="showCreate" preset="card" title="创建备份" style="width: 480px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="name" placeholder="备份名称" />
        <NInput v-model:value="notes" type="textarea" :rows="3" placeholder="备注（可选）" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" @click="create">创建</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.row { display: flex; justify-content: space-between; align-items: center; gap: 16px; width: 100%; }
.name { font-size: 15px; font-weight: 720; }
.meta { font-size: 12px; color: $color-text-muted; margin-top: 4px; word-break: break-all; }
.empty { padding: 64px 0; }
</style>
