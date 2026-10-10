<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  DocumentTextOutline,
  PlayOutline,
  OpenOutline,
  RefreshOutline,
  SendOutline,
  FolderOpenOutline,
  HeartOutline,
  Heart,
  CreateOutline,
  TrashOutline,
  CloudDownloadOutline,
  ShareSocialOutline,
  ImageOutline,
  AlertCircleOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NIcon,
  NInput,
  NSpace,
  NSpin,
  NTag,
  NEmpty,
  useMessage,
  NModal,
  NSelect,
  NInputNumber,
  NPopconfirm,
  NDynamicTags,
  NCard,
  NText,
  NSwitch,
  NInputGroup
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import type { WorkflowRecord } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const router = useRouter()
const loading = ref(false)
const items = ref<WorkflowRecord[]>([])
const keyword = ref('')
const onlyFavorites = ref(false)
const libraryRoot = ref('')
const missingCount = ref(0)

const showQueue = ref(false)
const queueTarget = ref<WorkflowRecord | null>(null)
const seed = ref<number | null>(null)
const queuing = ref(false)

const showRename = ref(false)
const renameTarget = ref<WorkflowRecord | null>(null)
const renameValue = ref('')

const showTags = ref(false)
const tagsTarget = ref<WorkflowRecord | null>(null)
const tagsValue = ref<string[]>([])

const showDetail = ref(false)
const detail = ref<WorkflowRecord | null>(null)
const openingFrontend = ref(false)

/** ComfyPilot never auto-starts an instance — gate every live action on this. */
const instanceRunning = computed(
  () => store.activeInstance?.status === 'running'
)
const needInstanceHint = t('workflows.needRunningInstance')

