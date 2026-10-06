<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NButton, NCard, NForm, NFormItem, NInput, NSwitch, NSpace, useMessage,
  NDivider, NSelect, NList, NListItem, NPopconfirm, NTag, NModal
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import type { AppSettings, RemoteInstanceConfig, EnvProbe } from '@shared/types'

const store = useAppStore()
const message = useMessage()
const { t, locale } = useI18n()

function setLocale(loc: 'zh-CN' | 'en-US'): void {
  form.value.locale = loc
  locale.value = loc
}
const form = ref<AppSettings>({ ...(store.settings as AppSettings) })
const saving = ref(false)
const remotes = ref<RemoteInstanceConfig[]>([])
const showRemote = ref(false)
const remoteDraft = ref<RemoteInstanceConfig>({ id: '', name: '', baseUrl: '', label: '', enabled: true })
const envProbe = ref<EnvProbe | null>(null)
const pythons = ref<Array<{ path: string; version: string }>>([])

watch(
  () => store.settings,
  (s) => {
    if (s) form.value = { ...s }
  },
  { deep: true }
)

async function pickDir(target: 'downloadDir' | 'defaultInstancePath' | 'outputIndexRoot' | 'extraModelPathsFile'): Promise<void> {
  const p = await ipc('shell.pickDirectory')
  if (p) form.value[target] = p
}

