<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  OpenOutline,
  RefreshOutline,
  ImageOutline,
  VideocamOutline,
  GitBranchOutline,
  HeartOutline,
  Heart,
  FolderOpenOutline,
  ShareSocialOutline,
  DownloadOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  PlayCircleOutline,
  CubeOutline,
  MusicalNotesOutline,
  DocumentOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NIcon,
  NSpace,
  NSpin,
  NEmpty,
  NInput,
  NSelect,
  NModal,
  NTag,
  NGrid,
  NGi,
  NCheckbox,
  NSwitch,
  NText,
  NDatePicker,
  useMessage,
  useDialog,
  NPagination
} from 'naive-ui'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { useAppStore } from '@/stores/app'
import { formatBytes } from '@/utils/format'
import { COLORS } from '@/styles/tokens'
import ListSkeleton from '@/components/ListSkeleton.vue'
import { isWebViewableImage, isRawImage } from '@shared/mediaTypes'
import type { OutputAsset, OutputAssetMatch, WorkflowRecord } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const dialog = useDialog()
const route = useRoute()
const router = useRouter()
const loading = ref(false)
const assets = ref<OutputAsset[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(60)
const root = ref('')
const type = ref('all')
const sort = ref<'createdAt' | 'size' | 'name'>('createdAt')
const order = ref<'asc' | 'desc'>('desc')
const onlyFavorites = ref(false)
const batchFilter = ref('')
const workflowFilter = ref('')
/** createdAt range filter (epoch ms pair). */
const dateRange = ref<[number, number] | null>(null)
const workflows = ref<WorkflowRecord[]>([])
const selected = ref<Set<string>>(new Set())

const typeOptions = computed(() => [
  { label: t('output.typeAll'), value: 'all' },
  { label: t('output.typeImage'), value: 'image' },
  { label: t('output.typeVideo'), value: 'video' },
  { label: t('output.typeAudio'), value: 'audio' },
  { label: t('output.type3d'), value: '3d' }
])

const sortOptions = computed(() => [
  { label: t('output.sortCreatedAt'), value: 'createdAt' },
  { label: t('output.sortSize'), value: 'size' },
  { label: t('output.sortName'), value: 'name' }
])

const workflowOptions = computed(() => [
  { label: t('output.filterWorkflowAll'), value: '' },
  ...workflows.value.map((w) => ({ label: w.name, value: w.id }))
])

function workflowName(id: string): string {
  return workflows.value.find((w) => w.id === id)?.name || id.slice(0, 8)
}

/**
 * All record ids the filter must include for the selected workflow (0.1.11):
 * same NAME (library/instance copies) AND same content fingerprint (renamed
 * copies) — outputs linked to any copy match the filter.
 */
const workflowFilterIds = computed<string[]>(() => {
  if (!workflowFilter.value) return []
  const sel = workflows.value.find((w) => w.id === workflowFilter.value)
  if (!sel) return [workflowFilter.value]
  const ids = new Set<string>([workflowFilter.value])
  for (const w of workflows.value) {
    if (w.name === sel.name) ids.add(w.id)
    if (sel.contentHash && w.contentHash === sel.contentHash) ids.add(w.id)
  }
  return [...ids]
})

const detail = ref<OutputAsset | null>(null)
const showDetail = ref(false)
const pngMeta = ref<Record<string, unknown> | null>(null)
const metaLoading = ref(false)
const lightbox = ref(false)
const lightboxSrc = ref('')
const lightboxAsset = ref<OutputAsset | null>(null)
/** Assets whose thumbnail <img> failed — degrade straight to the icon placeholder. */
const brokenThumbs = ref<Set<string>>(new Set())
/** Videos whose inline <video> failed (e.g. mkv container) — degrade to icon/system player. */
const failedVideos = ref<Set<string>>(new Set())
const lightboxVideoFailed = ref(false)
const lightboxImageFailed = ref(false)
const lightboxAudioFailed = ref(false)
const detailVideoFailed = ref(false)
const refreshing = ref(false)
let reqSeq = 0

/** Thumb src with a one-shot fallback chain: thumbnail → (icon when failed). */
function thumbSrc(a: OutputAsset): string | undefined {
  if (brokenThumbs.value.has(a.id)) return undefined
  return a.thumbnail || undefined
}

function onThumbError(a: OutputAsset): void {
  if (brokenThumbs.value.has(a.id)) return
  const next = new Set(brokenThumbs.value)
  next.add(a.id)
  brokenThumbs.value = next
}

/** Videos we can attempt to render inline (mp4/webm decode in Chromium; mkv degrades). */
function playableVideo(a: OutputAsset): boolean {
  return a.type === 'video' && Boolean(a.mediaUrl) && !failedVideos.value.has(a.id)
}

function onVideoError(a: OutputAsset): void {
  if (failedVideos.value.has(a.id)) return
  const next = new Set(failedVideos.value)
  next.add(a.id)
  failedVideos.value = next
}

/** Audio the protocol can serve — played inline in the lightbox (0.1.14). */
function playableAudio(a: OutputAsset): boolean {
  return a.type === 'audio' && Boolean(a.mediaUrl)
}

/** Fallback icon per type for cards without an inline preview (0.1.14). */
function typeIconOf(a: OutputAsset): typeof ImageOutline {
  if (a.type === 'video') return VideocamOutline
  if (a.type === 'audio') return MusicalNotesOutline
  if (a.type === '3d') return CubeOutline
  if (a.type === 'other') return DocumentOutline
  return ImageOutline
}

/** Distinguish "no data at all" from "filters matched nothing". */
const hasFilter = computed(
  () =>
    type.value !== 'all' ||
    onlyFavorites.value ||
    Boolean(batchFilter.value) ||
    Boolean(workflowFilter.value) ||
    Boolean(dateRange.value)
)

function clearFilters(): void {
  type.value = 'all'
  onlyFavorites.value = false
  batchFilter.value = ''
  workflowFilter.value = ''
  dateRange.value = null
}

async function refresh(): Promise<void> {
  const seq = ++reqSeq
  loading.value = true
  refreshing.value = true
  // Give previously failed thumbs/videos another chance (files may be fixed).
  brokenThumbs.value = new Set()
  failedVideos.value = new Set()
  try {
    const result = await ipc('output.list', {
      root: root.value || undefined,
      type: type.value === 'all' ? undefined : type.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      favorite: onlyFavorites.value ? true : undefined,
      batchJobId: batchFilter.value || undefined,
      // Any-of ids: every duplicate-name record of the selected workflow matches.
      workflowIds: workflowFilter.value ? workflowFilterIds.value : undefined,
      sort: sort.value,
      order: order.value,
      createdFrom: dateRange.value?.[0] ?? undefined,
      createdTo: dateRange.value?.[1] ?? undefined
    })
    // Drop stale responses so a slow old page never overwrites the new one.
    if (seq !== reqSeq) return
    assets.value = result.items
    total.value = result.total
    // prune selections that are no longer visible
    const ids = new Set(result.items.map((a) => a.id))
    for (const id of [...selected.value]) {
      if (!ids.has(id)) selected.value.delete(id)
    }
  } catch (err) {
    if (seq === reqSeq) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  } finally {
    if (seq === reqSeq) {
      loading.value = false
      refreshing.value = false
    }
  }
}

/** Instance output dir incl. --output-directory overrides — mirrors the main
 *  process's resolveOutputDir (0.1.11) so "Rescan" walks the REAL folder. */
function defaultOutputRoot(): string {
  const inst = store.activeInstance
  if (!inst?.path) return ''
  const args = inst.extraArgs || []
  const idx = args.indexOf('--output-directory')
  if (idx >= 0 && args[idx + 1]) {
    const p = args[idx + 1]
    if (/^[a-zA-Z]:[\\/]|^\//.test(p)) return p
    const base = inst.path.replace(/[\\/]+$/, '')
    return `${base}${base.includes('\\') ? '\\' : '/'}${p}`
  }
  const base = inst.path.replace(/[\\/]+$/, '')
  return `${base}${base.includes('\\') ? '\\' : '/'}output`
}

async function pickRoot(): Promise<void> {
  const p = await ipc('shell.pickDirectory')
  if (p) {
    root.value = p
    page.value = 1
    await refresh()
  }
}

function toggleSelect(id: string): void {
  if (selected.value.has(id)) selected.value.delete(id)
  else selected.value.add(id)
}

function toggleSelectAll(): void {
  if (selected.value.size === assets.value.length && assets.value.length) {
    selected.value.clear()
  } else {
    selected.value = new Set(assets.value.map((a) => a.id))
  }
}

async function toggleFavorite(a: OutputAsset): Promise<void> {
  try {
    await ipc('output.favorite', a.id, !a.favorite)
    a.favorite = !a.favorite
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function safeOpen(path: string): Promise<void> {
  try {
    await ipc('output.open', path)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function safeReveal(path: string): Promise<void> {
  try {
    await ipc('output.reveal', path)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openDetail(a: OutputAsset): Promise<void> {
  detail.value = a
  detailVideoFailed.value = false
  showDetail.value = true
  pngMeta.value = a.params && Object.keys(a.params).length ? a.params : null
  metaLoading.value = true
  void loadAssetsMatch(a)
  try {
    const meta = await ipc('workflow.parsePngMeta', a.path)
    if (meta) pngMeta.value = meta
  } catch {
    /* keep whatever we already have */
  } finally {
    metaLoading.value = false
  }
}

/** Assets-system records matching the detail asset (0.1.14, read-only). */
const assetsMatches = ref<OutputAssetMatch[] | null>(null)
const assetsLoading = ref(false)

async function loadAssetsMatch(a: OutputAsset): Promise<void> {
  assetsMatches.value = null
  const inst = store.activeInstance
  if (!inst) return
  assetsLoading.value = true
  try {
    assetsMatches.value = await ipc('output.assetsMatch', inst.id, a.fileName)
  } catch {
    assetsMatches.value = null
  } finally {
    assetsLoading.value = false
  }
}

/** Copy one value to the clipboard (assets job id etc.). */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await ipc('shell.writeClipboard', text)
    message.success(t('output.copied'))
  } catch {
    /* clipboard failure is non-fatal */
  }
}

/** Full-resolution display URL — never a bare fs path (renderer cannot load those). */
function lightboxUrl(a: OutputAsset): string {
  return a.mediaUrl || a.thumbnail || ''
}

function openLightbox(a: OutputAsset): void {
  // 0.1.14: audio plays inline when the media protocol can serve it; anything
  // the renderer cannot present (mkv videos, raw images like EXR, 3D models)
  // opens with the OS default application instead of showing a dead modal.
  if (a.type === 'audio') {
    if (!playableAudio(a)) {
      void safeOpen(a.path)
      return
    }
    lightboxAsset.value = a
    lightboxSrc.value = lightboxUrl(a)
    lightboxAudioFailed.value = false
    lightboxVideoFailed.value = false
    lightboxImageFailed.value = false
    lightbox.value = true
    return
  }
  if (a.type === 'video' && (!a.mediaUrl || failedVideos.value.has(a.id))) {
    void safeOpen(a.path)
    return
  }
  if (a.type === '3d' || a.type === 'other' || (a.type === 'image' && isRawImage(a.fileName))) {
    void safeOpen(a.path)
    return
  }
  if (a.type !== 'image' && a.type !== 'video') return
  lightboxAsset.value = a
  lightboxSrc.value = lightboxUrl(a)
  lightboxVideoFailed.value = false
  lightboxImageFailed.value = false
  lightboxAudioFailed.value = false
  lightbox.value = true
}

/** Index of the current lightbox asset in the visible page of images. */
function lightboxIndex(): number {
  if (!lightboxAsset.value) return -1
  return assets.value.findIndex((x) => x.id === lightboxAsset.value!.id)
}

function lightboxPrev(): void {
  const idx = lightboxIndex()
  if (idx < 0) return
  const images = assets.value.filter((x) => x.type === 'image')
  const cur = images.findIndex((x) => x.id === lightboxAsset.value!.id)
  if (cur <= 0) return
  const prev = images[cur - 1]
  lightboxAsset.value = prev
  lightboxSrc.value = lightboxUrl(prev)
  // Reset failure flags per asset — otherwise one broken image locks the whole
  // gallery into the fallback (the <img> never remounts to re-trigger @error).
  lightboxImageFailed.value = false
  lightboxVideoFailed.value = false
  lightboxAudioFailed.value = false
}

function lightboxNext(): void {
  const idx = lightboxIndex()
  if (idx < 0) return
  const images = assets.value.filter((x) => x.type === 'image')
  const cur = images.findIndex((x) => x.id === lightboxAsset.value!.id)
  if (cur < 0 || cur >= images.length - 1) return
  const next = images[cur + 1]
  lightboxAsset.value = next
  lightboxSrc.value = lightboxUrl(next)
  lightboxImageFailed.value = false
  lightboxVideoFailed.value = false
  lightboxAudioFailed.value = false
}

function onLightboxKey(e: KeyboardEvent): void {
  if (!lightbox.value) return
  if (e.key === 'ArrowLeft') lightboxPrev()
  else if (e.key === 'ArrowRight') lightboxNext()
  else if (e.key === 'Escape') lightbox.value = false
}

/** Restore this PNG's embedded workflow into the active instance's workflows folder. */
async function restoreWorkflow(): Promise<void> {
  if (!detail.value) return
  if (!store.activeInstanceId) {
    message.warning(t('output.needInstanceForRestore'))
    return
  }
  try {
    const rec = await ipc('output.importToWorkflow', detail.value.path, store.activeInstanceId)
    if (rec) {
      message.success(t('output.restoredToInstance', { name: rec.name }))
      showDetail.value = false
      void router.push('/workflows')
    } else {
      message.warning(t('output.noEmbeddedWorkflow'))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** Delete one asset. deleteFile=true removes the file; false drops the record only. */
async function doDeleteAsset(id: string, deleteFile: boolean): Promise<void> {
  try {
    await ipc('output.delete', id, deleteFile)
    if (detail.value?.id === id) {
      showDetail.value = false
      detail.value = null
    }
    if (lightboxAsset.value?.id === id) {
      lightbox.value = false
      lightboxAsset.value = null
      lightboxSrc.value = ''
    }
    selected.value.delete(id)
    message.success(deleteFile ? t('output.deletedWithFile') : t('output.deletedRecordOnly'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** Two explicit outcomes (mirrors models): record-only vs delete file too. */
function confirmDeleteAsset(a: OutputAsset): void {
  dialog.warning({
    title: t('output.deleteAction'),
    content: t('output.deleteConfirm'),
    positiveText: t('output.deleteFileToo'),
    negativeText: t('output.removeRecordOnly'),
    onPositiveClick: () => doDeleteAsset(a.id, true),
    onNegativeClick: () => doDeleteAsset(a.id, false)
  })
}

async function exportSelected(): Promise<void> {
  const paths = assets.value.filter((a) => selected.value.has(a.id)).map((a) => a.path)
  if (!paths.length) {
    message.warning(t('output.selectSome'))
    return
  }
  try {
    const dir = await ipc('shell.pickDirectory')
    if (!dir) return
    const res = await ipc('output.exportZip', paths, dir)
    message.success(t('output.exported', { path: res.path }))
    selected.value.clear()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function metaEntries(meta: Record<string, unknown>): Array<{ key: string; value: string }> {
  return Object.entries(meta || {}).map(([key, value]) => ({
    key,
    value:
      typeof value === 'string'
        ? value.length > 200
          ? value.slice(0, 200) + '...'
          : value
        : JSON.stringify(value)
  }))
}

watch([type, sort, order, onlyFavorites, batchFilter, workflowFilter, dateRange], () => {
  page.value = 1
  void refresh()
})

// root changes must reset page and refresh (was previously not watched).
watch(root, () => {
  page.value = 1
  void refresh()
})

watch(page, () => void refresh())

watch(pageSize, () => {
  page.value = 1
  void refresh()
})

let offBatch: (() => void) | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null

/** Debounced refresh when a batch produces new outputs. */
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, 1500)
}

// Switching the active instance retargets the library at the new output dir
// and drops the previous instance's selection/detail state — the old root
// kept listing stale outputs and restores targeted the wrong instance
// (0.1.13).
watch(
  () => store.instanceSwitchTick,
  () => {
    root.value = defaultOutputRoot()
    page.value = 1
    selected.value.clear()
    showDetail.value = false
    detail.value = null
    void refresh()
  }
)

onMounted(async () => {
  await store.bootstrap({ keepSelection: true })
  const q = route.query
  if (typeof q.batchJobId === 'string' && q.batchJobId) {
    batchFilter.value = q.batchJobId
  }
  if (typeof q.workflowId === 'string' && q.workflowId) {
    workflowFilter.value = q.workflowId
  }
  try {
    workflows.value = await ipc('workflow.list', { includeMissing: true })
  } catch {
    /* non-fatal  -filter dropdown just stays empty */
  }
  try {
    // Default to the active instance's output dir (honours --output-directory)
    // — no global setting needed.
    root.value = defaultOutputRoot()
  } catch {
    /* keep empty */
  }
  // Auto-refresh when a batch produces new outputs.
  offBatch = onIpc(IPC_EVENTS.batchProgress, () => scheduleRefresh())
  window.addEventListener('keydown', onLightboxKey)
  await refresh()
})

onUnmounted(() => {
  offBatch?.()
  if (refreshTimer) clearTimeout(refreshTimer)
  window.removeEventListener('keydown', onLightboxKey)
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('output.title') }}</h1>
        <p class="page-subtitle">{{ $t('output.subtitle') }}</p>
      </div>
      <NSpace align="center">
        <NInput
          v-model:value="root"
          :placeholder="$t('output.rootPlaceholder')"
          style="width: 220px"
        >
          <template #suffix>
            <NButton size="tiny" secondary @click="pickRoot">{{ $t('output.browse') }}</NButton>
          </template>
        </NInput>
        <NSelect v-model:value="type" :options="typeOptions" style="width: 110px" />
        <NSelect
          v-model:value="workflowFilter"
          :options="workflowOptions"
          :placeholder="$t('output.filterWorkflow')"
          style="width: 150px"
          clearable
        />
        <NSelect v-model:value="sort" :options="sortOptions" style="width: 120px" />
        <NButton secondary size="small" @click="order = order === 'desc' ? 'asc' : 'desc'">
          {{ order === 'desc' ? '↓' : '↑' }}
        </NButton>
        <NDatePicker
          v-model:value="dateRange"
          type="datetimerange"
          clearable
          :start-placeholder="$t('output.dateFrom')"
          :end-placeholder="$t('output.dateTo')"
          style="width: 280px"
        />
        <NSwitch v-model:value="onlyFavorites">
          <template #checked>{{ $t('output.favOnly') }}</template>
          <template #unchecked>{{ $t('output.favAll') }}</template>
        </NSwitch>
        <NButton type="primary" :loading="refreshing" @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>{{ $t('output.scan') }}
        </NButton>
      </NSpace>
    </div>

    <!-- filter chips + toolbar (toolbar stays visible even with filters) -->
    <NSpace align="center" style="margin-bottom: 12px" justify="space-between">
      <NSpace align="center">
        <NTag v-if="batchFilter" closable round type="info" @close="batchFilter = ''">
          {{ $t('output.filterBatch') }}: {{ batchFilter.slice(0, 8) }}
        </NTag>
        <NTag v-if="workflowFilter" closable round type="info" @close="workflowFilter = ''">
          {{ $t('output.filterWorkflow') }}: {{ workflowName(workflowFilter) }}
        </NTag>
        <NText depth="3">{{ $t('output.total', { n: total }) }}</NText>
      </NSpace>
      <NSpace>
        <NButton size="small" secondary @click="toggleSelectAll">
          {{
            assets.length && selected.size === assets.length
              ? $t('output.clearSelection')
              : $t('output.selectAll')
          }}
        </NButton>
        <NText v-if="selected.size" depth="3" style="align-self: center">
          {{ $t('output.selected', { n: selected.size }) }}
        </NText>
        <NButton size="small" secondary :disabled="!selected.size" @click="exportSelected">
          <template #icon><NIcon :component="ShareSocialOutline" /></template>
          {{ $t('output.exportZip') }}
        </NButton>
      </NSpace>
    </NSpace>

    <div class="page-body">
      <NSpin :show="loading && assets.length > 0">
        <ListSkeleton v-if="loading && !assets.length" :rows="8" variant="card" />
        <div v-else-if="assets.length">
          <NGrid cols="2 600:3 900:4 1200:5" :x-gap="14" :y-gap="14">
            <NGi v-for="a in assets" :key="a.id">
              <div
                class="card card-interactive asset"
                :class="{ selected: selected.has(a.id) }"
                @click="openDetail(a)"
              >
                <div class="thumb" @dblclick="openLightbox(a)">
                  <img
                    v-if="a.type === 'image' && isWebViewableImage(a.fileName) && thumbSrc(a)"
                    :src="thumbSrc(a)"
                    class="thumb-img"
                    :alt="a.fileName"
                    @error="onThumbError(a)"
                  />
                  <video
                    v-else-if="playableVideo(a)"
                    class="thumb-img"
                    :src="a.mediaUrl + '#t=0.35'"
                    muted
                    playsinline
                    preload="metadata"
                    @error="onVideoError(a)"
                  ></video>
                  <NIcon v-else :size="36" :component="typeIconOf(a)" />
                  <div v-if="playableVideo(a) || playableAudio(a)" class="thumb-play">
                    <NIcon :component="PlayCircleOutline" :size="30" color="#fff" />
                  </div>
                  <div class="thumb-check" @click.stop="toggleSelect(a.id)">
                    <NCheckbox :checked="selected.has(a.id)" />
                  </div>
                  <button
                    class="fav-btn"
                    type="button"
                    :aria-label="$t('output.favOnly')"
                    @click.stop="toggleFavorite(a)"
                  >
                    <NIcon
                      :component="a.favorite ? Heart : HeartOutline"
                      :color="a.favorite ? COLORS.danger : '#fff'"
                    />
                  </button>
                </div>
                <div class="asset-name">{{ a.fileName }}</div>
                <div class="asset-meta">
                  {{ formatBytes(a.size) }}
                  <span v-if="a.seed != null"> ·{{ $t('output.seed') }} {{ a.seed }}</span>
                </div>
                <div v-if="a.workflowName || a.batchJobId" class="asset-meta">
                  <NTag
                    v-if="a.workflowName"
                    size="tiny"
                    round
                    style="cursor: pointer"
                    @click.stop="a.workflowId && (workflowFilter = a.workflowId)"
                    >{{ a.workflowName }}</NTag
                  >
                  <NTag v-if="a.batchJobId" size="tiny" round type="info">{{
                    $t('output.fromBatch')
                  }}</NTag>
                </div>
                <NSpace justify="center">
                  <NButton size="tiny" secondary @click.stop="safeOpen(a.path)">
                    <template #icon><NIcon :component="OpenOutline" /></template>
                  </NButton>
                  <NButton size="tiny" secondary @click.stop="safeReveal(a.path)">
                    <template #icon><NIcon :component="FolderOpenOutline" /></template>
                  </NButton>
                  <NButton size="tiny" secondary @click.stop="openDetail(a)">{{
                    $t('output.params')
                  }}</NButton>
                  <NButton size="tiny" type="error" secondary @click.stop="confirmDeleteAsset(a)">
                    {{ $t('output.delete') }}
                  </NButton>
                </NSpace>
              </div>
            </NGi>
          </NGrid>
          <NSpace justify="center" style="margin-top: 18px">
            <NPagination
              v-model:page="page"
              v-model:page-size="pageSize"
              :page-count="Math.max(1, Math.ceil(total / pageSize))"
              :page-sizes="[40, 60, 100, 200]"
              show-size-picker
            />
          </NSpace>
        </div>
        <NEmpty
          v-else
          :description="hasFilter ? $t('common.noMatch') : $t('output.empty')"
          class="empty"
        >
          <template #extra>
            <NSpace vertical align="center" :size="10">
              <div v-if="workflowFilter" class="wf-empty-hint">
                {{ $t('output.workflowEmptyHint') }}
              </div>
              <NSpace>
                <NButton v-if="hasFilter" secondary @click="clearFilters">{{
                  $t('common.clearFilters')
                }}</NButton>
                <NButton v-if="workflowFilter" secondary :loading="refreshing" @click="refresh">
                  {{ $t('output.rescan') }}
                </NButton>
                <NButton v-else type="primary" @click="pickRoot">{{ $t('output.browse') }}</NButton>
              </NSpace>
            </NSpace>
          </template>
        </NEmpty>
      </NSpin>
    </div>

    <!-- Detail -->
    <NModal
      v-model:show="showDetail"
      preset="card"
      :title="detail?.fileName || $t('output.detailTitle')"
      style="width: 680px; border-radius: 20px"
    >
      <div v-if="detail" class="detail-body">
        <div class="detail-preview" @click="openLightbox(detail)">
          <video
            v-if="detail.type === 'video' && detail.mediaUrl && !detailVideoFailed"
            :src="detail.mediaUrl"
            class="detail-img"
            controls
            muted
            playsinline
            preload="metadata"
            @error="detailVideoFailed = true"
          ></video>
          <img
            v-else-if="thumbSrc(detail)"
            :src="thumbSrc(detail)"
            class="detail-img"
            :alt="detail.fileName"
            @error="onThumbError(detail)"
          />
          <NIcon v-else :size="48" :component="ImageOutline" />
        </div>
        <div class="detail-meta">
          <div>
            <b>{{ $t('output.size') }}</b> {{ formatBytes(detail.size) }}
          </div>
          <div v-if="detail.seed != null">
            <b>{{ $t('output.seed') }}</b> <NTag size="tiny" round>{{ detail.seed }}</NTag>
          </div>
          <div v-if="detail.workflowName">
            <b>{{ $t('output.fromWorkflow') }}</b> {{ detail.workflowName }}
          </div>
          <div v-if="detail.batchJobId">
            <b>{{ $t('output.fromBatch') }}</b>
            <NTag
              size="tiny"
              round
              type="info"
              style="cursor: pointer; margin-left: 6px"
              @click="router.push({ path: '/batch', query: { jobId: detail.batchJobId } })"
            >
              {{ detail.batchJobId.slice(0, 8) }}
            </NTag>
          </div>
          <div v-if="detail.promptId" class="mono">
            <b>{{ $t('output.promptId') }}</b> {{ detail.promptId }}
          </div>
          <div class="mono detail-path">{{ detail.path }}</div>
        </div>

        <!-- Instance assets-system record (0.1.14, read-only enhancement) -->
        <template v-if="assetsLoading || (assetsMatches && assetsMatches.length)">
          <div class="params-title">{{ $t('output.assetsTitle') }}</div>
          <div v-if="assetsLoading" class="assets-line">{{ $t('output.assetsLoading') }}</div>
          <div v-for="m in assetsMatches || []" :key="m.id" class="assets-hit">
            <div class="mono">ID: {{ m.id }}</div>
            <div v-if="m.jobId" class="mono">
              Prompt ID: {{ m.jobId }}
              <NButton text size="tiny" type="primary" @click="copyToClipboard(m.jobId || '')">
                {{ $t('output.copy') }}
              </NButton>
            </div>
            <div v-if="m.workflowName" class="assets-line">
              {{ $t('output.assetsWorkflow') }}: {{ m.workflowName }}
            </div>
            <div v-if="m.tags.length" class="assets-tags">
              <NTag v-for="tg in m.tags" :key="tg" size="tiny" round>{{ tg }}</NTag>
            </div>
            <img v-if="m.previewUrl" :src="m.previewUrl" class="assets-preview" :alt="m.name" />
          </div>
          <NText depth="3" class="assets-note">{{ $t('output.assetsNote') }}</NText>
        </template>

        <div class="params-title">{{ $t('output.pngParams') }}</div>
        <NSpin :show="metaLoading">
          <div v-if="pngMeta && metaEntries(pngMeta).length" class="params-list">
            <div v-for="row in metaEntries(pngMeta)" :key="row.key" class="param-row">
              <div class="param-key mono">{{ row.key }}</div>
              <div class="param-val mono">{{ row.value }}</div>
            </div>
          </div>
          <NEmpty v-else :description="$t('output.noPngParams')" style="padding: 16px 0" />
        </NSpin>
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showDetail = false">{{ $t('output.close') }}</NButton>
          <NButton secondary @click="detail && safeOpen(detail.path)">{{
            $t('output.openFile')
          }}</NButton>
          <NButton secondary @click="detail && safeReveal(detail.path)">
            <template #icon><NIcon :component="FolderOpenOutline" /></template>
            {{ $t('output.reveal') }}
          </NButton>
          <NButton v-if="detail?.type === 'image'" type="primary" @click="restoreWorkflow">
            <template #icon><NIcon :component="GitBranchOutline" /></template>
            {{ $t('output.restoreWorkflow') }}
          </NButton>
          <NButton v-if="detail" type="error" secondary @click="confirmDeleteAsset(detail)">
            {{ $t('output.delete') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Lightbox -->
    <NModal
      v-model:show="lightbox"
      preset="card"
      style="width: 90vw; max-width: 1100px; border-radius: 20px"
    >
      <div class="lightbox">
        <NButton
          v-if="lightboxAsset?.type === 'image'"
          class="lb-nav lb-prev"
          secondary
          circle
          size="large"
          @click="lightboxPrev"
        >
          <template #icon><NIcon :component="ChevronBackOutline" /></template>
        </NButton>
        <video
          v-if="lightboxAsset?.type === 'video' && lightboxSrc && !lightboxVideoFailed"
          :src="lightboxSrc"
          class="lightbox-img"
          controls
          autoplay
          loop
          @error="lightboxVideoFailed = true"
        ></video>
        <audio
          v-else-if="lightboxAsset?.type === 'audio' && lightboxSrc && !lightboxAudioFailed"
          :src="lightboxSrc"
          class="lightbox-audio"
          controls
          autoplay
          @error="lightboxAudioFailed = true"
        ></audio>
        <img
          v-else-if="
            lightboxAsset?.type === 'image' &&
            lightboxSrc &&
            !lightboxVideoFailed &&
            !lightboxImageFailed
          "
          :src="lightboxSrc"
          class="lightbox-img"
          :alt="lightboxAsset?.fileName || ''"
          @error="lightboxImageFailed = true"
        />
        <div v-if="lightboxImageFailed" class="lb-fallback">
          <NIcon :size="40" :component="ImageOutline" />
          <NText depth="3">{{ $t('output.imageLoadFailed') }}</NText>
          <NButton secondary @click="lightboxAsset && safeOpen(lightboxAsset.path)">
            {{ $t('output.openFile') }}
          </NButton>
        </div>
        <div v-if="lightboxVideoFailed" class="lb-fallback">
          <NIcon :size="40" :component="VideocamOutline" />
          <NText depth="3">{{ $t('output.videoPlaybackUnsupported') }}</NText>
          <NButton secondary @click="lightboxAsset && safeOpen(lightboxAsset.path)">
            {{ $t('output.openWithSystem') }}
          </NButton>
        </div>
        <div v-if="lightboxAudioFailed" class="lb-fallback">
          <NIcon :size="40" :component="MusicalNotesOutline" />
          <NText depth="3">{{ $t('output.audioPlaybackUnsupported') }}</NText>
          <NButton secondary @click="lightboxAsset && safeOpen(lightboxAsset.path)">
            {{ $t('output.openWithSystem') }}
          </NButton>
        </div>
        <NButton
          v-if="lightboxAsset?.type === 'image'"
          class="lb-nav lb-next"
          secondary
          circle
          size="large"
          @click="lightboxNext"
        >
          <template #icon><NIcon :component="ChevronForwardOutline" /></template>
        </NButton>
      </div>
      <template #footer>
        <NSpace justify="space-between">
          <NSpace>
            <NButton v-if="lightboxAsset?.type === 'image'" secondary @click="lightboxPrev">{{
              $t('output.prev')
            }}</NButton>
            <NButton v-if="lightboxAsset?.type === 'image'" secondary @click="lightboxNext">{{
              $t('output.next')
            }}</NButton>
          </NSpace>
          <NSpace>
            <NButton @click="lightbox = false">{{ $t('output.close') }}</NButton>
            <NButton secondary @click="lightboxAsset && safeOpen(lightboxAsset.path)">
              <template #icon><NIcon :component="DownloadOutline" /></template>
              {{ $t('output.openFile') }}
            </NButton>
          </NSpace>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.asset {
  padding: 14px;
  text-align: center;
  cursor: pointer;
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.asset.selected {
  outline: 2px solid $color-primary;
}
.thumb {
  height: 120px;
  border-radius: 12px;
  background: $gradient-soft;
  display: grid;
  place-items: center;
  color: $color-primary;
  margin-bottom: 10px;
  overflow: hidden;
  position: relative;
}
.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  background: #000;
}
.thumb-play {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.18);
  pointer-events: none;
}
.lb-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 0;
  justify-self: center;
}
.thumb-check {
  position: absolute;
  left: 6px;
  top: 6px;
  padding: 2px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  display: grid;
  place-items: center;
}
.fav-btn {
  position: absolute;
  right: 6px;
  top: 6px;
  border: none;
  background: rgba(0, 0, 0, 0.32);
  border-radius: 999px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    background 0.15s ease;

  &:hover {
    transform: scale(1.08);
    background: rgba(0, 0, 0, 0.45);
  }

  &:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.9);
    outline-offset: 1px;
  }
}
.asset-name {
  font-size: 12.5px;
  font-weight: 600;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.asset-meta {
  font-size: 11px;
  color: $color-text-muted-ink;
  margin: 6px 0 10px;
  min-height: 15px;
}
.empty {
  padding: 64px 0;
}
.wf-empty-hint {
  font-size: 12.5px;
  color: $color-text-muted-ink;
  max-width: 460px;
  text-align: center;
  line-height: 1.6;
}
.detail-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.detail-preview {
  height: 200px;
  border-radius: 12px;
  background: $gradient-soft;
  display: grid;
  place-items: center;
  overflow: hidden;
  cursor: zoom-in;
}
.detail-img {
  max-width: 100%;
  max-height: 200px;
  object-fit: contain;
}
.detail-meta {
  font-size: 13px;
  color: $color-text-secondary;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.detail-path {
  font-size: 11px;
  color: $color-text-muted-ink;
  word-break: break-all;
}
.params-title {
  font-size: 14px;
  font-weight: 700;
  margin-top: 4px;
}
.params-list {
  max-height: 240px;
  overflow: auto;
  border: 1px solid $color-border;
  border-radius: 12px;
}
.param-row {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid $color-border;
  font-size: 12px;

  &:last-child {
    border-bottom: none;
  }
}
.param-key {
  color: $color-primary;
  font-weight: 600;
}
.param-val {
  color: $color-text-secondary;
  word-break: break-all;
  white-space: pre-wrap;
}
.lightbox {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 12px;
  min-height: 320px;
}
.lightbox-img {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
  justify-self: center;
}
.lightbox-audio {
  width: 100%;
  max-width: 560px;
  justify-self: center;
}
.lb-nav {
  flex-shrink: 0;
}
.assets-line {
  margin: 4px 0;
  font-size: 12px;
}
.assets-hit {
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.assets-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.assets-preview {
  max-width: 220px;
  max-height: 160px;
  object-fit: contain;
  border-radius: 8px;
}
.assets-note {
  font-size: 12px;
}
</style>
