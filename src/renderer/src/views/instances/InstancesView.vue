<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  AddOutline, PlayOutline, StopOutline, TrashOutline, FolderOpenOutline,
  OpenOutline, RefreshOutline, PowerOutline, DownloadOutline, LinkOutline, RocketOutline,
  CreateOutline, TerminalOutline, PinOutline, SearchOutline, EllipsisHorizontalOutline,
  InformationCircleOutline
} from '@vicons/ionicons5'
import {
  NButton, NEmpty, NIcon, NModal, NForm, NFormItem, NInput, NInputNumber, NSpace,
  NSpin, NSelect, NTag, NCheckbox, NSwitch, useMessage, useDialog, NInputGroup,
  NDropdown, NTooltip, type DropdownOption
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { useI18n } from 'vue-i18n'
import { formatUptime } from '@/utils/format'
import type {
  ComfyInstanceConfig, ComfyInstanceInfo, LaunchArgTemplate, EnvProbe,
  PortCheckResult, InstanceDiscoveryCandidate, LaunchCommandPreview, InstanceStatus
} from '@shared/types'

const router = useRouter()
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

const draft = ref<ComfyInstanceConfig>({
  id: '', name: 'My ComfyUI', path: '', pythonPath: '', venvPath: '',
  port: 8188, listen: '127.0.0.1', extraArgs: [], argTemplateId: 'default',
  enabled: true, notes: '', autoStart: false, frontendVersion: '', pinned: false
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
})

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

function useCandidate(c: InstanceDiscoveryCandidate): void {
  draft.value.path = c.path
  if (c.estimatedVersion) draft.value.name = `ComfyUI ${c.estimatedVersion}`
  showDiscover.value = false
  showCreate.value = true
  message.success(t('instance.candidateFilled', { path: c.path }))
}

async function importSelectedCandidates(): Promise<void> {
  const picks = candidates.value.filter((c) => selectedCandidates.value.includes(c.path) && !c.registered)
  if (!picks.length) {
    message.warning(t('instance.selectUnregisteredFirst'))
    return
  }
  for (const c of picks) {
    try {
      const port = await ipc('instance.suggestPort')
      await ipc('instance.save', {
        ...draft.value,
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
    } catch (err) {
      message.error(`${c.path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  await store.refreshInstances()
  showDiscover.value = false
  message.success(t('instance.importedCount', { n: picks.length }))
}

async function suggestPort(): Promise<void> {
  try {
    draft.value.port = await ipc('instance.suggestPort')
    message.success(t('instance.portAssigned', { port: draft.value.port }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function checkPort(): Promise<void> {
  try {
    const r = await ipc('instance.checkPort', draft.value.port)
    portChecks.value[draft.value.port] = r
    message[r.available ? 'success' : 'warning'](
      r.available
        ? t('instance.portAvailableMsg', { port: r.port })
        : t('instance.portOccupiedMsg', { port: r.port, owner: r.owner || '' })
    )
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function createInstance(): Promise<void> {
  if (!draft.value.path) {
    message.warning(t('instance.selectInstallDirFirst'))
    return
  }
  saving.value = true
  try {
    draft.value.extraArgs = extraArgsText.value.split(/\s+/).filter(Boolean)
    const info = await ipc('instance.save', { ...draft.value })
    await store.refreshInstances()
    showCreate.value = false
    message.success(t('instance.instanceAdded', { name: info.name }))
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
  showEditModal.value = true
}

async function saveEdit(): Promise<void> {
  if (!editing.value) return
  editSaving.value = true
  try {
    editing.value.extraArgs = editExtraArgs.value.split(/\s+/).filter(Boolean)
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

async function exportDiag(info: ComfyInstanceInfo): Promise<void> {
  try {
    const pkg = await ipc('instance.exportDiagnostics', info.id)
    message.success(t('instance.diagExported', { path: pkg.path }))
    void ipc('shell.openPath', pkg.path).catch(() => undefined)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function startAll(): Promise<void> {
  try {
    await ipc('instance.startAll')
    await store.refreshInstances()
    message.success(t('instance.startAll'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function stopAll(): Promise<void> {
  try {
    await ipc('instance.stopAll')
    await store.refreshInstances()
    message.success(t('instance.stopAll'))
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
    { label: t('instance.restart'), key: 'restart', icon: () => h(NIcon, { component: RefreshOutline }) },
    { label: t('instance.previewCmd'), key: 'preview', icon: () => h(NIcon, { component: TerminalOutline }) },
    { label: t('instance.edit'), key: 'edit', icon: () => h(NIcon, { component: CreateOutline }) },
    {
      label: item.pinned ? t('instance.unpin') : t('instance.pin'),
      key: 'pin',
      icon: () => h(NIcon, { component: PinOutline })
    },
    { label: t('instance.forceKill'), key: 'forceKill', icon: () => h(NIcon, { component: PowerOutline }) },
    {
      label: t('instance.openBrowser'),
      key: 'openBrowser',
      icon: () => h(NIcon, { component: OpenOutline }),
      disabled: !item.url
    },
    { label: t('instance.probeEnv'), key: 'probeEnv', icon: () => h(NIcon, { component: LinkOutline }) },
    { label: t('instance.exportDiag'), key: 'exportDiag', icon: () => h(NIcon, { component: DownloadOutline }) },
    { label: t('instance.detail'), key: 'detail', icon: () => h(NIcon, { component: InformationCircleOutline }) },
    { label: t('instance.remove'), key: 'remove', icon: () => h(NIcon, { component: TrashOutline }) }
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
      if (item.url) void ipc('shell.openExternal', item.url)
      break
    case 'probeEnv':
      void probeEnv(item)
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
          <NInput v-model:value="search" :placeholder="$t('instance.searchPlaceholder')" clearable style="width: 220px">
            <template #prefix><NIcon :component="SearchOutline" /></template>
          </NInput>
        </NInputGroup>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton secondary @click="startAll">
              <template #icon><NIcon :component="PlayOutline" /></template>
              {{ $t('instance.startAll') }}
            </NButton>
          </template>
          {{ $t('instance.startAll') }}
        </NTooltip>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton secondary type="warning" @click="confirmStopAll">
              <template #icon><NIcon :component="StopOutline" /></template>
              {{ $t('instance.stopAll') }}
            </NButton>
          </template>
          {{ $t('instance.confirmStopAll') }}
        </NTooltip>
        <NButton secondary @click="openDiscover">
          <template #icon><NIcon :component="FolderOpenOutline" /></template>
          {{ $t('instance.discover') }}
        </NButton>
        <NButton type="primary" @click="showCreate = true">
          <template #icon><NIcon :component="AddOutline" /></template>
          {{ $t('instance.add') }}
        </NButton>
      </NSpace>
    </div>

    <div class="page-body">
    <NSpin :show="loading">
      <div v-if="filtered.length" class="grid cards">
        <article
          v-for="item in filtered"
          :key="item.id"
          class="card card-interactive inst"
          @click="router.push(`/instances/${item.id}`)"
        >
          <div class="inst-top">
            <div>
              <div class="inst-name">
                <NIcon v-if="item.pinned" :component="PinOutline" :size="14" class="pin-icon" />
                {{ item.name }}
              </div>
              <div class="inst-path mono">{{ item.path }}</div>
            </div>
            <span class="chip" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span>
          </div>

          <div class="meta-row">
            <span>{{ $t('instance.port') }} <b>{{ item.port }}</b></span>
            <span v-if="item.pid">PID <b>{{ item.pid }}</b></span>
            <span v-if="item.uptimeMs">
              <b>{{ $t('instance.uptime', { t: formatUptime(item.uptimeMs) }) }}</b>
            </span>
            <span v-if="item.autoStart"><NTag size="tiny" type="success" round>autoStart</NTag></span>
            <span v-if="item.managerEnabled"><NTag size="tiny" type="info" round>Manager</NTag></span>
          </div>

          <div v-if="envProbes[item.id]" class="env-box">
            <div class="mono">{{ envProbes[item.id].pythonVersion }}</div>
            <div class="mono">torch {{ envProbes[item.id].torchVersion || '—' }} · cuda {{ envProbes[item.id].cudaVersion || '—' }}</div>
          </div>

          <div class="actions" @click.stop>
            <!-- Primary: launch & open, or stop when running -->
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  v-if="item.status !== 'running'"
                  size="small"
                  type="primary"
                  secondary
                  :loading="busy[item.id]"
                  @click="launchAndOpen(item)"
                >
                  <template #icon><NIcon :component="RocketOutline" /></template>
                  {{ $t('instance.launchOpen') }}
                </NButton>
                <NButton v-else size="small" type="warning" secondary @click="stop(item)">
                  <template #icon><NIcon :component="StopOutline" /></template>
                  {{ $t('header.stop') }}
                </NButton>
              </template>
              {{ item.status === 'running' ? $t('header.stop') : $t('instance.launchOpen') }}
            </NTooltip>

            <!-- Secondary: start only / open frontend when already running -->
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  v-if="item.status !== 'running'"
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
                  :disabled="!item.url"
                  @click="item.url && router.push({ path: '/embed', query: { url: item.url } })"
                >
                  <template #icon><NIcon :component="OpenOutline" /></template>
                  {{ $t('instance.openFrontend') }}
                </NButton>
              </template>
              {{ item.status === 'running' ? $t('instance.openFrontend') : $t('header.start') }}
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
              <NButton type="primary" @click="showCreate = true">{{ $t('instance.addExistingManually') }}</NButton>
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
    <NModal v-model:show="showDiscover" preset="card" :title="$t('instance.candidates')" style="width: 720px; border-radius: 20px">
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
            <NButton size="tiny" secondary :disabled="c.registered" @click="useCandidate(c)">{{ $t('instance.fillForm') }}</NButton>
          </div>
        </div>
        <NEmpty v-else :description="$t('instance.noCandidates')" />
      </NSpin>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showDiscover = false">{{ $t('common.close') }}</NButton>
          <NButton secondary :loading="discovering" @click="runDiscover">{{ $t('instance.rescan') }}</NButton>
          <NButton type="primary" @click="importSelectedCandidates">{{ $t('instance.importSelected') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Launch command preview -->
    <NModal v-model:show="showPreviewModal" preset="card" :title="$t('instance.previewCmd')" style="width: 720px; border-radius: 20px">
      <div v-if="preview" class="preview-box">
        <div class="preview-label mono">cwd: {{ preview.cwd }}</div>
        <pre class="mono preview-cmd">{{ preview.commandLine }}</pre>
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
    <NModal v-model:show="showEditModal" preset="card" :title="$t('instance.edit')" style="width: 640px; border-radius: 20px">
      <NForm v-if="editing" label-placement="top">
        <NFormItem :label="$t('instance.instanceName')">
          <NInput v-model:value="editing.name" />
        </NFormItem>
        <NFormItem :label="$t('instance.installDir')">
          <NInput v-model:value="editing.path">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickEditPath('path')">{{ $t('instance.browse') }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem label="Python">
          <NInput v-model:value="editing.pythonPath" :placeholder="$t('instance.pythonPlaceholder')">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickEditPath('pythonPath')">{{ $t('instance.browse') }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem label="venv">
          <NInput v-model:value="editing.venvPath">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickEditPath('venvPath')">{{ $t('instance.browse') }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <div class="form-row">
          <NFormItem :label="$t('instance.port')">
            <NInputNumber v-model:value="editing.port" :min="1" :max="65535" />
          </NFormItem>
          <NFormItem :label="$t('instance.listen')">
            <NInput v-model:value="editing.listen" />
          </NFormItem>
        </div>
        <NFormItem :label="$t('instance.argTemplate')">
          <NSelect
            v-model:value="editing.argTemplateId"
            :options="templates.map((tpl) => ({
              label: `${t(`launchTpl.${tpl.id}.name`)} — ${t(`launchTpl.${tpl.id}.desc`)}`,
              value: tpl.id
            }))"
          />
        </NFormItem>
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
          <NButton type="primary" :loading="editSaving" @click="saveEdit">{{ $t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Create instance -->
    <NModal v-model:show="showCreate" preset="card" :title="$t('instance.addTitle')" style="width: 640px; border-radius: 20px">
      <NForm label-placement="top">
        <NFormItem :label="$t('instance.instanceName')">
          <NInput v-model:value="draft.name" :placeholder="$t('instance.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="$t('instance.comfyInstallDir')">
          <NInput v-model:value="draft.path" :placeholder="$t('instance.pathPlaceholder')">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickPath('path')">{{ $t('instance.browse') }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem :label="$t('instance.pythonLabel')">
          <NInput v-model:value="draft.pythonPath" :placeholder="$t('instance.pythonPlaceholder')">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickPath('pythonPath')">{{ $t('instance.browse') }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem :label="$t('instance.venvLabel')">
          <NInput v-model:value="draft.venvPath" :placeholder="$t('instance.venvPlaceholder')">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickPath('venvPath')">{{ $t('instance.browse') }}</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem :label="$t('instance.argTemplate')">
          <NSelect
            v-model:value="draft.argTemplateId"
            :options="templates.map((tpl) => ({
              label: `${t(`launchTpl.${tpl.id}.name`)} — ${t(`launchTpl.${tpl.id}.desc`)}`,
              value: tpl.id
            }))"
          />
        </NFormItem>
        <div class="form-row">
          <NFormItem :label="$t('instance.port')">
            <NSpace>
              <NInputNumber v-model:value="draft.port" :min="1" :max="65535" />
              <NButton size="small" secondary @click="suggestPort">{{ $t('instance.suggestPort') }}</NButton>
              <NButton size="small" secondary @click="checkPort">{{ $t('instance.checkPort') }}</NButton>
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
          <NButton type="primary" :loading="saving" @click="createInstance">{{ $t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.cards { grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
.inst { padding: 18px; cursor: pointer; }
.inst-top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.inst-name { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; gap: 6px; }
.pin-icon { color: $color-primary; }
.inst-path { margin-top: 6px; font-size: 12px; color: $color-text-muted; word-break: break-all; }
.meta-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; font-size: 12.5px; color: $color-text-secondary; b { color: $color-text; } }
.env-box { background: $color-surface-2; border-radius: 10px; padding: 8px 10px; font-size: 11.5px; color: $color-text-muted; margin-bottom: 10px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.empty { padding: 64px 0; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.cand-list { display: flex; flex-direction: column; gap: 8px; max-height: 420px; overflow: auto; }
.cand-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid $color-border; border-radius: 12px; }
.cand-main { flex: 1; min-width: 0; }
.cand-path { font-size: 12.5px; word-break: break-all; }
.cand-meta { font-size: 11.5px; color: $color-text-muted; margin-top: 2px; }
.cand-reg { font-size: 11px; color: $color-text-muted; width: 72px; }
.preview-box { background: $color-surface-2; border-radius: 12px; padding: 14px; }
.preview-label { font-size: 11.5px; color: $color-text-muted; margin-bottom: 8px; }
.preview-cmd { font-size: 12.5px; white-space: pre-wrap; word-break: break-all; margin: 0; line-height: 1.6; }
</style>
