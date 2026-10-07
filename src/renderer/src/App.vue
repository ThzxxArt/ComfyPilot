<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  SpeedometerOutline,
  ServerOutline,
  FolderOpenOutline,
  ExtensionPuzzleOutline,
  GitBranchOutline,
  PulseOutline,
  MedkitOutline,
  SettingsOutline,
  OpenOutline,
  LogoGithub,
  StorefrontOutline,
  PlayForwardOutline,
  ImagesOutline,
  SaveOutline,
  RocketOutline,
  PlayOutline,
  StopOutline
} from '@vicons/ionicons5'
import {
  NIcon, NAvatar, NButton, NSpace, NTooltip, NMessageProvider, NDialogProvider,
  NConfigProvider, NSelect, NTag
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { useI18n } from 'vue-i18n'
import { APP_VERSION } from '@shared/constants'
import { COLORS } from '@/styles/tokens'
import type { ComfyInstanceInfo } from '@shared/types'

const router = useRouter()
const route = useRoute()
const store = useAppStore()
const collapsed = ref(false)
const { t, locale } = useI18n()
const { launch, stop, busy } = useLaunch()

// Sidebar width used by embed.resize — keep in sync with $nav-width / collapsed state
const SIDEBAR_W = 240
const SIDEBAR_W_COLLAPSED = 72

const nav = computed(() => [
  // 生产
  { key: 'dashboard', label: t('nav.dashboard'), icon: SpeedometerOutline, path: '/', group: 'produce' as const },
  { key: 'instances', label: t('nav.instances'), icon: ServerOutline, path: '/instances', group: 'produce' as const },
  { key: 'workflows', label: t('nav.workflows'), icon: GitBranchOutline, path: '/workflows', group: 'produce' as const },
  { key: 'batch', label: t('nav.batch'), icon: PlayForwardOutline, path: '/batch', group: 'produce' as const },
  { key: 'output', label: t('nav.output'), icon: ImagesOutline, path: '/output', group: 'produce' as const },
  // 资产
  { key: 'models', label: t('nav.models'), icon: FolderOpenOutline, path: '/models', group: 'assets' as const },
  { key: 'nodes', label: t('nav.nodes'), icon: ExtensionPuzzleOutline, path: '/nodes', group: 'assets' as const },
  { key: 'market', label: t('nav.market'), icon: StorefrontOutline, path: '/market', group: 'assets' as const },
  // 运维
  { key: 'monitor', label: t('nav.monitor'), icon: PulseOutline, path: '/monitor', group: 'ops' as const },
  { key: 'doctor', label: t('nav.doctor'), icon: MedkitOutline, path: '/doctor', group: 'ops' as const },
  { key: 'install', label: t('nav.install'), icon: RocketOutline, path: '/install', group: 'ops' as const },
  { key: 'backup', label: t('nav.backup'), icon: SaveOutline, path: '/backup', group: 'ops' as const },
  { key: 'settings', label: t('nav.settings'), icon: SettingsOutline, path: '/settings', group: 'ops' as const }
])

const navGroups = computed(() => {
  const g = { produce: [] as typeof nav.value, assets: [] as typeof nav.value, ops: [] as typeof nav.value }
  for (const item of nav.value) g[item.group].push(item)
  return [
    { key: 'produce', label: t('nav.groupProduce'), items: g.produce },
    { key: 'assets', label: t('nav.groupAssets'), items: g.assets },
    { key: 'ops', label: t('nav.groupOps'), items: g.ops }
  ].filter((x) => x.items.length)
})

/** Align Naive UI chrome with the blue-violet design tokens (no more green default). */
const themeOverrides = {
  common: {
    primaryColor: COLORS.primary,
    primaryColorHover: COLORS.primaryHover,
    primaryColorPressed: COLORS.primaryPressed,
    primaryColorSuppl: COLORS.primary2,
    borderRadius: '12px',
    borderRadiusSmall: '8px',
    fontFamily:
      "'Inter','Segoe UI','PingFang SC','HarmonyOS Sans SC','Microsoft YaHei',system-ui,sans-serif",
    fontSize: '14px',
    successColor: COLORS.success,
    warningColor: COLORS.warning,
    errorColor: COLORS.danger,
    textColorBase: COLORS.text
  },
  Button: { fontWeight: '600' },
  Card: { borderRadius: '16px' },
  Modal: { borderRadius: '20px' }
}

const activeKey = computed(() => {
  const hit = nav.value.find((n) => route.path === n.path || (n.path !== '/' && route.path.startsWith(n.path)))
  return hit?.key ?? 'dashboard'
})

const runningCount = computed(() => store.instances.filter((i) => i.status === 'running').length)

const instanceOptions = computed(() =>
  store.instances.map((i: ComfyInstanceInfo) => ({
    label: `${i.name} · ${i.port} · ${i.status}`,
    value: i.id
  }))
)

const selectedInstanceId = computed({
  get: () => store.activeInstanceId || store.instances[0]?.id || null,
  set: (v: string | null) => {
    store.activeInstanceId = v
  }
})

const activeStatus = computed(() => store.activeInstance?.status || 'unknown')
const activeStatusLabel = computed(() => {
  const s = activeStatus.value
  try {
    return t(`status.${s}`)
  } catch {
    return s
  }
})

const sidebarWidth = computed(() => (collapsed.value ? SIDEBAR_W_COLLAPSED : SIDEBAR_W))

function notifyEmbedLayout(): void {
  // Publish sidebar metrics so EmbedView can size the WebContentsView correctly
  window.dispatchEvent(
    new CustomEvent('comfypilot:layout', {
      detail: {
        sidebarWidth: sidebarWidth.value,
        headerHeight: 64
      }
    })
  )
}

function onLayoutRequest(): void {
  notifyEmbedLayout()
}

watch([collapsed, sidebarWidth], () => notifyEmbedLayout())

let dispose: (() => void) | null = null

onMounted(async () => {
  await store.bootstrap()
  if (store.settings?.locale) locale.value = store.settings.locale
  dispose = store.bindLive()
  notifyEmbedLayout()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('comfypilot:layout-request', onLayoutRequest)
})

onUnmounted(() => {
  dispose?.()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('comfypilot:layout-request', onLayoutRequest)
})

function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  // Ctrl+, → settings
  if (e.key === ',') {
    e.preventDefault()
    void router.push('/settings')
    return
  }
  // Ctrl+1..9 → nav pages
  if (e.key >= '1' && e.key <= '9') {
    const idx = Number(e.key) - 1
    const item = nav.value[idx]
    if (item) {
      e.preventDefault()
      void router.push(item.path)
    }
    return
  }
  // Ctrl+Enter → launch active instance and open embed
  if (e.key === 'Enter') {
    e.preventDefault()
    void launchActive()
  }
}

