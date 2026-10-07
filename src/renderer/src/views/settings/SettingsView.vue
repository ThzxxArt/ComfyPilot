<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NButton, NCard, NForm, NFormItem, NInput, NInputNumber, NSwitch, NSpace, useMessage,
  NDivider, NSelect, NList, NListItem, NPopconfirm, NTag, NModal
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import type { AppSettings, RemoteInstanceConfig, EnvProbe, ProxySettings } from '@shared/types'
import { APP_VERSION, DEFAULT_SETTINGS, PIP_INDEX_PRESETS, TORCH_INDEX_PRESETS } from '@shared/constants'

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
  const base = (s && typeof s === 'object' ? JSON.parse(JSON.stringify(s)) : {}) as Partial<AppSettings>
  return {
    ...(DEFAULT_SETTINGS as AppSettings),
    ...(base as AppSettings),
    proxy: { ...defaultProxy, ...(base.proxy || {}) }
  } as AppSettings
}

const store = useAppStore()
const message = useMessage()
const { t, locale } = useI18n()

function setLocale(loc: 'zh-CN' | 'en-US'): void {
  form.value.locale = loc
  locale.value = loc
}

const form = ref<AppSettings>(cloneSettings(store.settings))
const saving = ref(false)
const remotes = ref<RemoteInstanceConfig[]>([])
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
/** Skip watch merge while we are the ones writing store.settings */
let suppressSettingsWatch = false
/** User has typed into the proxy form — do not clobber those edits */
let userEditedProxy = false
let applyingIncoming = false

