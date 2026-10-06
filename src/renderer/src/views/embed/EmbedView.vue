<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpace, NIcon, NInput, useMessage } from 'naive-ui'
import { OpenOutline, CloseOutline, ArrowBackOutline, RefreshOutline } from '@vicons/ionicons5'
import { ipc } from '@/composables/useIpc'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const url = ref(String(route.query.url || ''))
const embedded = ref(false)
const showFallback = ref(false)

const displayUrl = computed(() => url.value || 'http://127.0.0.1:8188')

async function embed(): Promise<void> {
  if (!displayUrl.value) return
  try {
    await ipc('embed.open', { url: displayUrl.value, title: 'ComfyUI' })
    embedded.value = true
    showFallback.value = false
    // Sidebar 240 + header 64 + local toolbar 56
    await ipc('embed.resize', {
      x: 240,
      y: 64 + 56,
      width: Math.max(200, window.innerWidth - 240),
      height: Math.max(160, window.innerHeight - 64 - 56)
    })
  } catch (err) {
    showFallback.value = true
    message.warning('内嵌视图不可用，已切换为外链模式')
    console.error(err)
  }
}

async function openExternal(): Promise<void> {
  await ipc('shell.openExternal', displayUrl.value)
}

async function closeEmbed(): Promise<void> {
  await ipc('embed.close')
  embedded.value = false
  showFallback.value = true
}

function onResize(): void {
  if (!embedded.value) return
  void ipc('embed.resize', {
    x: 240,
    y: 64 + 56,
    width: Math.max(200, window.innerWidth - 240),
    height: Math.max(160, window.innerHeight - 64 - 56)
  })
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  if (url.value) void embed()
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  void ipc('embed.close').catch(() => undefined)
})
</script>

<template>
  <div class="embed-page">
    <div class="embed-bar glass">
      <NSpace align="center" :size="10">
        <NButton text @click="router.back()">
          <template #icon>
            <NIcon :component="ArrowBackOutline" />
          </template>
          返回
        </NButton>
        <NInput v-model:value="url" placeholder="ComfyUI 地址，例如 http://127.0.0.1:8188" style="width: 360px" />
        <NButton type="primary" secondary @click="embed">内嵌加载</NButton>
        <NButton secondary @click="openExternal">
          <template #icon>
            <NIcon :component="OpenOutline" />
          </template>
          浏览器打开
        </NButton>
        <NButton v-if="embedded" secondary @click="embed">
          <template #icon>
            <NIcon :component="RefreshOutline" />
          </template>
          重载
        </NButton>
        <NButton v-if="embedded" secondary type="error" @click="closeEmbed">
          <template #icon>
            <NIcon :component="CloseOutline" />
          </template>
          关闭内嵌
        </NButton>
      </NSpace>
    </div>

    <div v-if="!embedded" class="fallback card">
      <div class="fallback-title">ComfyUI Frontend</div>
      <p class="fallback-text">
        将在应用内通过 WebContentsView 内嵌官方 Frontend。若内嵌不可用，可一键外链在系统浏览器打开。
      </p>
      <NSpace>
        <NButton type="primary" @click="embed">加载内嵌视图</NButton>
        <NButton secondary @click="openExternal">外链浏览器</NButton>
      </NSpace>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.embed-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
}

.embed-bar {
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  z-index: 2;
}

.fallback {
  margin: 40px auto;
  max-width: 560px;
  padding: 28px;
  text-align: center;
}

.fallback-title {
  font-size: 22px;
  font-weight: 750;
  background: $gradient-primary;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.fallback-text {
  color: $color-text-secondary;
  line-height: 1.65;
  margin: 12px 0 20px;
}
</style>
