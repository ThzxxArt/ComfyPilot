<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { OpenOutline, RefreshOutline, ImageOutline, VideocamOutline } from '@vicons/ionicons5'
import {
  NButton, NIcon, NSpace, NSpin, NEmpty, NInput, NSelect, useMessage, NGrid, NGi
} from 'naive-ui'
import { ipc } from '@/composables/useIpc'
import { formatBytes } from '@/utils/format'
import type { OutputAsset } from '@shared/types'

const message = useMessage()
const loading = ref(false)
const assets = ref<OutputAsset[]>([])
const root = ref('')
const type = ref('all')

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
    await refresh()
  }
}

onMounted(() => void refresh())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">产物库</h1>
        <p class="page-subtitle">索引 output 目录，还原 PNG 参数与 seed。</p>
      </div>
      <NSpace>
        <NInput v-model:value="root" placeholder="output 根目录" style="width: 240px">
          <template #suffix>
            <NButton size="tiny" secondary @click="pickRoot">浏览</NButton>
          </template>
        </NInput>
        <NSelect
          v-model:value="type"
          :options="[
            { label: '全部', value: 'all' },
            { label: '图像', value: 'image' },
            { label: '视频', value: 'video' },
            { label: '音频', value: 'audio' }
          ]"
          style="width: 110px"
        />
        <NButton type="primary" @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>扫描
        </NButton>
      </NSpace>
    </div>

    <NSpin :show="loading">
      <div v-if="assets.length">
        <NGrid :cols="4" :x-gap="14" :y-gap="14">
          <NGi v-for="a in assets" :key="a.id">
            <div class="card asset">
              <div class="thumb">
                <NIcon :size="36" :component="a.type === 'video' ? VideocamOutline : ImageOutline" />
              </div>
              <div class="asset-name">{{ a.fileName }}</div>
              <div class="asset-meta">{{ formatBytes(a.size) }}<span v-if="a.seed"> · seed {{ a.seed }}</span></div>
              <NButton size="tiny" secondary @click="ipc('output.open', a.path)">
                <template #icon><NIcon :component="OpenOutline" /></template>打开
              </NButton>
            </div>
          </NGi>
        </NGrid>
      </div>
      <NEmpty v-else description="选择 output 目录后点击扫描" class="empty" />
    </NSpin>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.asset { padding: 14px; text-align: center; }
.thumb {
  height: 120px;
  border-radius: 12px;
  background: $gradient-soft;
  display: grid;
  place-items: center;
  color: $color-primary;
  margin-bottom: 10px;
}
.asset-name { font-size: 12.5px; font-weight: 650; word-break: break-all; }
.asset-meta { font-size: 11px; color: $color-text-muted; margin: 6px 0 10px; }
.empty { padding: 64px 0; }
</style>
