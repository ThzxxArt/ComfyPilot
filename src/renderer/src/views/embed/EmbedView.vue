<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpace, NIcon, NInput, useMessage } from 'naive-ui'
import { OpenOutline, CloseOutline, ArrowBackOutline, RefreshOutline } from '@vicons/ionicons5'
import { ipc, onIpc } from '@/composables/useIpc'
import { IPC_EVENTS } from '@shared/types'
import { useAppStore } from '@/stores/app'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const store = useAppStore()
const url = ref(String(route.query.url || ''))
const embedded = ref(false)
const showFallback = ref(false)
/** 0.1.17 (WP9): a failed in-pane load must be visible, not a blank rectangle. */
const embedError = ref('')
let offEmbedState: (() => void) | null = null

// Layout metrics published by App.vue (sidebar collapse-aware)
const sidebarWidth = ref(240)
const headerHeight = ref(64)

// 工具栏高度实测：文案换行/窄窗口会让工具栏变高，硬编码会把内嵌区域算错
const barEl = ref<HTMLElement | null>(null)
const barHeight = ref(56)
let barObserver: ResizeObserver | null = null

// 0.1.17 (WP9): default to the ACTIVE instance's URL (honours custom ports and
// remotes) instead of a hardcoded 127.0.0.1:8188 that may belong to another one.
const displayUrl = computed(() => url.value || store.activeTargetUrl || '')

function measureBar(): void {
  const h = barEl.value?.getBoundingClientRect().height
  if (h && h > 0) barHeight.value = Math.round(h)
}

function embedEnabled(): boolean {
  return store.settings?.embedFrontend !== false
}

function currentRect(): { x: number; y: number; width: number; height: number } {
  const top = headerHeight.value + barHeight.value
  return {
    x: sidebarWidth.value,
    y: top,
    width: Math.max(200, window.innerWidth - sidebarWidth.value),
    height: Math.max(160, window.innerHeight - top)
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

/**
 * 0.1.18 (WP6 / U6): `embedded` used to flip true only AFTER `embed.open`
 * resolved. Unmounting (or switching URL) during that window let the view's
 * `embed.close` run first and the late `open` then attach a view nobody owns.
 * The flag is now optimistic and every async continuation checks its epoch.
 */
let embedEpoch = 0

async function embed(): Promise<void> {
  if (!displayUrl.value) return
  if (!embedEnabled()) {
    showFallback.value = true
    message.info(t('embed.embedDisabledInfo'))
    await openExternal()
    return
  }
  const epoch = ++embedEpoch
  embedded.value = true
  showFallback.value = false
  embedError.value = ''
  try {
    await ipc('embed.open', { url: displayUrl.value, title: 'ComfyUI' })
    if (epoch !== embedEpoch) {
      // A close/newer open won the race — close what we just opened.
      await ipc('embed.close').catch(() => undefined)
      return
    }
    await ipc('embed.resize', currentRect())
  } catch (err) {
    if (epoch !== embedEpoch) return
    embedded.value = false
    showFallback.value = true
    embedError.value = err instanceof Error ? err.message : String(err)
    message.warning(t('embed.embedUnavailable'))
    console.error(err)
  }
}

async function openExternal(): Promise<void> {
  await ipc('shell.openExternal', displayUrl.value)
}

async function closeEmbed(): Promise<void> {
  embedEpoch += 1
  await ipc('embed.close')
  embedded.value = false
  showFallback.value = true
}

function onResize(): void {
  measureBar()
  applyResize()
}

onMounted(() => {
  offEmbedState = onIpc(IPC_EVENTS.embedState, (payload) => {
    const p = payload as { state?: string; errorDescription?: string }
    if (p?.state === 'failed') {
      embedError.value = p.errorDescription || t('embed.loadFailed')
    } else if (p?.state === 'ready') {
      embedError.value = ''
    }
  })
  window.addEventListener('resize', onResize)
  window.addEventListener('comfypilot:layout', onLayout as EventListener)
  // Pull current layout metrics if App already published them
  window.dispatchEvent(new Event('comfypilot:layout-request'))
  void nextTick(() => {
    measureBar()
    if (barEl.value && typeof ResizeObserver !== 'undefined') {
      barObserver = new ResizeObserver(() => {
        measureBar()
        applyResize()
      })
      barObserver.observe(barEl.value)
    }
  })
  if (url.value) void embed()
})

onUnmounted(() => {
  embedEpoch += 1
  offEmbedState?.()
  offEmbedState = null
  window.removeEventListener('resize', onResize)
  window.removeEventListener('comfypilot:layout', onLayout as EventListener)
  barObserver?.disconnect()
  barObserver = null
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
    <div ref="barEl" class="embed-bar glass">
      <NSpace align="center" :size="10">
        <NButton text @click="router.back()">
          <template #icon>
            <NIcon :component="ArrowBackOutline" />
          </template>
          {{ $t('embed.back') }}
        </NButton>
        <NInput
          v-model:value="url"
          :placeholder="$t('embed.urlPlaceholder')"
          style="width: 360px"
        />
        <NButton type="primary" secondary @click="embed">{{ $t('embed.load') }}</NButton>
        <NButton secondary @click="openExternal">
          <template #icon>
            <NIcon :component="OpenOutline" />
          </template>
          {{ $t('embed.openBrowser') }}
        </NButton>
        <NButton v-if="embedded" secondary @click="embed">
          <template #icon>
            <NIcon :component="RefreshOutline" />
          </template>
          {{ $t('embed.reload') }}
        </NButton>
        <NButton v-if="embedded" secondary type="error" @click="closeEmbed">
          <template #icon>
            <NIcon :component="CloseOutline" />
          </template>
          {{ $t('embed.closeEmbed') }}
        </NButton>
      </NSpace>
    </div>

    <div v-if="embedded && embedError" class="embed-error card">
      <div class="fallback-title">{{ $t('embed.loadFailed') }}</div>
      <p class="fallback-text mono">{{ embedError }}</p>
      <NSpace>
        <NButton type="primary" secondary @click="embed">{{ $t('embed.reload') }}</NButton>
        <NButton secondary @click="closeEmbed">{{ $t('embed.closeEmbed') }}</NButton>
        <NButton secondary @click="openExternal">{{ $t('embed.openBrowser') }}</NButton>
      </NSpace>
    </div>

    <div v-if="!embedded" class="fallback card">
      <div class="fallback-title">ComfyUI Frontend</div>
      <p class="fallback-text">
        {{ $t('embed.fallbackText') }}
      </p>
      <NSpace>
        <NButton type="primary" @click="embed">{{ $t('embed.loadView') }}</NButton>
        <NButton secondary @click="openExternal">{{ $t('embed.externalBrowser') }}</NButton>
      </NSpace>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.embed-error {
  position: absolute;
  left: 50%;
  top: 40%;
  transform: translate(-50%, -50%);
  z-index: 5;
  max-width: 560px;
  padding: 18px 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.embed-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
}

.embed-bar {
  min-height: 56px;
  display: flex;
  align-items: center;
  padding: 8px 16px;
  border: none;
  border-bottom: 1px solid rgba($color-text-muted, 0.18);
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
  font-weight: 700;
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
