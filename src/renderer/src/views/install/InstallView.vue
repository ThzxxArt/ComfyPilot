<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  DownloadOutline, FlashOutline, CheckmarkCircleOutline, CloseCircleOutline,
  FolderOpenOutline, RocketOutline
} from '@vicons/ionicons5'
import {
  NButton, NIcon, NSpace, NInput, NSelect, NSwitch, useMessage,
  NSteps, NStep, NProgress, NCollapse, NCollapseItem, NTag, NAlert
} from 'naive-ui'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import type { GpuCapability, InstallPlan, InstallProgress } from '@shared/types'

const router = useRouter()
const message = useMessage()
const step = ref(0)
const detecting = ref(false)
const preflighting = ref(false)
const installing = ref(false)
const gpus = ref<GpuCapability[]>([])
const preflight = ref<{ ok: boolean; checks: Array<{ id: string; ok: boolean; detail: string }> } | null>(null)
const progress = ref<InstallProgress | null>(null)

const plan = ref<InstallPlan>({
  installRoot: '',
  instanceName: 'ComfyUI',
  useUv: false,
  pythonPath: 'python',
  torchChannel: 'cpu',
  comfyRepo: 'https://github.com/comfyanonymous/ComfyUI.git',
  comfyBranch: '',
  createDesktopShortcut: false,
  autoStart: false
})

const torchOptions = [
  { label: 'cu130 — NVIDIA 最新推荐', value: 'cu130' },
  { label: 'cu126 — NVIDIA 较旧卡', value: 'cu126' },
  { label: 'cu124 — NVIDIA 老卡', value: 'cu124' },
  { label: 'rocm — AMD (Linux)', value: 'rocm' },
  { label: 'xpu — Intel Arc', value: 'xpu' },
  { label: 'mps — Apple Silicon', value: 'mps' },
  { label: 'cpu — 无 GPU', value: 'cpu' }
]

const canStart = computed(() => Boolean(plan.value.installRoot.trim() && plan.value.instanceName.trim()))

const stepStatus = computed(() => {
  if (!progress.value) return 'process'
  if (progress.value.status === 'done') return 'finish'
  if (progress.value.error) return 'error'
  return 'process'
})

