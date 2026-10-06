<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { SearchOutline, DownloadOutline, StarOutline } from '@vicons/ionicons5'
import { NButton, NIcon, NInput, NList, NListItem, NSpace, NSpin, NTag, useMessage } from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import type { MarketItem } from '@shared/types'

const message = useMessage()
const loading = ref(false)
const items = ref<MarketItem[]>([])
const query = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    items.value = await ipc('market.list', { query: query.value })
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function install(item: MarketItem): Promise<void> {
  try {
    await ipc('market.install', item.id)
    message.success(`已安装 ${item.name}`)
    await load()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(() => void load())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">插件市场</h1>
        <p class="page-subtitle">浏览 Comfy Registry 精选节点包，一键安装。</p>
      </div>
      <NSpace>
        <NInput v-model:value="query" placeholder="搜索插件" style="width: 240px" @keyup.enter="load">
          <template #prefix><NIcon :component="SearchOutline" /></template>
        </NInput>
        <NButton type="primary" @click="load">搜索</NButton>
      </NSpace>
    </div>

    <NSpin :show="loading">
      <NList bordered class="market-list">
        <NListItem v-for="item in items" :key="item.id">
          <div class="row">
            <div>
              <div class="name">{{ item.displayName }}</div>
              <div class="desc">{{ item.description }}</div>
              <div class="tags">
                <NTag size="tiny" round>{{ item.author }}</NTag>
                <NTag size="tiny" round>{{ item.version }}</NTag>
                <NTag size="tiny" round>{{ item.category }}</NTag>
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
    </NSpin>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.row { display: flex; justify-content: space-between; gap: 16px; align-items: center; width: 100%; }
.name { font-size: 15px; font-weight: 720; }
.desc { font-size: 13px; color: $color-text-secondary; margin: 4px 0 8px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
