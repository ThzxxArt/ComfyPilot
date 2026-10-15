<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AddOutline,
  PlayOutline,
  StopOutline,
  TrashOutline,
  FolderOpenOutline,
  OpenOutline,
  RefreshOutline,
  PowerOutline,
  DownloadOutline,
  LinkOutline,
  RocketOutline,
  CreateOutline,
  TerminalOutline,
  PinOutline,
  SearchOutline,
  EllipsisHorizontalOutline,
  InformationCircleOutline,
  CloudDownloadOutline,
  ArrowUpCircleOutline,
  ConstructOutline,
  AlertCircleOutline
} from '@vicons/ionicons5'
import {
  NButton,
  NEmpty,
  NIcon,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSpace,
  NSpin,
  NSelect,
  NTag,
  NCheckbox,
  NSwitch,
  useMessage,
  useDialog,
  NInputGroup,
  NDropdown,
  NTooltip,
  type DropdownOption
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { useComfyUpdate } from '@/composables/useComfyUpdate'
import { LAUNCH_ARG_ERROR_KEYS, launchArgWarningKey } from '@shared/launchArgs'
import ComfyUpdateProgressModal from '@/components/ComfyUpdateProgressModal.vue'
import LaunchProfileEditor from '@/components/LaunchProfileEditor.vue'
import { useI18n } from 'vue-i18n'
import { formatDate, formatUptime } from '@/utils/format'
import { versionMismatch } from '@/utils/versionDisplay'
import type {
  ComfyInstanceConfig,
  ComfyInstanceInfo,
  LaunchArgTemplate,
  LaunchProfile,
  EnvProbe,
  PortCheckResult,
  InstanceDiscoveryCandidate,
  LaunchCommandPreview,
  InstanceStatus,
  ComfyUpdateInfo
} from '@shared/types'

const router = useRouter()
const route = useRoute()
const store = useAppStore()
const message = useMessage()
const dialog = useDialog()
const { t } = useI18n()
const { launch, stop, restart, forceKill, busy } = useLaunch()

const loading = ref(false)
const showCreate = ref(false)
const saving = ref(false)
const templates = ref<LaunchArgTemplate[]>([])
const envProbes = ref<Record<string, EnvProbe>>({})
const portChecks = ref<Record<number, PortCheckResult>>({})
const search = ref('')
const showDiscover = ref(false)
const discovering = ref(false)
const candidates = ref<InstanceDiscoveryCandidate[]>([])
const selectedCandidates = ref<string[]>([])
const preview = ref<LaunchCommandPreview | null>(null)
const previewFor = ref<ComfyInstanceInfo | null>(null)
const showPreviewModal = ref(false)
const editing = ref<ComfyInstanceInfo | null>(null)
const showEditModal = ref(false)
const editExtraArgs = ref('')
const editSaving = ref(false)
/** 0.1.9 structured launch tuning buffers (edit + create). */
const editProfile = ref<LaunchProfile>({})
const draftProfile = ref<LaunchProfile>({})

const draft = ref<ComfyInstanceConfig>({
  id: '',
  name: 'My ComfyUI',
  path: '',
  pythonPath: '',
  venvPath: '',
  port: 8188,
  listen: '127.0.0.1',
  extraArgs: [],
  argTemplateId: 'default',
  enabled: true,
  notes: '',
  autoStart: false,
  frontendVersion: '',
  pinned: false
})
const extraArgsText = ref('')

watch(extraArgsText, (v) => {
  draft.value.extraArgs = v.split(/\s+/).filter(Boolean)
})

/** Pinned first, then running, then name — mirrors instanceService.list. */
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  let list = [...store.instances]
  if (q) {
    list = list.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.path.toLowerCase().includes(q) ||
        String(i.port).includes(q)
    )
  }
  return list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const aRun = a.status === 'running' ? 0 : 1
    const bRun = b.status === 'running' ? 0 : 1
    if (aRun !== bRun) return aRun - bRun
    return a.name.localeCompare(b.name)
  })
})

function statusLabel(s: InstanceStatus | undefined): string {
  return t(`status.${s || 'unknown'}`)
}

/** Open the edit modal for an instance id (Detail → Edit deep-link). */
async function openEditById(editId: string): Promise<void> {
  if (!editId) return
  if (!store.instances.length) {
    try {
      await store.refreshInstances()
    } catch {
      /* fall through — not found below */
    }
  }
  const item = store.instances.find((i) => i.id === editId)
  if (item) {
    openEdit(item)
  } else {
    message.warning(t('instance.editTargetMissing'))
  }
}

function consumeEditQuery(): string | null {
  const raw = route.query.edit
  const editId = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] || '') : ''
  if (!editId) return null
  // Consume the deep-link so the modal does not reopen on a later re-render.
  void router.replace({ path: '/instances', query: { ...route.query, edit: undefined } })
  return editId
}

onMounted(async () => {
  loading.value = true
  try {
    await store.refreshInstances()
    templates.value = await ipc('settings.launchTemplates')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
  const editId = consumeEditQuery()
  if (editId) await openEditById(editId)
})

watch(
  () => route.query.edit,
  (raw) => {
    const editId = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] || '') : ''
    if (editId) {
      void openEditById(editId)
      void router.replace({ path: '/instances', query: { ...route.query, edit: undefined } })
    }
  }
)

