<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  SearchOutline,
  DownloadOutline,
  StarOutline,
  RefreshOutline,
  ArrowUpCircleOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NIcon,
  NInput,
  NList,
  NListItem,
  NPagination,
  NPopconfirm,
  NSpace,
  NSpin,
  NTag,
  NEmpty,
  NProgress,
  useMessage,
  useDialog
} from 'naive-ui'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import {
  useComfyUpdate,
  describeNodeError,
  hasDepsSkippedIssue
} from '@/composables/useComfyUpdate'
import NodeOpProgressModal from '@/components/NodeOpProgressModal.vue'
import ListSkeleton from '@/components/ListSkeleton.vue'
import { useAppStore } from '@/stores/app'
import type {
  MarketItem,
  RegistryPageResult,
  RegistryNodePack,
  NodePackRecord
} from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()

/**
 * Unified market item — both Registry and Manager map into this shape so
 * the list template, install / update / installed-badge logic is ONE code
 * path. Switching tabs only swaps the data source.
 */
interface DisplayItem {
  id: string
  name: string
  displayName: string
  description: string
  author: string
  version: string
  category: string
  tags: string[]
  downloads: number
  stars: number
  repository: string
  installed: boolean
  source: 'registry' | 'manager'
}

// ---- shared UI state ----
const loading = ref(false)
const loadingMore = ref(false)
const indexing = ref(false)
const indexProgress = ref<{ done: number; total: number; count: number } | null>(null)
const query = ref('')
const activeQuery = ref('')
const showOpModal = ref(false)
const opModalTitle = ref('')
const installingItem = ref<string | null>(null)
const updatingItem = ref<string | null>(null)
const {
  nodeInstallingPack,
  nodeUpdatingPack,
  nodeInstallMessage,
  nodeUpdateMessage,
  selectNodeOpInstance
} = useComfyUpdate()

// ---- source tab ----
const sourceTab = ref<'registry' | 'manager'>('registry')

// ---- unified data ----
const allItems = ref<DisplayItem[]>([])
const total = ref(0)
const totalPages = ref(1)
const page = ref(1)
const pageSize = 40
const scanned = ref(0)
const indexCount = ref(0)
const indexUpdatedAt = ref(0)
const sourceError = ref('')

// ---- installed badge ----
const localPackKeys = ref<Set<string>>(new Set())

async function refreshLocalPackKeys(): Promise<void> {
  try {
    const packs: NodePackRecord[] = await ipc('node.list', store.activeInstanceId || undefined)
    const keys = new Set<string>()
    for (const p of packs) {
      if (p.name) keys.add(p.name.toLowerCase())
      if (p.displayName) keys.add(p.displayName.toLowerCase())
      if (p.registryId) keys.add(p.registryId.toLowerCase())
      if (p.repository) {
        // Also match by repo URL (e.g. "github.com/kijai/ComfyUI-KJNodes")
        const repoKey = p.repository.toLowerCase().replace(/\.git$/, '')
        keys.add(repoKey)
        // Extract "owner/repo" part for matching
        const ghMatch = repoKey.match(/github\.com[/:]([^/]+\/[^/.]+)/)
        if (ghMatch) keys.add(ghMatch[1])
      }
    }
    localPackKeys.value = keys
  } catch {
    /* badge refresh is best-effort */
  }
}

function isInstalled(item: DisplayItem): boolean {
  // 1. Registry says installed (authoritative for registry items).
  if (item.installed) return true
  // 2. Local pack name/displayName/registryId/repository match.
  const keys = localPackKeys.value
  const id = item.id.toLowerCase()
  const name = item.name.toLowerCase()
  const display = item.displayName.toLowerCase()
  const repo = (item.repository || '').toLowerCase().replace(/\.git$/, '')
  return keys.has(id) || keys.has(name) || keys.has(display) || (repo !== '' && keys.has(repo))
}

