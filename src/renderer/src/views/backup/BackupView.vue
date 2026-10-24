<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AddOutline, TrashOutline, RefreshOutline, DownloadOutline } from '@vicons/ionicons5'
import {
  NButton,
  NIcon,
  NInput,
  NSpace,
  NSpin,
  NEmpty,
  useMessage,
  NModal,
  NPopconfirm,
  NList,
  NListItem,
  NCheckbox,
  NCheckboxGroup,
  NAlert
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import { formatBytes } from '@/utils/format'
import ListSkeleton from '@/components/ListSkeleton.vue'
import type { BackupManifest, BackupRestorePreview, BackupRestoreSection } from '@shared/types'

const { t } = useI18n()
const message = useMessage()
const loading = ref(false)
const items = ref<BackupManifest[]>([])
const loadError = ref('')
const showCreate = ref(false)
const name = ref('')
const notes = ref('')

// 0.1.18 (WP7): restore is destructive, so it is previewed first. The modal
// shows exactly what will change, which paths were remapped, and lets the user
// apply only the sections they want.
const preview = ref<BackupRestorePreview | null>(null)
const previewId = ref('')
const selectedSections = ref<BackupRestoreSection[]>([])
const previewLoading = ref(false)
const restoring = ref(false)
const ALL_SECTIONS: BackupRestoreSection[] = [
  'settings',
  'instances',
  'nodePacks',
  'models',
  'workflows',
  'remotes',
  'snapshots'
]

const visibleSections = computed(() =>
  ALL_SECTIONS.filter((s) => (preview.value?.counts[s] || s === 'settings') ?? false)
)

function sectionLabel(section: BackupRestoreSection): string {
  return t(`backup.section.${section}`)
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    items.value = await ipc('backup.list')
    loadError.value = ''
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
    message.error(loadError.value)
  } finally {
    loading.value = false
  }
}