async function pickPath(field: 'path' | 'pythonPath' | 'venvPath'): Promise<void> {
  await pickPathInto(draft.value, field)
}

async function pickEditPath(field: 'path' | 'pythonPath' | 'venvPath'): Promise<void> {
  if (!editing.value) return
  await pickPathInto(editing.value, field)
}

async function pickPathInto(
  target: ComfyInstanceConfig | ComfyInstanceInfo,
  field: 'path' | 'pythonPath' | 'venvPath'
): Promise<void> {
  try {
    if (field === 'pythonPath') {
      const p = await ipc('shell.pickFile', {
        filters: [
          { name: 'Python', extensions: ['exe'] },
          { name: 'All', extensions: ['*'] }
        ]
      })
      if (p) target[field] = p
    } else {
      const p = await ipc('shell.pickDirectory')
      if (p) target[field] = p
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function openDiscover(): Promise<void> {
  showDiscover.value = true
  await runDiscover()
}

async function runDiscover(): Promise<void> {
  discovering.value = true
  try {
    candidates.value = await ipc('instance.discover')
    selectedCandidates.value = candidates.value
      .filter((c) => !c.registered && c.hasMainPy)
      .map((c) => c.path)
    if (!candidates.value.length) {
      message.info(t('instance.discoverEmpty'))
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    discovering.value = false
  }
}

function toggleCandidate(path: string, checked: boolean): void {
  if (checked) {
    if (!selectedCandidates.value.includes(path)) {
      selectedCandidates.value = [...selectedCandidates.value, path]
    }
  } else {
    selectedCandidates.value = selectedCandidates.value.filter((p) => p !== path)
  }
}

/** Open the create dialog with a FRESH profile draft (no leakage between opens). */
function openCreate(): void {
  draftProfile.value = {}
  showCreate.value = true
}

function useCandidate(c: InstanceDiscoveryCandidate): void {
  draft.value.path = c.path
  if (c.estimatedVersion) draft.value.name = `ComfyUI ${c.estimatedVersion}`
  showDiscover.value = false
  openCreate()
  message.success(t('instance.candidateFilled', { path: c.path }))
}

async function importSelectedCandidates(): Promise<void> {
  const picks = candidates.value.filter(
    (c) => selectedCandidates.value.includes(c.path) && !c.registered
  )
  if (!picks.length) {
    message.warning(t('instance.selectUnregisteredFirst'))
    return
  }
  let ok = 0
  let fail = 0
  for (const c of picks) {
    try {
      const port = await ipc('instance.suggestPort')
      // Minimal payload — never spread draft.value (form residue must not leak).
      await ipc('instance.save', {
        id: '',
        name: c.path.split(/[\\/]/).pop() || 'ComfyUI',
        path: c.path,
        port,
        pinned: false,
        extraArgs: [],
        argTemplateId: 'default',
        enabled: true,
        autoStart: false,
        notes: c.reason,
        pythonPath: '',
        venvPath: '',
        listen: '127.0.0.1',
        frontendVersion: ''
      })
      ok++
    } catch (err) {
      fail++
      message.error(`${c.path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await store.refreshInstances()
  showDiscover.value = false
  if (fail === 0) {
    message.success(t('instance.importedCount', { n: ok }))
  } else {
    message.warning(t('instance.importedSummary', { ok, fail }))
  }
}

async function suggestPort(): Promise<void> {
  try {
    draft.value.port = await ipc('instance.suggestPort')
    message.success(t('instance.portAssigned', { port: draft.value.port }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function checkPortOf(port: number): Promise<void> {
  try {
    const r = await ipc('instance.checkPort', port)
    portChecks.value = { ...portChecks.value, [port]: r }
    message[r.available ? 'success' : 'warning'](
      r.available
        ? t('instance.portAvailableMsg', { port: r.port })
        : t('instance.portOccupiedMsg', { port: r.port, owner: r.owner || '' })
    )
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function checkPort(): Promise<void> {
  await checkPortOf(draft.value.port)
}

async function checkEditPort(): Promise<void> {
  if (!editing.value) return
  await checkPortOf(editing.value.port)
}

async function createInstance(): Promise<void> {
  if (!draft.value.path) {
    message.warning(t('instance.selectInstallDirFirst'))
    return
  }
  saving.value = true
  try {
    draft.value.extraArgs = extraArgsText.value.split(/\s+/).filter(Boolean)
    draft.value.launchProfile = Object.keys(draftProfile.value).length
      ? { ...draftProfile.value }
      : undefined
    const info = await ipc('instance.save', { ...draft.value })
    await store.refreshInstances()
    showCreate.value = false
    message.success(t('instance.instanceAdded', { name: info.name }))
    // Reset so a second "Add" does not inherit the previous form.
    draft.value = {
      id: '',
      name: 'My ComfyUI',
      path: '',
      pythonPath: '',
      venvPath: '',
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true,
      notes: '',
      autoStart: false,
      frontendVersion: '',
      pinned: false
    }
    extraArgsText.value = ''
    draftProfile.value = {}
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

/** Primary launcher action: start, wait ready, then open the frontend (useLaunch navigates). */
async function launchAndOpen(item: ComfyInstanceInfo): Promise<void> {
  await launch(item, { open: 'embed' })
}

async function showPreview(item: ComfyInstanceInfo): Promise<void> {
  try {
    preview.value = await ipc('instance.previewLaunch', item.id)
    previewFor.value = item
    showPreviewModal.value = true
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function copyPreview(): Promise<void> {
  if (!preview.value) return
  await ipc('shell.writeClipboard', preview.value.commandLine)
  message.success(t('instance.launchCmdCopied'))
}

async function exportLaunchScript(): Promise<void> {
  if (!previewFor.value) return
  try {
    const { path } = await ipc('instance.exportLaunchScript', previewFor.value.id)
    message.success(t('instance.launchScriptExported', { path }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function openEdit(item: ComfyInstanceInfo): void {
  editing.value = { ...item }
  editExtraArgs.value = (item.extraArgs || []).join(' ')
  editProfile.value = { ...(item.launchProfile || {}) }
  showEditModal.value = true
}

async function saveEdit(): Promise<void> {
  if (!editing.value) return
  editSaving.value = true
  try {
    editing.value.extraArgs = editExtraArgs.value.split(/\s+/).filter(Boolean)
    editing.value.launchProfile = Object.keys(editProfile.value).length
      ? { ...editProfile.value }
      : undefined
    await ipc('instance.save', { ...editing.value })
    await store.refreshInstances()
    editing.value = null
    showEditModal.value = false
    message.success(t('instance.configSaved'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    editSaving.value = false
  }
}

async function togglePin(item: ComfyInstanceInfo): Promise<void> {
  try {
    await ipc('instance.save', { ...item, pinned: !item.pinned })
    await store.refreshInstances()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeInstance(info: ComfyInstanceInfo): Promise<void> {
  try {
    await ipc('instance.remove', info.id)
    // Drop cached probe results with the instance — they were keyed by id
    // and lingered forever (0.1.13).
    delete envProbes.value[info.id]
    await store.refreshInstances()
    message.success(t('instance.removedToast'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function confirmRemove(item: ComfyInstanceInfo): void {
  dialog.warning({
    title: t('instance.remove'),
    content: t('instance.confirmRemove'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      void removeInstance(item)
    }
  })
}

function confirmForceKill(item: ComfyInstanceInfo): void {
  dialog.warning({
    title: t('instance.forceKill'),
    content: t('instance.confirmForceKill'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      void forceKill(item)
    }
  })
}

async function probeEnv(info: ComfyInstanceInfo): Promise<void> {
  try {
    envProbes.value[info.id] = await ipc('instance.probeEnv', info.id)
    message.success(t('instance.envProbed', { name: info.name }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// ---------- ComfyUI update / repair (0.1.4) ----------
const { startUpdate, checkComfyUpdate, repairEnv, updating, repairing, progress } = useComfyUpdate()
const showUpdateModal = ref(false)
const updateModalTitle = ref('')
const updateInfos = ref<Record<string, ComfyUpdateInfo>>({})

/** Reopen the (now closable) progress modal after the user hid it (0.1.11). */
function reopenUpdateModal(): void {
  // Repair and update share the stream — label by what actually runs.
  updateModalTitle.value = repairing.value ? t('instance.repairEnv') : t('instance.updateComfy')
  showUpdateModal.value = true
}

function sourceLabel(source: ComfyUpdateInfo['source']): string {
  if (source === 'git') return t('instance.sourceGit')
  if (source === 'zip') return t('instance.sourceZip')
  return t('instance.sourceUnknown')
}

function updateInfoSummary(info: ComfyUpdateInfo): string {
  const parts: string[] = [
    `${t('instance.versionLabel')}: ${info.current}`,
    sourceLabel(info.source)
  ]
  if (info.latest) parts.push(`${t('nodes.hasUpdate', { version: info.latest })}`)
  if (typeof info.behindCount === 'number') {
    parts.push(t('instance.behindCount', { n: info.behindCount }))
  }
  if (info.latestRelease) {
    parts.push(
      t('instance.latestRelease', {
        tag: info.latestRelease.tag,
        date: formatDate(info.latestRelease.publishedAt)
      })
    )
  }
  parts.push(
    info.updatable
      ? t('instance.updateAvailable', {
          latest: info.latest || info.current,
          current: info.current
        })
      : t('instance.updateNone')
  )
  if (info.error) parts.push(t('instance.updateCheckFailed', { error: info.error }))
  return parts.join(' · ')
}

async function doCheckComfyUpdate(item: ComfyInstanceInfo): Promise<void> {
  try {
    const info = await checkComfyUpdate(item.id)
    updateInfos.value = { ...updateInfos.value, [item.id]: info }
    dialog.info({
      title: t('instance.checkUpdate'),
      content: updateInfoSummary(info),
      positiveText: t('common.confirm')
    })
  } catch (err) {
    message.error(
      t('instance.updateCheckFailed', { error: err instanceof Error ? err.message : String(err) })
    )
  }
}

function confirmUpdateComfy(item: ComfyInstanceInfo): void {
  dialog.warning({
    title: t('instance.confirmUpdateComfy'),
    content: `${t('instance.confirmUpdateComfyBody')} ${t('instance.preserveNote')}`,
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      void runUpdateComfy(item)
    }
  })
}

async function runUpdateComfy(item: ComfyInstanceInfo): Promise<void> {
  updateModalTitle.value = t('instance.updateComfy')
  showUpdateModal.value = true
  try {
    const result = await startUpdate(item.id, { updateDeps: true })
    if (result.status === 'done') {
      message.success(t('update.msgDone'))
      await store.refreshInstances()
    } else if (result.error) {
      message.error(result.error)
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function confirmRepairEnv(item: ComfyInstanceInfo): void {
  dialog.warning({
    title: t('instance.repairEnv'),
    content: t('install.repairConfirm', { name: item.name }),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      void runRepairEnv(item)
    }
  })
}

async function runRepairEnv(item: ComfyInstanceInfo): Promise<void> {
  // Show the shared progress modal so the user can watch venv/torch/requirements.
  updateModalTitle.value = t('instance.repairEnv')
  showUpdateModal.value = true
  try {
    envProbes.value[item.id] = await repairEnv(item.id)
    message.success(t('instance.repairDone'))
  } catch (err) {
    message.error(
      t('instance.repairFailed', { error: err instanceof Error ? err.message : String(err) })
    )
  }
}

async function exportDiag(info: ComfyInstanceInfo): Promise<void> {
  try {
    const pkg = await ipc('instance.exportDiagnostics', info.id)
    message.success(t('instance.diagExported', { path: pkg.path }))
    void ipc('shell.openPath', pkg.path).catch(() => undefined)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function confirmStartAll(): void {
  dialog.info({
    title: t('instance.confirmStartAllTitle'),
    content: t('instance.confirmStartAll'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      void startAll()
    }
  })
}

/** Any instance live — gates the "stop all" button (0.1.11). */
const anyRunning = computed(() =>
  store.instances.some((i) => i.status === 'running' || i.status === 'starting')
)

async function startAll(): Promise<void> {
  // Snapshot running ids so the summary can tell "started" from "already up".
  const beforeRunning = new Set(
    store.instances.filter((i) => i.status === 'running').map((i) => i.id)
  )
  try {
    const results = await ipc('instance.startAll')
    await store.refreshInstances()
    void store.syncWs()
    const ok = results.filter((r) => r.ok).length
    const fail = results.length - ok
    const already = results.filter((r) => r.ok && beforeRunning.has(r.id)).length
    const text = t('instance.startAllSummary', {
      started: Math.max(0, ok - already),
      already,
      fail
    })
    if (fail === 0) message.success(text)
    else message.warning(text)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function stopAll(): Promise<void> {
  try {
    const results = await ipc('instance.stopAll')
    await store.refreshInstances()
    void store.syncWs()
    const ok = results.filter((r) => r.ok).length
    const fail = results.length - ok
    const text = t('instance.stopAllSummary', { ok, fail })
    if (fail === 0) message.success(text)
    else message.warning(text)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function confirmStopAll(): void {
  dialog.warning({
    title: t('instance.confirmStopAllTitle'),
    content: t('instance.confirmStopAll'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      void stopAll()
    }
  })
}

function moreOptions(item: ComfyInstanceInfo): DropdownOption[] {
  return [
    {
      label: t('instance.restart'),
      key: 'restart',
      icon: () => h(NIcon, { component: RefreshOutline })
    },
    {
      label: t('instance.previewCmd'),
      key: 'preview',
      icon: () => h(NIcon, { component: TerminalOutline })
    },
    { label: t('instance.edit'), key: 'edit', icon: () => h(NIcon, { component: CreateOutline }) },
    {
      label: item.pinned ? t('instance.unpin') : t('instance.pin'),
      key: 'pin',
      icon: () => h(NIcon, { component: PinOutline })
    },
    {
      label: t('instance.forceKill'),
      key: 'forceKill',
      icon: () => h(NIcon, { component: PowerOutline })
    },
    {
      label: t('instance.openBrowser'),
      key: 'openBrowser',
      icon: () => h(NIcon, { component: OpenOutline }),
      disabled: !item.url
    },
    {
      label: t('instance.probeEnv'),
      key: 'probeEnv',
      icon: () => h(NIcon, { component: LinkOutline })
    },
    {
      label: t('instance.checkUpdate'),
      key: 'checkComfyUpdate',
      icon: () => h(NIcon, { component: CloudDownloadOutline })
    },
    {
      label: t('instance.updateComfy'),
      key: 'updateComfy',
      icon: () => h(NIcon, { component: ArrowUpCircleOutline })
    },
    {
      label: t('instance.repairEnv'),
      key: 'repairEnv',
      icon: () => h(NIcon, { component: ConstructOutline })
    },
    {
      label: t('instance.exportDiag'),
      key: 'exportDiag',
      icon: () => h(NIcon, { component: DownloadOutline })
    },
    {
      label: t('instance.detail'),
      key: 'detail',
      icon: () => h(NIcon, { component: InformationCircleOutline })
    },
    {
      label: t('instance.remove'),
      key: 'remove',
      icon: () => h(NIcon, { component: TrashOutline })
    }
  ]
}

function onMoreSelect(key: string | number, item: ComfyInstanceInfo): void {
  switch (String(key)) {
    case 'restart':
      void restart(item)
      break
    case 'preview':
      void showPreview(item)
      break
    case 'edit':
      openEdit(item)
      break
    case 'pin':
      void togglePin(item)
      break
    case 'forceKill':
      confirmForceKill(item)
      break
    case 'openBrowser':
      if (item.status !== 'running') {
        message.warning(t('common.needRunningInstance'))
        break
      }
      if (item.url) void ipc('shell.openExternal', item.url)
      break
    case 'probeEnv':
      void probeEnv(item)
      break
    case 'checkComfyUpdate':
      void doCheckComfyUpdate(item)
      break
    case 'updateComfy':
      confirmUpdateComfy(item)
      break
    case 'repairEnv':
      confirmRepairEnv(item)
      break
    case 'exportDiag':
      void exportDiag(item)
      break
    case 'detail':
      void router.push(`/instances/${item.id}`)
      break
    case 'remove':
      confirmRemove(item)
      break
  }
}

function statusClass(s: string): string {
  if (s === 'running') return 'chip-success'
  if (s === 'error') return 'chip-danger'
  if (s === 'starting') return 'chip-warning'
  return 'chip-muted'
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('instance.title') }}</h1>
        <p class="page-subtitle">{{ $t('instance.subtitle') }}</p>
      </div>
      <NSpace>
        <NInputGroup>
          <NInput
            v-model:value="search"
            :placeholder="$t('instance.searchPlaceholder')"
            clearable
            style="width: 220px"
          >
            <template #prefix><NIcon :component="SearchOutline" /></template>
          </NInput>
        </NInputGroup>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton secondary @click="confirmStartAll">
              <template #icon><NIcon :component="PlayOutline" /></template>
              {{ $t('instance.startAll') }}
            </NButton>
          </template>
          {{ $t('instance.startAll') }}
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <span class="btn-wrap">
              <NButton secondary type="warning" :disabled="!anyRunning" @click="confirmStopAll">
                <template #icon><NIcon :component="StopOutline" /></template>
                {{ $t('instance.stopAll') }}
              </NButton>
            </span>
          </template>
          {{ anyRunning ? $t('instance.confirmStopAll') : $t('instance.stopAllDisabled') }}
        </NTooltip>
        <NButton secondary @click="openDiscover">
          <template #icon><NIcon :component="FolderOpenOutline" /></template>
          {{ $t('instance.discover') }}
        </NButton>
        <NButton type="primary" @click="openCreate">
          <template #icon><NIcon :component="AddOutline" /></template>
          {{ $t('instance.add') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
      <!-- The progress modal is closable while running (0.1.11); this banner
           keeps the operation reachable until it settles. -->
      <div v-if="updating" class="update-running-banner card">
        <NTag size="small" type="info" round>{{ $t('update.inProgress') }}</NTag>
        <span class="meta update-running-msg mono">{{ progress?.message || '' }}</span>
        <NButton size="tiny" secondary @click="reopenUpdateModal">{{
          $t('nodes.viewProgress')
        }}</NButton>
      </div>
      <NSpin :show="loading">
        <div v-if="filtered.length" class="grid cards">
          <article
            v-for="item in filtered"
            :key="item.id"
            class="card card-interactive inst"
            role="button"
            tabindex="0"
            :aria-label="item.name"
            @click="router.push(`/instances/${item.id}`)"
            @keydown.enter.prevent="router.push(`/instances/${item.id}`)"
            @keydown.space.prevent="router.push(`/instances/${item.id}`)"
          >
            <div class="inst-top">
              <div class="inst-main">
                <div class="inst-name" :title="item.name">
                  <NIcon v-if="item.pinned" :component="PinOutline" :size="14" class="pin-icon" />
                  {{ item.name }}
                </div>
                <div class="inst-path mono" :title="item.path">{{ item.path }}</div>
              </div>
              <span class="chip" :class="statusClass(item.status)">{{
                statusLabel(item.status)
              }}</span>
            </div>

            <div class="meta-row">
              <span
                >{{ $t('instance.listen') }}
                <b class="mono">{{ item.listen }}:{{ item.port }}</b></span
              >
              <span v-if="item.version || item.onlineVersion"
                >{{ $t('instance.versionLabel') }}
                <b>{{ item.onlineVersion || item.version }}</b>
                <NTag
                  v-if="item.onlineVersion"
                  size="tiny"
                  round
                  :type="versionMismatch(item.version, item.onlineVersion) ? 'warning' : 'success'"
                  :title="
                    versionMismatch(item.version, item.onlineVersion)
                      ? $t('instance.onlineVersionMismatch', {
                          installed: item.version,
                          online: item.onlineVersion
                        })
                      : $t('instance.onlineVersionTip')
                  "
                  >{{
                    versionMismatch(item.version, item.onlineVersion)
                      ? $t('instance.onlineVersionBadgeWarn')
                      : $t('instance.onlineBadge')
                  }}</NTag
                ></span
              >
              <span v-if="item.pid"
                >{{ $t('instance.metaPid') }} <b>{{ item.pid }}</b></span
              >
              <span v-if="item.uptimeMs">
                <b>{{ $t('instance.uptime', { t: formatUptime(item.uptimeMs) }) }}</b>
              </span>
              <span v-if="item.autoStart"
                ><NTag size="tiny" type="success" round>{{
                  $t('instance.metaAutoStart')
                }}</NTag></span
              >
              <span v-if="item.managerEnabled"
                ><NTag size="tiny" type="info" round>{{ $t('instance.metaManager') }}</NTag></span
              >
            </div>

            <div v-if="item.lastError" class="inst-error" :title="item.lastError">
              <NIcon :size="13" :component="AlertCircleOutline" />
              <span class="inst-error-text">{{ item.lastError }}</span>
            </div>

            <div v-if="envProbes[item.id]" class="env-box">
              <div class="mono">{{ envProbes[item.id].pythonVersion }}</div>
              <div class="mono">
                torch {{ envProbes[item.id].torchVersion || '—' }} · cuda
                {{ envProbes[item.id].cudaVersion || '—' }}
              </div>
            </div>

            <div class="actions" @click.stop>
              <!-- Primary: launch & open, or stop when running/starting -->
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    v-if="item.status !== 'running' && item.status !== 'starting'"
                    size="small"
                    type="primary"
                    secondary
                    :loading="busy[item.id]"
                    @click="launchAndOpen(item)"
                  >
                    <template #icon><NIcon :component="RocketOutline" /></template>
                    {{ $t('instance.launchOpen') }}
                  </NButton>
                  <NButton
                    v-else
                    size="small"
                    type="warning"
                    secondary
                    :loading="busy[`stop:${item.id}`]"
                    @click="stop(item)"
                  >
                    <template #icon><NIcon :component="StopOutline" /></template>
                    {{ $t('header.stop') }}
                  </NButton>
                </template>
                {{
                  item.status === 'running' || item.status === 'starting'
                    ? $t('header.stop')
                    : $t('instance.launchOpen')
                }}
              </NTooltip>

              <!-- Secondary: start only / open frontend when already running -->
              <NTooltip trigger="hover">
                <template #trigger>
                  <NButton
                    v-if="item.status !== 'running' && item.status !== 'starting'"
                    size="small"
                    type="primary"
                    tertiary
                    @click="launch(item, { open: 'none' })"
                  >
                    <template #icon><NIcon :component="PlayOutline" /></template>
                    {{ $t('header.start') }}
                  </NButton>
                  <NButton
                    v-else
                    size="small"
                    tertiary
                    :disabled="item.status !== 'running' || !item.url"
                    @click="
                      item.status === 'running' &&
                      item.url &&
                      router.push({ path: '/embed', query: { url: item.url } })
                    "
                  >
                    <template #icon><NIcon :component="OpenOutline" /></template>
                    {{ $t('instance.openFrontend') }}
                  </NButton>
                </template>
                {{
                  item.status === 'running' || item.status === 'starting'
                    ? $t('instance.openFrontend')
                    : $t('header.start')
                }}
              </NTooltip>

              <!-- More -->
              <NTooltip trigger="hover">
                <template #trigger>
                  <NDropdown
                    trigger="click"
                    :options="moreOptions(item)"
                    @select="(key: string | number) => onMoreSelect(key, item)"
                  >
                    <NButton size="small" secondary>
                      <template #icon><NIcon :component="EllipsisHorizontalOutline" /></template>
                    </NButton>
                  </NDropdown>
                </template>
                {{ $t('instance.moreActions') }}
              </NTooltip>
            </div>
          </article>
        </div>
        <div v-else class="empty">
          <NEmpty :description="$t('instance.emptyInstances')">
            <template #extra>
              <NSpace>
                <NButton type="primary" @click="openCreate">{{
                  $t('instance.addExistingManually')
                }}</NButton>
                <NButton secondary @click="router.push('/install')">
                  <template #icon><NIcon :component="RocketOutline" /></template>
                  {{ $t('instance.installIsolated') }}
                </NButton>
                <NButton secondary @click="openDiscover">{{ $t('instance.discover') }}</NButton>
              </NSpace>
            </template>
          </NEmpty>
        </div>
      </NSpin>
    </div>

    <!-- Discovery candidates -->
    <NModal
      v-model:show="showDiscover"
      preset="card"
      :title="$t('instance.candidates')"
      style="width: 720px; border-radius: 20px"
    >
      <NSpin :show="discovering">
        <div v-if="candidates.length" class="cand-list">
          <div v-for="c in candidates" :key="c.path" class="cand-row">
            <NCheckbox
              v-if="!c.registered"
              :checked="selectedCandidates.includes(c.path)"
              @update:checked="(v: boolean) => toggleCandidate(c.path, v)"
            />
            <span v-else class="cand-reg">{{ $t('instance.alreadyRegistered') }}</span>
            <div class="cand-main">
              <div class="mono cand-path">{{ c.path }}</div>
              <div class="cand-meta">
                {{ c.reason }}
                <span v-if="c.hasMainPy"> · main.py</span>
                <span v-if="c.hasVenv"> · venv</span>
                <span v-if="c.estimatedVersion"> · {{ c.estimatedVersion }}</span>
              </div>
            </div>
            <NButton size="tiny" secondary :disabled="c.registered" @click="useCandidate(c)">{{
              $t('instance.fillForm')
            }}</NButton>
          </div>
        </div>
        <NEmpty v-else :description="$t('instance.noCandidates')" />
      </NSpin>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showDiscover = false">{{ $t('common.close') }}</NButton>
          <NButton secondary :loading="discovering" @click="runDiscover">{{
            $t('instance.rescan')
          }}</NButton>
          <NButton type="primary" @click="importSelectedCandidates">{{
            $t('instance.importSelected')
          }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Launch command preview -->
    <NModal
      v-model:show="showPreviewModal"
      preset="card"
      :title="$t('instance.previewCmd')"
      style="width: 720px; border-radius: 20px"
    >
      <div v-if="preview" class="preview-box">
        <div class="preview-label mono">cwd: {{ preview.cwd }}</div>
        <pre class="mono preview-cmd">{{ preview.commandLine }}</pre>
        <div v-if="preview.validationErrors?.length" class="preview-errors">
          <div v-for="(e, i) in preview.validationErrors" :key="i" class="preview-error">
            •
            {{
              e.code === 'invalid-number'
                ? $t('launchArgs.errInvalidNumber', { flag: e.flag || '' })
                : $t(LAUNCH_ARG_ERROR_KEYS[e.code] || 'launchArgs.errGeneric', {
                    flag: e.flag || ''
                  })
            }}
          </div>
        </div>
        <div v-if="preview.validationWarnings?.length" class="preview-warns">
          <div v-for="(w, i) in preview.validationWarnings" :key="i" class="preview-warn">
            • {{ $t(launchArgWarningKey(w.code), { flag: w.flag }) }}
          </div>
        </div>
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showPreviewModal = false">{{ $t('common.close') }}</NButton>
          <NButton secondary @click="exportLaunchScript">{{ $t('instance.exportScript') }}</NButton>
          <NButton type="primary" @click="copyPreview">{{ $t('instance.copyCmd') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Edit instance -->
    <NModal
      v-model:show="showEditModal"
      preset="card"
      :title="$t('instance.edit')"
      style="width: 640px; border-radius: 20px"
    >
      <NForm v-if="editing" label-placement="top">
        <NFormItem :label="$t('instance.instanceName')">
          <NInput v-model:value="editing.name" />
        </NFormItem>
        <NFormItem :label="$t('instance.installDir')">
          <NInput v-model:value="editing.path">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickEditPath('path')">{{
                $t('instance.browse')
              }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem label="Python">
          <NInput
            v-model:value="editing.pythonPath"
            :placeholder="$t('instance.pythonPlaceholder')"
          >
            <template #suffix>
              <NButton size="tiny" secondary @click="pickEditPath('pythonPath')">{{
                $t('instance.browse')
              }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem label="venv">
          <NInput v-model:value="editing.venvPath">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickEditPath('venvPath')">{{
                $t('instance.browse')
              }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <div class="form-row">
          <NFormItem :label="$t('instance.port')">
            <NSpace vertical :size="6">
              <NSpace>
                <NInputNumber v-model:value="editing.port" :min="1" :max="65535" />
                <NButton size="small" secondary @click="checkEditPort">{{
                  $t('instance.checkPort')
                }}</NButton>
              </NSpace>
              <div
                v-if="editing.port && portChecks[editing.port]"
                class="port-check"
                :class="portChecks[editing.port]?.available ? 'ok' : 'bad'"
              >
                {{
                  portChecks[editing.port]?.available
                    ? $t('instance.portAvailableMsg', { port: editing.port })
                    : $t('instance.portOccupiedMsg', {
                        port: editing.port,
                        owner: portChecks[editing.port]?.owner || ''
                      })
                }}
              </div>
            </NSpace>
          </NFormItem>
          <NFormItem :label="$t('instance.listen')">
            <NInput v-model:value="editing.listen" />
          </NFormItem>
        </div>
        <NFormItem :label="$t('instance.argTemplate')">
          <NSelect
            v-model:value="editing.argTemplateId"
            :options="
              templates.map((tpl) => ({
                label: `${t(`launchTpl.${tpl.id}.name`)} — ${t(`launchTpl.${tpl.id}.desc`)}`,
                value: tpl.id
              }))
            "
          />
        </NFormItem>
        <LaunchProfileEditor
          v-model="editProfile"
          :extra-args="editExtraArgs.split(/\s+/).filter(Boolean)"
          :gpus="store.system?.gpus"
          :version="editing?.onlineVersion || ''"
          :baseline="editing?.launchProfile"
        />
        <NFormItem :label="$t('instance.extraArgs')">
          <NInput v-model:value="editExtraArgs" />
        </NFormItem>
        <NFormItem :label="$t('instance.notes')">
          <NInput v-model:value="editing.notes" type="textarea" :rows="2" />
        </NFormItem>
        <div class="form-row">
          <NFormItem label="autoStart">
            <NSwitch v-model:value="editing.autoStart" />
          </NFormItem>
          <NFormItem :label="$t('instance.pinned')">
            <NSwitch v-model:value="editing.pinned" />
          </NFormItem>
        </div>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showEditModal = false">{{ $t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="editSaving" @click="saveEdit">{{
            $t('common.save')
          }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Create instance -->
    <NModal
      v-model:show="showCreate"
      preset="card"
      :title="$t('instance.addTitle')"
      style="width: 640px; border-radius: 20px"
    >
      <NForm label-placement="top">
        <NFormItem :label="$t('instance.instanceName')">
          <NInput v-model:value="draft.name" :placeholder="$t('instance.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="$t('instance.comfyInstallDir')">
          <NInput v-model:value="draft.path" :placeholder="$t('instance.pathPlaceholder')">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickPath('path')">{{
                $t('instance.browse')
              }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem :label="$t('instance.pythonLabel')">
          <NInput v-model:value="draft.pythonPath" :placeholder="$t('instance.pythonPlaceholder')">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickPath('pythonPath')">{{
                $t('instance.browse')
              }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem :label="$t('instance.venvLabel')">
          <NInput v-model:value="draft.venvPath" :placeholder="$t('instance.venvPlaceholder')">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickPath('venvPath')">{{
                $t('instance.browse')
              }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem :label="$t('instance.argTemplate')">
          <NSelect
            v-model:value="draft.argTemplateId"
            :options="
              templates.map((tpl) => ({
                label: `${t(`launchTpl.${tpl.id}.name`)} — ${t(`launchTpl.${tpl.id}.desc`)}`,
                value: tpl.id
              }))
            "
          />
        </NFormItem>
        <LaunchProfileEditor
          v-model="draftProfile"
          :extra-args="extraArgsText.split(/\s+/).filter(Boolean)"
          :gpus="store.system?.gpus"
        />
        <div class="form-row">
          <NFormItem :label="$t('instance.port')">
            <NSpace vertical :size="6">
              <NSpace>
                <NInputNumber v-model:value="draft.port" :min="1" :max="65535" />
                <NButton size="small" secondary @click="suggestPort">{{
                  $t('instance.suggestPort')
                }}</NButton>
                <NButton size="small" secondary @click="checkPort">{{
                  $t('instance.checkPort')
                }}</NButton>
              </NSpace>
              <div
                v-if="draft.port && portChecks[draft.port]"
                class="port-check"
                :class="portChecks[draft.port]?.available ? 'ok' : 'bad'"
              >
                {{
                  portChecks[draft.port]?.available
                    ? $t('instance.portAvailableMsg', { port: draft.port })
                    : $t('instance.portOccupiedMsg', {
                        port: draft.port,
                        owner: portChecks[draft.port]?.owner || ''
                      })
                }}
              </div>
            </NSpace>
          </NFormItem>
          <NFormItem :label="$t('instance.listenAddr')">
            <NInput v-model:value="draft.listen" placeholder="127.0.0.1" />
          </NFormItem>
        </div>
        <NFormItem :label="$t('instance.extraArgs')">
          <NInput
            :value="extraArgsText"
            :placeholder="$t('instance.extraArgsPlaceholder')"
            @update:value="(v: string) => (extraArgsText = v)"
          />
        </NFormItem>
        <div class="form-row">
          <NFormItem :label="$t('instance.autoStartLabel')">
            <NSwitch v-model:value="draft.autoStart" />
          </NFormItem>
          <NFormItem :label="$t('instance.pinned')">
            <NSwitch v-model:value="draft.pinned" />
          </NFormItem>
        </div>
        <NFormItem :label="$t('instance.notes')">
          <NInput v-model:value="draft.notes" type="textarea" :rows="2" />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">{{ $t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="createInstance">{{
            $t('common.save')
          }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- ComfyUI update progress -->
    <ComfyUpdateProgressModal v-model:show="showUpdateModal" :title="updateModalTitle" />
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.cards {
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
}
.inst {
  padding: 20px;
  cursor: pointer;
}
.btn-wrap {
  display: inline-flex;
}
.update-running-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.update-running-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inst-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: -4px 0 10px;
  font-size: 12px;
  color: $color-danger;
  min-width: 0;
}
.inst-error-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inst-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.inst-main {
  flex: 1;
  min-width: 0;
}
.inst-top .chip {
  flex-shrink: 0;
}
.inst-name {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pin-icon {
  color: $color-primary;
  flex-shrink: 0;
}
.inst-path {
  margin-top: 6px;
  font-size: 12px;
  color: $color-text-muted-ink;
  word-break: break-all;
}
.meta-row {
  /* Two-column info grid (0.1.11) — every cell aligns, long values ellipsize. */
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 10px;
  margin: 12px 0;
  font-size: 12.5px;
  color: $color-text-secondary;
  b {
    color: $color-text;
  }

  > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.env-box {
  background: $color-surface-2;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 11.5px;
  color: $color-text-muted-ink;
  margin-bottom: 10px;
}
.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.empty {
  padding: 64px 0;
}
.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.port-check {
  font-size: 12px;
  line-height: 1.5;
  &.ok {
    color: $color-success;
  }
  &.bad {
    color: $color-danger;
  }
}
.cand-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 420px;
  overflow: auto;
}
.cand-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid $color-border;
  border-radius: 12px;
}
.cand-main {
  flex: 1;
  min-width: 0;
}
.cand-path {
  font-size: 12.5px;
  word-break: break-all;
}
.cand-meta {
  font-size: 11.5px;
  color: $color-text-muted-ink;
  margin-top: 2px;
}
.cand-reg {
  font-size: 11px;
  color: $color-text-muted-ink;
  width: 72px;
}
.preview-box {
  background: $color-surface-2;
  border-radius: 12px;
  padding: 14px;
}
.preview-label {
  font-size: 11.5px;
  color: $color-text-muted-ink;
  margin-bottom: 8px;
}
.preview-cmd {
  font-size: 12.5px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  line-height: 1.6;
}
.preview-errors {
  margin-top: 8px;
}
.preview-error {
  font-size: 12px;
  color: $color-danger;
  line-height: 1.7;
}
.preview-warns {
  margin-top: 6px;
}
.preview-warn {
  font-size: 12px;
  color: $color-warning;
  line-height: 1.7;
}
</style>