async function launchActive(): Promise<void> {
  const inst = store.activeInstance
  if (!inst) return
  await launch(inst, { open: 'embed' })
}

function go(path: string): void {
  void router.push(path)
}

function openComfy(): void {
  const inst = store.activeInstance
  if (inst?.url) {
    void ipc('shell.openExternal', inst.url)
  }
}

function openEmbed(): void {
  const inst = store.activeInstance
  if (inst?.url) void router.push({ path: '/embed', query: { url: inst.url } })
}

function openGithub(): void {
  void ipc('shell.openExternal', 'https://github.com/ThzxxArt/ComfyPilot')
}

function toggleCollapse(): void {
  collapsed.value = !collapsed.value
}

async function toggleInstanceRun(): Promise<void> {
  const inst = store.activeInstance
  if (!inst) return
  if (inst.status === 'running' || inst.status === 'starting') {
    await stop(inst)
  } else {
    await launch(inst, { open: 'none' })
  }
}
</script>

<template>
  <NConfigProvider :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <div class="shell" :class="{ collapsed }">
          <aside class="sider glass">
            <div class="brand">
              <div class="brand-mark" @click="toggleCollapse" :title="t('header.collapseSidebar')">
                <span class="brand-orb" />
              </div>
              <div v-if="!collapsed" class="brand-text">
                <div class="brand-name">ComfyPilot</div>
                <div class="brand-tag">Control Tower · v{{ APP_VERSION }}</div>
              </div>
            </div>

            <nav class="nav">
              <div v-for="group in navGroups" :key="group.key" class="nav-group">
                <div v-if="!collapsed" class="nav-group-label">{{ group.label }}</div>
                <button
                  v-for="item in group.items"
                  :key="item.key"
                  class="nav-item"
                  :class="{ active: activeKey === item.key }"
                  :title="collapsed ? item.label : undefined"
                  @click="go(item.path)"
                >
                  <NIcon :size="18" :component="item.icon" />
                  <span v-if="!collapsed" class="nav-label">{{ item.label }}</span>
                  <span v-if="!collapsed && item.key === 'instances' && runningCount" class="nav-badge">{{ runningCount }}</span>
                </button>
              </div>
            </nav>

            <div class="sider-footer">
              <div class="status-pill" :class="{ idle: runningCount === 0 }">
                <span class="pulse-dot" />
                <span v-if="!collapsed">{{ runningCount > 0 ? `${runningCount} ${t('common.running')}` : t('common.stopped') }}</span>
              </div>
              <NButton text class="github-btn" @click="openGithub">
                <template #icon>
                  <NIcon :component="LogoGithub" />
                </template>
                <span v-if="!collapsed">GitHub</span>
              </NButton>
            </div>
          </aside>

          <section class="main">
            <header class="header glass">
              <div class="header-left">
                <div class="header-title">{{ nav.find((n) => n.key === activeKey)?.label }}</div>
                <div class="header-crumb">{{ t('header.crumb') }}</div>
              </div>
              <NSpace align="center" :size="10">
                <!-- Active instance context — used by nodes/models/batch/monitor -->
                <div class="instance-pick">
                  <NSelect
                    v-model:value="selectedInstanceId"
                    :options="instanceOptions"
                    size="small"
                    style="width: 220px"
                    :placeholder="t('header.instancePlaceholder')"
                  />
                  <NTag
                    size="small"
                    round
                    :type="activeStatus === 'running' ? 'success' : activeStatus === 'error' ? 'error' : 'default'"
                  >
                    {{ activeStatusLabel }}
                  </NTag>
                  <NButton
                    size="small"
                    secondary
                    :type="activeStatus === 'running' ? 'warning' : 'primary'"
                    :disabled="!store.activeInstance"
                    :loading="store.activeInstance ? busy[store.activeInstance.id] : false"
                    @click="toggleInstanceRun"
                  >
                    <template #icon>
                      <NIcon :component="activeStatus === 'running' ? StopOutline : PlayOutline" />
                    </template>
                  </NButton>
                </div>
                <NTooltip trigger="hover">
                  <template #trigger>
                    <NButton secondary type="primary" :disabled="!store.activeInstance?.url" @click="openEmbed">
                      {{ t('header.embed') }}
                    </NButton>
                  </template>
                  {{ t('header.embedTip') }}
                </NTooltip>
                <NButton secondary :disabled="!store.activeInstance?.url" @click="openComfy">
                  <template #icon>
                    <NIcon :component="OpenOutline" />
                  </template>
                  {{ t('header.openExternal') }}
                </NButton>
                <NAvatar round size="small" class="avatar">C</NAvatar>
              </NSpace>
            </header>

            <main class="content">
              <router-view v-slot="{ Component }">
                <transition name="page-fade" mode="out-in">
                  <component :is="Component" />
                </transition>
              </router-view>
            </main>
          </section>
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.shell {
  display: grid;
  grid-template-columns: $nav-width 1fr;
  flex: 1;
  min-height: 0;
  height: 100%;
  width: 100%;
  transition: grid-template-columns 0.2s ease;

  &.collapsed {
    grid-template-columns: 72px 1fr;

    .brand-text,
    .nav-label,
    .nav-badge {
      display: none;
    }

    .nav-item {
      justify-content: center;
      padding: 11px 8px;
    }

    .status-pill {
      justify-content: center;
    }

    .github-btn {
      justify-content: center;
    }
  }
}

