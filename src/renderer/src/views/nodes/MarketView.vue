<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SearchOutline, DownloadOutline, StarOutline, RefreshOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NInput, NList, NListItem, NSpace, NSpin, NTag, NEmpty, NProgress, useMessage } from 'naive-ui'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { useAppStore } from '@/stores/app'
import type { MarketItem, RegistryPageResult } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const loading = ref(false)
const loadingMore = ref(false)
const indexing = ref(false)
const indexProgress = ref<{ done: number; total: number; count: number } | null>(null)
const items = ref<MarketItem[]>([])
const query = ref('')
const activeQuery = ref('')
const page = ref(1)
const totalPages = ref(1)
const total = ref(0)
const scanned = ref(0)
const indexCount = ref(0)
const indexUpdatedAt = ref(0)
const pageSize = 40

function hint(): string {
  if (activeQuery.value) {
    return t('market.hintMatch', {
      query: activeQuery.value,
      scanned: scanned.value || indexCount.value,
      total: total.value
    })
  }
  const idx = indexCount.value
    ? indexUpdatedAt.value
      ? t('market.hintIndexTime', {
          n: indexCount.value,
          time: new Date(indexUpdatedAt.value).toLocaleString()
        })
      : t('market.hintIndex', { n: indexCount.value })
    : ''
  return idx
    ? t('market.hintPagingWithIndex', {
        total: total.value,
        page: page.value,
        pages: Math.max(1, totalPages.value),
        idx
      })
    : t('market.hintPaging', {
        total: total.value,
        page: page.value,
        pages: Math.max(1, totalPages.value)
      })
}

async function loadIndexStatus(): Promise<void> {
  try {
    const s = await ipc('registry.indexStatus')
    indexCount.value = s.count
    indexUpdatedAt.value = s.updatedAt
  } catch {
    /* ignore */
  }
}

async function refreshIndex(): Promise<void> {
  indexing.value = true
  indexProgress.value = null
  try {
    const s = await ipc('registry.refreshIndex')
    indexCount.value = s.count
    indexUpdatedAt.value = s.updatedAt
    message.success(t('market.indexUpdated', { n: s.count }))
    if (activeQuery.value) await load(true)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    indexing.value = false
    indexProgress.value = null
  }
}

async function load(reset = true): Promise<void> {
  if (reset) {
    loading.value = true
    page.value = 1
    items.value = []
    activeQuery.value = query.value.trim()
  } else {
    loadingMore.value = true
  }
  try {
    const res: RegistryPageResult<MarketItem> = await ipc('market.list', {
      query: activeQuery.value || undefined,
      page: reset ? 1 : page.value + 1,
      limit: pageSize,
      instanceId: store.activeInstanceId || undefined
    })
    if (reset) items.value = res.items
    else items.value = [...items.value, ...res.items]
    total.value = res.total
    totalPages.value = res.totalPages
    scanned.value = res.scanned
    page.value = res.page
    if (reset && !res.items.length) {
      message.info(activeQuery.value ? t('market.noMatches') : t('market.registryEmpty'))
    }
    void loadIndexStatus()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore(): Promise<void> {
  if (page.value >= totalPages.value) return
  await load(false)
}

async function install(item: MarketItem): Promise<void> {
  try {
    await ipc('market.install', item.id, store.activeInstanceId || undefined)
    message.success(t('market.installedItem', { name: item.name }))
    await load(true)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

let offProgress: (() => void) | null = null

onMounted(() => {
  offProgress = onIpc(IPC_EVENTS.registryIndexProgress, (p) => {
    indexProgress.value = p as { done: number; total: number; count: number }
    indexing.value = true
  })
  void loadIndexStatus()
  void load(true)
  // warm the full-catalog index in background so search is instant
  void ipc('registry.ensureIndex')
    .then((s) => {
      indexCount.value = s.count
      indexUpdatedAt.value = s.updatedAt
    })
    .catch(() => undefined)
    .finally(() => {
      indexing.value = false
      indexProgress.value = null
    })
})

onUnmounted(() => offProgress?.())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('market.title') }}</h1>
        <p class="page-subtitle">{{ $t('market.subtitle') }} {{ hint() }}</p>
      </div>
      <NSpace>
        <NInput
          v-model:value="query"
          :placeholder="$t('market.searchPlaceholder')"
          clearable
          style="width: 280px"
          @keyup.enter="load(true)"
          @clear="load(true)"
        >
          <template #prefix><NIcon :component="SearchOutline" /></template>
        </NInput>
        <NButton type="primary" @click="load(true)">{{ $t('market.search') }}</NButton>
        <NButton secondary :loading="indexing" @click="refreshIndex">
          <template #icon><NIcon :component="RefreshOutline" /></template>
          {{ $t('market.refreshIndex') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
      <div v-if="indexing && indexProgress" class="index-banner">
        <NProgress
          type="line"
          :percentage="indexProgress.total ? Math.min(100, Math.round((indexProgress.done / indexProgress.total) * 100)) : 0"
          :height="8"
          processing
        />
        <div class="meta">{{ $t('market.indexing', { done: indexProgress.done, total: indexProgress.total, count: indexProgress.count }) }}</div>
      </div>

      <NSpin :show="loading">
        <NList v-if="items.length" bordered class="market-list">
          <NListItem v-for="item in items" :key="item.id">
            <div class="row">
              <div>
                <div class="name">{{ item.displayName }}</div>
                <div class="desc">{{ item.description }}</div>
                <div class="tags">
                  <NTag v-if="item.author" size="tiny" round>{{ item.author }}</NTag>
                  <NTag v-if="item.version" size="tiny" round>v{{ item.version }}</NTag>
                  <NTag v-if="item.category" size="tiny" round>{{ item.category }}</NTag>
                  <NTag size="tiny" round>
                    <template #icon><NIcon :component="StarOutline" /></template>
                    {{ item.stars }}
                  </NTag>
                  <NTag size="tiny" round>{{ item.downloads }} DL</NTag>
                  <NTag v-if="item.installed" size="tiny" round type="success">{{ $t('market.installedTag') }}</NTag>
                </div>
              </div>
              <NButton type="primary" secondary :disabled="item.installed" @click="install(item)">
                <template #icon><NIcon :component="DownloadOutline" /></template>
                {{ item.installed ? $t('market.installedTag') : $t('market.install') }}
              </NButton>
            </div>
          </NListItem>
        </NList>
        <NEmpty v-else-if="!loading" :description="$t('market.empty')" style="padding: 48px 0" />
      </NSpin>

      <div v-if="items.length" class="more-row">
        <NButton secondary :loading="loadingMore" :disabled="page >= totalPages" @click="loadMore">
          {{ page < totalPages ? $t('market.loadMore') : $t('market.lastPage') }}
        </NButton>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.row { display: flex; justify-content: space-between; gap: 16px; align-items: center; width: 100%; }
.name { font-size: 15px; font-weight: 700; }
.desc { font-size: 13px; color: $color-text-secondary; margin: 4px 0 8px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.more-row { display: flex; justify-content: center; padding: 16px 0 8px; }
.index-banner { margin-bottom: 12px; padding: 12px 14px; border-radius: 12px; background: rgba(79, 110, 247, 0.08); }
.meta { font-size: 12px; color: $color-text-secondary; margin-top: 6px; }
</style>
