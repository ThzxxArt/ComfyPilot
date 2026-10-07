<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  AddOutline, PlayOutline, StopOutline, TrashOutline, FolderOpenOutline,
  OpenOutline, RefreshOutline, PowerOutline, CopyOutline, LinkOutline, RocketOutline,
  CreateOutline, TerminalOutline, PinOutline, SearchOutline, PulseOutline
} from '@vicons/ionicons5'
import {
  NButton, NEmpty, NIcon, NModal, NForm, NFormItem, NInput, NInputNumber, NSpace,
  NSpin, NPopconfirm, NSelect, NTag, NCheckbox, NSwitch, useMessage, NInputGroup
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { ipc } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import type {
  ComfyInstanceConfig, ComfyInstanceInfo, LaunchArgTemplate, EnvProbe,
  PortCheckResult, InstanceDiscoveryCandidate, LaunchCommandPreview
} from '@shared/types'

const router = useRouter()
const store = useAppStore()
const message = useMessage()
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

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = store.instances
  if (!q) return list
  return list.filter(
    (i) =>
      i.name.toLowerCase().includes(q) ||
      i.path.toLowerCase().includes(q) ||
      String(i.port).includes(q)
  )
})

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
  try {
    if (field === 'pythonPath') {
      const p = await ipc('shell.pickFile', {
        filters: [
          { name: 'Python', extensions: ['exe'] },
          { name: 'All', extensions: ['*'] }
        ]
      })
      if (p) draft.value[field] = p
    } else {
      const p = await ipc('shell.pickDirectory')
      if (p) draft.value[field] = p
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
      message.info('未在常见路径发现 ComfyUI，请手动选择目录')
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
  message.success(`已填入候选：${c.path}`)
}

async function importSelectedCandidates(): Promise<void> {
  const picks = candidates.value.filter((c) => selectedCandidates.value.includes(c.path) && !c.registered)
  if (!picks.length) {
    message.warning('请先勾选未注册的候选')
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
  message.success(`已导入 ${picks.length} 个实例`)
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
  message.success('启动命令已复制')
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
    message.success('实例配置已保存（端口/参数改动需重启生效）')
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
        <h1 class="page-title">{{ $t('instance.title') }}</h1>
        <p class="page-subtitle">{{ $t('instance.subtitle') }}</p>
      </div>
      <NSpace>
        <NInputGroup>
          <NInput v-model:value="search" :placeholder="$t('instance.searchPlaceholder')" clearable style="width: 220px">
            <template #prefix><NIcon :component="SearchOutline" /></template>
          </NInput>
        </NInputGroup>
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
            <span class="chip" :class="statusClass(item.status)">{{ item.status }}</span>
          </div>

          <div class="meta-row">
            <span>端口 <b>{{ item.port }}</b></span>
            <span v-if="item.pid">PID <b>{{ item.pid }}</b></span>
            <span v-if="item.uptimeMs">运行 <b>{{ Math.floor(item.uptimeMs / 1000) }}s</b></span>
            <span v-if="item.autoStart"><NTag size="tiny" type="success" round>autoStart</NTag></span>
            <span v-if="item.managerEnabled"><NTag size="tiny" type="info" round>Manager</NTag></span>
          </div>

          <div v-if="envProbes[item.id]" class="env-box">
            <div class="mono">{{ envProbes[item.id].pythonVersion }}</div>
            <div class="mono">torch {{ envProbes[item.id].torchVersion || '—' }} · cuda {{ envProbes[item.id].cudaVersion || '—' }}</div>
          </div>

          <div class="actions" @click.stop>
            <NButton
              size="small"
              type="primary"
              secondary
              :loading="busy[item.id]"
              @click="launchAndOpen(item)"
            >
              <template #icon><NIcon :component="RocketOutline" /></template>
              {{ $t('instance.launchOpen') }}
            </NButton>
            <NButton v-if="item.status !== 'running'" size="small" type="primary" tertiary @click="launch(item, { open: 'none' })">
              <template #icon><NIcon :component="PlayOutline" /></template>
            </NButton>
            <NButton v-else size="small" type="warning" secondary @click="stop(item)">
              <template #icon><NIcon :component="StopOutline" /></template>
            </NButton>
            <NButton size="small" secondary @click="restart(item)">
              <template #icon><NIcon :component="RefreshOutline" /></template>
            </NButton>
            <NButton size="small" secondary :title="$t('instance.previewCmd')" @click="showPreview(item)">
              <template #icon><NIcon :component="TerminalOutline" /></template>
            </NButton>
            <NButton size="small" secondary :title="$t('instance.edit')" @click="openEdit(item)">
              <template #icon><NIcon :component="CreateOutline" /></template>
            </NButton>
            <NButton size="small" secondary @click="togglePin(item)">
              <template #icon><NIcon :component="PinOutline" /></template>
            </NButton>
            <NPopconfirm @positive-click="forceKill(item)">
              <template #trigger>
                <NButton size="small" type="error" secondary>
                  <template #icon><NIcon :component="PowerOutline" /></template>
                </NButton>
              </template>
              强制结束进程，未保存队列将丢失。
            </NPopconfirm>
            <NButton size="small" secondary @click="item.url && ipc('shell.openExternal', item.url)">
              <template #icon><NIcon :component="OpenOutline" /></template>
            </NButton>
            <NButton size="small" secondary @click="probeEnv(item)">
              <template #icon><NIcon :component="LinkOutline" /></template>
            </NButton>
            <NButton size="small" secondary @click="exportDiag(item)">
              <template #icon><NIcon :component="CopyOutline" /></template>
            </NButton>
            <NButton size="small" secondary @click="router.push(`/instances/${item.id}`)">
              <template #icon><NIcon :component="PulseOutline" /></template>
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
      <div v-else class="empty">
        <NEmpty description="还没有 ComfyUI 实例">
          <template #extra>
            <NSpace>
              <NButton type="primary" @click="showCreate = true">手动添加已有实例</NButton>
              <NButton secondary @click="router.push('/install')">
                <template #icon><NIcon :component="RocketOutline" /></template>
                一键装机（隔离环境）
              </NButton>
              <NButton secondary @click="openDiscover">自动发现</NButton>
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
            <NButton size="tiny" secondary :disabled="c.registered" @click="useCandidate(c)">填入表单</NButton>
          </div>
        </div>
        <NEmpty v-else description="未发现候选" />
      </NSpin>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showDiscover = false">关闭</NButton>
          <NButton secondary :loading="discovering" @click="runDiscover">重新扫描</NButton>
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
          <NButton @click="showPreviewModal = false">关闭</NButton>
          <NButton type="primary" @click="copyPreview">{{ $t('instance.copyCmd') }}</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Edit instance -->
    <NModal v-model:show="showEditModal" preset="card" :title="$t('instance.edit')" style="width: 640px; border-radius: 20px">
      <NForm v-if="editing" label-placement="top">
        <NFormItem label="实例名称">
          <NInput v-model:value="editing.name" />
        </NFormItem>
        <NFormItem label="安装目录">
          <NInput v-model:value="editing.path" />
        </NFormItem>
        <NFormItem label="Python">
          <NInput v-model:value="editing.pythonPath" placeholder="留空自动探测" />
        </NFormItem>
        <NFormItem label="venv">
          <NInput v-model:value="editing.venvPath" />
        </NFormItem>
        <div class="form-row">
          <NFormItem label="端口">
            <NInputNumber v-model:value="editing.port" :min="1" :max="65535" />
          </NFormItem>
          <NFormItem label="监听">
            <NInput v-model:value="editing.listen" />
          </NFormItem>
        </div>
        <NFormItem label="启动参数模板">
          <NSelect
            v-model:value="editing.argTemplateId"
            :options="templates.map((t) => ({ label: `${t.name} — ${t.description}`, value: t.id }))"
          />
        </NFormItem>
        <NFormItem label="额外参数（空格分隔）">
          <NInput v-model:value="editExtraArgs" />
        </NFormItem>
        <NFormItem label="备注">
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
          <NButton @click="showEditModal = false">取消</NButton>
          <NButton type="primary" :loading="editSaving" @click="saveEdit">保存</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- Create instance -->
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
        <div class="form-row">
          <NFormItem label="autoStart（App 启动自动拉起）">
            <NSwitch v-model:value="draft.autoStart" />
          </NFormItem>
          <NFormItem :label="$t('instance.pinned')">
            <NSwitch v-model:value="draft.pinned" />
          </NFormItem>
        </div>
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
.inst-name { font-size: 17px; font-weight: 750; letter-spacing: -0.02em; display: flex; align-items: center; gap: 6px; }
.pin-icon { color: $color-primary; }
.inst-path { margin-top: 6px; font-size: 12px; color: $color-text-muted; word-break: break-all; }
.meta-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; font-size: 12.5px; color: $color-text-secondary; b { color: $color-text; } }
.env-box { background: $color-surface-2; border-radius: 10px; padding: 8px 10px; font-size: 11.5px; color: $color-text-muted; margin-bottom: 10px; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
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