// ---- unified filtered + paginated view ----
function clearSearch(): void {
  query.value = ''
  void load(true)
}

const filteredItems = computed(() => {
  const q = activeQuery.value.trim().toLowerCase()
  if (!q) return allItems.value
  return allItems.value.filter((n) =>
    [n.name, n.displayName, n.description, n.author, n.category, ...(n.tags || [])]
      .join(' ')
      .toLowerCase()
      .includes(q)
  )
})

const displayItems = computed(() => {
  if (sourceTab.value === 'registry') {
    // Registry: server-side pagination — allItems is already one page.
    return allItems.value
  }
  // Manager: client-side pagination over the full filtered list.
  const start = (page.value - 1) * pageSize
  return filteredItems.value.slice(start, start + pageSize)
})

const displayTotal = computed(() =>
  sourceTab.value === 'registry' ? total.value : filteredItems.value.length
)

const displayPages = computed(() =>
  sourceTab.value === 'registry'
    ? Math.max(1, totalPages.value)
    : Math.max(1, Math.ceil(filteredItems.value.length / pageSize))
)

function hint(): string {
  if (activeQuery.value) {
    return t('market.hintMatch', {
      query: activeQuery.value,
      scanned:
        sourceTab.value === 'registry' ? scanned.value || indexCount.value : displayTotal.value,
      total: displayTotal.value
    })
  }
  if (sourceTab.value === 'manager') {
    // Manager: show its own total + page — no registry index info.
    return displayPages.value > 1
      ? t('market.managerCount', { n: displayTotal.value }) +
          ' · ' +
          t('market.managerPage', { page: page.value, pages: displayPages.value })
      : t('market.managerCount', { n: displayTotal.value })
  }
  // Registry: full paging + index info.
  const idx = indexCount.value
    ? indexUpdatedAt.value
      ? t('market.hintIndexTime', {
          n: indexCount.value,
          time: new Date(indexUpdatedAt.value).toLocaleString()
        })
      : t('market.hintIndex', { n: indexCount.value })
    : ''
  return idx
    ? t('market.hintPagingWithIndex', {
        total: displayTotal.value,
        page: page.value,
        pages: displayPages.value,
        idx
      })
    : t('market.hintPaging', {
        total: displayTotal.value,
        page: page.value,
        pages: displayPages.value
      })
}

// ---- map sources into DisplayItem ----
function mapRegistryItem(m: MarketItem): DisplayItem {
  return {
    id: m.id,
    name: m.name,
    displayName: m.displayName || m.name,
    description: m.description || '',
    author: m.author || '',
    version: m.version || '',
    category: m.category || '',
    tags: m.tags || [],
    downloads: m.downloads || 0,
    stars: m.stars || m.rating || 0,
    repository: m.repository || '',
    installed: Boolean(m.installed),
    source: 'registry'
  }
}

function mapManagerItem(r: RegistryNodePack): DisplayItem {
  return {
    id: r.id,
    name: r.name || r.displayName,
    displayName: r.displayName || r.name,
    description: r.description || '',
    author: r.author || '',
    version: r.latestVersion || '',
    category: (r.tags || [])[0] || '',
    tags: r.tags || [],
    downloads: r.downloads || 0,
    stars: r.score || 0,
    repository: r.repository || '',
    installed: false, // refreshed below via localPackKeys
    source: 'manager'
  }
}

// ---- registry load ----
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
    message.success(t('market.indexUpdated', { n: s.count }))
    if (activeQuery.value) await load(true)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    indexing.value = false
    indexProgress.value = null
  }
}

