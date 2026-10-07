<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { SearchOutline, DownloadOutline, StarOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NInput, NList, NListItem, NSpace, NSpin, NTag, NEmpty, useMessage } from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import type { MarketItem, RegistryPageResult } from '@shared/types'

const message = useMessage()
const loading = ref(false)
const loadingMore = ref(false)
const items = ref<MarketItem[]>([])
const query = ref('')
const activeQuery = ref('')
const page = ref(1)
const totalPages = ref(1)
const total = ref(0)
const scanned = ref(0)
const pageSize = 40
const scanPages = ref(20)

function hint(): string {
  if (activeQuery.value) {
    return `「${activeQuery.value}」匹配 ${total.value} 条 · 已扫描 ${scanned.value} 条 Registry 数据`
  }
  return `Registry 共 ${total.value} 个插件 · 第 ${page.value}/${Math.max(1, totalPages.value)} 页`
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
      scanPages: scanPages.value
    })
    if (reset) items.value = res.items
    else items.value = [...items.value, ...res.items]
    total.value = res.total
    totalPages.value = res.totalPages
    scanned.value = res.scanned
    page.value = res.page
    if (reset && !res.items.length) {
      message.info(activeQuery.value ? '没有匹配的插件，可尝试更短的关键词' : 'Registry 暂无数据')
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore(): Promise<void> {
  if (page.value >= totalPages.value) {
    // search mode: widen the remote scan window
    scanPages.value = Math.min(60, scanPages.value + 20)
    await load(true)
    return
  }
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

onMounted(() => void load(true))
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
      </NSpace>
    </div>

    <div class="page-body">
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
        <NButton secondary :loading="loadingMore" @click="loadMore">
          {{ page < totalPages ? '加载下一页' : '扩大搜索范围' }}
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
</style>
