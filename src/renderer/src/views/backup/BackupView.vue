<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AddOutline, TrashOutline, RefreshOutline, DownloadOutline } from '@vicons/ionicons5'
import {
  NButton, NIcon, NInput, NSpace, NSpin, NEmpty, useMessage, NModal, NPopconfirm, NList, NListItem
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import { formatBytes } from '@/utils/format'
import type { BackupManifest } from '@shared/types'

const { t } = useI18n()
const message = useMessage()
const loading = ref(false)
const items = ref<BackupManifest[]>([])
const showCreate = ref(false)
const name = ref('')
const notes = ref('')

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
    message.success(t('backup.created', { name: b.name }))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function restore(id: string): Promise<void> {
  try {
    await ipc('backup.restore', id)
    message.success(t('backup.restored'))
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
        <h1 class="page-title">{{ t('backup.title') }}</h1>
        <p class="page-subtitle">{{ t('backup.subtitle') }}</p>
      </div>
      <NSpace>
        <NButton secondary @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>{{ t('common.refresh') }}
        </NButton>
        <NButton type="primary" @click="showCreate = true">
          <template #icon><NIcon :component="AddOutline" /></template>{{ t('backup.create') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
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
                <template #icon><NIcon :component="DownloadOutline" /></template>{{ t('backup.restore') }}
              </NButton>
              <NButton size="small" secondary @click="openFolder(b.id)">{{ t('backup.openFolder') }}</NButton>
              <NPopconfirm @positive-click="removeBackup(b.id)">
                <template #trigger>
                  <NButton size="small" type="error" secondary>
                    <template #icon><NIcon :component="TrashOutline" /></template>
                  </NButton>
                </template>
                {{ t('backup.deleteConfirm') }}
              </NPopconfirm>
            </NSpace>
          </div>
        </NListItem>
      </NList>
      <NEmpty v-else :description="t('backup.empty')" class="empty" />
    </NSpin>
    </div>

    <NModal v-model:show="showCreate" preset="card" :title="t('backup.create')" style="width: 480px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="name" :placeholder="t('backup.namePlaceholder')" />
        <NInput v-model:value="notes" type="textarea" :rows="3" :placeholder="t('backup.notesPlaceholder')" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" @click="create">{{ t('backup.createAction') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.row { display: flex; justify-content: space-between; align-items: center; gap: 16px; width: 100%; }
.name { font-size: 15px; font-weight: 700; }
.meta { font-size: 12px; color: $color-text-muted; margin-top: 4px; word-break: break-all; }
.empty { padding: 64px 0; }
</style>