async function save(): Promise<void> {
  saving.value = true
  try {
    const next = await ipc('settings.set', form.value)
    store.settings = next
    message.success('设置已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

async function loadRemotes(): Promise<void> {
  remotes.value = await ipc('remote.list')
}

async function saveRemote(): Promise<void> {
  if (!remoteDraft.value.id) remoteDraft.value.id = `remote-${Date.now()}`
  await ipc('remote.save', remoteDraft.value)
  showRemote.value = false
  message.success('远程实例已保存')
  await loadRemotes()
}

async function probeEnv(): Promise<void> {
  envProbe.value = await ipc('env.probe', {
    pythonPath: 'python',
    venvPath: form.value.defaultInstancePath || undefined
  })
  pythons.value = await ipc('env.listPythons')
  message.success('环境探测完成')
}

onMounted(async () => {
  await store.bootstrap({ keepSelection: true })
  await loadRemotes()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">设置</h1>
        <p class="page-subtitle">路径、网络、安全策略、远程实例与环境。</p>
      </div>
      <NButton type="primary" :loading="saving" @click="save">保存设置</NButton>
    </div>

    <div class="grid settings-grid">
      <NCard title="路径" class="card" size="small">
        <NForm label-placement="top">
          <NFormItem label="默认 ComfyUI 实例目录">
            <NInput v-model:value="form.defaultInstancePath">
              <template #suffix>
                <NButton size="tiny" secondary @click="pickDir('defaultInstancePath')">浏览</NButton>
              </template>
            </NInput>
          </NFormItem>
          <NFormItem label="模型下载目录">
            <NInput v-model:value="form.downloadDir">
              <template #suffix>
                <NButton size="tiny" secondary @click="pickDir('downloadDir')">浏览</NButton>
              </template>
            </NInput>
          </NFormItem>
          <NFormItem label="extra_model_paths.yaml">
            <NInput v-model:value="form.extraModelPathsFile" placeholder="共享模型路径配置" />
          </NFormItem>
          <NFormItem label="产物索引根目录">
            <NInput v-model:value="form.outputIndexRoot">
              <template #suffix>
                <NButton size="tiny" secondary @click="pickDir('outputIndexRoot')">浏览</NButton>
              </template>
            </NInput>
          </NFormItem>
        </NForm>
      </NCard>

      <NCard title="网络" class="card" size="small">
        <NForm label-placement="top">
          <NFormItem label="GitHub 镜像 / 代理前缀">
            <NInput v-model:value="form.githubEndpoint" placeholder="可选" />
          </NFormItem>
          <NFormItem label="HuggingFace Endpoint">
            <NInput v-model:value="form.hfEndpoint" placeholder="例如 https://hf-mirror.com" />
          </NFormItem>
          <NFormItem label="Civitai Endpoint">
            <NInput v-model:value="form.civitaiEndpoint" placeholder="https://civitai.com" />
          </NFormItem>
          <NFormItem label="网络模式">
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

      <NCard title="安全策略（对齐 Manager 语义）" class="card" size="small">
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
          <NFormItem label="使用 aria2 下载">
            <NSwitch v-model:value="form.useAria2" />
          </NFormItem>
          <NFormItem label="aria2 路径">
            <NInput v-model:value="form.aria2Path" placeholder="可选" />
          </NFormItem>
        </NForm>
      </NCard>

      <NCard title="应用行为" class="card" size="small">
        <NForm label-placement="top">
          <NFormItem label="启动时检查更新">
            <NSwitch v-model:value="form.enableAutoCheckUpdates" />
          </NFormItem>
          <NFormItem label="优先内嵌 ComfyUI Frontend">
            <NSwitch v-model:value="form.embedFrontend" />
          </NFormItem>
          <NFormItem :label="t('settings.language')">
            <NSpace>
              <NButton :type="form.locale === 'zh-CN' ? 'primary' : 'default'" secondary @click="setLocale('zh-CN')">
                简体中文
              </NButton>
              <NButton :type="form.locale === 'en-US' ? 'primary' : 'default'" secondary @click="setLocale('en-US')">
                English
              </NButton>
            </NSpace>
          </NFormItem>
          <NFormItem label="主题">
            <NSpace>
              <NButton :type="form.theme === 'light' ? 'primary' : 'default'" secondary @click="form.theme = 'light'">
                亮色（推荐）
              </NButton>
              <NButton :type="form.theme === 'system' ? 'primary' : 'default'" secondary @click="form.theme = 'system'">
                跟随系统
              </NButton>
            </NSpace>
          </NFormItem>
        </NForm>
      </NCard>

      <NCard title="远程实例" class="card" size="small">
        <NList v-if="remotes.length" bordered>
          <NListItem v-for="r in remotes" :key="r.id">
            <div class="row">
              <div>
                <div class="name">{{ r.name }}</div>
                <div class="meta mono">{{ r.baseUrl }}</div>
              </div>
              <NSpace>
                <NButton size="tiny" secondary @click="ipc('remote.test', r.id).then((s) => message.info(`online=${s.online}`))">
                  测试
                </NButton>
                <NPopconfirm @positive-click="ipc('remote.remove', r.id).then(loadRemotes)">
                  <template #trigger>
                    <NButton size="tiny" type="error" secondary>删除</NButton>
                  </template>
                  删除远程配置？
                </NPopconfirm>
              </NSpace>
            </div>
          </NListItem>
        </NList>
        <div v-else class="meta">暂无远程实例</div>
        <NButton style="margin-top: 12px" secondary @click="showRemote = true">添加远程实例</NButton>
      </NCard>

      <NCard title="Python 环境" class="card" size="small">
        <NButton secondary @click="probeEnv">探测环境</NButton>
        <template v-if="envProbe">
          <NDivider style="margin: 12px 0" />
          <div class="meta">Python: {{ envProbe.pythonVersion }}</div>
          <div class="meta">Torch: {{ envProbe.torchVersion || '—' }} · CUDA: {{ envProbe.cudaVersion || '—' }}</div>
          <div class="meta">
            MPS: <NTag size="tiny" round>{{ envProbe.mpsAvailable ? 'yes' : 'no' }}</NTag>
            NPU: <NTag size="tiny" round>{{ envProbe.npuAvailable ? 'yes' : 'no' }}</NTag>
          </div>
          <div v-if="pythons.length" class="meta">可用解释器：{{ pythons.length }} 个</div>
        </template>
      </NCard>

      <NCard title="关于" class="card" size="small">
        <div class="about">
          <div class="about-logo">ComfyPilot</div>
          <div class="about-line">v0.1.0 · MIT License</div>
          <div class="about-line">TypeScript · Vue 3 · Electron · Naive UI · SQLite</div>
          <NDivider style="margin: 12px 0" />
          <div class="about-line">控制塔，不是编辑器。旁路管理 ComfyUI 生产资产。</div>
          <NSpace style="margin-top: 12px">
            <NButton secondary @click="ipc('shell.openExternal', 'https://github.com/comfy-pilot/comfy-pilot')">
              GitHub 仓库
            </NButton>
          </NSpace>
        </div>
      </NCard>
    </div>

    <NModal v-model:show="showRemote" preset="card" title="添加远程实例" style="width: 480px; border-radius: 20px">
      <NSpace vertical>
        <NInput v-model:value="remoteDraft.name" placeholder="名称" />
        <NInput v-model:value="remoteDraft.baseUrl" placeholder="http://192.168.1.10:8188" />
        <NInput v-model:value="remoteDraft.label" placeholder="标签" />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showRemote = false">取消</NButton>
          <NButton type="primary" @click="saveRemote">保存</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;
.settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.about-logo {
  font-size: 20px; font-weight: 800;
  background: $gradient-primary;
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.about-line { margin-top: 6px; font-size: 13px; color: $color-text-secondary; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; }
.name { font-size: 14px; font-weight: 700; }
.meta { font-size: 12px; color: $color-text-muted; margin-top: 2px; word-break: break-all; }
</style>
