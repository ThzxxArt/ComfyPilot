<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { SearchOutline, DownloadOutline, StarOutline, RefreshOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NInput, NList, NListItem, NSpace, NSpin, NTag, NEmpty, NProgress, useMessage } from 'naive-ui'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import type { MarketItem, RegistryPageResult } from '@shared/types'

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
    return `「${activeQuery.value}」在全库 ${scanned.value || indexCount.value} 条中匹配 ${total.value} 条`
  }
  const idx = indexCount.value
    ? `全库索引 ${indexCount.value} 条${indexUpdatedAt.value ? ' · ' + new Date(indexUpdatedAt.value).toLocaleString() : ''}`
    : ''
  return `Registry 共 ${total.value} 个插件 · 第 ${page.value}/${Math.max(1, totalPages.value)} 页${idx ? ' · ' + idx : ''}`
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
    message.success(`全库索引已更新：${s.count} 条`)
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
      limit: pageSize
    })
    if (reset) items.value = res.items
    else items.value = [...items.value, ...res.items]
    total.value = res.total
    totalPages.value = res.totalPages
    scanned.value = res.scanned
    page.value = res.page
    if (reset && !res.items.length) {
      message.info(activeQuery.value ? '全库中没有匹配的插件' : 'Registry 暂无数据')
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
    await ipc('market.install', item.id)
    message.success(`已安装 ${item.name}`)
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
        <h1 class="page-title">插件市场</h1>
        <p class="page-subtitle">Comfy Registry 插件库（真实分页 + 本地检索）。{{ hint() }}</p>
      </div>
      <NSpace>
        <NInput
          v-model:value="query"
          placeholder="搜索名称 / 描述 / 作者 / 标签"
          clearable
          style="width: 280px"
          @keyup.enter="load(true)"
          @clear="load(true)"
        >
          <template #prefix><NIcon :component="SearchOutline" /></template>
        </NInput>
        <NButton type="primary" @click="load(true)">搜索</NButton>
        <NButton secondary :loading="indexing" @click="refreshIndex">
          <template #icon><NIcon :component="RefreshOutline" /></template>
          更新全库索引
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
        <div class="meta">正在建立全库索引 {{ indexProgress.done }}/{{ indexProgress.total }} 页 · 已收 {{ indexProgress.count }} 条</div>
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
                  <NTag v-if="item.installed" size="tiny" round type="success">已安装</NTag>
                </div>
              </div>
              <NButton type="primary" secondary :disabled="item.installed" @click="install(item)">
                <template #icon><NIcon :component="DownloadOutline" /></template>
                {{ item.installed ? '已安装' : '安装' }}
              </NButton>
            </div>
          </NListItem>
        </NList>
        <NEmpty v-else-if="!loading" description="暂无数据" style="padding: 48px 0" />
      </NSpin>

      <div v-if="items.length" class="more-row">
        <NButton secondary :loading="loadingMore" :disabled="page >= totalPages" @click="loadMore">
          {{ page < totalPages ? '加载下一页' : '已到末页' }}
        </NButton>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.row { display: flex; justify-content: space-between; gap: 16px; align-items: center; width: 100%; }
.name { font-size: 15px; font-weight: 720; }
.desc { font-size: 13px; color: $color-text-secondary; margin: 4px 0 8px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.more-row { display: flex; justify-content: center; padding: 16px 0 8px; }
.index-banner { margin-bottom: 12px; padding: 12px 14px; border-radius: 12px; background: rgba(79, 110, 247, 0.08); }
.meta { font-size: 12px; color: $color-text-secondary; margin-top: 6px; }
</style>
