<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpace, NIcon, NInput, useMessage } from 'naive-ui'
import { OpenOutline, CloseOutline, ArrowBackOutline, RefreshOutline } from '@vicons/ionicons5'
import { ipc } from '@/composables/useIpc'
import { useAppStore } from '@/stores/app'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const store = useAppStore()
const url = ref(String(route.query.url || ''))
const embedded = ref(false)
const showFallback = ref(false)

// Layout metrics published by App.vue (sidebar collapse-aware)
const sidebarWidth = ref(240)
const headerHeight = ref(64)
const TOOLBAR_H = 56

const displayUrl = computed(() => url.value || 'http://127.0.0.1:8188')

function embedEnabled(): boolean {
  return store.settings?.embedFrontend !== false
}

function currentRect(): { x: number; y: number; width: number; height: number } {
  return {
    x: sidebarWidth.value,
    y: headerHeight.value + TOOLBAR_H,
    width: Math.max(200, window.innerWidth - sidebarWidth.value),
    height: Math.max(160, window.innerHeight - headerHeight.value - TOOLBAR_H)
  }
}

function applyResize(): void {
  if (!embedded.value) return
  void ipc('embed.resize', currentRect())
}

function onLayout(e: Event): void {
  const detail = (e as CustomEvent<{ sidebarWidth?: number; headerHeight?: number }>).detail
  if (detail?.sidebarWidth != null) sidebarWidth.value = detail.sidebarWidth
  if (detail?.headerHeight != null) headerHeight.value = detail.headerHeight
  applyResize()
}

async function embed(): Promise<void> {
  if (!displayUrl.value) return
  if (!embedEnabled()) {
    showFallback.value = true
    message.info('已关闭内嵌 Frontend，正在用系统浏览器打开')
    await openExternal()
    return
  }
  try {
    await ipc('embed.open', { url: displayUrl.value, title: 'ComfyUI' })
    embedded.value = true
    showFallback.value = false
    await ipc('embed.resize', currentRect())
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
  applyResize()
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  window.addEventListener('comfypilot:layout', onLayout as EventListener)
  // Pull current layout metrics if App already published them
  window.dispatchEvent(new Event('comfypilot:layout-request'))
  if (url.value) void embed()
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('comfypilot:layout', onLayout as EventListener)
  void ipc('embed.close').catch(() => undefined)
})

// Keep URL in sync when navigating to /embed with a new query
watch(
  () => route.query.url,
  (v) => {
    const next = String(v || '')
    if (next && next !== url.value) {
      url.value = next
      void embed()
    }
  }
)
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
  flex-shrink: 0;
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
