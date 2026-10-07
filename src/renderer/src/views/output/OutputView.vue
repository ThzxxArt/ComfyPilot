<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  OpenOutline,
  RefreshOutline,
  ImageOutline,
  VideocamOutline,
  GitBranchOutline
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
  useMessage
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import { useAppStore } from '@/stores/app'
import { formatBytes } from '@/utils/format'
import type { OutputAsset } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const loading = ref(false)
const assets = ref<OutputAsset[]>([])
const root = ref('')
const type = ref('all')

const typeOptions = computed(() => [
  { label: t('output.typeAll'), value: 'all' },
  { label: t('output.typeImage'), value: 'image' },
  { label: t('output.typeVideo'), value: 'video' },
  { label: t('output.typeAudio'), value: 'audio' }
])

const detail = ref<OutputAsset | null>(null)
const showDetail = ref(false)
const pngMeta = ref<Record<string, unknown> | null>(null)
const metaLoading = ref(false)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    assets.value = await ipc('output.list', {
      root: root.value || undefined,
      type: type.value === 'all' ? undefined : type.value
    })
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function pickRoot(): Promise<void> {
  const p = await ipc('shell.pickDirectory')
  if (p) {
    root.value = p
    // Persist so media URL gate can serve thumbnails for this root.
    try {
      await ipc('settings.set', { outputIndexRoot: p })
    } catch {
      /* non-fatal — previews may stay as icons */
    }
    await refresh()
  }
}

/** Open the PNG parameter restore panel for an asset. */
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

/** Restore this PNG's embedded workflow as a new workflow record. */
async function restoreWorkflow(): Promise<void> {
  if (!detail.value) return
  try {
    const rec = await ipc('output.importToWorkflow', detail.value.path)
    if (rec) {
      message.success(t('output.restored', { name: rec.name }))
      showDetail.value = false
    } else {
      message.warning(t('output.noEmbeddedWorkflow'))
    }
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

onMounted(async () => {
  // Prefer the configured output index root so users don't re-browse every time.
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
      <NSpace>
        <NInput v-model:value="root" :placeholder="$t('output.rootPlaceholder')" style="width: 240px">
          <template #suffix>
            <NButton size="tiny" secondary @click="pickRoot">{{ $t('output.browse') }}</NButton>
          </template>
        </NInput>
        <NSelect
          v-model:value="type"
          :options="typeOptions"
          style="width: 110px"
        />
        <NButton type="primary" @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>{{ $t('output.scan') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
      <NSpin :show="loading">
        <div v-if="assets.length">
          <NGrid :cols="4" :x-gap="14" :y-gap="14">
            <NGi v-for="a in assets" :key="a.id">
              <div class="card asset" @click="openDetail(a)">
                <div class="thumb">
                  <img v-if="a.thumbnail" :src="a.thumbnail" class="thumb-img" :alt="a.fileName" />
                  <NIcon
                    v-else
                    :size="36"
                    :component="a.type === 'video' ? VideocamOutline : ImageOutline"
                  />
                </div>
                <div class="asset-name">{{ a.fileName }}</div>
                <div class="asset-meta">
                  {{ formatBytes(a.size) }}<span v-if="a.seed"> · seed {{ a.seed }}</span>
                </div>
                <NSpace justify="center">
                  <NButton size="tiny" secondary @click.stop="ipc('output.open', a.path)">
                    <template #icon><NIcon :component="OpenOutline" /></template>{{ $t('output.open') }}
                  </NButton>
                  <NButton size="tiny" secondary @click.stop="openDetail(a)">{{ $t('output.params') }}</NButton>
                </NSpace>
              </div>
            </NGi>
          </NGrid>
        </div>
        <NEmpty v-else :description="$t('output.empty')" class="empty" />
      </NSpin>
    </div>

    <NModal
      v-model:show="showDetail"
      preset="card"
      :title="detail?.fileName || $t('output.detailTitle')"
      style="width: 640px; border-radius: 20px"
    >
      <div v-if="detail" class="detail-body">
        <div class="detail-preview">
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
          <NButton secondary @click="detail && ipc('output.open', detail.path)">{{ $t('output.openFile') }}</NButton>
          <NButton type="primary" @click="restoreWorkflow">
            <template #icon><NIcon :component="GitBranchOutline" /></template>
            {{ $t('output.restoreWorkflow') }}
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
}
.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
  height: 180px;
  border-radius: 12px;
  background: $gradient-soft;
  display: grid;
  place-items: center;
  overflow: hidden;
}
.detail-img {
  max-width: 100%;
  max-height: 180px;
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
</style>
