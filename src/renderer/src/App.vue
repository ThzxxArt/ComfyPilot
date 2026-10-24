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
  NIcon,
  NAvatar,
  NButton,
  NSpace,
  NTooltip,
  NMessageProvider,
  NDialogProvider,
  NConfigProvider,
  NSelect,
  NTag,
  NAlert
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { usePipOps } from '@/composables/usePipOps'
import { createDiscreteApi, dateEnUS, dateZhCN, enUS, zhCN } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { APP_VERSION } from '@shared/constants'
import { COLORS } from '@/styles/tokens'
import PipOpModal from '@/components/PipOpModal.vue'
import TaskCenter from '@/components/TaskCenter.vue'
import NotificationCenter from '@/components/NotificationCenter.vue'
import CommandPalette from '@/components/CommandPalette.vue'

// App.vue sits outside NMessageProvider — use discrete message/dialog APIs.
const discreteApi = createDiscreteApi(['message', 'dialog'])
const discreteMessage = discreteApi.message
const discreteDialog = discreteApi.dialog
import type { ComfyInstanceInfo } from '@shared/types'

const router = useRouter()
const route = useRoute()
const store = useAppStore()
const collapsed = ref(false)
const { t, locale } = useI18n()
/** 0.1.18 (WP6 / U11): Naive's own strings (pickers, dialogs, empty states)
 *  must follow the app language instead of staying on its default. */
const naiveLocale = computed(() => (locale.value === 'en-US' ? enUS : zhCN))
const naiveDateLocale = computed(() => (locale.value === 'en-US' ? dateEnUS : dateZhCN))
const { launch, stop, busy } = useLaunch()
// 0.1.12: restore pip-op state after a renderer reload so the banner/modal
// stop being invisible while main is still installing.
const { refreshStatus: refreshPipStatus } = usePipOps()
watch(
  () => store.activeInstanceId,
  (nid) => {
    if (nid) void refreshPipStatus(nid)
  }
)

// Sidebar width used by embed.resize — keep in sync with $nav-width / collapsed state
const SIDEBAR_W = 240
const SIDEBAR_W_COLLAPSED = 72

const nav = computed(() => [
  // 生产
  {
    key: 'dashboard',
    label: t('nav.dashboard'),
    icon: SpeedometerOutline,
    path: '/',
    group: 'produce' as const
  },
  {
    key: 'instances',
    label: t('nav.instances'),
    icon: ServerOutline,
    path: '/instances',
    group: 'produce' as const
  },
  {
    key: 'workflows',
    label: t('nav.workflows'),
    icon: GitBranchOutline,
    path: '/workflows',
    group: 'produce' as const
  },
  {
    key: 'batch',
    label: t('nav.batch'),
    icon: PlayForwardOutline,
    path: '/batch',
    group: 'produce' as const
  },
  {
    key: 'output',
    label: t('nav.output'),
    icon: ImagesOutline,
    path: '/output',
    group: 'produce' as const
  },
  // 资产
  {
    key: 'models',
    label: t('nav.models'),
    icon: FolderOpenOutline,
    path: '/models',
    group: 'assets' as const
  },
  {
    key: 'nodes',
    label: t('nav.nodes'),
    icon: ExtensionPuzzleOutline,
    path: '/nodes',
    group: 'assets' as const
  },
  {
    key: 'market',
    label: t('nav.market'),
    icon: StorefrontOutline,
    path: '/market',
    group: 'assets' as const
  },
  // 运维
  {
    key: 'monitor',
    label: t('nav.monitor'),
    icon: PulseOutline,
    path: '/monitor',
    group: 'ops' as const
  },
  {
    key: 'doctor',
    label: t('nav.doctor'),
    icon: MedkitOutline,
    path: '/doctor',
    group: 'ops' as const
  },
  {
    key: 'install',
    label: t('nav.install'),
    icon: RocketOutline,
    path: '/install',
    group: 'ops' as const
  },
  {
    key: 'backup',
    label: t('nav.backup'),
    icon: SaveOutline,
    path: '/backup',
    group: 'ops' as const
  },
  {
    key: 'settings',
    label: t('nav.settings'),
    icon: SettingsOutline,
    path: '/settings',
    group: 'ops' as const
  }
])