watch(
  () => form.value.proxy,
  () => {
    if (!applyingIncoming) userEditedProxy = true
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
        if (key === 'proxy' && userEditedProxy) continue
        // @ts-expect-error index write
        form.value[key] = incoming[key]
      }
    } finally {
      applyingIncoming = false
    }
    if (!userEditedProxy) proxyTestResult.value = null
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
      userEditedProxy = false
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
    message.success(r.enabled ? t('settings.proxyApplied', { url: r.url }) : t('settings.proxyDirect'))
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function pickDir(target: 'downloadDir' | 'defaultInstancePath' | 'outputIndexRoot' | 'extraModelPathsFile'): Promise<void> {
  try {
    const p = await ipc('shell.pickDirectory')
    if (p) form.value[target] = p
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function loadRemotes(): Promise<void> {
  try {
    remotes.value = await ipc('remote.list')
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

function cancelRemoteDialog(): void {
  showRemote.value = false
  remoteDraft.value = emptyRemote()
}

async function probeEnv(): Promise<void> {
  try {
    envProbe.value = await ipc('env.probe', {
      pythonPath: 'python',
      venvPath: form.value.defaultInstancePath || undefined
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
    message.info(`online=${s.online}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
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
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ t('settings.title') }}</h1>
        <p class="page-subtitle">{{ t('settings.subtitle') }}</p>
      </div>
      <NButton type="primary" :loading="saving" @click="save()">{{ t('settings.saveSettings') }}</NButton>
    </div>

    <div class="page-body">
    <div class="grid settings-grid">
      <NCard :title="t('settings.paths')" class="card" size="small">
        <NForm label-placement="top">
          <NFormItem :label="t('settings.defaultInstancePath')">
            <NInput v-model:value="form.defaultInstancePath">
              <template #suffix>
                <NButton size="tiny" secondary @click="pickDir('defaultInstancePath')">{{ t('settings.browse') }}</NButton>
              </template>
            </NInput>
          </NFormItem>
          <NFormItem :label="t('settings.downloadDir')">
            <NInput v-model:value="form.downloadDir">
              <template #suffix>
                <NButton size="tiny" secondary @click="pickDir('downloadDir')">{{ t('settings.browse') }}</NButton>
              </template>
            </NInput>
          </NFormItem>
          <NFormItem label="extra_model_paths.yaml">
            <NInput v-model:value="form.extraModelPathsFile" :placeholder="t('settings.extraModelPathsPlaceholder')" />
          </NFormItem>
          <NFormItem :label="t('settings.outputIndexRoot')">
            <NInput v-model:value="form.outputIndexRoot">
              <template #suffix>
                <NButton size="tiny" secondary @click="pickDir('outputIndexRoot')">{{ t('settings.browse') }}</NButton>
              </template>
            </NInput>
          </NFormItem>
        </NForm>
      </NCard>

      <NCard :title="t('settings.network')" class="card" size="small">
        <NForm label-placement="top">
          <NFormItem :label="t('settings.githubEndpoint')">
            <NInput v-model:value="form.githubEndpoint" :placeholder="t('settings.optional')" />
          </NFormItem>
          <NFormItem label="HuggingFace Endpoint">
            <NInput v-model:value="form.hfEndpoint" :placeholder="t('settings.hfEndpointPlaceholder')" />
          </NFormItem>
          <NFormItem label="Civitai Endpoint">
            <NInput v-model:value="form.civitaiEndpoint" placeholder="https://civitai.com" />
          </NFormItem>
          <NFormItem :label="t('settings.pipIndexLabel')">
            <NSelect
              v-model:value="form.pipIndex"
              :options="pipIndexOptions"
              filterable
              tag
            />
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
          </NFormItem>
        </NForm>
      </NCard>

      <NCard :title="t('settings.security')" class="card" size="small">
        <NForm label-placement="top">
          <NFormItem label="security_level">
            <NSelect
              v-model:value="form.securityLevel"
              :options="[
                { label: 'strong', value: 'strong' },
                { label: 'normal', value: 'normal' },
                { label: 'normal-', value: 'normal-' },
                { label: 'weak', value: 'weak' }
              ]"
            />
          </NFormItem>
          <NFormItem label="allow_git_url_install">
            <NSwitch v-model:value="form.allowGitUrlInstall" />
          </NFormItem>
          <NFormItem label="allow_pip_install">
            <NSwitch v-model:value="form.allowPipInstall" />
          </NFormItem>
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
              <NInput v-model:value="form.proxy.host" placeholder="127.0.0.1" :disabled="!form.proxy.enabled" />
            </NFormItem>
            <NFormItem :label="t('settings.proxyPort')">
              <NInputNumber v-model:value="form.proxy.port" :min="1" :max="65535" :disabled="!form.proxy.enabled" />
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
            <NButton secondary :loading="testingProxy" @click="testProxy">{{ t('settings.testConnection') }}</NButton>
            <NButton secondary @click="applyProxy">{{ t('settings.applyNow') }}</NButton>
          </NSpace>
          <div v-if="proxyTestResult" class="meta" :class="proxyTestResult.ok ? 'pass-ink' : 'fail-ink'">
            {{ proxyTestResult.ok ? '✓' : '✗' }} {{ proxyTestResult.via }} · {{ proxyTestResult.ms }}ms
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
            <NSwitch v-model:value="form.launchOnBoot" @update:value="() => save({ silent: true })" />
          </NFormItem>
          <NFormItem :label="t('settings.minimizeToTray')">
            <NSwitch v-model:value="form.minimizeToTray" />
          </NFormItem>
          <NFormItem :label="t('settings.autoStartInstances')">
            <NSwitch v-model:value="form.autoStartInstancesOnLaunch" />
          </NFormItem>
          <NFormItem :label="t('settings.language')">
            <NSpace>
              <NButton :type="form.locale === 'zh-CN' ? 'primary' : 'default'" secondary @click="setLocale('zh-CN')">
                {{ t('settings.langZhCN') }}
              </NButton>
              <NButton :type="form.locale === 'en-US' ? 'primary' : 'default'" secondary @click="setLocale('en-US')">
                English
              </NButton>
            </NSpace>
          </NFormItem>
          <NFormItem :label="t('settings.theme')">
            <NSpace>
              <NButton :type="form.theme === 'light' ? 'primary' : 'default'" secondary @click="form.theme = 'light'">
                {{ t('settings.themeLight') }}
              </NButton>
            </NSpace>
          </NFormItem>
        </NForm>
      </NCard>

      <NCard :title="t('settings.remotes')" class="card" size="small">
        <NList v-if="remotes.length" bordered>
          <NListItem v-for="r in remotes" :key="r.id">
            <div class="row">
              <div>
                <div class="name">{{ r.name }}</div>
                <div class="meta mono">{{ r.baseUrl }}</div>
              </div>
              <NSpace>
                <NButton size="tiny" secondary @click="testRemote(r.id)">{{ t('settings.test') }}</NButton>
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
        <NButton style="margin-top: 12px" secondary @click="openRemoteDialog">{{ t('settings.addRemote') }}</NButton>
      </NCard>

      <NCard :title="t('settings.pythonEnv')" class="card" size="small">
        <NButton secondary @click="probeEnv">{{ t('settings.probeEnv') }}</NButton>
        <template v-if="envProbe">
          <NDivider style="margin: 12px 0" />
          <div class="meta">Python: {{ envProbe.pythonVersion }}</div>
          <div class="meta">Torch: {{ envProbe.torchVersion || '—' }} · CUDA: {{ envProbe.cudaVersion || '—' }}</div>
          <div class="meta">
            MPS: <NTag size="tiny" round>{{ envProbe.mpsAvailable ? 'yes' : 'no' }}</NTag>
            NPU: <NTag size="tiny" round>{{ envProbe.npuAvailable ? 'yes' : 'no' }}</NTag>
          </div>
          <div v-if="pythons.length" class="meta">{{ t('settings.availablePythons', { n: pythons.length }) }}</div>
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

      <NCard :title="t('settings.about')" class="card" size="small">
        <div class="about">
          <div class="about-logo">ComfyPilot</div>
          <div class="about-line">v{{ APP_VERSION }} · MIT License</div>
          <div class="about-line">TypeScript · Vue 3 · Electron · Naive UI</div>
          <div class="about-line">{{ t('settings.aboutStorage') }}</div>
          <NDivider style="margin: 12px 0" />
          <div class="about-line">{{ t('settings.aboutConfigDir', { path: configPath }) }}</div>
          <div class="about-line">{{ t('settings.aboutTagline') }}</div>
          <NSpace style="margin-top: 12px">
            <NButton secondary @click="openConfigDir">{{ t('settings.openConfigDir') }}</NButton>
            <NButton secondary @click="ipc('shell.openExternal', 'https://github.com/ThzxxArt/ComfyPilot')">
              {{ t('settings.githubRepo') }}
            </NButton>
          </NSpace>
        </div>
      </NCard>
    </div>
    </div>

    <NModal v-model:show="showRemote" preset="card" :title="t('settings.addRemote')" style="width: 480px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="remoteDraft.name" :placeholder="t('settings.remoteName')" />
        <NInput v-model:value="remoteDraft.baseUrl" placeholder="http://192.168.1.10:8188" />
        <NInput v-model:value="remoteDraft.label" :placeholder="t('settings.remoteLabel')" />
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
.settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.proxy-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
.about-logo {
  font-size: 20px; font-weight: 800;
  background: $gradient-primary;
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.about-line { margin-top: 6px; font-size: 13px; color: $color-text-secondary; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; }
.name { font-size: 14px; font-weight: 700; }
.meta { font-size: 12px; color: $color-text-muted; margin-top: 2px; word-break: break-all; }
.shortcut-list { display: flex; flex-direction: column; gap: 10px; }
.shortcut-row { display: flex; align-items: center; gap: 12px; }
.shortcut-desc { font-size: 13px; color: $color-text-secondary; }
.pass-ink { color: $color-success; }
.fail-ink { color: $color-danger; }
</style>