async function load(reset = true): Promise<void> {
  if (sourceTab.value === 'manager') {
    await loadManager()
    return
  }
  if (reset) {
    loading.value = true
    page.value = 1
    allItems.value = []
    activeQuery.value = query.value.trim()
  } else {
    loadingMore.value = true
  }
  sourceError.value = ''
  try {
    const res: RegistryPageResult<MarketItem> = await ipc('market.list', {
      query: activeQuery.value || undefined,
      page: reset ? 1 : page.value + 1,
      limit: pageSize,
      instanceId: store.activeInstanceId || undefined
    })
    const mapped = res.items.map(mapRegistryItem)
    if (reset) allItems.value = mapped
    else allItems.value = [...allItems.value, ...mapped]
    total.value = res.total
    totalPages.value = res.totalPages
    scanned.value = res.scanned
    page.value = res.page
    if (reset && !res.items.length) {
      message.info(activeQuery.value ? t('market.noMatches') : t('market.registryEmpty'))
    }
    void loadIndexStatus()
  } catch (err) {
    sourceError.value = err instanceof Error ? err.message : String(err)
    message.error(sourceError.value)
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore(): Promise<void> {
  if (sourceTab.value === 'registry' && page.value < totalPages.value) {
    await load(false)
    return
  }
  // Manager: client-side page advance
  if (page.value < displayPages.value) {
    page.value += 1
  }
}

/** Re-fetch the CURRENT page in place (keeps paging position after install/update). */
async function loadCurrentPage(): Promise<void> {
  if (sourceTab.value === 'manager') {
    void refreshLocalPackKeys()
    return
  }
  loading.value = true
  try {
    const res: RegistryPageResult<MarketItem> = await ipc('market.list', {
      query: activeQuery.value || undefined,
      page: page.value,
      limit: pageSize,
      instanceId: store.activeInstanceId || undefined
    })
    const start = (page.value - 1) * pageSize
    const mapped = res.items.map(mapRegistryItem)
    allItems.value = [...allItems.value.slice(0, start), ...mapped]
    total.value = res.total
    totalPages.value = res.totalPages
    scanned.value = res.scanned
    page.value = res.page
    void loadIndexStatus()
    void refreshLocalPackKeys()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

// ---- manager load ----
async function loadManager(): Promise<void> {
  loading.value = true
  page.value = 1
  activeQuery.value = query.value.trim()
  sourceError.value = ''
  try {
    const raw = await ipc('node.managerChannel')
    allItems.value = raw.map(mapManagerItem)
    total.value = allItems.value.length
    totalPages.value = Math.max(1, Math.ceil(allItems.value.length / pageSize))
    if (!allItems.value.length) {
      message.info(t('market.managerEmpty'))
    }
    void refreshLocalPackKeys()
  } catch (err) {
    sourceError.value = err instanceof Error ? err.message : String(err)
    message.error(sourceError.value)
  } finally {
    loading.value = false
  }
}

// ---- unified install / update ----
async function install(item: DisplayItem): Promise<void> {
  if (installingItem.value) return
  installingItem.value = item.id
  opModalTitle.value = t('nodes.installing')
  showOpModal.value = true
  try {
    const rec =
      item.source === 'registry'
        ? await ipc('market.install', {
            id: item.id,
            version: item.version || undefined,
            repository: item.repository || undefined,
            instanceId: store.activeInstanceId || undefined
          })
        : await ipc('node.install', {
            id: item.id,
            version: item.version || undefined,
            source: 'manager',
            url: item.repository || undefined,
            instanceId: store.activeInstanceId || undefined
          })
    if (hasDepsSkippedIssue(rec?.issues)) {
      dialog.warning({
        title: t('nodes.depsNotInstalled'),
        content: `${t('nodes.depsNotInstalledBody', { name: item.name })}\n${t('nodes.depsNotInstalledFix')}`,
        positiveText: t('common.confirm')
      })
    } else {
      message.success(t('market.installedItem', { name: item.name }))
    }
    await loadCurrentPage()
  } catch (err) {
    // Modal stays open with the failure log — except OP_BUSY (nothing ran).
    if ((err as { code?: string })?.code === 'OP_BUSY') showOpModal.value = false
    message.error(describeNodeError(t, err))
  } finally {
    installingItem.value = null
  }
}

async function resolveLocalPack(
  item: DisplayItem
): Promise<{ id: string; name: string; locked?: boolean } | null> {
  try {
    const packs = await ipc('node.list', store.activeInstanceId || undefined)
    const found = packs.find(
      (p) =>
        p.name === item.name ||
        p.name?.toLowerCase() === item.name?.toLowerCase() ||
        p.registryId === item.id ||
        p.id === item.id
    )
    if (!found) return null
    // Unique id beats name: duplicate names can exist (e.g. Foo + .disabled/Foo).
    return { id: found.id, name: found.name, locked: found.locked }
  } catch {
    return null
  }
}

async function updateItem(item: DisplayItem): Promise<void> {
  if (updatingItem.value) return
  updatingItem.value = item.id
  // Snapshot the target instance: resolveLocalPack and the update call must
  // act on the SAME instance even if the header selection changes mid-await.
  const forInst = store.activeInstanceId || undefined
  try {
    const local = await resolveLocalPack(item)
    if (!local) {
      message.error(t('nodes.updateFailed', { error: 'Pack not found locally' }))
      return
    }
    if (local.locked) {
      message.warning(t('nodes.locked'))
      return
    }
    if ((store.activeInstanceId || undefined) !== forInst) {
      message.warning(t('nodes.opBusy'))
      return
    }
    // Only open the modal once a real operation is about to start — opening
    // early showed the previous op's stale log for these early returns.
    opModalTitle.value = t('nodes.updating')
    showOpModal.value = true
    await ipc('node.update', local.id, undefined, forInst)
    message.success(t('nodes.updateDone', { name: local.name }))
    await loadCurrentPage()
  } catch (err) {
    if ((err as { code?: string })?.code === 'OP_BUSY') showOpModal.value = false
    // Modal stays open with the failure log (0.1.9 — manual close only).
    const msg = describeNodeError(t, err)
    const backup = /backup at (.+)$/i.exec(msg)
    if (/rollback (also failed|FAILED)/i.test(msg) && backup) {
      message.error(t('nodes.rollbackFailed', { path: backup[1].trim() }))
    } else {
      message.error(t('nodes.updateFailed', { error: msg }))
    }
  } finally {
    updatingItem.value = null
  }
}

// ---- lifecycle ----
let offProgress: (() => void) | null = null

function applyRouteQuery(): boolean {
  const q = typeof route.query.q === 'string' ? route.query.q.trim() : ''
  if (!q) return false
  query.value = q
  void load(true)
  return true
}

onMounted(() => {
  // Op-modal must follow THIS view's active instance, not whatever stream the
  // NodesView last viewed (0.1.9 per-instance op tracking).
  selectNodeOpInstance(store.activeInstanceId || '')
  offProgress = onIpc(IPC_EVENTS.registryIndexProgress, (p) => {
    const ev = p as { done: number; total: number; count: number; ready?: boolean }
    indexProgress.value = ev
    if (ev.ready || (typeof ev.total === 'number' && ev.total > 0 && ev.done >= ev.total)) {
      indexing.value = false
      indexProgress.value = null
      void loadIndexStatus()
      return
    }
    indexing.value = true
  })
  void loadIndexStatus()
  if (!applyRouteQuery()) void load(true)
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

watch(sourceTab, () => {
  page.value = 1
  allItems.value = []
  void load(true)
})

watch(
  () => route.query.q,
  () => applyRouteQuery()
)

watch(
  () => store.instanceSwitchTick,
  () => {
    void loadCurrentPage()
    void refreshLocalPackKeys()
  }
)

watch(activeQuery, () => {
  page.value = 1
})

watch(
  () => [nodeInstallingPack.value, nodeUpdatingPack.value],
  ([wasInstalling, wasUpdating], [prevInstalling, prevUpdating]) => {
    const finished = (prevInstalling && !wasInstalling) || (prevUpdating && !wasUpdating)
    if (finished) {
      void loadCurrentPage()
      void refreshLocalPackKeys()
    }
  }
)

// 0.1.9: node-op modal never auto-closes — success/failure both keep the log
// visible until the user closes it (ComfyUI-Manager terminal behaviour).
watch(
  () => store.instanceSwitchTick,
  () => selectNodeOpInstance(store.activeInstanceId || '')
)

onUnmounted(() => offProgress?.())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('market.title') }}</h1>
        <p class="page-subtitle">
          {{ sourceTab === 'registry' ? $t('market.subtitle') : $t('market.subtitleManager') }}
          {{ hint() }}
        </p>
      </div>
      <NSpace>
        <NInput
          v-model:value="query"
          :placeholder="$t('market.searchPlaceholder')"
          clearable
          style="width: 280px"
          @keyup.enter="load(true)"
          @clear="load(true)"
        >
          <template #prefix><NIcon :component="SearchOutline" /></template>
        </NInput>
        <NButton type="primary" @click="load(true)">{{ $t('market.search') }}</NButton>
        <NButton
          secondary
          :loading="indexing || loading"
          @click="sourceTab === 'registry' ? refreshIndex() : loadManager()"
        >
          <template #icon><NIcon :component="RefreshOutline" /></template>
          {{ sourceTab === 'registry' ? $t('market.refreshIndex') : $t('market.refreshManager') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
      <NSpace class="source-tabs" align="center" :size="8">
        <NButton
          :type="sourceTab === 'registry' ? 'primary' : 'default'"
          :secondary="sourceTab !== 'registry'"
          @click="sourceTab = 'registry'"
        >
          {{ $t('market.tabRegistry') }}
        </NButton>
        <NButton
          :type="sourceTab === 'manager' ? 'primary' : 'default'"
          :secondary="sourceTab !== 'manager'"
          @click="sourceTab = 'manager'"
        >
          {{ $t('market.tabManager') }}
        </NButton>
      </NSpace>

      <!-- shared banner: install/update in progress -->
      <div v-if="nodeInstallingPack || nodeUpdatingPack" class="index-banner">
        <div class="meta">
          <template v-if="nodeInstallingPack">
            {{ $t('nodes.installing') }} <span class="mono">{{ nodeInstallingPack }}</span>
            <span v-if="nodeInstallMessage"> — {{ nodeInstallMessage }}</span>
          </template>
          <template v-else>
            {{ $t('nodes.updating') }} <span class="mono">{{ nodeUpdatingPack }}</span>
            <span v-if="nodeUpdateMessage"> — {{ nodeUpdateMessage }}</span>
          </template>
        </div>
        <NButton size="tiny" secondary @click="showOpModal = true">
          {{ $t('nodes.viewProgress') }}
        </NButton>
      </div>

      <!-- registry index progress -->
      <div v-if="indexing && indexProgress && sourceTab === 'registry'" class="index-banner">
        <NProgress
          type="line"
          :percentage="
            indexProgress.total
              ? Math.min(100, Math.round((indexProgress.done / indexProgress.total) * 100))
              : 0
          "
          :height="8"
          processing
        />
        <div class="meta">
          {{
            $t('market.indexing', {
              done: indexProgress.done,
              total: indexProgress.total,
              count: indexProgress.count
            })
          }}
        </div>
      </div>

      <!-- unified list -->
      <NSpin :show="loading && displayItems.length > 0">
        <ListSkeleton v-if="loading && !displayItems.length" :rows="6" />
        <NList v-else-if="displayItems.length" bordered class="market-list">
          <NListItem v-for="item in displayItems" :key="item.source + ':' + item.id">
            <div class="row">
              <div class="item-main">
                <div class="name" :title="item.displayName">{{ item.displayName }}</div>
                <div class="desc clamp-2" :title="item.description">{{ item.description }}</div>
                <div class="tags">
                  <NTag v-if="item.author" size="tiny" round>{{ item.author }}</NTag>
                  <NTag v-if="item.version" size="tiny" round>v{{ item.version }}</NTag>
                  <NTag v-if="item.category" size="tiny" round>{{ item.category }}</NTag>
                  <NTag v-if="item.stars" size="tiny" round>
                    <template #icon><NIcon :component="StarOutline" /></template>
                    {{ item.stars }}
                  </NTag>
                  <NTag size="tiny" round>{{
                    $t('market.downloadsShort', { n: item.downloads })
                  }}</NTag>
                  <NButton
                    v-if="isInstalled(item)"
                    size="tiny"
                    text
                    type="success"
                    @click="router.push('/nodes')"
                  >
                    {{ $t('market.installedTag') }}
                  </NButton>
                </div>
              </div>
              <NSpace>
                <NPopconfirm v-if="isInstalled(item)" @positive-click="updateItem(item)">
                  <template #trigger>
                    <NButton
                      size="small"
                      secondary
                      :disabled="updatingItem !== null && updatingItem !== item.id"
                      :loading="
                        updatingItem === item.id ||
                        (nodeUpdatingPack !== null && nodeUpdatingPack === item.name)
                      "
                    >
                      <template #icon><NIcon :component="ArrowUpCircleOutline" /></template>
                      {{ $t('nodes.update') }}
                    </NButton>
                  </template>
                  {{ $t('nodes.confirmUpdate', { name: item.name, version: item.version }) }}
                </NPopconfirm>
                <NButton
                  type="primary"
                  secondary
                  :disabled="
                    isInstalled(item) || (installingItem !== null && installingItem !== item.id)
                  "
                  :loading="
                    installingItem === item.id ||
                    (nodeInstallingPack !== null &&
                      (nodeInstallingPack === item.id || nodeInstallingPack === item.name))
                  "
                  @click="install(item)"
                >
                  <template #icon><NIcon :component="DownloadOutline" /></template>
                  {{ isInstalled(item) ? $t('market.installedTag') : $t('market.install') }}
                </NButton>
              </NSpace>
            </div>
          </NListItem>
        </NList>
        <NEmpty
          v-else-if="!loading"
          :description="
            sourceError ||
            (activeQuery
              ? $t('common.noMatch')
              : sourceTab === 'registry'
                ? $t('market.empty')
                : $t('market.managerEmpty'))
          "
          class="empty"
        >
          <template #extra>
            <NButton v-if="sourceError" secondary @click="load(true)">{{
              $t('common.retry')
            }}</NButton>
            <NButton v-else-if="activeQuery" secondary @click="clearSearch">{{
              $t('common.clearFilters')
            }}</NButton>
          </template>
        </NEmpty>
      </NSpin>

      <!-- unified pagination -->
      <div v-if="displayItems.length" class="pager">
        <template v-if="sourceTab === 'registry'">
          <NButton
            secondary
            :loading="loadingMore"
            :disabled="page >= totalPages"
            @click="loadMore"
          >
            {{ page < totalPages ? $t('market.loadMore') : $t('market.lastPage') }}
          </NButton>
        </template>
        <template v-else>
          <NPagination
            v-if="displayPages > 1"
            v-model:page="page"
            :page-count="displayPages"
            :page-slot="7"
          />
        </template>
      </div>
    </div>
    <NodeOpProgressModal v-model:show="showOpModal" :title="opModalTitle" mode="single" />
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  width: 100%;
}
.item-main {
  flex: 1;
  min-width: 0;
}
.name {
  font-size: 15px;
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desc {
  font-size: 13px;
  color: $color-text-secondary;
  margin: 4px 0 8px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.pager {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}
.index-banner {
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba($color-primary, 0.08);
}
.index-banner .mono {
  display: inline-block;
  max-width: 100%;
  vertical-align: bottom;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
  color: $color-text-secondary;
  margin-top: 6px;
}
.source-tabs {
  margin: 4px 0 12px;
}
.empty {
  padding: 64px 0;
}
</style>