const navGroups = computed(() => {
  const g = {
    produce: [] as typeof nav.value,
    assets: [] as typeof nav.value,
    ops: [] as typeof nav.value
  }
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
  Card: { borderRadius: '20px' },
  Modal: { borderRadius: '20px' }
}

const activeKey = computed(() => {
  const hit = nav.value.find(
    (n) => route.path === n.path || (n.path !== '/' && route.path.startsWith(n.path))
  )
  return hit?.key ?? 'dashboard'
})

const runningCount = computed(
  () => store.instances.filter((i) => i.status === 'running' || i.status === 'starting').length
)

const instanceOptions = computed(() => {
  const local = store.instances.map((i: ComfyInstanceInfo) => ({
    label: `${i.name} · ${i.port} · ${t(`status.${i.status || 'unknown'}`)}`,
    value: i.id
  }))
  const remote = store.remotes.map((r) => ({
    label: `☁ ${r.name} · ${r.label || r.baseUrl}`,
    value: `remote:${r.id}`
  }))
  return [...local, ...remote]
})

const selectedInstanceId = computed({
  get: () => {
    if (store.activeRemoteId) return `remote:${store.activeRemoteId}`
    // No instances[0] fallback: the store deliberately treats "no id" as no
    // local target (0.1.18 WP2). Showing one here made the header lie.
    return store.activeInstanceId || null
  },
  set: (v: string | null) => {
    if (v && v.startsWith('remote:')) {
      store.activeRemoteId = v.slice(7)
      store.activeInstanceId = null
    } else {
      store.activeRemoteId = null
      store.activeInstanceId = v
    }
  }
})

/** A remote is selected AND actually resolvable (guards stale activeRemoteId). */
const remoteReady = computed(() => store.isRemoteActive && Boolean(store.activeRemote))

const activeStatus = computed(() => {
  if (store.isRemoteActive) return remoteReady.value ? 'running' : 'unknown'
  return store.activeInstance?.status || 'unknown'
})
/** ComfyPilot never auto-starts an instance — every Frontend open is gated on this. */
const instanceRunning = computed(() => {
  if (store.isRemoteActive) return remoteReady.value
  return activeStatus.value === 'running'
})
const needInstanceHint = computed(() => t('common.needRunningInstance'))
const activeStatusLabel = computed(() => {
  if (remoteReady.value) return t('status.remote')
  if (store.isRemoteActive) return t('status.unknown')
  return t(`status.${activeStatus.value || 'unknown'}`)
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
/**
 * Cursor driven by `notificationSeq` (monotonic). The notifications array is
 * capped at 20 entries — watching `length` silently dies after the 20th toast.
 */
let notifiedSeq = 0

// Surface main-process notifications as global toasts (task done / failed).
watch(
  () => store.notificationSeq,
  (seq) => {
    const newCount = seq - notifiedSeq
    if (newCount <= 0) return
    notifiedSeq = seq
    const items = store.notifications
    // Array holds the last 20; show everything new from the tail.
    const start = Math.max(0, items.length - newCount)
    for (let i = start; i < items.length; i++) {
      const n = items[i]
      if (!n) continue
      // Prefer i18n keys from main; fall back to the literal strings.
      const title = n.titleKey ? t(n.titleKey, n.params || {}) : n.title
      const msg = n.messageKey ? t(n.messageKey, n.params || {}) : n.message
      discreteMessage[
        n.type === 'error'
          ? 'error'
          : n.type === 'warning'
            ? 'warning'
            : n.type === 'success'
              ? 'success'
              : 'info'
      ](title && msg ? `${title} — ${msg}` : title || msg, { duration: n.duration ?? 5000 })
    }
  }
)

/**
 * 0.1.16: if the previous session did not write a clean-exit marker, the app
 * likely ended unexpectedly. Surface it and offer a diagnostics export — this
 * is the only reliable way to prove a "silent crash" actually happened.
 */
async function retryBootstrap(): Promise<void> {
  store.bootstrapError = ''
  await store.bootstrap({ keepSelection: true })
}

async function openLogsDir(): Promise<void> {
  try {
    const dir = await ipc('settings.logsDir')
    if (dir) await ipc('shell.openPath', dir)
  } catch {
    /* best-effort */
  }
}

async function checkPreviousExit(): Promise<void> {
  try {
    const info = await ipc('app.previousExit')
    if (info.clean) return
    discreteDialog.warning({
      title: t('session.uncleanTitle'),
      content: t('session.uncleanMsg'),
      positiveText: t('session.export'),
      negativeText: t('session.dismiss'),
      onPositiveClick: () => void exportAppDiagnostics()
    })
  } catch {
    /* liveness hint must never block startup */
  }
}

async function exportAppDiagnostics(): Promise<void> {
  try {
    const { path } = await ipc('app.exportDiagnostics')
    discreteMessage.success(t('session.exported', { path }))
  } catch (e) {
    discreteMessage.error(e instanceof Error ? e.message : String(e))
  }
}

onMounted(async () => {
  await store.bootstrap()
  if (store.settings?.locale) locale.value = store.settings.locale
  dispose = store.bindLive()
  notifyEmbedLayout()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('comfypilot:layout-request', onLayoutRequest)
  if (store.activeInstanceId) void refreshPipStatus(store.activeInstanceId)
  void checkPreviousExit()
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
  // Ctrl+Enter → launch active instance and open embed (not while typing in a field)
  if (e.key === 'Enter') {
    const el = e.target as HTMLElement | null
    const tag = el?.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
    e.preventDefault()
    void launchActive()
  }
}

async function launchActive(): Promise<void> {
  // Remote context: nothing to launch locally — open its frontend instead.
  if (store.isRemoteActive) {
    openEmbed()
    return
  }
  const inst = store.activeInstance
  if (!inst) return
  await launch(inst, { open: 'embed' })
}

function go(path: string): void {
  void router.push(path)
}

/** Frontend URL for the active context — remote baseUrl when a remote is selected. */
function currentFrontendUrl(): string | null {
  if (store.isRemoteActive) return store.activeRemote?.baseUrl || null
  return store.activeInstance?.url || null
}

function openComfy(): void {
  if (!instanceRunning.value) {
    discreteMessage.warning(needInstanceHint.value)
    return
  }
  const url = currentFrontendUrl()
  if (url) {
    void ipc('shell.openExternal', url).catch(() => undefined)
  }
}

function openEmbed(): void {
  if (!instanceRunning.value) {
    discreteMessage.warning(needInstanceHint.value)
    return
  }
  const url = currentFrontendUrl()
  if (url) void router.push({ path: '/embed', query: { url } })
}

function openGithub(): void {
  void ipc('shell.openExternal', 'https://github.com/ThzxxArt/ComfyPilot').catch(() => undefined)
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
  <NConfigProvider
    :theme-overrides="themeOverrides"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
  >
    <NMessageProvider>
      <NDialogProvider>
        <div class="shell" :class="{ collapsed }">
          <aside class="sider glass">
            <div class="brand">
              <button
                class="brand-mark"
                type="button"
                :title="t('header.collapseSidebar')"
                :aria-label="t('header.collapseSidebar')"
                @click="toggleCollapse"
              >
                <span class="brand-orb" />
              </button>
              <div v-if="!collapsed" class="brand-text">
                <div class="brand-name">ComfyPilot</div>
                <div class="brand-tag">{{ $t('app.brandTag') }} · v{{ APP_VERSION }}</div>
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
                  :aria-current="activeKey === item.key ? 'page' : undefined"
                  @click="go(item.path)"
                >
                  <NIcon :size="18" :component="item.icon" />
                  <span v-if="!collapsed" class="nav-label">{{ item.label }}</span>
                  <span
                    v-if="!collapsed && item.key === 'instances' && runningCount"
                    class="nav-badge"
                    >{{ runningCount }}</span
                  >
                </button>
              </div>
            </nav>

            <div class="sider-footer">
              <div class="status-pill" :class="{ idle: runningCount === 0 }">
                <span class="pulse-dot" />
                <span v-if="!collapsed">{{
                  runningCount > 0 ? `${runningCount} ${t('common.running')}` : t('common.stopped')
                }}</span>
              </div>
              <NButton text class="github-btn" @click="openGithub">
                <template #icon>
                  <NIcon :component="LogoGithub" />
                </template>
                <span v-if="!collapsed">{{ $t('app.github') }}</span>
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
                <!-- 0.1.18 (WP5/WP6): task center + notification center,
                     reachable from every view. -->
                <TaskCenter />
                <NotificationCenter />
                <!-- Active instance context — used by nodes/models/batch/monitor -->
                <div class="instance-pick">
                  <NSelect
                    v-model:value="selectedInstanceId"
                    class="instance-select"
                    :options="instanceOptions"
                    size="small"
                    :placeholder="t('header.instancePlaceholder')"
                  />
                  <NTag
                    size="small"
                    round
                    :type="
                      activeStatus === 'running'
                        ? 'success'
                        : activeStatus === 'error'
                          ? 'error'
                          : 'default'
                    "
                  >
                    {{ activeStatusLabel }}
                  </NTag>
                  <NTooltip trigger="hover" :disabled="!store.isRemoteActive">
                    <template #trigger>
                      <span class="btn-wrap">
                        <NButton
                          size="small"
                          secondary
                          :type="activeStatus === 'running' ? 'warning' : 'primary'"
                          :disabled="!store.activeInstance || store.isRemoteActive"
                          :loading="
      store.activeInstance
        ? Boolean(busy[store.activeInstance.id] || busy['stop:' + store.activeInstance.id])
        : false
    "
                          @click="toggleInstanceRun"
                        >
                          <template #icon>
                            <NIcon
                              :component="activeStatus === 'running' ? StopOutline : PlayOutline"
                            />
                          </template>
                        </NButton>
                      </span>
                    </template>
                    {{ $t('header.remoteNoControl') }}
                  </NTooltip>
                </div>
                <NTooltip trigger="hover">
                  <template #trigger>
                    <span class="btn-wrap">
                      <NButton
                        secondary
                        type="primary"
                        :disabled="!instanceRunning"
                        :title="instanceRunning ? '' : needInstanceHint"
                        @click="openEmbed"
                      >
                        {{ t('header.embed') }}
                      </NButton>
                    </span>
                  </template>
                  {{ instanceRunning ? t('header.embedTip') : needInstanceHint }}
                </NTooltip>
                <NTooltip trigger="hover" :disabled="instanceRunning">
                  <template #trigger>
                    <span class="btn-wrap">
                      <NButton secondary :disabled="!instanceRunning" @click="openComfy">
                        <template #icon>
                          <NIcon :component="OpenOutline" />
                        </template>
                        {{ t('header.openExternal') }}
                      </NButton>
                    </span>
                  </template>
                  {{ needInstanceHint }}
                </NTooltip>
                <NAvatar round size="small" class="avatar" aria-hidden="true">C</NAvatar>
              </NSpace>
            </header>

            <main class="content">
              <!-- 0.1.18 (WP6): a failed bootstrap is a page-level state, not a
                   toast that disappears before the user can read it. -->
              <NAlert
                v-if="store.bootstrapError"
                type="error"
                closable
                class="bootstrap-alert"
                @close="store.bootstrapError = ''"
              >
                <template #header>{{ t('notify.bootstrapFailed') }}</template>
                <div class="bootstrap-alert-body">
                  <span class="mono">{{ store.bootstrapError }}</span>
                  <NSpace>
                    <NButton size="tiny" secondary @click="retryBootstrap">
                      {{ t('common.retry') }}
                    </NButton>
                    <NButton size="tiny" secondary @click="openLogsDir">
                      {{ t('palette.openLogs') }}
                    </NButton>
                  </NSpace>
                </div>
              </NAlert>
              <router-view v-slot="{ Component }">
                <transition name="page-fade" mode="out-in">
                  <component :is="Component" />
                </transition>
              </router-view>
            </main>
          </section>
        </div>
        <!-- Global pip-op modal (0.1.12): missing-package fix / recipes / pack deps -->
        <PipOpModal />
        <!-- Inside NMessageProvider: the palette reports open-log failures. -->
        <CommandPalette />
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
  background: $color-bg-glass;
  border: 1px solid rgba($color-text-muted, 0.18);
}

.instance-select {
  width: 220px;
}

/* 窄窗口收窄实例选择器，保证右侧操作区不被顶出 */
@media (max-width: 1360px) {
  .instance-select {
    width: 160px;
  }
}

.btn-wrap {
  display: inline-flex;
}

.sider {
  display: flex;
  flex-direction: column;
  padding: 18px 14px;
  border: none;
  border-right: 1px solid rgba($color-text-muted, 0.16);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.88) 0%, rgba(244, 247, 252, 0.9) 100%);
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
  border: none;
  padding: 0;
  cursor: pointer;
  flex-shrink: 0;

  &:focus-visible {
    outline: 2px solid rgba($color-primary, 0.6);
    outline-offset: 2px;
  }
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
  color: $color-text-muted-ink;
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
  color: $color-text-muted-ink;
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
    background: rgba($color-primary, 0.08);
    color: $color-primary;
  }

  &:focus-visible {
    outline: 2px solid rgba($color-primary, 0.55);
    outline-offset: -2px;
  }

  &.active {
    background: rgba(255, 255, 255, 0.95);
    color: $color-primary;
    border-color: rgba($color-primary, 0.22);
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
  border-top: 1px solid rgba($color-text-muted, 0.16);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba($color-success, 0.1);
  color: $color-success;
  font-size: 12px;
  font-weight: 600;

  &.idle {
    background: rgba($color-text-muted, 0.12);
    color: $color-text-secondary;

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

.bootstrap-alert {
  margin: 12px 24px 0;
}
.bootstrap-alert-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  word-break: break-all;
}
.header {
  height: $header-height;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 24px;
  border: none;
  border-bottom: 1px solid rgba($color-text-muted, 0.16);
}

.header-left {
  min-width: 0;
}

.header-title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-crumb {
  font-size: 12px;
  color: $color-text-muted-ink;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
