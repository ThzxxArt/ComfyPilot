<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
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
  DownloadOutline
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
  useMessage,
  NPagination
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import { useAppStore } from '@/stores/app'
import { formatBytes } from '@/utils/format'
import type { OutputAsset } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const route = useRoute()
const router = useRouter()
const loading = ref(false)
const assets = ref<OutputAsset[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 60
const root = ref('')
const type = ref('all')
const sort = ref<'createdAt' | 'size' | 'name'>('createdAt')
const order = ref<'asc' | 'desc'>('desc')
const onlyFavorites = ref(false)
const batchFilter = ref('')
const selected = ref<Set<string>>(new Set())

const typeOptions = computed(() => [
  { label: t('output.typeAll'), value: 'all' },
  { label: t('output.typeImage'), value: 'image' },
  { label: t('output.typeVideo'), value: 'video' },
  { label: t('output.typeAudio'), value: 'audio' }
])

const sortOptions = computed(() => [
  { label: t('output.sortCreatedAt'), value: 'createdAt' },
  { label: t('output.sortSize'), value: 'size' },
  { label: t('output.sortName'), value: 'name' }
])

const detail = ref<OutputAsset | null>(null)
const showDetail = ref(false)
const pngMeta = ref<Record<string, unknown> | null>(null)
const metaLoading = ref(false)
const lightbox = ref(false)
const lightboxSrc = ref('')
const lightboxAsset = ref<OutputAsset | null>(null)
const refreshing = ref(false)
let reqSeq = 0

async function refresh(): Promise<void> {
  const seq = ++reqSeq
  loading.value = true
  refreshing.value = true
  try {
    const result = await ipc('output.list', {
      root: root.value || undefined,
      type: type.value === 'all' ? undefined : type.value,
      limit: pageSize,
      offset: (page.value - 1) * pageSize,
      favorite: onlyFavorites.value ? true : undefined,
      batchJobId: batchFilter.value || undefined,
      sort: sort.value,
      order: order.value
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

async function pickRoot(): Promise<void> {
  const p = await ipc('shell.pickDirectory')
  if (p) {
    root.value = p
    try {
      await ipc('settings.set', { outputIndexRoot: p })
    } catch {
      /* non-fatal — previews may stay as icons */
    }
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
  showDetail.value = true
  pngMeta.value = a.params && Object.keys(a.params).length ? a.params : null
  metaLoading.value = true
  try {
    const meta = await ipc('workflow.parsePngMeta', a.path)
    if (meta) pngMeta.value = meta
  } catch {
    /* keep whatever we already have */
  } finally {
    metaLoading.value = false
  }
}

function openLightbox(a: OutputAsset): void {
  if (!a.thumbnail && a.type !== 'image') return
  lightboxAsset.value = a
  lightboxSrc.value = a.thumbnail || a.path
  lightbox.value = true
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
          ? value.slice(0, 200) + '…'
          : value
        : JSON.stringify(value)
  }))
}

watch([type, sort, order, onlyFavorites, batchFilter], () => {
  page.value = 1
  void refresh()
})

watch(page, () => void refresh())

onMounted(async () => {
  await store.bootstrap({ keepSelection: true })
  const q = route.query
  if (typeof q.batchJobId === 'string' && q.batchJobId) {
    batchFilter.value = q.batchJobId
  }
  try {
    const settings = await ipc('settings.get')
    if (settings.outputIndexRoot) root.value = settings.outputIndexRoot
    else if (store.activeInstance?.path) {
      const base = store.activeInstance.path.replace(/[\\/]+$/, '')
      root.value = `${base}${base.includes('\\') ? '\\' : '/'}output`
    }
  } catch {
    /* keep empty */
  }
  await refresh()
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
        <NInput v-model:value="root" :placeholder="$t('output.rootPlaceholder')" style="width: 220px">
          <template #suffix>
            <NButton size="tiny" secondary @click="pickRoot">{{ $t('output.browse') }}</NButton>
          </template>
        </NInput>
        <NSelect v-model:value="type" :options="typeOptions" style="width: 110px" />
        <NSelect v-model:value="sort" :options="sortOptions" style="width: 120px" />
        <NButton secondary size="small" @click="order = order === 'desc' ? 'asc' : 'desc'">
          {{ order === 'desc' ? '↓' : '↑' }}
        </NButton>
        <NSwitch v-model:value="onlyFavorites">
          <template #checked>{{ $t('output.favOnly') }}</template>
          <template #unchecked>{{ $t('output.favAll') }}</template>
        </NSwitch>
        <NButton type="primary" @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>{{ $t('output.scan') }}
        </NButton>
      </NSpace>
    </div>

    <!-- batch filter chip -->
    <NSpace v-if="batchFilter" align="center" style="margin-bottom: 12px">
      <NTag closable round type="info" @close="batchFilter = ''">
        {{ $t('output.filterBatch') }}: {{ batchFilter.slice(0, 8) }}…
      </NTag>
      <NText depth="3">{{ $t('output.total', { n: total }) }}</NText>
    </NSpace>
    <NSpace v-else align="center" style="margin-bottom: 12px" justify="space-between">
      <NText depth="3">{{ $t('output.total', { n: total }) }}</NText>
      <NSpace>
        <NButton size="small" secondary @click="toggleSelectAll">
          {{ assets.length && selected.size === assets.length ? $t('output.clearSelection') : $t('output.selectAll') }}
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
      <NSpin :show="loading">
        <div v-if="assets.length">
          <NGrid cols="2 600:3 900:4 1200:5" :x-gap="14" :y-gap="14">
            <NGi v-for="a in assets" :key="a.id">
              <div
                class="card asset"
                :class="{ selected: selected.has(a.id) }"
                @click="openDetail(a)"
              >
                <div class="thumb" @dblclick="openLightbox(a)">
                  <img v-if="a.thumbnail" :src="a.thumbnail" class="thumb-img" :alt="a.fileName" />
                  <NIcon
                    v-else
                    :size="36"
                    :component="a.type === 'video' ? VideocamOutline : ImageOutline"
                  />
                  <div class="thumb-check" @click.stop="toggleSelect(a.id)">
                    <NCheckbox :checked="selected.has(a.id)" />
                  </div>
                  <button class="fav-btn" type="button" @click.stop="toggleFavorite(a)">
                    <NIcon :component="a.favorite ? Heart : HeartOutline" :color="a.favorite ? '#e2557a' : '#fff'" />
                  </button>
                </div>
                <div class="asset-name">{{ a.fileName }}</div>
                <div class="asset-meta">
                  {{ formatBytes(a.size) }}
                  <span v-if="a.seed != null"> · seed {{ a.seed }}</span>
                </div>
                <div class="asset-meta" v-if="a.workflowName || a.batchJobId">
                  <NTag v-if="a.workflowName" size="tiny" round>{{ a.workflowName }}</NTag>
                  <NTag v-if="a.batchJobId" size="tiny" round type="info">{{ $t('output.fromBatch') }}</NTag>
                </div>
                <NSpace justify="center">
                  <NButton size="tiny" secondary @click.stop="safeOpen(a.path)">
                    <template #icon><NIcon :component="OpenOutline" /></template>
                  </NButton>
                  <NButton size="tiny" secondary @click.stop="safeReveal(a.path)">
                    <template #icon><NIcon :component="FolderOpenOutline" /></template>
                  </NButton>
                  <NButton size="tiny" secondary @click.stop="openDetail(a)">{{ $t('output.params') }}</NButton>
                </NSpace>
              </div>
            </NGi>
          </NGrid>
          <NSpace justify="center" style="margin-top: 18px">
            <NPagination
              v-model:page="page"
              :page-count="Math.max(1, Math.ceil(total / pageSize))"
              :page-size="pageSize"
            />
          </NSpace>
        </div>
        <NEmpty v-else :description="$t('output.empty')" class="empty">
          <template #extra>
            <NButton type="primary" @click="pickRoot">{{ $t('output.browse') }}</NButton>
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
          <img
            v-if="detail.thumbnail"
            :src="detail.thumbnail"
            class="detail-img"
            :alt="detail.fileName"
          />
          <NIcon v-else :size="48" :component="ImageOutline" />
        </div>
        <div class="detail-meta">
          <div><b>{{ $t('output.size') }}</b> {{ formatBytes(detail.size) }}</div>
          <div v-if="detail.seed != null"><b>Seed</b> <NTag size="tiny" round>{{ detail.seed }}</NTag></div>
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
              @click="router.push({ path: '/batch' })"
            >
              {{ detail.batchJobId.slice(0, 8) }} →
            </NTag>
          </div>
          <div v-if="detail.promptId" class="mono"><b>prompt_id</b> {{ detail.promptId }}</div>
          <div class="mono detail-path">{{ detail.path }}</div>
        </div>

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
          <NButton secondary @click="detail && safeOpen(detail.path)">{{ $t('output.openFile') }}</NButton>
          <NButton secondary @click="detail && safeReveal(detail.path)">
            <template #icon><NIcon :component="FolderOpenOutline" /></template>
            {{ $t('output.reveal') }}
          </NButton>
          <NButton
            v-if="detail?.type === 'image'"
            type="primary"
            @click="restoreWorkflow"
          >
            <template #icon><NIcon :component="GitBranchOutline" /></template>
            {{ $t('output.restoreWorkflow') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Lightbox -->
    <NModal v-model:show="lightbox" preset="card" style="width: 90vw; max-width: 1100px; border-radius: 20px">
      <div class="lightbox">
        <img v-if="lightboxSrc" :src="lightboxSrc" class="lightbox-img" />
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="lightbox = false">{{ $t('output.close') }}</NButton>
          <NButton
            secondary
            @click="lightboxAsset && safeOpen(lightboxAsset.path)"
          >
            <template #icon><NIcon :component="DownloadOutline" /></template>
            {{ $t('output.openFile') }}
          </NButton>
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
}
.thumb-check {
  position: absolute;
  left: 6px;
  top: 6px;
}
.fav-btn {
  position: absolute;
  right: 6px;
  top: 6px;
  border: none;
  background: rgba(0, 0, 0, 0.28);
  border-radius: 999px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.asset-name {
  font-size: 12.5px;
  font-weight: 600;
  word-break: break-all;
}
.asset-meta {
  font-size: 11px;
  color: $color-text-muted;
  margin: 6px 0 10px;
}
.empty {
  padding: 64px 0;
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
  color: $color-text-muted;
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
  place-items: center;
  min-height: 320px;
}
.lightbox-img {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
}
</style>