async function create(): Promise<void> {
  try {
    const b = await ipc('backup.create', {
      name: name.value || `backup-${Date.now()}`,
      notes: notes.value
    })
    showCreate.value = false
    name.value = ''
    notes.value = ''
    message.success(t('backup.created', { name: b.name }))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openRestore(id: string): Promise<void> {
  previewId.value = id
  previewLoading.value = true
  try {
    const p = await ipc('backup.preview', id)
    // A fast second click (another backup) used to apply A's preview to B —
    // and restore B with A's section selection.
    if (previewId.value !== id) return
    preview.value = p
    selectedSections.value = ALL_SECTIONS.filter((s) => s === 'settings' || (p.counts[s] || 0) > 0)
    if (!p.canRestore) {
      message.error(t('backup.previewInvalid'))
    }
  } catch (err) {
    if (previewId.value !== id) return
    preview.value = null
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    if (previewId.value === id) previewLoading.value = false
  }
}

async function applyRestore(): Promise<void> {
  if (!preview.value) return
  restoring.value = true
  try {
    const result = await ipc('backup.restore', previewId.value, {
      sections: selectedSections.value
    })
    if (result.ok) {
      message.success(t('backup.restored', { n: result.restored }))
      if (result.preRestoreId) {
        message.info(t('backup.preRestoreCreated', { id: result.preRestoreId }), {
          duration: 8000
        })
      }
    } else {
      message.warning(
        t('backup.restorePartial', { restored: result.restored, failed: result.failed })
      )
    }
    if (result.warnings.length) {
      message.warning(result.warnings.slice(0, 3).join('; '))
    }
    preview.value = null
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    restoring.value = false
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
      <NSpin :show="loading && items.length > 0">
        <ListSkeleton v-if="loading && !items.length" :rows="5" />
        <NList v-else-if="items.length" bordered>
          <NListItem v-for="b in items" :key="b.id">
            <div class="row">
              <div class="backup-main">
                <div class="name" :title="b.name">{{ b.name }}</div>
                <div class="meta">
                  {{ new Date(b.createdAt).toLocaleString() }} · {{ formatBytes(b.size) }}
                </div>
                <div class="meta mono">{{ b.path }}</div>
              </div>
              <NSpace>
                <NButton size="small" type="primary" secondary @click="openRestore(b.id)">
                  <template #icon><NIcon :component="DownloadOutline" /></template
                  >{{ t('backup.restore') }}
                </NButton>
                <NButton size="small" secondary @click="openFolder(b.id)">{{
                  t('backup.openFolder')
                }}</NButton>
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
        <NEmpty v-else :description="loadError || t('backup.empty')" class="empty">
          <template #extra>
            <NButton v-if="loadError" secondary @click="refresh">{{ t('common.retry') }}</NButton>
          </template>
        </NEmpty>
      </NSpin>
    </div>

    <NModal
      v-model:show="showCreate"
      preset="card"
      :title="t('backup.create')"
      style="width: 480px; border-radius: 20px"
    >
      <NSpace vertical>
        <NInput v-model:value="name" :placeholder="t('backup.namePlaceholder')" />
        <NInput
          v-model:value="notes"
          type="textarea"
          :rows="3"
          :placeholder="t('backup.notesPlaceholder')"
        />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" @click="create">{{ t('backup.createAction') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal
      :show="Boolean(preview) || previewLoading"
      preset="card"
      :title="t('backup.previewTitle')"
      style="width: 620px; border-radius: 20px"
      @update:show="
        (v: boolean) => {
          if (!v) preview = null
        }
      "
    >
      <NSpin :show="previewLoading">
        <div v-if="preview" class="preview">
          <p class="preview-name">{{ preview.name || preview.id }}</p>

          <NAlert v-if="!preview.canRestore" type="error" :bordered="false">
            {{ t('backup.previewInvalid') }}
            <ul class="preview-list">
              <li v-for="p in preview.invalidPaths" :key="p" class="mono">{{ p }}</li>
            </ul>
          </NAlert>

          <div class="preview-block">
            <div class="preview-label">{{ t('backup.previewSections') }}</div>
            <NCheckboxGroup v-model:value="selectedSections">
              <NSpace vertical>
                <NCheckbox
                  v-for="s in visibleSections"
                  :key="s"
                  :value="s"
                  :label="`${sectionLabel(s)} (${preview.counts[s] || 0})`"
                />
              </NSpace>
            </NCheckboxGroup>
          </div>

          <div v-if="preview.settingsChanged.length" class="preview-block">
            <div class="preview-label">{{ t('backup.previewSettings') }}</div>
            <div class="chips">
              <span v-for="k in preview.settingsChanged" :key="k" class="chip">{{ k }}</span>
            </div>
          </div>

          <div v-if="preview.workflowFiles.length" class="preview-block">
            <div class="preview-label">{{ t('backup.previewFiles') }}</div>
            <ul class="preview-list">
              <li v-for="f in preview.workflowFiles" :key="f.id">
                <span class="mono">{{ f.name }}</span>
                <span v-if="f.missing" class="tag tag-warn">{{ t('backup.fileMissing') }}</span>
                <span v-else-if="f.remapped" class="tag">{{ t('backup.fileRemapped') }}</span>
              </li>
            </ul>
          </div>

          <div v-if="preview.warnings.length" class="preview-block">
            <div class="preview-label">{{ t('backup.previewWarnings') }}</div>
            <ul class="preview-list">
              <li v-for="w in preview.warnings" :key="w">{{ w }}</li>
            </ul>
          </div>

          <p class="preview-note">{{ t('backup.previewNote') }}</p>
        </div>
      </NSpin>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="preview = null">{{ t('common.cancel') }}</NButton>
          <NButton
            type="primary"
            :disabled="!preview?.canRestore || !selectedSections.length"
            :loading="restoring"
            @click="applyRestore"
          >
            {{ t('backup.restoreSelected') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  width: 100%;
}
.backup-main {
  flex: 1;
  min-width: 0;
}
.row > .n-space {
  flex-shrink: 0;
}
.name {
  font-size: 15px;
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
  color: $color-text-muted-ink;
  margin-top: 4px;
  word-break: break-all;
}
.empty {
  padding: 64px 0;
}
.preview {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.preview-name {
  margin: 0;
  font-weight: 700;
  font-size: 15px;
}
.preview-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preview-label {
  font-size: 12px;
  font-weight: 700;
  color: $color-text-muted-ink;
}
.preview-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  word-break: break-all;
}
.preview-note {
  margin: 0;
  font-size: 12px;
  color: $color-text-muted-ink;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: $color-bg-soft;
}
.tag {
  margin-left: 8px;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: $color-bg-soft;
}
.tag-warn {
  background: rgba(240, 160, 32, 0.15);
}
</style>
