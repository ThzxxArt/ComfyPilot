<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  CloudDownloadOutline,
  SearchOutline,
  RefreshOutline,
  DuplicateOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NDataTable,
  NIcon,
  NInput,
  NSpace,
  NSpin,
  NTag,
  NModal,
  NEmpty,
  useMessage,
  useDialog,
  NTabs,
  NTabPane,
  NDynamicTags,
  type DataTableColumns
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onDownloadProgress, onModelScanProgress } from '@/composables/useIpc'
import { formatBytes } from '@/utils/format'
import ListSkeleton from '@/components/ListSkeleton.vue'
import { MODEL_CATEGORY_LABELS, STARTER_MODELS } from '@shared/constants'
import type {
  DownloadTask,
  ModelRecord,
  StorageStats,
  DuplicateGroup,
  StarterModel,
  ModelCategory
} from '@shared/types'

const { t, te } = useI18n()
const store = useAppStore()
const message = useMessage()
const dialog = useDialog()
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

// Single-file rename (model.rename)
const showRenameOne = ref(false)
const renameOneTarget = ref<ModelRecord | null>(null)
const renameOneValue = ref('')

// Detail panel (tags + civitai)
const showDetail = ref(false)
const detailTarget = ref<ModelRecord | null>(null)
const tagsValue = ref<string[]>([])
const civitaiLoading = ref(false)
const civitaiResult = ref<Record<string, unknown> | null>(null)

// extra_model_paths.yaml parse
const extraPathsFile = ref('')
const extraPathsResult = ref<string[]>([])
const extraPathsLoading = ref(false)

/** Real category set — mirrors ComfyUI's registered model folders (folder_paths.py). */
const CATEGORY_KEYS: ModelCategory[] = [
  'checkpoints',
  'diffusion_models',
  'loras',
  'vae',
  'text_encoders',
  'clip_vision',
  'controlnet',
  'upscale_models',
  'embeddings',
  'style_models',
  'diffusers',
  'vae_approx',
  'gligen',
  'latent_upscale_models',
  'photomaker',
  'classifiers',
  'model_patches',
  'audio_encoders',
  'hypernetworks',
  'background_removal',
  'frame_interpolation',
  'geometry_estimation',
  'optical_flow',
  'detection',
  'other'
]

/** i18n `models.cat.<key>` with MODEL_CATEGORY_LABELS fallback. */
function catLabel(key: string): string {
  const i18nKey = `models.cat.${key}`
  return te(i18nKey) ? t(i18nKey) : MODEL_CATEGORY_LABELS[key] || key
}

/** 'total' is a summary, not a category card. */
const storageTotal = computed(() => storage.value.find((s) => s.category === 'total') || null)
const storageByCategory = computed(() => storage.value.filter((s) => s.category !== 'total'))

/** Localized download status chip. */
function dlStatusLabel(status: DownloadTask['status']): string {
  const key = `models.dlStatus.${status}`
  return te(key) ? t(key) : String(status)
}

const finishedStatuses = new Set(['done', 'error', 'cancelled'])
const hasFinishedDownloads = computed(() =>
  downloads.value.some((d) => finishedStatuses.has(d.status))
)

