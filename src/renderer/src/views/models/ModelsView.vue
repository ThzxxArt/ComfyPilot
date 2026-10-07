<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CloudDownloadOutline, SearchOutline, RefreshOutline,
  DuplicateOutline
} from '@vicons/ionicons5'
import {
  NButton, NDataTable, NIcon, NInput, NSpace, NSpin, NTag, NPopconfirm, NModal,
  useMessage, NTabs, NTabPane, NGrid, NGi, type DataTableColumns
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onDownloadProgress, onModelScanProgress } from '@/composables/useIpc'
import { formatBytes } from '@/utils/format'
import { MODEL_CATEGORY_LABELS, STARTER_MODELS } from '@shared/constants'
import type { DownloadTask, ModelRecord, StorageStats, DuplicateGroup, StarterModel } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const loading = ref(false)
const scanning = ref(false)
const scanProgress = ref('')
const models = ref<ModelRecord[]>([])
const keyword = ref('')
const showDownload = ref(false)
const showRename = ref(false)
const renamePattern = ref('{name}')
const renameResult = ref<Array<{ from: string; to: string; ok: boolean; error?: string }>>([])
const downloadUrl = ref('')
const downloads = ref<DownloadTask[]>([])
const storage = ref<StorageStats[]>([])
const duplicates = ref<DuplicateGroup[]>([])
const tab = ref('all')
const starterModels = ref<StarterModel[]>(STARTER_MODELS)
const starterBusy = ref<string | null>(null)

async function downloadStarter(s: StarterModel): Promise<void> {
  starterBusy.value = s.id
  try {
    await ipc('installer.installStarter', { id: s.id, instanceId: store.activeInstanceId || undefined })
    message.success(t('models.downloadStartedNamed', { name: s.name }))
    showDownload.value = false
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    starterBusy.value = null
  }
}

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  let list = models.value
  if (tab.value !== 'all') list = list.filter((m) => m.category === tab.value)
  if (!k) return list
  return list.filter(
    (m) =>
      m.name.toLowerCase().includes(k) ||
      m.category.toLowerCase().includes(k) ||
      m.fileName.toLowerCase().includes(k) ||
      (m.architecture || '').toLowerCase().includes(k) ||
      m.tags.some((t) => t.toLowerCase().includes(k))
  )
})

function hTag(text: string, type: 'info' | 'success' | 'warning' = 'info') {
  return h(NTag, { size: 'tiny', round: true, bordered: false, type }, { default: () => text })
}

const columns = computed<DataTableColumns<ModelRecord>>(() => [
  {
    title: t('models.colName'),
    key: 'name',
    ellipsis: { tooltip: true },
    render: (row) =>
      h('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0' }, [
        row.thumbnail
          ? h('img', {
              src: row.thumbnail,
              alt: '',
              style: 'width:36px;height:36px;border-radius:8px;object-fit:cover;flex:none'
            })
          : h('span', {
              style:
                'width:36px;height:36px;border-radius:8px;background:rgba(79,110,247,0.12);flex:none'
            }),
        h('span', { style: 'overflow:hidden;text-overflow:ellipsis' }, row.name)
      ])
  },
  { title: t('models.colCategory'), key: 'category', width: 130, render: (row) => hTag(MODEL_CATEGORY_LABELS[row.category] || row.category) },
  {
    title: t('models.colArchitecture'),
    key: 'architecture',
    width: 90,
    render: (row) => (row.architecture ? hTag(row.architecture, 'success') : hTag('—', 'info'))
  },
  { title: t('models.colSize'), key: 'size', width: 100, render: (row) => formatBytes(row.size) },
  {
    title: t('models.colDuplicate'),
    key: 'duplicateOf',
    width: 80,
    render: (row) => (row.duplicateOf ? hTag(t('models.tagDuplicate'), 'warning') : hTag(t('models.tagUnique'), 'success'))
  },
  { title: t('models.colPath'), key: 'path', ellipsis: { tooltip: true }, className: 'mono' },
  {
    title: t('models.colActions'),
    key: 'actions',
    width: 180,
    render: (row) =>
      h('div', { style: 'display:flex;gap:6px' }, [
        h(
          NPopconfirm,
          {
            onPositiveClick: async () => {
              try {
                await ipc('model.delete', row.id, true)
                await refresh()
                message.success(t('models.deleted'))
              } catch (err) {
                message.error(err instanceof Error ? err.message : String(err))
              }
            }
          },
          {
            trigger: () =>
              h(NButton, { size: 'tiny', type: 'error', secondary: true }, { default: () => t('models.deleteAction') }),
            default: () => t('models.deleteConfirm')
          }
        ),
        h(
          NButton,
          {
            size: 'tiny',
            secondary: true,
            onClick: async () => {
              try {
                const dir = await ipc('shell.pickDirectory')
                if (dir) {
                  await ipc('model.move', row.id, dir)
                  await refresh()
                  message.success(t('models.moved'))
                }
              } catch (err) {
                message.error(err instanceof Error ? err.message : String(err))
              }
            }
          },
          { default: () => t('models.moveAction') }
        )
      ])
  }
])