const originLabel = (o: WorkflowRecord['origin']): string => {
  if (o === 'library') return t('workflows.originLibrary')
  if (o === 'instance') return t('workflows.originInstance')
  return t('workflows.originExternal')
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    items.value = await ipc('workflow.list', { includeMissing: true })
    const info = await ipc('workflow.libraryInfo', store.activeInstanceId || undefined)
    libraryRoot.value = info.root
    missingCount.value = info.missing
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function importFile(): Promise<void> {
  if (!store.activeInstanceId) {
    message.warning(t('workflows.needInstanceForImport'))
    return
  }
  try {
    const paths = await ipc('shell.pickFiles', {
      filters: [{ name: 'Workflow', extensions: ['json', 'png'] }]
    })
    if (!paths?.length) return
    const imported = await ipc('workflow.importMany', paths, store.activeInstanceId)
    await refresh()
    const names = imported.map((r) => r.name).join(', ')
    message.success(t('workflows.importedToInstance', { name: names, root: libraryRoot.value }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    await refresh()
  }
}

async function toggleFavorite(row: WorkflowRecord): Promise<void> {
  try {
    await ipc('workflow.favorite', row.id, !row.favorite)
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openRename(row: WorkflowRecord): Promise<void> {
  renameTarget.value = row
  renameValue.value = row.name
  showRename.value = true
}

async function doRename(): Promise<void> {
  if (!renameTarget.value || !renameValue.value.trim()) return
  try {
    await ipc('workflow.rename', renameTarget.value.id, renameValue.value.trim())
    showRename.value = false
    message.success(t('workflows.renamed'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openTags(row: WorkflowRecord): Promise<void> {
  tagsTarget.value = row
  tagsValue.value = [...(row.tags || [])]
  showTags.value = true
}

async function doTags(): Promise<void> {
  if (!tagsTarget.value) return
  try {
    await ipc('workflow.tag', tagsTarget.value.id, tagsValue.value)
    showTags.value = false
    message.success(t('workflows.tagsSaved'))
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeRow(row: WorkflowRecord): Promise<void> {
  try {
    // library + instance → delete the source file; external → unregister only.
    const deleteSource = row.origin !== 'external'
    await ipc('workflow.delete', row.id, { deleteSource })
    message.success(
      t(deleteSource ? 'workflows.deletedWithFile' : 'workflows.deleted')
    )
    await refresh()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** Confirm text that matches what delete will actually do. */
function deleteConfirmText(row: WorkflowRecord): string {
  if (row.origin === 'library') return t('workflows.deleteLibraryConfirm')
  if (row.origin === 'instance') return t('workflows.deleteInstanceConfirm')
  return t('workflows.deleteConfirm')
}

async function exportZip(row: WorkflowRecord): Promise<void> {
  try {
    const dir = await ipc('shell.pickDirectory')
    if (!dir) return
    const res = await ipc('workflow.exportZip', row.id, dir)
    message.success(t('workflows.exported', { path: res.path }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function copyToInstance(row: WorkflowRecord): Promise<void> {
  try {
    const res = await ipc('workflow.copyToInstance', row.id, store.activeInstanceId || '')
    message.success(t('workflows.copiedToInstance', { path: res.path }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openInFrontend(row: WorkflowRecord): Promise<void> {
  if (openingFrontend.value) return
  if (!instanceRunning.value) {
    message.warning(needInstanceHint)
    return
  }
  openingFrontend.value = true
  try {
    const res = await ipc('workflow.openInFrontend', row.id, store.activeInstanceId || undefined)
    message.success(
      t(res.mode === 'embed' ? 'workflows.openedInFrontendEmbed' : 'workflows.openedInFrontend', {
        name: res.instanceName
      })
    )
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    openingFrontend.value = false
  }
}

async function reveal(row: WorkflowRecord): Promise<void> {
  try {
    await ipc('workflow.reveal', row.id)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function openDetail(row: WorkflowRecord): void {
  detail.value = row
  showDetail.value = true
}

function openQueue(row: WorkflowRecord): void {
  queueTarget.value = row
  seed.value = null
  showQueue.value = true
}

function closeQueue(): void {
  showQueue.value = false
  queueTarget.value = null
  seed.value = null
}

async function doQueue(): Promise<void> {
  if (!queueTarget.value || queuing.value) return
  if (!instanceRunning.value) {
    message.warning(needInstanceHint)
    return
  }
  queuing.value = true
  try {
    const promptId = await ipc('workflow.queue', {
      workflowPath: queueTarget.value.path,
      instanceId: store.activeInstanceId || '',
      seed: seed.value ?? undefined
    })
    message.success(promptId ? t('workflows.queued', { id: promptId }) : t('workflows.queueFailed'))
    closeQueue()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    queuing.value = false
  }
}

async function safeRevealPath(path: string): Promise<void> {
  try {
    await ipc('shell.reveal', path)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function sendToBatch(row: WorkflowRecord): Promise<void> {
  if (!instanceRunning.value) {
    message.warning(needInstanceHint)
    return
  }
  try {
    await ipc('batch.create', {
      name: t('batch.defaultName') + ' · ' + row.name,
      instanceId: store.activeInstanceId || '',
      items: [{ workflowId: row.id, workflowName: row.name, workflowPath: row.path, count: 1 }],
      notes: '',
      params: { seedMode: 'random' }
    })
    message.success(t('workflows.sentToBatchHint'))
    await router.push('/batch')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function filtered(): WorkflowRecord[] {
  const k = keyword.value.trim().toLowerCase()
  return items.value.filter((w) => {
    if (onlyFavorites.value && !w.favorite) return false
    if (!k) return true
    return (
      w.name.toLowerCase().includes(k) ||
      (w.tags || []).some((tg) => tg.toLowerCase().includes(k)) ||
      w.path.toLowerCase().includes(k)
    )
  })
}

onMounted(async () => {
  await store.bootstrap({ keepSelection: true })
  await refresh()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('workflows.title') }}</h1>
        <p class="page-subtitle">{{ $t('workflows.subtitle') }}</p>
      </div>
      <NSpace align="center">
        <NInput v-model:value="keyword" clearable :placeholder="$t('workflows.searchPlaceholder')" style="width: 200px" />
        <NSwitch v-model:value="onlyFavorites">
          <template #checked>{{ $t('workflows.favOnly') }}</template>
          <template #unchecked>{{ $t('workflows.favAll') }}</template>
        </NSwitch>
        <NButton secondary :loading="loading" @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>{{ $t('workflows.refresh') }}
        </NButton>
        <NButton type="primary" @click="importFile">{{ $t('workflows.import') }}</NButton>
      </NSpace>
    </div>

    <!-- Library location banner: user must always know WHERE imports land -->
    <NCard size="small" class="lib-banner" v-if="libraryRoot">
      <div class="lib-row">
        <div class="lib-left">
          <NIcon :component="FolderOpenOutline" :size="18" />
          <NText depth="2" class="lib-label">{{ $t('workflows.libraryRoot') }}</NText>
          <NText code class="lib-path">{{ libraryRoot }}</NText>
          <NTag v-if="missingCount" size="small" type="warning" round>
            {{ $t('workflows.missingCount', { n: missingCount }) }}
          </NTag>
        </div>
        <NButton size="tiny" secondary @click="libraryRoot && safeRevealPath(libraryRoot)">
          {{ $t('workflows.openLibrary') }}
        </NButton>
      </div>
    </NCard>

    <div class="page-body">
      <NSpin :show="loading">
        <div v-if="filtered().length" class="grid cards">
          <article
            v-for="wf in filtered()"
            :key="wf.id"
            class="card card-interactive wf"
            :class="{ missing: wf.missing }"
          >
            <div class="wf-top">
              <div class="wf-icon">
                <NIcon :size="22" :component="wf.format === 'png' ? ImageOutline : DocumentTextOutline" />
              </div>
              <div class="wf-title">
                <div class="wf-name">{{ wf.name }}</div>
                <div class="wf-meta">
                  {{ wf.nodeCount }} nodes · {{ wf.format }} · v{{ wf.version }}
                </div>
              </div>
              <NButton text @click="toggleFavorite(wf)">
                <template #icon>
                  <NIcon :component="wf.favorite ? Heart : HeartOutline" :color="wf.favorite ? '#e2557a' : undefined" />
                </template>
              </NButton>
            </div>

            <div class="wf-tags">
              <NTag size="tiny" round :type="wf.origin === 'library' ? 'success' : wf.origin === 'instance' ? 'info' : 'default'">
                {{ originLabel(wf.origin) }}
              </NTag>
              <NTag v-for="tg in wf.tags" :key="tg" size="tiny" round>{{ tg }}</NTag>
              <NTag v-if="wf.seed != null" size="tiny" round type="info">seed {{ wf.seed }}</NTag>
              <NTag v-if="wf.missingNodes.length" size="tiny" round type="warning">
                {{ $t('workflows.missingNodes', { n: wf.missingNodes.length }) }}
              </NTag>
              <NTag v-if="wf.missing" size="tiny" round type="error">
                <template #icon><NIcon :component="AlertCircleOutline" /></template>
                {{ $t('workflows.missingFile') }}
              </NTag>
            </div>

            <div class="wf-path mono" :title="wf.path">{{ wf.path }}</div>
            <div v-if="wf.sourcePath" class="wf-src mono">{{ $t('workflows.sourcePath') }}: {{ wf.sourcePath }}</div>

            <div class="wf-actions">
              <NButton
                size="tiny"
                type="primary"
                secondary
                :disabled="wf.missing || openingFrontend || !instanceRunning"
                :loading="openingFrontend"
                :title="instanceRunning ? '' : needInstanceHint"
                @click="openInFrontend(wf)"
              >
                <template #icon><NIcon :component="PlayOutline" /></template>{{ $t('workflows.openFrontend') }}
              </NButton>
              <NButton
                size="tiny"
                secondary
                :disabled="wf.missing || !instanceRunning"
                :title="instanceRunning ? '' : needInstanceHint"
                @click="openQueue(wf)"
              >
                <template #icon><NIcon :component="SendOutline" /></template>{{ $t('workflows.queue') }}
              </NButton>
              <NButton
                size="tiny"
                secondary
                :disabled="wf.missing || !instanceRunning"
                :title="instanceRunning ? '' : needInstanceHint"
                @click="sendToBatch(wf)"
              >
                {{ $t('workflows.toBatch') }}
              </NButton>
              <NButton size="tiny" secondary @click="openDetail(wf)">{{ $t('workflows.detail') }}</NButton>
            </div>
            <div class="wf-actions">
              <NButton size="tiny" quaternary @click="openRename(wf)">
                <template #icon><NIcon :component="CreateOutline" /></template>
              </NButton>
              <NButton size="tiny" quaternary @click="openTags(wf)">{{ $t('workflows.editTags') }}</NButton>
              <NButton size="tiny" quaternary :disabled="wf.missing" @click="exportZip(wf)">
                <template #icon><NIcon :component="ShareSocialOutline" /></template>
              </NButton>
              <NButton size="tiny" quaternary :disabled="wf.missing" @click="copyToInstance(wf)">
                <template #icon><NIcon :component="CloudDownloadOutline" /></template>
              </NButton>
              <NButton size="tiny" quaternary @click="reveal(wf)">
                <template #icon><NIcon :component="OpenOutline" /></template>
              </NButton>
              <NPopconfirm @positive-click="removeRow(wf)">
                <template #trigger>
                  <NButton size="tiny" quaternary type="error">
                    <template #icon><NIcon :component="TrashOutline" /></template>
                  </NButton>
                </template>
                {{ deleteConfirmText(wf) }}
              </NPopconfirm>
            </div>
          </article>
        </div>
        <NEmpty v-else :description="$t('workflows.empty')" class="empty">
          <template #extra>
            <NButton type="primary" @click="importFile">{{ $t('workflows.import') }}</NButton>
          </template>
        </NEmpty>
      </NSpin>
    </div>

    <!-- Queue -->
    <NModal v-model:show="showQueue" preset="card" :title="$t('workflows.queueTitle')" style="width: 480px; border-radius: 20px">
      <NSpace vertical>
        <div>{{ queueTarget?.name }}</div>
        <NSelect
          :options="store.instances.map((i) => ({ label: i.name, value: i.id }))"
          :value="store.activeInstanceId"
          :placeholder="$t('workflows.instancePlaceholder')"
          @update:value="(v: string) => (store.activeInstanceId = v)"
        />
        <NInputNumber v-model:value="seed" :placeholder="$t('workflows.seedPlaceholder')" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="closeQueue">{{ $t('workflows.cancel') }}</NButton>
          <NButton
            type="primary"
            :loading="queuing"
            :disabled="!instanceRunning"
            :title="instanceRunning ? '' : needInstanceHint"
            @click="doQueue"
          >
            {{ $t('workflows.enqueue') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Rename -->
    <NModal v-model:show="showRename" preset="card" :title="$t('workflows.renameTitle')" style="width: 420px; border-radius: 20px">
      <NInputGroup>
        <NInput v-model:value="renameValue" :placeholder="$t('workflows.renamePlaceholder')" @keyup.enter="doRename" />
      </NInputGroup>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRename = false">{{ $t('workflows.cancel') }}</NButton>
          <NButton type="primary" @click="doRename">{{ $t('workflows.renameSave') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Tags -->
    <NModal v-model:show="showTags" preset="card" :title="$t('workflows.tagsTitle')" style="width: 480px; border-radius: 20px">
      <NDynamicTags v-model:value="tagsValue" />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showTags = false">{{ $t('workflows.cancel') }}</NButton>
          <NButton type="primary" @click="doTags">{{ $t('workflows.tagsSave') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Detail -->
    <NModal v-model:show="showDetail" preset="card" :title="detail?.name || $t('workflows.detail')" style="width: 560px; border-radius: 20px">
      <NSpace vertical v-if="detail">
        <div><b>{{ $t('workflows.filePath') }}</b> <NText code>{{ detail.path }}</NText></div>
        <div v-if="detail.sourcePath"><b>{{ $t('workflows.sourcePath') }}</b> <NText code>{{ detail.sourcePath }}</NText></div>
        <div><b>{{ $t('workflows.origin') }}</b> {{ originLabel(detail.origin) }}</div>
        <div><b>{{ $t('workflows.nodeCount') }}</b> {{ detail.nodeCount }}</div>
        <div v-if="detail.modelUsed"><b>{{ $t('workflows.modelUsed') }}</b> {{ detail.modelUsed }}</div>
        <div v-if="detail.seed != null"><b>Seed</b> {{ detail.seed }}</div>
        <div v-if="detail.description"><b>{{ $t('workflows.description') }}</b> {{ detail.description }}</div>
        <div v-if="detail.missingNodes.length">
          <b>{{ $t('workflows.missingNodes', { n: detail.missingNodes.length }) }}</b>
          <NSpace>
            <NTag
              v-for="n in detail.missingNodes.slice(0, 12)"
              :key="n"
              size="tiny"
              round
              type="warning"
              style="cursor: pointer"
              @click="router.push({ path: '/market', query: { q: n } })"
            >
              {{ n }} →
            </NTag>
          </NSpace>
        </div>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showDetail = false">{{ $t('workflows.close') }}</NButton>
          <NButton secondary @click="detail && reveal(detail)">{{ $t('workflows.reveal') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.lib-banner {
  margin-bottom: 14px;
  border-radius: 16px;
}
.lib-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}
.lib-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.lib-label {
  flex-shrink: 0;
}
.lib-path {
  font-size: 12px;
  // Take the remaining banner width instead of a hard 420px cap.
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.cards {
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}
.wf {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wf.missing {
  opacity: 0.72;
  border: 1px dashed rgba(220, 80, 80, 0.45);
}
.wf-top {
  display: flex;
  gap: 12px;
  align-items: center;
}
.wf-title {
  flex: 1;
  min-width: 0;
}
.wf-icon {
  width: 42px;
  height: 42px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: $gradient-soft;
  color: $color-primary;
  flex-shrink: 0;
}
.wf-name {
  font-size: 15px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-meta {
  font-size: 12px;
  color: $color-text-muted;
  margin-top: 2px;
}
.wf-path {
  font-size: 11px;
  color: $color-text-muted;
  word-break: break-all;
}
.wf-src {
  font-size: 10.5px;
  color: $color-text-muted;
  word-break: break-all;
  opacity: 0.85;
}
.wf-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
}
.wf-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.empty {
  padding: 64px 0;
}
</style>
