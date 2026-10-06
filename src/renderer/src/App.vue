<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
  SaveOutline
} from '@vicons/ionicons5'
import { NIcon, NAvatar, NButton, NSpace, NTooltip, NMessageProvider, NDialogProvider, NConfigProvider } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const route = useRoute()
const store = useAppStore()
const collapsed = ref(false)
const { t, locale } = useI18n()

const nav = computed(() => [
  { key: 'dashboard', label: t('nav.dashboard'), icon: SpeedometerOutline, path: '/' },
  { key: 'instances', label: t('nav.instances'), icon: ServerOutline, path: '/instances' },
  { key: 'models', label: t('nav.models'), icon: FolderOpenOutline, path: '/models' },
  { key: 'nodes', label: t('nav.nodes'), icon: ExtensionPuzzleOutline, path: '/nodes' },
  { key: 'market', label: t('nav.market'), icon: StorefrontOutline, path: '/market' },
  { key: 'workflows', label: t('nav.workflows'), icon: GitBranchOutline, path: '/workflows' },
  { key: 'batch', label: t('nav.batch'), icon: PlayForwardOutline, path: '/batch' },
  { key: 'output', label: t('nav.output'), icon: ImagesOutline, path: '/output' },
  { key: 'monitor', label: t('nav.monitor'), icon: PulseOutline, path: '/monitor' },
  { key: 'doctor', label: t('nav.doctor'), icon: MedkitOutline, path: '/doctor' },
  { key: 'backup', label: t('nav.backup'), icon: SaveOutline, path: '/backup' },
  { key: 'settings', label: t('nav.settings'), icon: SettingsOutline, path: '/settings' }
])

const activeKey = computed(() => {
  const hit = nav.value.find((n) => route.path === n.path || (n.path !== '/' && route.path.startsWith(n.path)))
  return hit?.key ?? 'dashboard'
})

const runningCount = computed(() => store.instances.filter((i) => i.status === 'running').length)

let dispose: (() => void) | null = null

onMounted(async () => {
  await store.bootstrap()
  if (store.settings?.locale) locale.value = store.settings.locale
  dispose = store.bindLive()
})

onUnmounted(() => dispose?.())

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
  void ipc('shell.openExternal', 'https://github.com/comfy-pilot/comfy-pilot')
}
</script>

<template>
  <NConfigProvider>
    <NMessageProvider>
      <NDialogProvider>
        <div class="shell">
          <aside class="sider glass" :class="{ collapsed }">
            <div class="brand">
              <div class="brand-mark">
                <span class="brand-orb" />
              </div>
              <div class="brand-text">
                <div class="brand-name">ComfyPilot</div>
                <div class="brand-tag">Control Tower</div>
              </div>
            </div>

            <nav class="nav">
              <button
                v-for="item in nav"
                :key="item.key"
                class="nav-item"
                :class="{ active: activeKey === item.key }"
                @click="go(item.path)"
              >
                <NIcon :size="18" :component="item.icon" />
                <span class="nav-label">{{ item.label }}</span>
                <span v-if="item.key === 'instances' && runningCount" class="nav-badge">{{ runningCount }}</span>
              </button>
            </nav>

            <div class="sider-footer">
              <div class="status-pill">
                <span class="pulse-dot" />
                <span>{{ t('common.running') }}</span>
              </div>
              <NButton text class="github-btn" @click="openGithub">
                <template #icon>
                  <NIcon :component="LogoGithub" />
                </template>
                GitHub
              </NButton>
            </div>
          </aside>

          <section class="main">
            <header class="header glass">
              <div class="header-left">
                <div class="header-title">{{ nav.find((n) => n.key === activeKey)?.label }}</div>
                <div class="header-crumb">ComfyUI · MIT · ThzxxArt</div>
              </div>
              <NSpace align="center" :size="10">
                <NTooltip trigger="hover">
                  <template #trigger>
                    <NButton secondary type="primary" :disabled="!store.activeInstance?.url" @click="openEmbed">
                      内嵌 Frontend
                    </NButton>
                  </template>
                  在应用内嵌入官方 ComfyUI Frontend
                </NTooltip>
                <NButton secondary :disabled="!store.activeInstance?.url" @click="openComfy">
                  <template #icon>
                    <NIcon :component="OpenOutline" />
                  </template>
                  外链打开
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
  height: 100%;
  width: 100%;
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
  gap: 6px;
  margin-top: 8px;
  flex: 1;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border-radius: 14px;
  border: 1px solid transparent;
  background: transparent;
  color: $color-text-secondary;
  font-size: 14px;
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
  color: #047857;
  font-size: 12px;
  font-weight: 600;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
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
  font-weight: 750;
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
