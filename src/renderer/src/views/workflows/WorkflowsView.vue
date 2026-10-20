<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { useInstanceScope } from '@/composables/useInstanceScope'
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
  useDialog,
  NModal,
  NSelect,
  NInputNumber,
  NPopconfirm,
  NDynamicTags,
  NCard,
  NText,
  NSwitch,
  NInputGroup,
  NTooltip
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import { COLORS } from '@/styles/tokens'
import ListSkeleton from '@/components/ListSkeleton.vue'
import type { WorkflowCompareResult, WorkflowRecord } from '@shared/types'

const { t } = useI18n()
const store = useAppStore()
const message = useMessage()
const dialog = useDialog()
const router = useRouter()
const loading = ref(false)
const items = ref<WorkflowRecord[]>([])
const keyword = ref('')
const onlyFavorites = ref(false)
const libraryRoot = ref('')
const missingCount = ref(0)

const showQueue = ref(false)
const queueTarget = ref<WorkflowRecord | null>(null)
const queueInstanceId = ref('')
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

// ---------- compare two workflows (0.1.11, README roadmap「工作流版本对照」) ----------
const showCompare = ref(false)
const compareA = ref<string | null>(null)
const compareB = ref<string | null>(null)
const compareResult = ref<WorkflowCompareResult | null>(null)
const comparing = ref(false)

/** Flat i18n keys for diff fields — never a dynamic domain. */
const CMP_FIELD_KEYS: Record<string, string> = {
  name: 'workflows.cmpFieldName',
  format: 'workflows.cmpFieldFormat',
  version: 'workflows.cmpFieldVersion',
  nodeCount: 'workflows.cmpFieldNodeCount',
  seed: 'workflows.cmpFieldSeed',
  modelUsed: 'workflows.cmpFieldModel',
  origin: 'workflows.cmpFieldOrigin',
  tags: 'workflows.cmpFieldTags',
  updatedAt: 'workflows.cmpFieldUpdatedAt'
}

function cmpFieldLabel(field: string): string {
  return CMP_FIELD_KEYS[field] ? t(CMP_FIELD_KEYS[field]) : field
}

const compareOptions = computed(() =>
  items.value.map((w) => ({ label: `${w.name} (${originLabel(w.origin)})`, value: w.id }))
)

function openCompare(pick?: WorkflowRecord): void {
  if (pick) compareA.value = pick.id
  if (compareB.value === compareA.value) compareB.value = null
  compareResult.value = null
  showCompare.value = true
}

async function runCompare(): Promise<void> {
  if (!compareA.value || !compareB.value) {
    message.warning(t('workflows.comparePick'))
    return
  }
  comparing.value = true
  try {
    compareResult.value = await ipc('workflow.compare', compareA.value, compareB.value)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    comparing.value = false
  }
}

/** ComfyPilot never auto-starts an instance —gate every live action on this. */
const instanceRunning = computed(() => store.activeInstance?.status === 'running')
const needInstanceHint = computed(() => t('workflows.needRunningInstance'))

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
    const result = await ipc('workflow.importMany', paths, store.activeInstanceId)
    await refresh()
    const names = result.ok.map((r: { name: string }) => r.name).join(', ')
    if (result.errors.length) {
      message.warning(
        t('workflows.importedWithErrors', { ok: result.ok.length, failed: result.errors.length })
      )
      // Surface every failure with its reason — console.warn is invisible to users.
      const lines = result.errors.map((e: { path: string; message: string }) => {
        const base = e.path.split(/[\\/]/).pop() || e.path
        return `${base}: ${e.message}`
      })
      dialog.error({
        title: t('workflows.importFailedTitle'),
        content: () =>
          h(
            'div',
            { style: 'max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:6px' },
            [
              h(
                'p',
                t('workflows.importedWithErrors', {
                  ok: result.ok.length,
                  failed: result.errors.length
                })
              ),
              ...lines.map((l: string) =>
                h(
                  'div',
                  {
                    style:
                      'font-family:monospace;font-size:12px;word-break:break-all;padding:4px 8px;border-radius:6px;background:rgba(239,68,68,0.10);border:1px solid rgba(239,68,68,0.30)'
                  },
                  l
                )
              )
            ]
          ),
        positiveText: t('common.confirm')
      })
    } else {
      message.success(t('workflows.importedToInstance', { name: names, root: libraryRoot.value }))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    await refresh()
  }
}

