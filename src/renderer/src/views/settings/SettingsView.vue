<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, computed } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSwitch,
  NSpace,
  useMessage,
  useDialog,
  NDivider,
  NSelect,
  NList,
  NListItem,
  NPopconfirm,
  NTag,
  NModal,
  NProgress
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import type {
  AppSettings,
  AppUpdateStatus,
  RemoteInstanceConfig,
  RemoteInstanceStatus,
  EnvProbe,
  ProxySettings
} from '@shared/types'
import {
  APP_VERSION,
  DEFAULT_SETTINGS,
  PIP_INDEX_PRESETS,
  TORCH_INDEX_PRESETS
} from '@shared/constants'

const pipIndexLabelKeys: Record<string, string> = {
  '': 'settings.pipOfficial',
  'https://pypi.tuna.tsinghua.edu.cn/simple': 'settings.pipTsinghua',
  'https://mirrors.aliyun.com/pypi/simple/': 'settings.mirrorAliyun',
  'https://pypi.mirrors.ustc.edu.cn/simple/': 'settings.pipUstc'
}
const torchIndexLabelKeys: Record<string, string> = {
  '': 'settings.torchOfficial',
  'https://mirror.sjtu.edu.cn/pytorch-wheels': 'settings.torchSjtu',
  'https://mirrors.aliyun.com/pytorch-wheels': 'settings.mirrorAliyun'
}
const pipIndexOptions = computed(() =>
  PIP_INDEX_PRESETS.map((p) => ({
    label: pipIndexLabelKeys[p.value] ? t(pipIndexLabelKeys[p.value]) : p.value,
    value: p.value
  }))
)
const torchIndexOptions = computed(() =>
  TORCH_INDEX_PRESETS.map((p) => ({
    label: torchIndexLabelKeys[p.value] ? t(torchIndexLabelKeys[p.value]) : p.value,
    value: p.value
  }))
)

const shortcuts = computed(() => [
  { keys: 'Ctrl+1 … Ctrl+9', desc: t('settings.shortcutNav') },
  { keys: 'Ctrl+Enter', desc: t('settings.shortcutLaunch') },
  { keys: 'Ctrl+,', desc: t('settings.shortcutSettings') }
])

const defaultProxy: ProxySettings = { ...DEFAULT_SETTINGS.proxy }

function cloneSettings(s: Partial<AppSettings> | null | undefined): AppSettings {
  const base = (
    s && typeof s === 'object' ? JSON.parse(JSON.stringify(s)) : {}
  ) as Partial<AppSettings>
  return {
    ...(DEFAULT_SETTINGS as AppSettings),
    ...(base as AppSettings),
    proxy: { ...defaultProxy, ...(base.proxy || {}) }
  } as AppSettings
}

const store = useAppStore()
const message = useMessage()
const dialog = useDialog()
const { t, locale } = useI18n()

async function setLocale(loc: 'zh-CN' | 'en-US'): Promise<void> {
  form.value.locale = loc
  locale.value = loc
  // Persist immediately — leaving the page without Save used to silently
  // revert the language on next launch (0.1.11).
  //
  // 0.1.17 (WP9): save the WHOLE form, not just the locale. Saving only the
  // locale let the settings watch merge the stored values back over the form,
  // silently discarding unsaved edits the user had typed.
  await save({ silent: true })
}

const form = ref<AppSettings>(cloneSettings(store.settings))
const saving = ref(false)
const remotes = ref<RemoteInstanceConfig[]>([])
/** 0.1.18 (WP1/S6): stored secrets that cannot be decrypted need re-entry. */
const credStatus = ref<{ proxyPasswordUnreadable: boolean; lockedRemoteIds: string[] }>({
  proxyPasswordUnreadable: false,
  lockedRemoteIds: []
})
const showRemote = ref(false)
const emptyRemote = (): RemoteInstanceConfig => ({
  id: '',
  name: '',
  baseUrl: '',
  label: '',
  enabled: true
})
const remoteDraft = ref<RemoteInstanceConfig>(emptyRemote())
const envProbe = ref<EnvProbe | null>(null)
const pythons = ref<Array<{ path: string; version: string }>>([])
const testingProxy = ref(false)
const proxyTestResult = ref<{ ok: boolean; via: string; ms: number; error?: string } | null>(null)
const configPath = ref('…')

