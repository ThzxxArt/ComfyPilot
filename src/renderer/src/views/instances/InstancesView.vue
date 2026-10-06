<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  AddOutline, PlayOutline, StopOutline, TrashOutline, FolderOpenOutline,
  OpenOutline, RefreshOutline, PowerOutline, CopyOutline, LinkOutline
} from '@vicons/ionicons5'
import {
  NButton, NEmpty, NIcon, NModal, NForm, NFormItem, NInput, NInputNumber, NSpace,
  NSpin, NPopconfirm, NSelect, NTag, useMessage
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import type { ComfyInstanceConfig, ComfyInstanceInfo, LaunchArgTemplate, EnvProbe, PortCheckResult } from '@shared/types'

const router = useRouter()
const store = useAppStore()
const message = useMessage()
const loading = ref(false)
const showCreate = ref(false)
const saving = ref(false)
const templates = ref<LaunchArgTemplate[]>([])
const envProbes = ref<Record<string, EnvProbe>>({})
const portChecks = ref<Record<number, PortCheckResult>>({})

const draft = ref<ComfyInstanceConfig>({
  id: '', name: 'My ComfyUI', path: '', pythonPath: '', venvPath: '',
  port: 8188, listen: '127.0.0.1', extraArgs: [], argTemplateId: 'default',
  enabled: true, notes: '', autoStart: false, frontendVersion: ''
})
const extraArgsText = ref('')

watch(extraArgsText, (v) => {
  draft.value.extraArgs = v.split(/\s+/).filter(Boolean)
})

onMounted(async () => {
  loading.value = true
  await store.refreshInstances()
  templates.value = await ipc('settings.launchTemplates')
  loading.value = false
})

async function pickPath(field: 'path' | 'pythonPath' | 'venvPath'): Promise<void> {
  const p = await ipc('shell.pickDirectory')
  if (p) draft.value[field] = p
}

async function discover(): Promise<void> {
  try {
    const found = await ipc('instance.discover', draft.value.path || undefined)
    if (found[0]) {
      draft.value.path = found[0].path
      message.success(`发现候选：${found[0].path}（${found[0].reason}）`)
    } else {
      message.info('未在常见路径发现 ComfyUI，请手动选择目录')
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function suggestPort(): Promise<void> {
  try {
    draft.value.port = await ipc('instance.suggestPort')
    message.success(`已分配空闲端口 ${draft.value.port}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function checkPort(): Promise<void> {
  try {
    const r = await ipc('instance.checkPort', draft.value.port)
    portChecks.value[draft.value.port] = r
    message[r.available ? 'success' : 'warning'](`端口 ${r.port} ${r.available ? '可用' : '占用：' + (r.owner || '')}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function createInstance(): Promise<void> {
  if (!draft.value.path) {
    message.warning('请先选择 ComfyUI 安装目录')
    return
  }
  saving.value = true
  try {
    draft.value.extraArgs = extraArgsText.value.split(/\s+/).filter(Boolean)
    const info = await ipc('instance.save', { ...draft.value })
    await store.refreshInstances()
    showCreate.value = false
    message.success(`已添加实例：${info.name}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

async function start(info: ComfyInstanceInfo): Promise<void> {
  try {
    await ipc('instance.start', info.id)
    await store.refreshInstances()
    message.success(`正在启动 ${info.name}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function stop(info: ComfyInstanceInfo): Promise<void> {
  try {
    await ipc('instance.stop', info.id)
    await store.refreshInstances()
    message.success(`已停止 ${info.name}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function restart(info: ComfyInstanceInfo): Promise<void> {
  try {
    await ipc('instance.restart', info.id)
    await store.refreshInstances()
    message.success(`已重启 ${info.name}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function forceKill(info: ComfyInstanceInfo): Promise<void> {
  try {
    await ipc('instance.forceKill', info.id)
    await store.refreshInstances()
    message.warning(`已强杀 ${info.name}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeInstance(info: ComfyInstanceInfo): Promise<void> {
  try {
    await ipc('instance.remove', info.id)
    await store.refreshInstances()
    message.success('实例已移除（文件未删除）')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function probeEnv(info: ComfyInstanceInfo): Promise<void> {
  try {
    envProbes.value[info.id] = await ipc('instance.probeEnv', info.id)
    message.success(`已探测 ${info.name} 环境`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function exportDiag(info: ComfyInstanceInfo): Promise<void> {
  try {
    const pkg = await ipc('instance.exportDiagnostics', info.id)
    message.success(`诊断包：${pkg.path}`)
    void ipc('shell.openPath', pkg.path).catch(() => undefined)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
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
        <h1 class="page-title">实例管理</h1>
        <p class="page-subtitle">发现、启动、多实例并行管理，端口冲突检测与环境探测。</p>
      </div>
      <NSpace>
        <NButton secondary @click="discover">
          <template #icon><NIcon :component="FolderOpenOutline" /></template>
          自动发现
        </NButton>
        <NButton type="primary" @click="showCreate = true">
          <template #icon><NIcon :component="AddOutline" /></template>
          添加实例
        </NButton>
      </NSpace>
    </div>

    <NSpin :show="loading">
      <div v-if="store.instances.length" class="grid cards">
        <article
          v-for="item in store.instances"
          :key="item.id"
          class="card card-interactive inst"
          @click="router.push(`/instances/${item.id}`)"
        >
          <div class="inst-top">
            <div>
              <div class="inst-name">{{ item.name }}</div>
              <div class="inst-path mono">{{ item.path }}</div>
            </div>
            <span class="chip" :class="statusClass(item.status)">{{ item.status }}</span>
          </div>

          <div class="meta-row">
            <span>端口 <b>{{ item.port }}</b></span>
            <span v-if="item.pid">PID <b>{{ item.pid }}</b></span>
            <span v-if="item.uptimeMs">运行 <b>{{ Math.floor(item.uptimeMs / 1000) }}s</b></span>
            <span v-if="item.managerEnabled"><NTag size="tiny" type="info" round>Manager</NTag></span>
          </div>

          <div v-if="envProbes[item.id]" class="env-box">
            <div class="mono">{{ envProbes[item.id].pythonVersion }}</div>
            <div class="mono">torch {{ envProbes[item.id].torchVersion || '—' }} · cuda {{ envProbes[item.id].cudaVersion || '—' }}</div>
          </div>

          <div class="actions" @click.stop>
            <NButton v-if="item.status !== 'running'" size="small" type="primary" secondary @click="start(item)">
              <template #icon><NIcon :component="PlayOutline" /></template>启动
            </NButton>
            <NButton v-else size="small" type="warning" secondary @click="stop(item)">
              <template #icon><NIcon :component="StopOutline" /></template>停止
            </NButton>
            <NButton size="small" secondary @click="restart(item)">
              <template #icon><NIcon :component="RefreshOutline" /></template>重启
            </NButton>
            <NPopconfirm @positive-click="forceKill(item)">
              <template #trigger>
                <NButton size="small" type="error" secondary>
                  <template #icon><NIcon :component="PowerOutline" /></template>强杀
                </NButton>
              </template>
              强制结束进程，未保存队列将丢失。
            </NPopconfirm>
            <NButton size="small" secondary @click="item.url && ipc('shell.openExternal', item.url)">
              <template #icon><NIcon :component="OpenOutline" /></template>
            </NButton>
            <NButton size="small" secondary @click="probeEnv(item)">
              <template #icon><NIcon :component="LinkOutline" /></template>环境
            </NButton>
            <NButton size="small" secondary @click="exportDiag(item)">
              <template #icon><NIcon :component="CopyOutline" /></template>诊断包
            </NButton>
            <NPopconfirm @positive-click="removeInstance(item)">
              <template #trigger>
                <NButton size="small" type="error" quaternary>
                  <template #icon><NIcon :component="TrashOutline" /></template>
                </NButton>
              </template>
              仅从 ComfyPilot 移除登记，不会删除磁盘文件。
            </NPopconfirm>
          </div>
        </article>
      </div>
      <NEmpty v-else description="还没有 ComfyUI 实例，点击右上角添加或自动发现" class="empty" />
    </NSpin>

    <NModal v-model:show="showCreate" preset="card" title="添加 ComfyUI 实例" style="width: 640px; border-radius: 20px">
      <NForm label-placement="top">
        <NFormItem label="实例名称">
          <NInput v-model:value="draft.name" placeholder="例如：主力 SDXL" />
        </NFormItem>
        <NFormItem label="ComfyUI 安装目录">
          <NInput v-model:value="draft.path" placeholder="包含 main.py 的目录">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickPath('path')">浏览</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem label="Python 可执行文件">
          <NInput v-model:value="draft.pythonPath" placeholder="留空则自动探测">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickPath('pythonPath')">浏览</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem label="venv 路径（可选）">
          <NInput v-model:value="draft.venvPath" placeholder="虚拟环境根目录">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickPath('venvPath')">浏览</NButton>
            </template>
          </NInput>
        </NFormItem>
        <NFormItem label="启动参数模板">
          <NSelect
            v-model:value="draft.argTemplateId"
            :options="templates.map((t) => ({ label: `${t.name} — ${t.description}`, value: t.id }))"
          />
        </NFormItem>
        <div class="form-row">
          <NFormItem label="端口">
            <NSpace>
              <NInputNumber v-model:value="draft.port" :min="1" :max="65535" />
              <NButton size="small" secondary @click="suggestPort">建议端口</NButton>
              <NButton size="small" secondary @click="checkPort">检测</NButton>
            </NSpace>
          </NFormItem>
          <NFormItem label="监听地址">
            <NInput v-model:value="draft.listen" placeholder="127.0.0.1" />
          </NFormItem>
        </div>
        <NFormItem label="额外参数（空格分隔）">
          <NInput
            :value="extraArgsText"
            placeholder="例如 --preview-method taesd"
            @update:value="(v: string) => (extraArgsText = v)"
          />
        </NFormItem>
        <NFormItem label="备注">
          <NInput v-model:value="draft.notes" type="textarea" :rows="2" />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="createInstance">保存</NButton>
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
.inst-name { font-size: 17px; font-weight: 750; letter-spacing: -0.02em; }
.inst-path { margin-top: 6px; font-size: 12px; color: $color-text-muted; word-break: break-all; }
.meta-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; font-size: 12.5px; color: $color-text-secondary; b { color: $color-text; } }
.env-box { background: $color-surface-2; border-radius: 10px; padding: 8px 10px; font-size: 11.5px; color: $color-text-muted; margin-bottom: 10px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.empty { padding: 64px 0; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
</style>