.instance-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(148, 163, 184, 0.18);
}

.sider {
  display: flex;
  flex-direction: column;
  padding: 18px 14px;
  border-right: 1px solid rgba(148, 163, 184, 0.16);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(244, 247, 252, 0.9) 100%);
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 18px;
}

.brand-mark {
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: $gradient-primary;
  display: grid;
  place-items: center;
  box-shadow: $shadow-glow;
}

.brand-orb {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 0 16px rgba(255, 255, 255, 0.8);
}

.brand-name {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: $color-text;
}

.brand-tag {
  font-size: 11px;
  color: $color-text-muted;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-group-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: $color-text-muted;
  padding: 6px 14px 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid transparent;
  background: transparent;
  color: $color-text-secondary;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;

  &:hover {
    background: rgba(79, 110, 247, 0.08);
    color: $color-primary;
  }

  &.active {
    background: rgba(255, 255, 255, 0.95);
    color: $color-primary;
    border-color: rgba(79, 110, 247, 0.22);
    box-shadow: $shadow-md;
    position: relative;

    &::before {
      content: '';
      position: absolute;
      left: -1px;
      top: 12px;
      bottom: 12px;
      width: 3px;
      border-radius: 999px;
      background: $gradient-primary;
    }
  }
}

.nav-badge {
  margin-left: auto;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: $gradient-primary;
  color: white;
  font-size: 11px;
  display: grid;
  place-items: center;
}

.sider-footer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.1);
  color: $color-success;
  font-size: 12px;
  font-weight: 600;

  &.idle {
    background: rgba(148, 163, 184, 0.12);
    color: $color-text-muted;

    .pulse-dot {
      background: $color-text-muted;
      box-shadow: none;
      animation: none;
    }
  }
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.header {
  height: $header-height;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
}

.header-title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.header-crumb {
  font-size: 12px;
  color: $color-text-muted;
  margin-top: 2px;
}

.avatar {
  background: $gradient-primary;
  color: white;
  font-weight: 700;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* router-view page fills content — do NOT flex grandchildren (breaks page-header) */
.content > * {
  flex: 1;
  min-height: 0;
}

.page-fade-enter-active,
.page-fade-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.page-fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.page-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