async function openConfigDir(): Promise<void> {
  try {
    const dir = await ipc('settings.dataDir')
    configPath.value = dir
    await ipc('shell.openPath', dir)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** Open the global app log directory (0.1.15) — instance logs live there too. */
async function openLogsDir(): Promise<void> {
  try {
    const dir = await ipc('settings.logsDir')
    await ipc('shell.openPath', dir)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function addScanRoot(): Promise<void> {
  try {
    const dir = await ipc('shell.pickDirectory')
    if (dir && !form.value.modelScanRoots.includes(dir)) {
      form.value.modelScanRoots = [...form.value.modelScanRoots, dir]
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}
/** Skip watch merge while we are the ones writing store.settings */
let suppressSettingsWatch = false
/**
 * 0.1.17 (WP9-9): fields the user has edited since the last save. The old merge
 * only protected `proxy`, so any background settings refresh silently reverted
 * edits in every other field on screen.
 */
const editedKeys = new Set<keyof AppSettings>()
let applyingIncoming = false

function sameValue(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return a === b
  }
}

watch(
  form,
  () => {
    if (applyingIncoming || suppressSettingsWatch) return
    const saved = store.settings as AppSettings | undefined
    for (const key of Object.keys(form.value) as Array<keyof AppSettings>) {
      if (!saved || !sameValue(form.value[key], saved[key])) editedKeys.add(key)
      else editedKeys.delete(key)
    }
  },
  { deep: true }
)

watch(
  () => store.settings,
  (s) => {
    if (!s || suppressSettingsWatch) return
    applyingIncoming = true
    try {
      const incoming = cloneSettings(s)
      for (const key of Object.keys(incoming) as Array<keyof AppSettings>) {
        // Never clobber a field the user is editing.
        if (editedKeys.has(key as keyof AppSettings)) continue
        // @ts-expect-error index write
        form.value[key] = incoming[key]
      }
    } finally {
      applyingIncoming = false
    }
    if (!editedKeys.has('proxy')) proxyTestResult.value = null
  },
  { deep: true }
)

async function save(opts?: { silent?: boolean }): Promise<boolean> {
  saving.value = true
  suppressSettingsWatch = true
  try {
    const next = await ipc('settings.set', form.value)
    store.settings = next
    applyingIncoming = true
    try {
      const merged = cloneSettings(next)
      for (const key of Object.keys(merged) as Array<keyof AppSettings>) {
        // @ts-expect-error index write
        form.value[key] = merged[key]
      }
    } finally {
      applyingIncoming = false
      editedKeys.clear()
    }
    if (!opts?.silent) message.success(t('settings.saveSuccess'))
    return true
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    return false
  } finally {
    suppressSettingsWatch = false
    saving.value = false
  }
}

// 0.1.18 (WP6 / U10): leaving with unsaved edits used to discard them without
// a word. The guard only fires when something actually differs from disk.
onBeforeRouteLeave(async () => {
  if (!editedKeys.size || saving.value) return true
  return await new Promise<boolean>((resolve) => {
    dialog.warning({
      title: t('settings.unsavedTitle'),
      content: t('settings.unsavedBody', { n: editedKeys.size }),
      positiveText: t('settings.saveAndLeave'),
      negativeText: t('settings.leaveWithoutSaving'),
      onPositiveClick: () => {
        void save().then((ok) => resolve(ok))
      },
      onNegativeClick: () => resolve(true),
      onClose: () => resolve(false),
      onMaskClick: () => resolve(false)
    })
  })
})

async function testProxy(): Promise<void> {
  testingProxy.value = true
  try {
    const saved = await save({ silent: true })
    if (!saved) return
    proxyTestResult.value = await ipc('proxy.test', {})
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    testingProxy.value = false
  }
}

async function applyProxy(): Promise<void> {
  try {
    const saved = await save({ silent: true })
    if (!saved) return
    const r = await ipc('proxy.apply')
    message.success(
      r.enabled ? t('settings.proxyApplied', { url: r.url }) : t('settings.proxyDirect')
    )
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** 0.1.18 (WP7): export a secret-free config snapshot. */
async function exportConfig(): Promise<void> {
  try {
    const payload = await ipc('settings.exportConfig')
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const ANCHOR_TAG = 'a'
    const a = document.createElement(ANCHOR_TAG)
    a.href = url
    a.download = `comfypilot-settings-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    message.success(t('settings.exportDone'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

const importInput = ref<HTMLInputElement | null>(null)

function pickImportFile(): void {
  importInput.value?.click()
}

async function onImportFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as { settings?: Record<string, unknown> }
    const incoming = parsed.settings || (parsed as Record<string, unknown>)
    const current = (store.settings || {}) as Record<string, unknown>
    const changed = Object.keys(incoming).filter(
      (k) => k !== 'proxy' && JSON.stringify(incoming[k]) !== JSON.stringify(current[k])
    )
    const confirmed = await new Promise<boolean>((resolve) => {
      dialog.warning({
        title: t('settings.importPreviewTitle'),
        content: changed.length
          ? t('settings.importPreviewBody', {
              n: changed.length,
              list: changed.slice(0, 10).join(', ')
            })
          : t('settings.importNoChanges'),
        positiveText: t('settings.importApply'),
        negativeText: t('common.cancel'),
        onPositiveClick: () => resolve(true),
        onNegativeClick: () => resolve(false),
        onClose: () => resolve(false),
        onMaskClick: () => resolve(false)
      })
    })
    if (!confirmed) return
    const result = await ipc('settings.importConfig', parsed as Record<string, unknown>)
    store.settings = result.settings
    form.value = cloneSettings(result.settings)
    editedKeys.clear()
    message.success(t('settings.importDone', { n: result.applied.length }))
  } catch (err) {
    message.error(
      t('settings.importInvalid', { error: err instanceof Error ? err.message : String(err) })
    )
  }
}

async function loadCredentialStatus(): Promise<void> {
  try {
    credStatus.value = await ipc('settings.credentialStatus')
  } catch {
    /* status is advisory */
  }
}

async function loadRemotes(): Promise<void> {
  try {
    remotes.value = await ipc('remote.list')
    void loadCredentialStatus()
    // 0.1.17 (WP10): the app-store copy feeds the global instance selector —
    // without this it kept showing the pre-edit remote list until restart.
    await store.refreshRemotes()
  } catch (err) {
    console.error(err)
  }
}

async function saveRemote(): Promise<void> {
  try {
    if (!remoteDraft.value.id) remoteDraft.value.id = `remote-${Date.now()}`
    await ipc('remote.save', remoteDraft.value)
    showRemote.value = false
    remoteDraft.value = emptyRemote()
    message.success(t('settings.remoteSaved'))
    await loadRemotes()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function openRemoteDialog(): void {
  remoteDraft.value = emptyRemote()
  showRemote.value = true
}

/**
 * 0.1.18 (regression): the "credential needs re-entry" tag had no edit path —
 * delete + re-add was the only way, losing the whole configuration.
 */
function editRemote(r: RemoteInstanceConfig): void {
  remoteDraft.value = { ...r, apiKey: r.apiKey || '' }
  showRemote.value = true
}

function cancelRemoteDialog(): void {
  showRemote.value = false
  remoteDraft.value = emptyRemote()
}

async function probeEnv(): Promise<void> {
  try {
    envProbe.value = await ipc('env.probe', {
      pythonPath: 'python'
    })
    pythons.value = await ipc('env.listPythons')
    message.success(t('settings.envProbeDone'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function testRemote(id: string): Promise<void> {
  try {
    const s = await ipc('remote.test', id)
    remoteStatuses.value = { ...remoteStatuses.value, [id]: s }
    message.info(s.online ? t('settings.remoteOnline') : t('settings.remoteOffline'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** POST /free against a remote — the meaningful remote "lifecycle" action
 *  (ComfyUI has no remote process start/stop protocol, 0.1.11). */
async function freeRemoteMemory(id: string): Promise<void> {
  try {
    const r = await ipc('remote.freeMemory', id)
    if (r.ok) message.success(t('settings.freeMemoryDone'))
    else message.warning(t('settings.freeMemoryFailed', { error: r.error || '' }))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** Open a remote instance's frontend (remote maintenance companion action). */
function openRemoteFrontend(r: RemoteInstanceConfig): void {
  if (!r.baseUrl) return
  void ipc('shell.openExternal', r.baseUrl).catch(() => undefined)
}

// ---------- app self-update (0.1.11) ----------
const appUpdate = ref<AppUpdateStatus | null>(null)
const checkingAppUpdate = ref(false)
let offAppUpdate: (() => void) | null = null

function appUpdateText(s: AppUpdateStatus): string {
  if (s.status === 'available') {
    return t('settings.updateAvailable', { version: s.availableVersion || '' })
  }
  if (s.status === 'downloading') {
    return t('settings.updateDownloading', { percent: s.progress?.percent ?? 0 })
  }
  if (s.status === 'downloaded') {
    return t('settings.updateReady', { version: s.availableVersion || '' })
  }
  if (s.status === 'not-available') return t('settings.updateNone')
  if (s.status === 'unsupported') return t('settings.updateUnsupported')
  if (s.status === 'error') return t('settings.updateFailed', { error: s.error || '' })
  return t('settings.updateChecking')
}

/** Compact MB/duration formatting for the download progress line (0.1.13). */
function formatUpdateBytes(n?: number): string {
  if (!n || n <= 0) return ''
  const mb = n / 1024 / 1024
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

const installingAppUpdate = ref(false)
async function installAppUpdateNow(): Promise<void> {
  installingAppUpdate.value = true
  try {
    const r = await ipc('app.installUpdate')
    // Success quits into the installer — nothing else to do here.
    if (!r.ok) message.error(t('settings.updateInstallFailed', { error: r.error || '' }))
  } catch (err) {
    message.error(
      t('settings.updateInstallFailed', {
        error: err instanceof Error ? err.message : String(err)
      })
    )
  } finally {
    installingAppUpdate.value = false
  }
}

async function checkAppUpdate(): Promise<void> {
  checkingAppUpdate.value = true
  try {
    appUpdate.value = await ipc('app.checkUpdate')
  } catch (err) {
    appUpdate.value = {
      status: 'error',
      currentVersion: APP_VERSION,
      error: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now()
    }
  } finally {
    checkingAppUpdate.value = false
  }
}

/** remote.listStatus — probe every remote at once and show online/queue state. */
const remoteStatuses = ref<Record<string, RemoteInstanceStatus>>({})
const testingRemotes = ref(false)

async function testAllRemotes(): Promise<void> {
  testingRemotes.value = true
  try {
    const list = await ipc('remote.listStatus')
    const map: Record<string, RemoteInstanceStatus> = {}
    for (const s of list) map[s.id] = s
    remoteStatuses.value = map
    message.success(t('settings.testAllRemotes'))
  } catch (err) {
    message.error(
      t('settings.remoteTestAllFailed', { error: err instanceof Error ? err.message : String(err) })
    )
  } finally {
    testingRemotes.value = false
  }
}

function remoteStatusOf(id: string): RemoteInstanceStatus | undefined {
  return remoteStatuses.value[id]
}

async function removeRemote(id: string): Promise<void> {
  try {
    await ipc('remote.remove', id)
    await loadRemotes()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(async () => {
  await store.bootstrap({ keepSelection: true })
  await loadRemotes()
  try {
    configPath.value = await ipc('settings.dataDir')
  } catch {
    /* ignore */
  }
  // Live self-update status stream (0.1.11).
  offAppUpdate = onIpc(IPC_EVENTS.appUpdate, (p) => {
    appUpdate.value = p as AppUpdateStatus
  })
  // Seed from the last known status so a previous check survives navigation.
  try {
    const last = await ipc('app.updateStatus')
    if (last && last.checkedAt > 0) appUpdate.value = last
  } catch {
    /* status is best-effort */
  }
})

onUnmounted(() => {
  offAppUpdate?.()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ t('settings.title') }}</h1>
        <p class="page-subtitle">{{ t('settings.subtitle') }}</p>
      </div>
      <NButton type="primary" :loading="saving" @click="save()">{{
        t('settings.saveSettings')
      }}</NButton>
    </div>

    <div class="page-body">
      <div class="grid settings-grid">
        <NCard :title="t('settings.paths')" class="card" size="small">
          <NForm label-placement="top">
            <NFormItem :label="t('settings.modelScanRoots')">
              <div class="scan-roots">
                <div v-for="(r, idx) in form.modelScanRoots" :key="idx" class="scan-root-row">
                  <NInput :value="r" readonly size="small" :title="r" />
                  <NButton
                    size="tiny"
                    secondary
                    type="error"
                    @click="form.modelScanRoots.splice(idx, 1)"
                  >
                    {{ t('common.delete') }}
                  </NButton>
                </div>
                <NButton size="small" secondary @click="addScanRoot">
                  {{ t('settings.addScanRoot') }}
                </NButton>
                <div class="hint">{{ t('settings.modelScanRootsHint') }}</div>
              </div>
            </NFormItem>
            <NFormItem :label="t('settings.outputScanDepth')">
              <NInputNumber
                v-model:value="form.outputScanDepth"
                :min="2"
                :max="10"
                style="width: 160px"
              />
              <div class="hint">{{ t('settings.outputScanDepthHint') }}</div>
            </NFormItem>
          </NForm>
        </NCard>
        <NCard :title="t('settings.network')" class="card" size="small">
          <NForm label-placement="top">
            <NFormItem :label="t('settings.githubEndpoint')">
              <NInput v-model:value="form.githubEndpoint" :placeholder="t('settings.optional')" />
            </NFormItem>
            <NFormItem :label="t('settings.hfEndpointLabel')">
              <NInput
                v-model:value="form.hfEndpoint"
                :placeholder="t('settings.hfEndpointPlaceholder')"
              />
            </NFormItem>
            <NFormItem :label="t('settings.civitaiEndpointLabel')">
              <NInput v-model:value="form.civitaiEndpoint" placeholder="https://civitai.com" />
            </NFormItem>
            <NFormItem :label="t('settings.pipIndexLabel')">
              <NSelect v-model:value="form.pipIndex" :options="pipIndexOptions" filterable tag />
              <div class="hint">{{ t('settings.pipMirrorHint') }}</div>
            </NFormItem>
            <NFormItem :label="t('settings.torchIndexLabel')">
              <NSelect
                v-model:value="form.torchIndexMirror"
                :options="torchIndexOptions"
                filterable
                tag
              />
              <div class="hint">{{ t('settings.torchIndexHint') }}</div>
            </NFormItem>
            <NFormItem :label="t('settings.networkMode')">
              <NSelect
                v-model:value="form.networkMode"
                :options="[
                  { label: 'public', value: 'public' },
                  { label: 'private', value: 'private' },
                  { label: 'offline', value: 'offline' },
                  { label: 'personal_cloud', value: 'personal_cloud' }
                ]"
              />
              <div class="hint">{{ t('settings.networkModeHint') }}</div>
            </NFormItem>
          </NForm>
        </NCard>

        <NCard :title="t('settings.security')" class="card" size="small">
          <NForm label-placement="top">
            <NFormItem :label="t('settings.securityLevelLabel')">
              <NSelect
                v-model:value="form.securityLevel"
                :options="[
                  { label: 'strong', value: 'strong' },
                  { label: 'normal', value: 'normal' },
                  { label: 'normal-', value: 'normal-' },
                  { label: 'weak', value: 'weak' }
                ]"
              />
              <div class="hint">{{ t('settings.securityLevelHint') }}</div>
            </NFormItem>
            <NFormItem :label="t('settings.allowGitLabel')">
              <NSwitch v-model:value="form.allowGitUrlInstall" />
              <div class="hint">{{ t('settings.allowGitHint') }}</div>
            </NFormItem>
            <NFormItem :label="t('settings.allowPipLabel')">
              <NSwitch v-model:value="form.allowPipInstall" />
              <div class="hint">{{ t('settings.allowPipHint') }}</div>
            </NFormItem>
            <NFormItem :label="t('settings.allowUnverifiedRuntimeLabel')">
              <NSwitch v-model:value="form.allowUnverifiedRuntime" />
              <div class="hint">{{ t('settings.allowUnverifiedRuntimeHint') }}</div>
            </NFormItem>
          </NForm>
        </NCard>

        <NCard :title="t('settings.download')" class="card" size="small">
          <NForm label-placement="top">
            <NFormItem :label="t('settings.useAria2')">
              <NSwitch v-model:value="form.useAria2" />
            </NFormItem>
            <NFormItem :label="t('settings.aria2Path')">
              <NInput v-model:value="form.aria2Path" :placeholder="t('settings.optional')" />
            </NFormItem>
          </NForm>
        </NCard>

        <NCard :title="t('settings.proxy')" class="card" size="small">
          <NForm label-placement="top">
            <NFormItem :label="t('settings.proxyEnabled')">
              <NSwitch v-model:value="form.proxy.enabled" />
            </NFormItem>
            <div v-if="credStatus.proxyPasswordUnreadable" class="cred-warn">
              <NTag size="tiny" type="warning">{{ t('settings.credNeedsReentry') }}</NTag>
              <span class="hint">{{ t('settings.proxyPasswordLockedHint') }}</span>
            </div>
            <div class="proxy-grid">
              <NFormItem :label="t('settings.proxyProtocol')">
                <NSelect
                  v-model:value="form.proxy.protocol"
                  :options="[
                    { label: 'HTTP', value: 'http' },
                    { label: 'HTTPS', value: 'https' },
                    { label: 'SOCKS5', value: 'socks5' }
                  ]"
                />
              </NFormItem>
              <NFormItem :label="t('settings.proxyHost')">
                <NInput
                  v-model:value="form.proxy.host"
                  placeholder="127.0.0.1"
                  :disabled="!form.proxy.enabled"
                />
              </NFormItem>
              <NFormItem :label="t('settings.proxyPort')">
                <NInputNumber
                  v-model:value="form.proxy.port"
                  :min="1"
                  :max="65535"
                  :disabled="!form.proxy.enabled"
                />
              </NFormItem>
              <NFormItem :label="t('settings.proxyUsername')">
                <NInput v-model:value="form.proxy.username" :disabled="!form.proxy.enabled" />
              </NFormItem>
              <NFormItem :label="t('settings.proxyPassword')">
                <NInput
                  v-model:value="form.proxy.password"
                  type="password"
                  show-password-on="click"
                  :disabled="!form.proxy.enabled"
                />
              </NFormItem>
              <NFormItem :label="t('settings.proxyBypass')">
                <NInput
                  v-model:value="form.proxy.bypass"
                  placeholder="localhost,127.0.0.1,::1"
                  :disabled="!form.proxy.enabled"
                />
              </NFormItem>
            </div>
            <NSpace>
              <NButton secondary :loading="testingProxy" @click="testProxy">{{
                t('settings.testConnection')
              }}</NButton>
              <NButton secondary @click="applyProxy">{{ t('settings.applyNow') }}</NButton>
            </NSpace>
            <div
              v-if="proxyTestResult"
              class="meta"
              :class="proxyTestResult.ok ? 'pass-ink' : 'fail-ink'"
            >
              {{ proxyTestResult.ok ? '✓' : '✗' }} {{ proxyTestResult.via }} ·
              {{ proxyTestResult.ms }}ms
              <span v-if="proxyTestResult.error">{{ proxyTestResult.error }}</span>
            </div>
            <div class="meta">{{ t('settings.proxyHint') }}</div>
          </NForm>
        </NCard>

        <NCard :title="t('settings.appBehavior')" class="card" size="small">
          <NForm label-placement="top">
            <NFormItem :label="t('settings.autoCheckUpdates')">
              <NSwitch v-model:value="form.enableAutoCheckUpdates" />
            </NFormItem>
            <NFormItem :label="t('settings.embedFrontend')">
              <NSwitch v-model:value="form.embedFrontend" />
            </NFormItem>
            <NFormItem :label="t('settings.launchOnBoot')">
              <NSwitch
                v-model:value="form.launchOnBoot"
                @update:value="() => save({ silent: true })"
              />
            </NFormItem>
            <NFormItem :label="t('settings.minimizeToTray')">
              <NSwitch v-model:value="form.minimizeToTray" />
            </NFormItem>
            <NFormItem :label="t('settings.autoStartInstances')">
              <NSwitch v-model:value="form.autoStartInstancesOnLaunch" />
            </NFormItem>
            <NFormItem :label="t('settings.language')">
              <NSpace>
                <NButton
                  :type="form.locale === 'zh-CN' ? 'primary' : 'default'"
                  secondary
                  @click="setLocale('zh-CN')"
                >
                  {{ t('settings.langZhCN') }}
                </NButton>
                <NButton
                  :type="form.locale === 'en-US' ? 'primary' : 'default'"
                  secondary
                  @click="setLocale('en-US')"
                >
                  English
                </NButton>
              </NSpace>
            </NFormItem>
          </NForm>
        </NCard>

        <NCard :title="t('settings.remotes')" class="card" size="small">
          <div class="remotes-head">
            <NButton
              size="small"
              secondary
              type="primary"
              :loading="testingRemotes"
              :disabled="!remotes.length"
              @click="testAllRemotes"
            >
              {{ t('settings.testAllRemotes') }}
            </NButton>
          </div>
          <NList v-if="remotes.length" bordered>
            <NListItem v-for="r in remotes" :key="r.id">
              <div class="row">
                <div class="remote-main">
                  <div class="name" :title="r.name">{{ r.name }}</div>
                  <div class="meta mono">{{ r.baseUrl }}</div>
                  <NTag v-if="r.apiKeyLocked" size="tiny" type="warning">
                    {{ t('settings.credNeedsReentry') }}
                  </NTag>
                  <div v-if="remoteStatusOf(r.id)" class="remote-status">
                    <NTag
                      size="tiny"
                      round
                      :type="remoteStatusOf(r.id)?.online ? 'success' : 'error'"
                    >
                      {{
                        remoteStatusOf(r.id)?.online
                          ? t('settings.remoteOnline')
                          : t('settings.remoteOffline')
                      }}
                    </NTag>
                    <span v-if="remoteStatusOf(r.id)?.version" class="meta">
                      {{
                        t('settings.remoteStatusVersion', {
                          version: remoteStatusOf(r.id)?.version || ''
                        })
                      }}
                    </span>
                    <span class="meta">
                      {{
                        t('settings.remoteQueueInfo', {
                          running: remoteStatusOf(r.id)?.queueRunning ?? 0,
                          pending: remoteStatusOf(r.id)?.queuePending ?? 0
                        })
                      }}
                    </span>
                    <span v-if="remoteStatusOf(r.id)?.error" class="meta remote-error">
                      {{ t('settings.remoteErrorLabel') }}: {{ remoteStatusOf(r.id)?.error }}
                    </span>
                  </div>
                </div>
                <NSpace>
                  <NButton size="tiny" secondary @click="testRemote(r.id)">{{
                    t('settings.test')
                  }}</NButton>
                  <NButton size="tiny" secondary @click="editRemote(r)">
                    {{ t('common.edit') }}
                  </NButton>
                  <NButton size="tiny" secondary @click="openRemoteFrontend(r)">
                    {{ t('settings.remoteOpen') }}
                  </NButton>
                  <NButton size="tiny" secondary @click="freeRemoteMemory(r.id)">
                    {{ t('settings.freeMemory') }}
                  </NButton>
                  <NPopconfirm @positive-click="removeRemote(r.id)">
                    <template #trigger>
                      <NButton size="tiny" type="error" secondary>{{ t('common.delete') }}</NButton>
                    </template>
                    {{ t('settings.deleteRemoteConfirm') }}
                  </NPopconfirm>
                </NSpace>
              </div>
            </NListItem>
          </NList>
          <div v-else class="meta">{{ t('settings.noRemotes') }}</div>
          <NButton style="margin-top: 12px" secondary @click="openRemoteDialog">{{
            t('settings.addRemote')
          }}</NButton>
        </NCard>

        <NCard :title="t('settings.pythonEnv')" class="card" size="small">
          <NButton secondary @click="probeEnv">{{ t('settings.probeEnv') }}</NButton>
          <template v-if="envProbe">
            <NDivider style="margin: 12px 0" />
            <div class="meta">Python: {{ envProbe.pythonVersion }}</div>
            <div class="meta">
              Torch: {{ envProbe.torchVersion || '—' }} · CUDA: {{ envProbe.cudaVersion || '—' }}
            </div>
            <div class="meta">
              MPS:
              <NTag size="tiny" round>{{
                envProbe.mpsAvailable ? t('common.yes') : t('common.no')
              }}</NTag>
              NPU:
              <NTag size="tiny" round>{{
                envProbe.npuAvailable ? t('common.yes') : t('common.no')
              }}</NTag>
            </div>
            <div v-if="pythons.length" class="meta">
              {{ t('settings.availablePythons', { n: pythons.length }) }}
            </div>
          </template>
        </NCard>

        <NCard :title="t('settings.shortcuts')" class="card" size="small">
          <div class="shortcut-list">
            <div v-for="s in shortcuts" :key="s.keys" class="shortcut-row">
              <NTag size="small" round>{{ s.keys }}</NTag>
              <span class="shortcut-desc">{{ s.desc }}</span>
            </div>
          </div>
        </NCard>

        <NCard :title="t('settings.importExportTitle')" class="card" size="small">
          <div class="meta">{{ t('settings.importExportHint') }}</div>
          <NSpace style="margin-top: 10px">
            <NButton secondary @click="exportConfig">{{ t('settings.exportConfig') }}</NButton>
            <NButton secondary @click="pickImportFile">{{ t('settings.importConfig') }}</NButton>
          </NSpace>
          <input
            ref="importInput"
            type="file"
            accept="application/json,.json"
            style="display: none"
            @change="onImportFile"
          />
        </NCard>

        <NCard :title="t('settings.about')" class="card" size="small">
          <div class="about">
            <div class="about-logo">ComfyPilot</div>
            <div class="about-line">v{{ APP_VERSION }} · MIT License</div>
            <NSpace align="center" style="margin: 6px 0">
              <NButton size="tiny" secondary :loading="checkingAppUpdate" @click="checkAppUpdate">
                {{ t('settings.checkUpdate') }}
              </NButton>
              <span v-if="appUpdate && appUpdate.checkedAt" class="meta">{{
                appUpdateText(appUpdate)
              }}</span>
            </NSpace>
            <!-- Live download progress (0.1.13): percent + transferred/speed. -->
            <div v-if="appUpdate?.status === 'downloading'" class="update-dl">
              <NProgress
                type="line"
                :percentage="appUpdate.progress?.percent || 0"
                :height="8"
                :show-indicator="false"
              />
              <span class="meta">
                {{ appUpdate.progress?.percent || 0 }}%
                <template v-if="appUpdate.progress?.total">
                  · {{ formatUpdateBytes(appUpdate.progress?.transferred) }} /
                  {{ formatUpdateBytes(appUpdate.progress?.total) }}</template
                >
                <template v-if="appUpdate.progress?.bytesPerSecond">
                  · {{ formatUpdateBytes(appUpdate.progress?.bytesPerSecond) }}/s</template
                >
              </span>
            </div>
            <!-- Restart-and-install entry for a downloaded update (0.1.13). -->
            <NPopconfirm
              v-if="appUpdate?.status === 'downloaded'"
              @positive-click="installAppUpdateNow"
            >
              <template #trigger>
                <NButton
                  size="tiny"
                  type="primary"
                  style="margin-top: 6px"
                  :loading="installingAppUpdate"
                >
                  {{ t('settings.updateRestartInstall') }}
                </NButton>
              </template>
              {{ t('settings.updateInstallConfirm') }}
            </NPopconfirm>
            <div class="about-line">TypeScript · Vue 3 · Electron · Naive UI</div>
            <div class="about-line">{{ t('settings.aboutStorage') }}</div>
            <NDivider style="margin: 12px 0" />
            <div class="about-line">{{ t('settings.aboutConfigDir', { path: configPath }) }}</div>
            <div class="about-line">{{ t('settings.aboutTagline') }}</div>
            <NSpace style="margin-top: 12px">
              <NButton secondary @click="openConfigDir">{{ t('settings.openConfigDir') }}</NButton>
              <NButton secondary @click="openLogsDir">{{ t('settings.openLogsDir') }}</NButton>
              <NButton
                secondary
                @click="ipc('shell.openExternal', 'https://github.com/ThzxxArt/ComfyPilot')"
              >
                {{ t('settings.githubRepo') }}
              </NButton>
            </NSpace>
          </div>
        </NCard>
      </div>
    </div>

    <NModal
      v-model:show="showRemote"
      preset="card"
      :title="t('settings.addRemote')"
      style="width: 480px; border-radius: 20px"
    >
      <NSpace vertical>
        <NInput v-model:value="remoteDraft.name" :placeholder="t('settings.remoteName')" />
        <NInput v-model:value="remoteDraft.baseUrl" placeholder="http://192.168.1.10:8188" />
        <NInput v-model:value="remoteDraft.label" :placeholder="t('settings.remoteLabel')" />
        <NInput
          v-model:value="remoteDraft.apiKey"
          type="password"
          show-password-on="click"
          :placeholder="t('settings.remoteApiKeyPlaceholder')"
        />
        <div class="hint">{{ t('settings.remoteApiKeyHint') }}</div>
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="cancelRemoteDialog">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" @click="saveRemote">{{ t('common.save') }}</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.settings-grid {
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
}
.hint {
  font-size: 12px;
  line-height: 1.6;
  color: $color-text-muted-ink;
  margin-top: 4px;
  max-width: 640px;
}
.scan-roots {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.scan-root-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.proxy-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
.about-logo {
  font-size: 20px;
  font-weight: 800;
  background: $gradient-primary;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.about-line {
  margin-top: 6px;
  font-size: 13px;
  color: $color-text-secondary;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  width: 100%;
}
.remote-main {
  flex: 1;
  min-width: 0;
}
.name {
  font-size: 14px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 12px;
  color: $color-text-muted-ink;
  margin-top: 2px;
  word-break: break-all;
}
.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.shortcut-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.shortcut-desc {
  font-size: 13px;
  color: $color-text-secondary;
}
.remotes-head {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-bottom: 10px;
}
.remote-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.remote-error {
  color: $color-danger;
}
.update-dl {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  max-width: 420px;
}
.pass-ink {
  color: $color-success;
}
.fail-ink {
  color: $color-danger;
}
</style>