// ---------- 0.1.15: import the running instance's built-in default workflow ----------
const importingDefault = ref(false)

async function importDefaultWorkflow(): Promise<void> {
  const instId = store.activeInstanceId
  if (!instId) {
    message.warning(needInstanceHint.value)
    return
  }
  if (importingDefault.value) return
  importingDefault.value = true
  try {
    const rec = await ipc('workflow.importDefault', { instanceId: instId, target: 'instance' })
    message.success(t('workflows.defaultImported', { name: rec.name }))
    await refresh()
  } catch (err) {
    // v0.40 and older servers have no /default_workflow route — explain
    // honestly instead of showing the raw English fallback.
    if ((err as { code?: string })?.code === 'DEFAULT_WORKFLOW_UNSUPPORTED') {
      message.warning(t('workflows.defaultUnsupported'))
    } else {
      message.error(err instanceof Error ? err.message : String(err))
    }
  } finally {
    importingDefault.value = false
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
    // library + instance —delete the source file; external —unregister only.
    const deleteSource = row.origin !== 'external'
    await ipc('workflow.delete', row.id, { deleteSource })
    message.success(t(deleteSource ? 'workflows.deletedWithFile' : 'workflows.deleted'))
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
    // An explicit, resolvable instance id — an empty string would silently
    // fall back to the main process's default instance (0.1.13).
    const inst = store.activeInstance
    if (!inst) {
      message.warning(needInstanceHint.value)
      return
    }
    const res = await ipc('workflow.copyToInstance', row.id, inst.id)
    message.success(t('workflows.copiedToInstance', { path: res.path }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openInFrontend(row: WorkflowRecord): Promise<void> {
  if (openingFrontend.value) return
  if (!instanceRunning.value) {
    message.warning(needInstanceHint.value)
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
  // Local draft — selecting another instance here must not hijack the global switch.
  queueInstanceId.value = store.activeInstanceId || ''
  seed.value = null
  showQueue.value = true
}

/** Running state of the instance picked inside the queue modal. */
const queueInstanceRunning = computed(
  () => store.instances.find((i) => i.id === queueInstanceId.value)?.status === 'running'
)

function closeQueue(): void {
  showQueue.value = false
  queueTarget.value = null
  seed.value = null
}

async function doQueue(): Promise<void> {
  if (!queueTarget.value || queuing.value) return
  if (!queueInstanceRunning.value) {
    message.warning(needInstanceHint.value)
    return
  }
  const wf = queueTarget.value
  const instId = queueInstanceId.value
  // 0.1.12: preflight against the running instance's /object_info. Missing
  // node types are WARNED, never blocked (the user may know better); an
  // unavailable object_info skips the dialog entirely.
  try {
    const pre = await ipc('workflow.preflight', wf.path, instId)
    if (pre.available && pre.missingTypes.length) {
      const confirmed = await new Promise<boolean>((resolve) => {
        dialog.warning({
          title: t('nodePreflight.title'),
          content: t('nodePreflight.missingBody', {
            n: pre.missingTypes.length,
            list: pre.missingTypes.slice(0, 8).join(', ')
          }),
          positiveText: t('nodePreflight.queueAnyway'),
          negativeText: t('common.cancel'),
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
          onMaskClick: () => resolve(false)
        })
      })
      if (!confirmed) return
    }
  } catch {
    /* preflight is advisory — never blocks on its own failure */
  }
  queuing.value = true
  try {
    const promptId = await ipc('workflow.queue', {
      workflowPath: wf.path,
      instanceId: instId,
      seed: seed.value ?? undefined
    })
    closeQueue()
    if (promptId) {
      // Offer a jump to the output library (promptId is linked via sidecar).
      dialog.success({
        title: t('workflows.queued', { id: promptId }),
        content: t('workflows.queuedHint'),
        positiveText: t('workflows.viewOutputs'),
        negativeText: t('common.close'),
        onPositiveClick: () => {
          void router.push({ path: '/output', query: { workflowId: wf.id } })
        }
      })
    } else {
      message.warning(t('workflows.queueFailed'))
    }
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
  // batch.create does NOT need a running instance —only batch.start does.
  // Relax the gate to just require an instance to exist.
  const inst = store.activeInstance
  if (!inst) {
    message.warning(t('workflows.needInstanceForImport'))
    return
  }
  try {
    const job = await ipc('batch.create', {
      name: t('batch.defaultName') + ' ·' + row.name,
      // Record the REAL id — never an empty string that resolves elsewhere.
      instanceId: inst.id,
      items: [{ workflowId: row.id, workflowName: row.name, workflowPath: row.path, count: 1 }],
      notes: '',
      params: { seedMode: 'random' }
    })
    message.success(t('workflows.sentToBatchHint'))
    // Navigate to BatchView with the job highlighted.
    void router.push({ path: '/batch', query: { jobId: job.id } })
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// computed (not a function): the template reads it several times, and a plain
// function re-filtered the full list on every re-render (0.1.16).
const filtered = computed<WorkflowRecord[]>(() => {
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
})

const hasFilter = computed(() => keyword.value.trim().length > 0 || onlyFavorites.value)

function clearFilters(): void {
  keyword.value = ''
  onlyFavorites.value = false
}

// 0.1.17 (WP9): workflows are instance-scoped — switching instances must drop
// the old filters/list so edits can never target the previous instance.
useInstanceScope(() => {
  clearFilters()
  void refresh()
})

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
        <NInput
          v-model:value="keyword"
          clearable
          :placeholder="$t('workflows.searchPlaceholder')"
          style="width: 200px"
        />
        <NSwitch v-model:value="onlyFavorites">
          <template #checked>{{ $t('workflows.favOnly') }}</template>
          <template #unchecked>{{ $t('workflows.favAll') }}</template>
        </NSwitch>
        <NButton secondary :loading="loading" @click="refresh">
          <template #icon><NIcon :component="RefreshOutline" /></template
          >{{ $t('workflows.refresh') }}
        </NButton>
        <NButton secondary @click="openCompare()">{{ $t('workflows.compare') }}</NButton>
        <NTooltip trigger="hover" :disabled="instanceRunning">
          <template #trigger>
            <span class="btn-wrap">
              <NButton
                secondary
                :disabled="!instanceRunning || importingDefault"
                :loading="importingDefault"
                @click="importDefaultWorkflow"
              >
                {{ $t('workflows.importDefault') }}
              </NButton>
            </span>
          </template>
          {{ needInstanceHint }}
        </NTooltip>
        <NButton type="primary" @click="importFile">{{ $t('workflows.import') }}</NButton>
      </NSpace>
    </div>

    <!-- Library location banner: user must always know WHERE imports land -->
    <NCard v-if="libraryRoot" size="small" class="lib-banner">
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
      <NSpin :show="loading && filtered.length > 0">
        <ListSkeleton v-if="loading && !filtered.length" :rows="6" variant="card" />
        <div v-else-if="filtered.length" class="grid cards">
          <article
            v-for="wf in filtered"
            :key="wf.id"
            class="card card-interactive wf"
            :class="{ missing: wf.missing }"
          >
            <div class="wf-top">
              <div class="wf-icon">
                <NIcon
                  :size="22"
                  :component="wf.format === 'png' ? ImageOutline : DocumentTextOutline"
                />
              </div>
              <div class="wf-title">
                <div class="wf-name" :title="wf.name">{{ wf.name }}</div>
                <div class="wf-meta">
                  {{ $t('nodes.nodeCount', { n: wf.nodeCount }) }} ·
                  {{ String(wf.format).toUpperCase() }} ·
                  {{ $t('workflows.formatVersion', { version: wf.version }) }}
                </div>
              </div>
              <NButton
                text
                :title="wf.favorite ? $t('workflows.favOnly') : $t('workflows.favAll')"
                :aria-label="wf.favorite ? $t('workflows.favOnly') : $t('workflows.favAll')"
                @click="toggleFavorite(wf)"
              >
                <template #icon>
                  <NIcon
                    :component="wf.favorite ? Heart : HeartOutline"
                    :color="wf.favorite ? COLORS.danger : undefined"
                  />
                </template>
              </NButton>
            </div>

            <div class="wf-tags">
              <NTag
                size="tiny"
                round
                :type="
                  wf.origin === 'library'
                    ? 'success'
                    : wf.origin === 'instance'
                      ? 'info'
                      : 'default'
                "
              >
                {{ originLabel(wf.origin) }}
              </NTag>
              <NTag v-for="tg in wf.tags" :key="tg" size="tiny" round>{{ tg }}</NTag>
              <NTag v-if="wf.seed != null" size="tiny" round type="info"
                >{{ $t('workflows.seed') }} {{ wf.seed }}</NTag
              >
              <NTag v-if="wf.missingNodes.length" size="tiny" round type="warning">
                {{ $t('workflows.missingNodes', { n: wf.missingNodes.length }) }}
              </NTag>
              <NTag v-if="wf.missing" size="tiny" round type="error">
                <template #icon><NIcon :component="AlertCircleOutline" /></template>
                {{ $t('workflows.missingFile') }}
              </NTag>
            </div>

            <div class="wf-path mono" :title="wf.path">{{ wf.path }}</div>
            <div v-if="wf.sourcePath" class="wf-src mono">
              {{ $t('workflows.sourcePath') }}: {{ wf.sourcePath }}
            </div>

            <div class="wf-actions">
              <NTooltip trigger="hover" :disabled="instanceRunning">
                <template #trigger>
                  <span class="btn-wrap">
                    <NButton
                      size="tiny"
                      type="primary"
                      secondary
                      :disabled="wf.missing || openingFrontend || !instanceRunning"
                      :loading="openingFrontend"
                      @click="openInFrontend(wf)"
                    >
                      <template #icon><NIcon :component="PlayOutline" /></template
                      >{{ $t('workflows.openFrontend') }}
                    </NButton>
                  </span>
                </template>
                {{ needInstanceHint }}
              </NTooltip>
              <NTooltip trigger="hover" :disabled="instanceRunning">
                <template #trigger>
                  <span class="btn-wrap">
                    <NButton
                      size="tiny"
                      secondary
                      :disabled="wf.missing || !instanceRunning"
                      @click="openQueue(wf)"
                    >
                      <template #icon><NIcon :component="SendOutline" /></template
                      >{{ $t('workflows.queue') }}
                    </NButton>
                  </span>
                </template>
                {{ needInstanceHint }}
              </NTooltip>
              <NButton size="tiny" secondary :disabled="wf.missing" @click="sendToBatch(wf)">
                {{ $t('workflows.toBatch') }}
              </NButton>
              <NButton size="tiny" secondary @click="openDetail(wf)">{{
                $t('workflows.detail')
              }}</NButton>
              <NButton
                size="tiny"
                secondary
                @click="router.push({ path: '/output', query: { workflowId: wf.id } })"
              >
                {{ $t('workflows.viewOutputs') }}
              </NButton>
            </div>
            <div class="wf-actions wf-actions-secondary">
              <NButton
                size="tiny"
                quaternary
                :title="$t('workflows.renameTitle')"
                :aria-label="$t('workflows.renameTitle')"
                @click="openRename(wf)"
              >
                <template #icon><NIcon :component="CreateOutline" /></template>
              </NButton>
              <NButton size="tiny" quaternary @click="openTags(wf)">{{
                $t('workflows.editTags')
              }}</NButton>
              <NButton
                size="tiny"
                quaternary
                :disabled="wf.missing"
                :title="$t('workflows.exportZip')"
                :aria-label="$t('workflows.exportZip')"
                @click="exportZip(wf)"
              >
                <template #icon><NIcon :component="ShareSocialOutline" /></template>
              </NButton>
              <NButton
                size="tiny"
                quaternary
                :disabled="wf.missing"
                :title="$t('workflows.copyToInstanceLabel')"
                :aria-label="$t('workflows.copyToInstanceLabel')"
                @click="copyToInstance(wf)"
              >
                <template #icon><NIcon :component="CloudDownloadOutline" /></template>
              </NButton>
              <NButton
                size="tiny"
                quaternary
                :title="$t('workflows.reveal')"
                :aria-label="$t('workflows.reveal')"
                @click="reveal(wf)"
              >
                <template #icon><NIcon :component="OpenOutline" /></template>
              </NButton>
              <NPopconfirm @positive-click="removeRow(wf)">
                <template #trigger>
                  <NButton
                    size="tiny"
                    quaternary
                    type="error"
                    :title="$t('common.delete')"
                    :aria-label="$t('common.delete')"
                  >
                    <template #icon><NIcon :component="TrashOutline" /></template>
                  </NButton>
                </template>
                {{ deleteConfirmText(wf) }}
              </NPopconfirm>
            </div>
          </article>
        </div>
        <NEmpty
          v-else
          :description="hasFilter ? $t('common.noMatch') : $t('workflows.empty')"
          class="empty"
        >
          <template #extra>
            <NButton v-if="hasFilter" secondary @click="clearFilters">{{
              $t('common.clearFilters')
            }}</NButton>
            <NButton v-else type="primary" @click="importFile">{{
              $t('workflows.import')
            }}</NButton>
          </template>
        </NEmpty>
      </NSpin>
    </div>

    <!-- Queue -->
    <NModal
      v-model:show="showQueue"
      preset="card"
      :title="$t('workflows.queueTitle')"
      style="width: 480px; border-radius: 20px"
    >
      <NSpace vertical>
        <div>{{ queueTarget?.name }}</div>
        <NSelect
          :options="store.instances.map((i) => ({ label: i.name, value: i.id }))"
          :value="queueInstanceId"
          :placeholder="$t('workflows.instancePlaceholder')"
          @update:value="(v: string) => (queueInstanceId = v)"
        />
        <NInputNumber v-model:value="seed" :placeholder="$t('workflows.seedPlaceholder')" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="closeQueue">{{ $t('workflows.cancel') }}</NButton>
          <NTooltip trigger="hover" :disabled="queueInstanceRunning">
            <template #trigger>
              <span class="btn-wrap">
                <NButton
                  type="primary"
                  :loading="queuing"
                  :disabled="!queueInstanceRunning"
                  @click="doQueue"
                >
                  {{ $t('workflows.enqueue') }}
                </NButton>
              </span>
            </template>
            {{ needInstanceHint }}
          </NTooltip>
        </NSpace>
      </template>
    </NModal>

    <!-- Rename -->
    <NModal
      v-model:show="showRename"
      preset="card"
      :title="$t('workflows.renameTitle')"
      style="width: 420px; border-radius: 20px"
    >
      <NInputGroup>
        <NInput
          v-model:value="renameValue"
          :placeholder="$t('workflows.renamePlaceholder')"
          @keyup.enter="doRename"
        />
      </NInputGroup>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRename = false">{{ $t('workflows.cancel') }}</NButton>
          <NButton type="primary" @click="doRename">{{ $t('workflows.renameSave') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Tags -->
    <NModal
      v-model:show="showTags"
      preset="card"
      :title="$t('workflows.tagsTitle')"
      style="width: 480px; border-radius: 20px"
    >
      <NDynamicTags v-model:value="tagsValue" />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showTags = false">{{ $t('workflows.cancel') }}</NButton>
          <NButton type="primary" @click="doTags">{{ $t('workflows.tagsSave') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Detail -->
    <NModal
      v-model:show="showDetail"
      preset="card"
      :title="detail?.name || $t('workflows.detail')"
      style="width: 560px; border-radius: 20px"
    >
      <NSpace v-if="detail" vertical>
        <div>
          <b>{{ $t('workflows.filePath') }}</b> <NText code>{{ detail.path }}</NText>
        </div>
        <div v-if="detail.sourcePath">
          <b>{{ $t('workflows.sourcePath') }}</b> <NText code>{{ detail.sourcePath }}</NText>
        </div>
        <div>
          <b>{{ $t('workflows.origin') }}</b> {{ originLabel(detail.origin) }}
        </div>
        <div>
          <b>{{ $t('workflows.nodeCount') }}</b> {{ detail.nodeCount }}
        </div>
        <div v-if="detail.modelUsed">
          <b>{{ $t('workflows.modelUsed') }}</b>
          <NTag
            size="tiny"
            round
            type="info"
            style="cursor: pointer; margin-left: 6px"
            @click="router.push({ path: '/models', query: { q: detail.modelUsed } })"
          >
            {{ detail.modelUsed }} →
          </NTag>
        </div>
        <div v-if="detail.seed != null">
          <b>{{ $t('workflows.seed') }}</b> {{ detail.seed }}
        </div>
        <div v-if="detail.description">
          <b>{{ $t('workflows.description') }}</b> {{ detail.description }}
        </div>
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
              {{ n }} —
            </NTag>
          </NSpace>
        </div>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showDetail = false">{{ $t('workflows.close') }}</NButton>
          <NButton secondary @click="detail && reveal(detail)">{{
            $t('workflows.reveal')
          }}</NButton>
          <NButton v-if="detail" type="primary" @click="openCompare(detail)">{{
            $t('workflows.compareWith')
          }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Compare (0.1.11) -->
    <NModal
      v-model:show="showCompare"
      preset="card"
      :title="$t('workflows.compareTitle')"
      style="width: 760px; border-radius: 20px"
    >
      <NSpace vertical :size="14">
        <div class="cmp-pick">
          <NSelect
            v-model:value="compareA"
            :options="compareOptions"
            :placeholder="$t('workflows.compareA')"
            filterable
          />
          <NSelect
            v-model:value="compareB"
            :options="compareOptions"
            :placeholder="$t('workflows.compareB')"
            filterable
          />
          <NButton
            type="primary"
            :loading="comparing"
            :disabled="!compareA || !compareB || compareA === compareB"
            @click="runCompare"
          >
            {{ $t('workflows.compareRun') }}
          </NButton>
        </div>
        <template v-if="compareResult">
          <table class="cmp-table">
            <thead>
              <tr>
                <th>{{ $t('workflows.compareField') }}</th>
                <th>{{ compareResult.a.name }}</th>
                <th>{{ compareResult.b.name }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in compareResult.diffs" :key="d.field" :class="{ changed: d.changed }">
                <td class="cmp-field">{{ cmpFieldLabel(d.field) }}</td>
                <td class="mono">{{ d.a }}</td>
                <td class="mono">{{ d.b }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="compareResult.nodesOnlyA.length" class="cmp-nodes">
            <b>{{ $t('workflows.compareOnlyA') }}</b>
            <NSpace style="margin-top: 6px">
              <NTag
                v-for="n in compareResult.nodesOnlyA.slice(0, 24)"
                :key="n"
                size="tiny"
                round
                type="warning"
                >{{ n }}</NTag
              >
            </NSpace>
          </div>
          <div v-if="compareResult.nodesOnlyB.length" class="cmp-nodes">
            <b>{{ $t('workflows.compareOnlyB') }}</b>
            <NSpace style="margin-top: 6px">
              <NTag
                v-for="n in compareResult.nodesOnlyB.slice(0, 24)"
                :key="n"
                size="tiny"
                round
                type="info"
                >{{ n }}</NTag
              >
            </NSpace>
          </div>
        </template>
        <NEmpty v-else :description="$t('workflows.compareIdle')" style="padding: 24px 0" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCompare = false">{{ $t('common.close') }}</NButton>
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
  grid-auto-rows: 1fr;
}
.wf {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wf.missing {
  opacity: 0.72;
  border: 1px dashed rgba($color-danger, 0.45);
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
.wf-top .n-button {
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
  color: $color-text-muted-ink;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 路径/来源固定单行省略 —— 多行 break-all 是卡片高度参差的主因 */
.wf-path {
  font-size: 11px;
  color: $color-text-muted-ink;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-src {
  font-size: 10.5px;
  color: $color-text-muted-ink;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
/* 第二排操作吸底，保证同网格卡片按钮位置一致 */
.wf-actions-secondary {
  margin-top: auto;
}
.btn-wrap {
  display: inline-flex;
}
.empty {
  padding: 64px 0;
}

/* ---------- compare (0.1.11) ---------- */
.cmp-pick {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 10px;
}

.cmp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;

  th,
  td {
    text-align: left;
    padding: 7px 10px;
    border-bottom: 1px solid $color-border;
    word-break: break-all;
  }

  th {
    color: $color-text-secondary;
    font-weight: 700;
  }

  tr.changed td {
    background: rgba($color-warning, 0.08);
  }
}

.cmp-field {
  color: $color-text-muted-ink;
  white-space: nowrap;
}

.cmp-nodes {
  font-size: 12.5px;
  color: $color-text-secondary;
}
</style>