async function refresh(): Promise<void> {
  loading.value = true
  try {
    models.value = await ipc('model.list')
    storage.value = await ipc('model.storageStats')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function scan(hash = false): Promise<void> {
  scanning.value = true
  try {
    const roots = store.settings?.modelScanRoots?.length
      ? store.settings.modelScanRoots
      : store.instances[0]?.path
        ? [`${store.instances[0].path.replace(/[\\/]+$/, '')}/models`]
        : []
    models.value = await ipc('model.scan', { roots, hash })
    storage.value = await ipc('model.storageStats')
    if (hash) duplicates.value = await ipc('model.findDuplicates')
    message.success(t('models.scanDone', { n: models.value.length }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    scanning.value = false
    scanProgress.value = ''
  }
}

async function findDuplicates(): Promise<void> {
  try {
    duplicates.value = await ipc('model.findDuplicates')
    message.success(t('models.dupGroupsFound', { n: duplicates.value.length }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function ensureThumbs(): Promise<void> {
  try {
    const n = await ipc('model.ensureThumbs')
    message.success(t('models.thumbsDone', { n }))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function batchRename(dryRun = true): Promise<void> {
  try {
    const ids = filtered.value.slice(0, 50).map((m) => m.id)
    renameResult.value = await ipc('model.batchRename', {
      ids,
      pattern: renamePattern.value,
      dryRun
    })
    if (!dryRun) {
      showRename.value = false
      await refresh()
      message.success(t('models.renameDone'))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function pauseDl(id: string): Promise<void> {
  try {
    await ipc('model.pauseDownload', id)
    downloads.value = await ipc('model.downloads')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function resumeDl(id: string): Promise<void> {
  try {
    await ipc('model.resumeDownload', id)
    downloads.value = await ipc('model.downloads')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function startDownload(): Promise<void> {
  if (!downloadUrl.value.trim()) return
  try {
    await ipc('model.download', { url: downloadUrl.value.trim() })
    showDownload.value = false
    downloadUrl.value = ''
    downloads.value = await ipc('model.downloads')
    message.success(t('models.downloadQueued'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

let offScan: (() => void) | null = null
let offDl: (() => void) | null = null

onMounted(async () => {
  await refresh()
  downloads.value = await ipc('model.downloads')
  offScan = onModelScanProgress((p) => {
    const prog = p as { scanned: number; total: number; phase: string }
    scanProgress.value = `${prog.phase} ${prog.scanned}/${prog.total}`
  })
  offDl = onDownloadProgress(() => {
    void ipc('model.downloads').then((list) => (downloads.value = list))
  })
})

onUnmounted(() => {
  offScan?.()
  offDl?.()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('models.title') }}</h1>
        <p class="page-subtitle">{{ $t('models.subtitle') }}</p>
      </div>
      <NSpace>
        <NInput v-model:value="keyword" clearable :placeholder="$t('models.searchPlaceholder')" style="width: 220px">
          <template #prefix><NIcon :component="SearchOutline" /></template>
        </NInput>
        <NButton secondary :loading="scanning" @click="scan(false)">
          <template #icon><NIcon :component="RefreshOutline" /></template>{{ $t('models.scan') }}
        </NButton>
        <NButton secondary :loading="scanning" @click="scan(true)">
          <template #icon><NIcon :component="DuplicateOutline" /></template>{{ $t('models.scanHash') }}
        </NButton>
        <NButton secondary @click="ensureThumbs">{{ $t('models.genThumbs') }}</NButton>
        <NButton secondary @click="showRename = true">{{ $t('models.batchRename') }}</NButton>
        <NButton type="primary" @click="showDownload = true">
          <template #icon><NIcon :component="CloudDownloadOutline" /></template>{{ $t('models.download') }}
        </NButton>
      </NSpace>
    </div>

    <div v-if="scanProgress" class="scan-banner card">{{ scanProgress }}</div>

    <NGrid :cols="5" :x-gap="12" class="stats">
      <NGi v-for="s in storage" :key="s.category">
        <div class="stat-mini card">
          <div class="stat-mini-val">{{ s.count }}</div>
          <div class="stat-mini-label">{{ MODEL_CATEGORY_LABELS[s.category] || s.category }}</div>
          <div class="stat-mini-sub">{{ formatBytes(s.bytes) }}</div>
        </div>
      </NGi>
    </NGrid>

    <div v-if="downloads.length" class="dl-banner card">
      <div v-for="d in downloads" :key="d.id" class="dl-row">
        <span class="dl-name">{{ d.fileName }}</span>
        <span class="chip" :class="d.status === 'done' ? 'chip-success' : d.status === 'error' ? 'chip-danger' : 'chip-warning'">{{ d.status }}</span>
        <span class="mono">{{ formatBytes(d.receivedBytes) }} / {{ formatBytes(d.totalBytes) }}</span>
        <span v-if="d.speedBps" class="mono">{{ formatBytes(d.speedBps) }}/s</span>
        <NButton v-if="d.status === 'running'" size="tiny" secondary @click="pauseDl(d.id)">{{ $t('models.pause') }}</NButton>
        <NButton v-if="d.status === 'paused'" size="tiny" secondary @click="resumeDl(d.id)">{{ $t('models.resume') }}</NButton>
      </div>
    </div>

    <div class="card table-card">
      <NTabs v-model:value="tab" type="segment" class="tabs">
        <NTabPane name="all" :tab="$t('models.tabAll')" />
        <NTabPane name="checkpoints" tab="Checkpoint" />
        <NTabPane name="loras" tab="LoRA" />
        <NTabPane name="diffusion_models" tab="Diffusion" />
        <NTabPane name="vae" tab="VAE" />
        <NTabPane name="controlnet" tab="ControlNet" />
      </NTabs>
      <NSpin :show="loading">
        <NDataTable :columns="columns" :data="filtered" :row-key="(row) => row.id" size="small" :bordered="false" max-height="480" />
      </NSpin>
    </div>

    <div class="card dup-card">
      <div class="dup-head">
        <div>
          <div class="panel-title">{{ $t('models.dupTitle') }}</div>
          <div class="panel-sub">{{ $t('models.dupHint') }}</div>
        </div>
        <NButton secondary @click="findDuplicates">{{ $t('models.analyzeDup') }}</NButton>
      </div>
      <div v-if="duplicates.length">
        <div v-for="g in duplicates" :key="g.hash" class="dup-group">
          <div class="mono dup-hash">{{ g.hash.slice(0, 16) }}…</div>
          <div v-for="f in g.files" :key="f" class="mono dup-file">{{ f }}</div>
        </div>
      </div>
      <div v-else class="panel-sub">{{ $t('models.dupEmpty') }}</div>
    </div>

    <NModal v-model:show="showRename" preset="card" :title="$t('models.renameTitle')" style="width: 560px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="renamePattern" :placeholder="$t('models.renamePatternPlaceholder', { example: '{category}_{index}_{name}' })" />
        <div class="meta">{{ $t('models.renamePatternMeta', { list: '{name} {category} {index} {arch}' }) }}</div>
        <div v-if="renameResult.length" class="rename-preview">
          <div v-for="(r, i) in renameResult" :key="i" class="mono">
            <span :class="r.ok ? 'pass-ink' : 'fail-ink'">{{ r.ok ? 'OK' : 'ERR' }}</span>
            {{ r.from }} → {{ r.to }}<span v-if="r.error"> ({{ r.error }})</span>
          </div>
        </div>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRename = false">{{ $t('models.cancel') }}</NButton>
          <NButton secondary @click="batchRename(true)">{{ $t('models.preview') }}</NButton>
          <NButton type="primary" @click="batchRename(false)">{{ $t('models.renameExec') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal v-model:show="showDownload" preset="card" :title="$t('models.downloadTitle')" style="width: 560px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="downloadUrl" :placeholder="$t('models.downloadUrlPlaceholder')" />
        <div class="meta">{{ $t('models.starterHint') }}</div>
        <div class="starter-list">
          <div v-for="s in starterModels" :key="s.id" class="starter-row">
            <div class="starter-info">
              <div class="starter-name">
                {{ s.name }}
                <NTag v-if="s.recommended" size="tiny" type="primary" round>{{ $t('models.recommended') }}</NTag>
                <NTag size="tiny" round>{{ s.family }}</NTag>
              </div>
              <div class="starter-desc">{{ $t(s.description) }}</div>
            </div>
            <NButton
              size="small"
              type="primary"
              secondary
              :loading="starterBusy === s.id"
              @click="downloadStarter(s)"
            >
              {{ $t('models.downloadStarter') }}
            </NButton>
          </div>
        </div>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showDownload = false">{{ $t('models.cancel') }}</NButton>
          <NButton type="primary" @click="startDownload">{{ $t('models.startDownload') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.stats { margin-bottom: 14px; }
.stat-mini { padding: 12px 14px; }
.stat-mini-val { font-size: 22px; font-weight: 700; }
.stat-mini-label { font-size: 11px; color: $color-text-muted; margin-top: 2px; }
.stat-mini-sub { font-size: 11px; color: $color-text-secondary; }
.table-card { padding: 4px 8px 12px; margin-bottom: 14px; }
.tabs { padding: 4px 8px 0; }
.scan-banner, .dl-banner { margin-bottom: 12px; padding: 12px 16px; font-size: 13px; color: $color-text-secondary; }
.dl-row { display: flex; gap: 12px; align-items: center; padding: 6px 0; }
.dl-name { font-weight: 600; color: $color-text; }
.dup-card { padding: 18px; }
.dup-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.panel-title { font-size: 15px; font-weight: 700; }
.panel-sub { font-size: 12px; color: $color-text-muted; margin-top: 2px; }
.dup-group { padding: 10px 0; border-top: 1px solid $color-border; }
.dup-hash { color: $color-primary; font-size: 12px; }
.dup-file { font-size: 11.5px; color: $color-text-muted; margin-top: 4px; word-break: break-all; }
.rename-preview {
  max-height: 220px;
  overflow: auto;
  background: $color-surface-2;
  border-radius: 10px;
  padding: 10px;
  font-size: 11.5px;
}
.meta { font-size: 12px; color: $color-text-muted; }
.pass-ink { color: $color-success; }
.fail-ink { color: $color-danger; }
.starter-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 240px;
  overflow: auto;
}
.starter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid $color-border;
  border-radius: 12px;
  background: $color-surface-2;
}
.starter-info { flex: 1; min-width: 0; }
.starter-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
}
.starter-desc {
  font-size: 12px;
  color: $color-text-muted;
  margin-top: 4px;
}
</style>