async function pickRoot(): Promise<void> {
  try {
    const p = await ipc('shell.pickDirectory')
    if (p) plan.value.installRoot = p
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function detectGpu(): Promise<void> {
  detecting.value = true
  try {
    gpus.value = await ipc('installer.detectGpu')
    const rec = gpus.value[0]?.recommendedTorch
    if (rec) plan.value.torchChannel = rec
    message.success(`推荐 torch：${plan.value.torchChannel}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    detecting.value = false
  }
}

async function runPreflight(): Promise<void> {
  if (!plan.value.installRoot.trim()) {
    message.warning('请先选择安装目录')
    return
  }
  preflighting.value = true
  try {
    preflight.value = await ipc('installer.preflight', {
      installRoot: plan.value.installRoot,
      useUv: plan.value.useUv
    })
    if (preflight.value.ok) {
      message.success('预检通过')
      step.value = Math.max(step.value, 2)
    } else {
      message.warning('预检有未通过项，请先解决')
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    preflighting.value = false
  }
}

async function startInstall(): Promise<void> {
  if (!canStart.value) return
  installing.value = true
  try {
    await ipc('installer.start', { ...plan.value })
    message.success('安装已开始，请看进度')
  } catch (err) {
    installing.value = false
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function cancelInstall(): Promise<void> {
  await ipc('installer.cancel')
  message.warning('已请求取消安装')
}

function onProgress(p: unknown): void {
  progress.value = p as InstallProgress
  if (progress.value?.status === 'done') {
    installing.value = false
    step.value = 3
    message.success('ComfyPilot 隔离环境安装完成！')
  }
  if (progress.value?.error) {
    installing.value = false
    message.error(progress.value.error)
  }
}

let off: (() => void) | null = null

onMounted(async () => {
  off = onIpc(IPC_EVENTS.installProgress, onProgress)
  try {
    const existing = await ipc('installer.status')
    if (existing) {
      progress.value = existing
      installing.value = existing.status === 'running' && !existing.error
    }
  } catch {
    /* ignore */
  }
  await detectGpu()
})

onUnmounted(() => off?.())
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">一键装机 · 全隔离环境</h1>
        <p class="page-subtitle">
          自动创建独立 venv、安装 PyTorch 与 ComfyUI，<b>不污染系统 Python</b>。
        </p>
      </div>
      <NSpace>
        <NButton secondary @click="router.push('/instances')">已有实例</NButton>
      </NSpace>
    </div>

    <NAlert v-if="progress?.error" type="error" class="mb" :title="'安装失败'">
      {{ progress.error }}
    </NAlert>
    <NAlert v-else-if="progress?.status === 'done'" type="success" class="mb" title="安装完成">
      实例「{{ plan.instanceName }}」已注册，可到「实例」页一键启动。
      <NButton size="tiny" secondary style="margin-left: 8px" @click="router.push('/instances')">
        去实例列表
      </NButton>
    </NAlert>

    <NSteps :current="step + 1" :status="stepStatus" class="mb">
      <NStep title="配置" description="目录 / GPU / 隔离" />
      <NStep title="预检" description="git / python / 磁盘" />
      <NStep title="安装" description="venv + torch + ComfyUI" />
      <NStep title="完成" description="注册并可启动" />
    </NSteps>

    <div class="grid layout">
      <section class="card panel">
        <div class="panel-title">安装配置</div>

        <div class="field">
          <label>安装根目录（将创建 .venv + ComfyUI）</label>
          <NInput v-model:value="plan.installRoot" placeholder="例如 D:\ComfyPilotRuntimes\comfy-main">
            <template #suffix>
              <NButton size="tiny" secondary @click="pickRoot">
                <template #icon><NIcon :component="FolderOpenOutline" /></template>
              </NButton>
            </template>
          </NInput>
        </div>

        <div class="field">
          <label>实例名称</label>
          <NInput v-model:value="plan.instanceName" placeholder="ComfyUI" />
        </div>

        <div class="field">
          <label>包管理 / 环境</label>
          <NSpace align="center">
            <NSwitch v-model:value="plan.useUv" />
            <span class="hint">{{ plan.useUv ? 'uv（更快，需已安装 uv）' : 'python -m venv（通用）' }}</span>
          </NSpace>
        </div>

        <div class="field">
          <label>PyTorch 渠道</label>
          <NSelect v-model:value="plan.torchChannel" :options="torchOptions" />
          <div class="hint" v-if="gpus.length">
            检测到：{{ gpus[0]?.model }}（{{ gpus[0]?.notes }}）
            <NButton size="tiny" text type="primary" @click="detectGpu">重新检测</NButton>
          </div>
        </div>

        <div class="field">
          <label>ComfyUI 仓库</label>
          <NInput v-model:value="plan.comfyRepo" />
        </div>

        <div class="field">
          <label>分支（可选，默认 master）</label>
          <NInput v-model:value="plan.comfyBranch" placeholder="master" />
        </div>

        <div class="field">
          <NSpace>
            <NSwitch v-model:value="plan.autoStart" />
            <span class="hint">安装完成后自动启动实例</span>
          </NSpace>
        </div>

        <NSpace class="actions">
          <NButton secondary :loading="preflighting" @click="runPreflight">
            <template #icon><NIcon :component="FlashOutline" /></template>
            运行预检
          </NButton>
          <NButton type="primary" :disabled="!canStart || installing" :loading="installing" @click="startInstall">
            <template #icon><NIcon :component="RocketOutline" /></template>
            开始一键安装
          </NButton>
          <NButton v-if="installing" type="error" secondary @click="cancelInstall">取消</NButton>
        </NSpace>

        <div v-if="preflight" class="preflight">
          <div v-for="c in preflight.checks" :key="c.id" class="check">
            <NIcon
              :size="16"
              :component="c.ok ? CheckmarkCircleOutline : CloseCircleOutline"
              :style="{ color: c.ok ? '#10b981' : '#ef4444' }"
            />
            <span>{{ c.detail }}</span>
          </div>
        </div>
      </section>

      <section class="card panel">
        <div class="panel-title">安装进度</div>
        <NProgress
          type="line"
          :percentage="progress?.percent ?? 0"
          indicator-placement="inside"
          processing
          class="mb"
        />

        <div class="steps-log">
          <div
            v-for="s in progress?.steps || []"
            :key="s.id"
            class="step-row"
            :class="s.status"
          >
            <div class="step-head">
              <NIcon
                :size="16"
                :component="s.status === 'done' ? CheckmarkCircleOutline : s.status === 'failed' ? CloseCircleOutline : DownloadOutline"
              />
              <b>{{ s.title }}</b>
              <NTag size="tiny" round>{{ s.status }}</NTag>
            </div>
            <div class="step-detail">{{ s.detail }}</div>
            <NCollapse v-if="s.log.length" class="log-collapse">
              <NCollapseItem :title="`日志 (${s.log.length})`" :name="s.id">
                <div v-for="(line, i) in s.log" :key="i" class="mono log-line">{{ line }}</div>
              </NCollapseItem>
            </NCollapse>
          </div>

          <div v-if="!progress" class="hint">
            尚未开始安装。配置目录后点击「运行预检」或「开始一键安装」。
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.layout {
  grid-template-columns: 1.1fr 1fr;
  align-items: start;
}

.panel {
  padding: 20px;
}

.panel-title {
  font-size: 16px;
  font-weight: 750;
  margin-bottom: 16px;
}

.field {
  margin-bottom: 14px;

  label {
    display: block;
    font-size: 12.5px;
    font-weight: 650;
    color: $color-text-secondary;
    margin-bottom: 6px;
  }
}

.hint {
  font-size: 12px;
  color: $color-text-muted;
  margin-top: 4px;
}

.actions {
  margin: 16px 0;
}

.preflight {
  margin-top: 12px;
  background: $color-surface-2;
  border-radius: 12px;
  padding: 12px;
}

.check {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12.5px;
  padding: 4px 0;
}

.steps-log {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.step-row {
  border: 1px solid $color-border;
  border-radius: 12px;
  padding: 10px 12px;

  &.running {
    border-color: rgba(79, 110, 247, 0.4);
    background: rgba(79, 110, 247, 0.06);
  }
  &.done {
    border-color: rgba(16, 185, 129, 0.35);
  }
  &.failed {
    border-color: rgba(239, 68, 68, 0.4);
    background: rgba(239, 68, 68, 0.05);
  }
}

.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
}

.step-detail {
  margin: 6px 0 4px;
  font-size: 12px;
  color: $color-text-muted;
}

.log-line {
  font-size: 11px;
  color: $color-text-secondary;
  line-height: 1.5;
}

.mb {
  margin-bottom: 16px;
}
</style>