async function downloadStarter(s: StarterModel): Promise<void> {
  starterBusy.value = s.id
  try {
    await ipc('installer.installStarter', {
      id: s.id,
      instanceId: store.activeInstanceId || undefined
    })
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

/** Distinguish "no data at all" from "filters matched nothing". */
const hasFilter = computed(() => keyword.value.trim().length > 0 || tab.value !== 'all')

function clearFilters(): void {
  keyword.value = ''
  tab.value = 'all'
}

function hTag(text: string, type: 'info' | 'success' | 'warning' = 'info') {
  return h(NTag, { size: 'tiny', round: true, bordered: false, type }, { default: () => text })
}

async function doDelete(id: string, deleteFile: boolean): Promise<void> {
  try {
    await ipc('model.delete', id, deleteFile)
    await refresh()
    message.success(t('models.deleted'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** Two explicit outcomes: record-only vs delete file too. Dismiss = cancel. */
function confirmDelete(row: ModelRecord): void {
  dialog.warning({
    title: t('models.deleteAction'),
    content: t('models.deleteConfirm'),
    positiveText: t('models.deleteFileToo'),
    negativeText: t('models.removeRecordOnly'),
    onPositiveClick: () => doDelete(row.id, true),
    onNegativeClick: () => doDelete(row.id, false)
  })
}

function openRenameOne(row: ModelRecord): void {
  renameOneTarget.value = row
  renameOneValue.value = row.name
  showRenameOne.value = true
}

async function doRenameOne(): Promise<void> {
  if (!renameOneTarget.value) return
  const newName = renameOneValue.value.trim()
  if (!newName) return
  try {
    await ipc('model.rename', renameOneTarget.value.id, newName)
    showRenameOne.value = false
    message.success(t('models.renameOneDone'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function doSymlink(row: ModelRecord): Promise<void> {
  try {
    const dir = await ipc('shell.pickDirectory')
    if (dir) {
      await ipc('model.symlink', row.id, dir)
      await refresh()
      message.success(t('models.symlinkDone'))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function openDetail(row: ModelRecord): void {
  detailTarget.value = row
  tagsValue.value = [...(row.tags || [])]
  civitaiResult.value = null
  showDetail.value = true
}

async function saveTags(): Promise<void> {
  if (!detailTarget.value) return
  try {
    await ipc('model.tag', detailTarget.value.id, tagsValue.value)
    detailTarget.value = { ...detailTarget.value, tags: [...tagsValue.value] }
    message.success(t('models.tagsSaved'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

const civitaiJson = computed(() =>
  civitaiResult.value ? JSON.stringify(civitaiResult.value, null, 2) : ''
)

async function fetchCivitai(): Promise<void> {
  if (!detailTarget.value) return
  civitaiLoading.value = true
  try {
    civitaiResult.value = await ipc('model.fetchCivitaiMeta', detailTarget.value.id)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    civitaiLoading.value = false
  }
}

function defaultExtraPathsFile(): string {
  const path = store.activeInstance?.path
  return path ? `${path.replace(/[\\/]+$/, '')}/extra_model_paths.yaml` : ''
}

async function pickExtraFile(): Promise<void> {
  try {
    const p = await ipc('shell.pickFile', {
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }]
    })
    if (p) {
      extraPathsFile.value = p
      await parseExtraPaths()
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function parseExtraPaths(): Promise<void> {
  const file = extraPathsFile.value.trim()
  if (!file) return
  extraPathsLoading.value = true
  try {
    extraPathsResult.value = await ipc('model.parseExtraPaths', file)
    message.success(t('models.parseExtraCount', { n: extraPathsResult.value.length }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    extraPathsLoading.value = false
  }
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
        h(
          'span',
          {
            style: 'overflow:hidden;text-overflow:ellipsis;cursor:pointer',
            title: t('models.detailAction'),
            onClick: () => openDetail(row)
          },
          row.name
        )
      ])
  },
  {
    title: t('models.colCategory'),
    key: 'category',
    width: 130,
    render: (row) => hTag(catLabel(row.category))
  },
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
    render: (row) =>
      row.duplicateOf
        ? hTag(t('models.tagDuplicate'), 'warning')
        : hTag(t('models.tagUnique'), 'success')
  },
  { title: t('models.colPath'), key: 'path', ellipsis: { tooltip: true }, className: 'mono' },
  {
    title: t('models.colActions'),
    key: 'actions',
    width: 320,
    render: (row) =>
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [
        h(
          NButton,
          {
            size: 'tiny',
            secondary: true,
            onClick: () => openDetail(row)
          },
          { default: () => t('models.detailAction') }
        ),
        h(
          NButton,
          {
            size: 'tiny',
            secondary: true,
            onClick: () => openRenameOne(row)
          },
          { default: () => t('models.renameOneAction') }
        ),
        h(
          NButton,
          {
            size: 'tiny',
            secondary: true,
            onClick: () => doSymlink(row)
          },
          { default: () => t('models.symlinkAction') }
        ),
        h(
          NButton,
          {
            size: 'tiny',
            type: 'error',
            secondary: true,
            onClick: () => confirmDelete(row)
          },
          { default: () => t('models.deleteAction') }
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

/** Scan roots: settings roots win; otherwise the ACTIVE instance's models/ dir. */
function currentScanRoots(): string[] {
  if (store.settings?.modelScanRoots?.length) return store.settings.modelScanRoots
  const path = store.activeInstance?.path
  return path ? [`${path.replace(/[\\/]+$/, '')}/models`] : []
}

async function scan(hash = false): Promise<void> {
  scanning.value = true
  try {
    const roots = currentScanRoots()
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

// Active instance changed → drop stale list and re-scan against the new roots.
watch(
  () => store.instanceSwitchTick,
  () => {
    void refresh()
    if (!scanning.value) void scan(false)
    extraPathsFile.value = defaultExtraPathsFile()
  }
)

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

/** Applies to ALL filtered rows (no 50-row cap). dryRun keeps the preview. */
async function batchRename(dryRun = true): Promise<void> {
  try {
    const ids = filtered.value.map((m) => m.id)
    renameResult.value = await ipc('model.batchRename', {
      ids,
      pattern: renamePattern.value,
      dryRun
    })
    if (!dryRun) {
      showRename.value = false
      await refresh()
      message.success(t('models.renameDoneCount', { n: renameResult.value.length }))
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

async function cancelDl(id: string): Promise<void> {
  try {
    await ipc('model.cancelDownload', id)
    downloads.value = await ipc('model.downloads')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function clearFinishedDl(): Promise<void> {
  try {
    await ipc('model.clearFinishedDownloads')
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
  extraPathsFile.value = defaultExtraPathsFile()
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
        <NInput
          v-model:value="keyword"
          clearable
          :placeholder="$t('models.searchPlaceholder')"
          style="width: 220px"
        >
          <template #prefix><NIcon :component="SearchOutline" /></template>
        </NInput>
        <NButton secondary :loading="scanning" @click="scan(false)">
          <template #icon><NIcon :component="RefreshOutline" /></template>{{ $t('models.scan') }}
        </NButton>
        <NButton secondary :loading="scanning" @click="scan(true)">
          <template #icon><NIcon :component="DuplicateOutline" /></template
          >{{ $t('models.scanHash') }}
        </NButton>
        <NButton secondary @click="ensureThumbs">{{ $t('models.genThumbs') }}</NButton>
        <NButton secondary @click="showRename = true">{{ $t('models.batchRename') }}</NButton>
        <NButton type="primary" @click="showDownload = true">
          <template #icon><NIcon :component="CloudDownloadOutline" /></template
          >{{ $t('models.download') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
      <div v-if="scanProgress" class="scan-banner card">{{ scanProgress }}</div>

      <div v-if="storageTotal" class="stat-summary card">
        <div class="stat-mini-val">{{ storageTotal.count }}</div>
        <div class="stat-mini-label">{{ $t('models.storageTotal') }}</div>
        <div class="stat-mini-sub">{{ formatBytes(storageTotal.bytes) }}</div>
      </div>

      <div v-if="storageByCategory.length" class="stats">
        <div v-for="s in storageByCategory" :key="s.category" class="stat-mini card">
          <div class="stat-mini-val">{{ s.count }}</div>
          <div class="stat-mini-label" :title="catLabel(s.category)">
            {{ catLabel(s.category) }}
          </div>
          <div class="stat-mini-sub">{{ formatBytes(s.bytes) }}</div>
        </div>
      </div>

      <div v-if="downloads.length" class="dl-banner card">
        <div class="dl-head">
          <div class="panel-title">{{ $t('models.downloadsTitle') }}</div>
          <NButton v-if="hasFinishedDownloads" size="tiny" secondary @click="clearFinishedDl">
            {{ $t('models.clearFinished') }}
          </NButton>
        </div>
        <div v-for="d in downloads" :key="d.id" class="dl-row">
          <span class="dl-name" :title="d.fileName">{{ d.fileName }}</span>
          <span
            class="chip"
            :class="
              d.status === 'done'
                ? 'chip-success'
                : d.status === 'error'
                  ? 'chip-danger'
                  : 'chip-warning'
            "
            >{{ dlStatusLabel(d.status) }}</span
          >
          <span class="mono"
            >{{ formatBytes(d.receivedBytes) }} / {{ formatBytes(d.totalBytes) }}</span
          >
          <span v-if="d.speedBps" class="mono">{{ formatBytes(d.speedBps) }}/s</span>
          <span v-if="d.error" class="dl-error">{{ d.error }}</span>
          <NButton
            v-if="d.status === 'running' || d.status === 'queued' || d.status === 'paused'"
            size="tiny"
            secondary
            @click="cancelDl(d.id)"
          >
            {{ $t('models.cancel') }}
          </NButton>
          <NButton v-if="d.status === 'running'" size="tiny" secondary @click="pauseDl(d.id)">{{
            $t('models.pause')
          }}</NButton>
          <NButton v-if="d.status === 'paused'" size="tiny" secondary @click="resumeDl(d.id)">{{
            $t('models.resume')
          }}</NButton>
        </div>
      </div>

      <div class="card table-card">
        <NTabs v-model:value="tab" type="segment" class="tabs">
          <NTabPane name="all" :tab="$t('models.tabAll')" />
          <NTabPane v-for="c in CATEGORY_KEYS" :key="c" :name="c" :tab="catLabel(c)" />
        </NTabs>
        <NSpin :show="loading && filtered.length > 0">
          <ListSkeleton v-if="loading && !filtered.length" :rows="6" />
          <NDataTable
            v-else-if="filtered.length"
            :columns="columns"
            :data="filtered"
            :row-key="(row) => row.id"
            size="small"
            :bordered="false"
            max-height="480"
          />
          <NEmpty
            v-else
            :description="hasFilter ? $t('common.noMatch') : $t('models.empty')"
            class="empty-state"
          >
            <template #extra>
              <NButton v-if="hasFilter" secondary @click="clearFilters">{{
                $t('common.clearFilters')
              }}</NButton>
              <NButton v-else type="primary" :loading="scanning" @click="scan(false)">{{
                $t('models.scan')
              }}</NButton>
            </template>
          </NEmpty>
        </NSpin>
      </div>

      <div class="card scan-settings-card">
        <div class="dup-head">
          <div>
            <div class="panel-title">{{ $t('models.parseExtraTitle') }}</div>
            <div class="panel-sub">{{ $t('models.parseExtraFileLabel') }}</div>
          </div>
          <NSpace>
            <NButton secondary @click="pickExtraFile">{{ $t('models.parseExtraBrowse') }}</NButton>
            <NButton
              type="primary"
              :loading="extraPathsLoading"
              :disabled="!extraPathsFile.trim()"
              @click="parseExtraPaths"
            >
              {{ $t('models.parseExtraRun') }}
            </NButton>
          </NSpace>
        </div>
        <NInput
          v-model:value="extraPathsFile"
          :placeholder="$t('models.parseExtraFilePlaceholder')"
          class="mono"
        />
        <div v-if="extraPathsResult.length" class="extra-paths">
          <div v-for="p in extraPathsResult" :key="p" class="mono extra-path">{{ p }}</div>
        </div>
        <div v-else class="panel-sub">{{ $t('models.parseExtraEmpty') }}</div>
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
    </div>

    <NModal
      v-model:show="showRename"
      preset="card"
      :title="$t('models.renameTitle')"
      style="width: 560px; border-radius: 20px"
    >
      <NSpace vertical>
        <NInput
          v-model:value="renamePattern"
          :placeholder="
            $t('models.renamePatternPlaceholder', { example: '{category}_{index}_{name}' })
          "
        />
        <div class="meta">
          {{ $t('models.renamePatternMeta', { list: '{name} {category} {index} {arch}' }) }}
        </div>
        <div class="meta">{{ $t('models.renameTargetCount', { n: filtered.length }) }}</div>
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
          <NButton type="primary" @click="batchRename(false)">{{
            $t('models.renameExec')
          }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal
      v-model:show="showDownload"
      preset="card"
      :title="$t('models.downloadTitle')"
      style="width: 560px; border-radius: 20px"
    >
      <NSpace vertical>
        <NInput v-model:value="downloadUrl" :placeholder="$t('models.downloadUrlPlaceholder')" />
        <div class="meta">{{ $t('models.starterHint') }}</div>
        <div class="starter-list">
          <div v-for="s in starterModels" :key="s.id" class="starter-row">
            <div class="starter-info">
              <div class="starter-name">
                {{ s.name }}
                <NTag v-if="s.recommended" size="tiny" type="primary" round>{{
                  $t('models.recommended')
                }}</NTag>
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

    <NModal
      v-model:show="showRenameOne"
      preset="card"
      :title="$t('models.renameOneTitle')"
      style="width: 480px; border-radius: 20px"
    >
      <NInput
        v-model:value="renameOneValue"
        :placeholder="$t('models.renameOnePlaceholder')"
        @keyup.enter="doRenameOne"
      />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRenameOne = false">{{ $t('models.cancel') }}</NButton>
          <NButton type="primary" :disabled="!renameOneValue.trim()" @click="doRenameOne">
            {{ $t('models.renameExec') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal
      v-model:show="showDetail"
      preset="card"
      :title="$t('models.detailTitle')"
      style="width: 640px; border-radius: 20px"
    >
      <div v-if="detailTarget" class="detail-body">
        <div class="detail-grid">
          <div class="detail-label">{{ $t('models.colName') }}</div>
          <div class="detail-val">{{ detailTarget.name }}</div>
          <div class="detail-label">{{ $t('models.colCategory') }}</div>
          <div class="detail-val">{{ catLabel(detailTarget.category) }}</div>
          <div class="detail-label">{{ $t('models.colArchitecture') }}</div>
          <div class="detail-val">{{ detailTarget.architecture || '—' }}</div>
          <div class="detail-label">{{ $t('models.colSize') }}</div>
          <div class="detail-val">{{ formatBytes(detailTarget.size) }}</div>
          <div class="detail-label">{{ $t('models.colPath') }}</div>
          <div class="detail-val mono">{{ detailTarget.path }}</div>
        </div>

        <div class="detail-section">
          <div class="panel-title">{{ $t('models.tagsTitle') }}</div>
          <NDynamicTags v-model:value="tagsValue" />
          <NButton type="primary" size="small" @click="saveTags">{{
            $t('models.tagsSave')
          }}</NButton>
        </div>

        <div class="detail-section">
          <div class="panel-title">{{ $t('models.civitaiTitle') }}</div>
          <NButton secondary :loading="civitaiLoading" @click="fetchCivitai">
            {{ $t('models.civitaiFetch') }}
          </NButton>
          <pre v-if="civitaiJson" class="civitai-json">{{ civitaiJson }}</pre>
          <div v-else class="panel-sub">{{ $t('models.civitaiEmpty') }}</div>
        </div>
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showDetail = false">{{ $t('models.cancel') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.stat-summary {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 14px 18px;
  margin-bottom: 12px;
}
.stat-mini {
  padding: 12px 14px;
}
.stat-mini-val {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat-summary .stat-mini-val {
  font-size: 28px;
}
.stat-mini-label {
  font-size: 11px;
  color: $color-text-muted-ink;
  margin-top: 2px;
}
.stat-summary .stat-mini-label {
  margin-top: 0;
  font-size: 13px;
}
.stat-mini-sub {
  font-size: 11px;
  color: $color-text-secondary;
}
.stat-summary .stat-mini-sub {
  font-size: 13px;
  margin-left: auto;
}
.table-card {
  padding: 4px 8px 12px;
  margin-bottom: 14px;
}
.tabs {
  padding: 4px 8px 0;
}
.scan-banner,
.dl-banner {
  margin-bottom: 12px;
  padding: 12px 16px;
  font-size: 13px;
  color: $color-text-secondary;
}
.dl-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.dl-row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 6px 0;
  flex-wrap: wrap;
}
.dl-name {
  font-weight: 600;
  color: $color-text;
  min-width: 0;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-error {
  color: $color-danger;
  font-size: 12px;
  word-break: break-all;
}
.empty-state {
  padding: 64px 0;
}
.dup-card {
  padding: 18px;
}
.dup-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.panel-title {
  font-size: 15px;
  font-weight: 700;
}
.panel-sub {
  font-size: 12px;
  color: $color-text-muted-ink;
  margin-top: 2px;
}
.dup-group {
  padding: 10px 0;
  border-top: 1px solid $color-border;
}
.dup-hash {
  color: $color-primary;
  font-size: 12px;
}
.dup-file {
  font-size: 11.5px;
  color: $color-text-muted-ink;
  margin-top: 4px;
  word-break: break-all;
}
.rename-preview {
  max-height: 220px;
  overflow: auto;
  background: $color-surface-2;
  border-radius: 10px;
  padding: 10px;
  font-size: 11.5px;
}
.meta {
  font-size: 12px;
  color: $color-text-muted-ink;
}
.pass-ink {
  color: $color-success;
}
.fail-ink {
  color: $color-danger;
}
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
.starter-info {
  flex: 1;
  min-width: 0;
}
.starter-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
}
.starter-desc {
  font-size: 12px;
  color: $color-text-muted-ink;
  margin-top: 4px;
}
.scan-settings-card {
  padding: 18px;
  margin-bottom: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.extra-paths {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
  background: $color-surface-2;
  border-radius: 10px;
  padding: 10px;
}
.extra-path {
  font-size: 11.5px;
  color: $color-text-secondary;
  word-break: break-all;
}
.detail-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 8px 12px;
  font-size: 13px;
}
.detail-label {
  color: $color-text-muted-ink;
  font-size: 12px;
}
.detail-val {
  color: $color-text;
  word-break: break-all;
  min-width: 0;
}
.detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.civitai-json {
  width: 100%;
  max-height: 240px;
  overflow: auto;
  margin: 0;
  padding: 10px;
  background: $color-surface-2;
  border-radius: 10px;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
