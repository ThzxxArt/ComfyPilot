<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  CheckmarkCircleOutline,
  CloseCircleOutline,
  CloudDownloadOutline,
  DownloadOutline,
  FlashOutline,
  FolderOpenOutline,
  HardwareChipOutline,
  RocketOutline
} from '@vicons/ionicons5'
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NIcon,
  NInput,
  NProgress,
  NRadio,
  NRadioGroup,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { ipc, onIpc, IPC_EVENTS } from '@/composables/useIpc'
import { useLaunch } from '@/composables/useLaunch'
import { useAppStore } from '@/stores/app'
import { clampPercent, formatBytes } from '@/utils/format'
import { severityColor } from '@/styles/tokens'
import {
  PIP_INDEX_PRESETS,
  STARTER_MODELS,
  TORCH_DISK_GB,
  TORCH_INDEX_PRESETS
} from '@shared/constants'
import type {
  GpuCapability,
  InstallPlan,
  InstallProgress,
  InstallStepId,
  InstallStepStatus,
  RuntimeDownloadProgress,
  RuntimeKind,
  StarterModel,
  TorchChannel
} from '@shared/types'

type PreflightCheck = {
  id: string
  ok: boolean
  detail: string
  detailKey?: string
  detailParams?: Record<string, string | number>
  fixId?: string
  fixLabel?: string
  fixLabelKey?: string
}
type PreflightResult = {
  ok: boolean
  checks: PreflightCheck[]
  diskNeedGb?: number
  diskFreeGb?: number
}

/** Prefer i18n key from main; fall back to English detail. */
function detailOf(item: { detail?: string; detailKey?: string; detailParams?: Record<string, string | number> }): string {
  if (item.detailKey) {
    try {
      return t(item.detailKey, item.detailParams || {})
    } catch {
      /* fall through */
    }
  }
  return item.detail || ''
}

const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const store = useAppStore()
const { launch } = useLaunch()

const DEFAULT_REPO = 'https://github.com/comfyanonymous/ComfyUI.git'

const plan = ref<InstallPlan>({
  installRoot: '',
  instanceName: 'ComfyUI',
  useUv: true,
  pythonPath: '',
  torchChannel: 'cpu',
  comfyRepo: DEFAULT_REPO,
  comfyBranch: '',
  createDesktopShortcut: false,
  autoStart: true,
  comfySource: 'zip',
  skipStarter: false
})

const pipIndex = ref('')
const torchIndexMirror = ref('')
const gpus = ref<GpuCapability[]>([])
const gpuSentence = ref('')
const preflight = ref<PreflightResult | null>(null)
const preflighting = ref(false)
const installing = ref(false)
const progress = ref<InstallProgress | null>(null)
const runtimeProg = ref<RuntimeDownloadProgress | null>(null)
const fixingId = ref<string | null>(null)
const expandedLogIds = ref<string[]>([])
const suggestFreeGb = ref(0)
const starterModels = ref<StarterModel[]>([...STARTER_MODELS])
const starterBusy = ref<string | null>(null)

const TORCH_CHANNEL_VALUES: TorchChannel[] = [
  'cu130',
  'cu126',
  'cu124',
  'rocm',
  'xpu',
  'mps',
  'cpu'
]

const FIX_KIND: Record<string, RuntimeKind> = {
  'bootstrap-python': 'python',
  'bootstrap-mingit': 'mingit',
  'bootstrap-uv': 'uv'
}

const FIX_LABEL_KEY: Record<string, string> = {
  'bootstrap-python': 'install.fixPython',
  'bootstrap-mingit': 'install.fixGit',
  'bootstrap-uv': 'install.fixUv'
}

const STEP_TITLE_KEY: Record<InstallStepId, string> = {
  bootstrap: 'install.stepBootstrap',
  preflight: 'install.stepPreflight',
  python: 'install.stepPython',
  venv: 'install.stepVenv',
  comfyui: 'install.stepComfyui',
  torch: 'install.stepTorch',
  requirements: 'install.stepRequirements',
  register: 'install.stepRegister',
  starter: 'install.stepStarter',
  done: 'install.stepDone'
}

function stepTitleKey(id: InstallStepId): string {
  return STEP_TITLE_KEY[id] || id
}

const torchOptions = computed(() =>
  TORCH_CHANNEL_VALUES.map((v) => ({
    label: t(`install.torchChannels.${v}`),
    value: v as TorchChannel
  }))
)

function torchLabel(ch: TorchChannel): string {
  return t(`install.torchChannels.${ch}`)
}

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

const canStart = computed(() => Boolean(plan.value.installRoot.trim() && plan.value.instanceName.trim()))

const isDone = computed(() => progress.value?.status === 'done' && !progress.value?.error)
const isFailed = computed(() => Boolean(progress.value?.error))
const installingNow = computed(() => installing.value || progress.value?.status === 'running')

/** Hard preflight failures (root/disk) must block the CTA — soft fixables do not. */
const hasHardPreflightFail = computed(() =>
  Boolean(preflight.value?.checks?.some((c) => !c.ok && !c.fixId))
)
const canStartInstall = computed(() => canStart.value && !hasHardPreflightFail.value && !installingNow.value)

const diskNeedGb = computed(() => {
  if (typeof preflight.value?.diskNeedGb === 'number') return preflight.value.diskNeedGb
  return (TORCH_DISK_GB[plan.value.torchChannel] || 3) + 4
})
const diskFreeGb = computed(() => {
  if (typeof preflight.value?.diskFreeGb === 'number') return preflight.value.diskFreeGb
  return suggestFreeGb.value
})

function fmtGb(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  return n >= 10 ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1)
}

function bytesText(b: { receivedBytes: number; totalBytes: number; speedBps: number }): string {
  return t('install.bytes', {
    recv: formatBytes(b.receivedBytes),
    total: formatBytes(b.totalBytes),
    speed: `${formatBytes(b.speedBps)}/s`
  })
}

function stepStatusTag(status: InstallStepStatus): 'success' | 'error' | 'info' | 'default' {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'running') return 'info'
  return 'default'
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function pickRoot(): Promise<void> {
  try {
    const p = await ipc('shell.pickDirectory')
    if (p) plan.value.installRoot = p
  } catch (err) {
    message.error(errText(err))
  }
}

async function detectGpu(): Promise<void> {
  try {
    gpus.value = await ipc('installer.detectGpu')
    const rec = gpus.value[0]?.recommendedTorch
    if (rec) {
      plan.value.torchChannel = rec
      gpuSentence.value = t('install.gpuDetected', {
        model: gpus.value[0]?.model || rec,
        channel: torchLabel(rec)
      })
    }
  } catch (err) {
    message.error(errText(err))
  }
}

async function runPreflight(): Promise<void> {
  if (!plan.value.installRoot.trim()) return
  preflighting.value = true
  try {
    preflight.value = await ipc('installer.preflight', {
      installRoot: plan.value.installRoot,
      useUv: plan.value.useUv,
      pythonPath: plan.value.pythonPath || undefined,
      torchChannel: plan.value.torchChannel
    })
  } catch (err) {
    message.error(errText(err))
  } finally {
    preflighting.value = false
  }
}

let preflightTimer: ReturnType<typeof setTimeout> | null = null

function schedulePreflight(delay = 400): void {
  if (preflightTimer) clearTimeout(preflightTimer)
  preflightTimer = setTimeout(() => {
    preflightTimer = null
    if (plan.value.installRoot.trim() && plan.value.torchChannel) {
      void runPreflight()
    }
  }, delay)
}

watch(
  () => [plan.value.installRoot, plan.value.torchChannel, plan.value.useUv] as const,
  () => schedulePreflight()
)

async function applyFix(check: PreflightCheck): Promise<void> {
  const fixId = check.fixId
  if (!fixId) return
  const kind = FIX_KIND[fixId]
  if (!kind) return
  fixingId.value = fixId
  try {
    await ipc('bootstrap.download', kind)
    await runPreflight()
  } catch (err) {
    message.error(errText(err))
  } finally {
    fixingId.value = null
    runtimeProg.value = null
  }
}

function fixLabelOf(check: PreflightCheck): string {
  const key = (check.fixId ? FIX_LABEL_KEY[check.fixId] : null) || check.fixLabelKey
  return key ? t(key) : check.fixLabel || t('common.retry')
}

function buildPlan(overrides: Partial<InstallPlan>): InstallPlan {
  return {
    installRoot: plan.value.installRoot.trim(),
    instanceName: plan.value.instanceName.trim() || 'ComfyUI',
    useUv: plan.value.useUv,
    pythonPath: plan.value.pythonPath || '',
    torchChannel: plan.value.torchChannel,
    comfyRepo: plan.value.comfyRepo.trim() || DEFAULT_REPO,
    comfyBranch: plan.value.comfyBranch.trim(),
    createDesktopShortcut: plan.value.createDesktopShortcut,
    autoStart: plan.value.autoStart,
    comfySource: plan.value.comfySource || 'zip',
    skipStarter: Boolean(plan.value.skipStarter),
    ...overrides
  }
}

async function startInstall(overrides: Partial<InstallPlan>): Promise<void> {
  if (!canStartInstall.value) {
    if (hasHardPreflightFail.value) {
      message.error(t('install.preflightBlocked'))
    }
    return
  }
  const payload = buildPlan(overrides)
  installing.value = true
  try {
    await ipc('installer.start', payload)
    if (!progress.value) {
      progress.value = {
        runId: 'pending',
        step: 'bootstrap',
        status: 'running',
        steps: [],
        message: '',
        percent: 0
      }
    }
  } catch (err) {
    installing.value = false
    message.error(errText(err))
  }
}

/** Primary CTA: one-click defaults; still honors an explicit skipStarter. */
function startFullAuto(): void {
  void startInstall({
    comfySource: 'zip',
    useUv: true,
    autoStart: true,
    skipStarter: Boolean(plan.value.skipStarter),
    fullAuto: true
  })
}

function startCustom(): void {
  void startInstall({ fullAuto: false })
}

async function cancelInstall(): Promise<void> {
  try {
    await ipc('installer.cancel')
  } catch (err) {
    message.error(errText(err))
  }
}

function onProgress(p: unknown): void {
  const next = p as InstallProgress
  if (!next) return
  progress.value = next

  for (const s of next.steps) {
    if (s.status === 'failed' && !expandedLogIds.value.includes(s.id)) {
      expandedLogIds.value = [...expandedLogIds.value, s.id]
    }
  }

  if (next.status === 'done' && !next.error) {
    installing.value = false
  }
  if (next.error) {
    installing.value = false
    message.error(next.error)
  }
}

function onRuntimeProgress(p: unknown): void {
  const rp = p as RuntimeDownloadProgress
  runtimeProg.value = rp && rp.phase !== 'done' ? rp : null
}

function setLogExpanded(stepId: string, names: Array<string | number>): void {
  const open = names.includes(stepId)
  if (open && !expandedLogIds.value.includes(stepId)) {
    expandedLogIds.value = [...expandedLogIds.value, stepId]
  } else if (!open) {
    expandedLogIds.value = expandedLogIds.value.filter((x) => x !== stepId)
  }
}

function logExpandedNames(stepId: string): string[] {
  return expandedLogIds.value.includes(stepId) ? [stepId] : []
}

async function savePipIndex(v: string): Promise<void> {
  pipIndex.value = v
  try {
    await ipc('settings.set', { pipIndex: v })
  } catch (err) {
    message.error(errText(err))
  }
}

async function saveTorchIndex(v: string): Promise<void> {
  torchIndexMirror.value = v
  try {
    await ipc('settings.set', { torchIndexMirror: v })
  } catch (err) {
    message.error(errText(err))
  }
}

function findInstalledInstance() {
  // Prefer the id stamped by the installer's register step — no path guessing.
  const fromProgress = progress.value?.instanceId
  if (fromProgress) {
    const hit = store.instances.find((i) => i.id === fromProgress)
    if (hit) return hit
  }
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '')
  return (
    store.instances.find((i) => i.name === plan.value.instanceName.trim()) ||
    store.instances.find(
      (i) =>
        i.path &&
        plan.value.installRoot &&
        (norm(i.path) === norm(plan.value.installRoot) ||
          norm(i.path).startsWith(norm(plan.value.installRoot) + '/'))
    ) ||
    null
  )
}

async function launchNow(): Promise<void> {
  try {
    await store.refreshInstances()
    const inst = findInstalledInstance()
    if (inst) {
      await launch(inst, { open: 'embed' })
      return
    }
    await router.push('/instances')
  } catch (err) {
    message.error(errText(err))
  }
}

function goInstances(): void {
  void router.push('/instances')
}

async function installStarter(s: StarterModel): Promise<void> {
  if (starterBusy.value) return
  starterBusy.value = s.id
  try {
    let instanceId: string | undefined
    try {
      await store.refreshInstances()
      instanceId = findInstalledInstance()?.id
    } catch {
      /* instance lookup is best-effort */
    }
    await ipc('installer.installStarter', { id: s.id, instanceId })
    message.success(t('models.downloadStarted'))
  } catch (err) {
    message.error(errText(err))
  } finally {
    starterBusy.value = null
  }
}

const offHandlers: Array<() => void> = []

onMounted(async () => {
  offHandlers.push(onIpc(IPC_EVENTS.installProgress, onProgress))
  offHandlers.push(onIpc(IPC_EVENTS.runtimeProgress, onRuntimeProgress))

  try {
    const existing = await ipc('installer.status')
    if (existing) {
      progress.value = existing
      installing.value = existing.status === 'running' && !existing.error
      for (const s of existing.steps) {
        if (s.status === 'failed' && !expandedLogIds.value.includes(s.id)) {
          expandedLogIds.value = [...expandedLogIds.value, s.id]
        }
      }
    }
  } catch {
    /* no in-flight install */
  }

  try {
    const sug = await ipc('installer.suggestInstallRoot')
    if (sug?.path) {
      plan.value.installRoot = sug.path
      suggestFreeGb.value = sug.freeGb || 0
    }
  } catch {
    /* user can pick manually */
  }

  try {
    const settings = await ipc('settings.get')
    pipIndex.value = settings.pipIndex || ''
    torchIndexMirror.value = settings.torchIndexMirror || ''
  } catch {
    /* defaults stay empty */
  }

  // Auto-recommend mirrors when the user has not chosen any yet.
  if (!pipIndex.value) {
    void probeAndRecommendMirrors(true)
  }

  try {
    const list = await ipc('installer.starterModels')
    if (list?.length) starterModels.value = list
  } catch {
    /* fall back to bundled STARTER_MODELS */
  }

  await detectGpu()
  schedulePreflight(120)
})

const probingMirrors = ref(false)
const mirrorProbeHint = ref('')

async function probeAndRecommendMirrors(auto = false): Promise<void> {
  probingMirrors.value = true
  mirrorProbeHint.value = auto ? t('install.probeAuto') : t('install.probeManual')
  try {
    const rec = await ipc('net.recommendMirrors')
    if (rec?.pipIndex || rec?.pipLabel) {
      if (!pipIndex.value || !auto) {
        pipIndex.value = rec.pipIndex || ''
        torchIndexMirror.value = rec.torchIndexMirror || ''
        await ipc('settings.set', { pipIndex: pipIndex.value, torchIndexMirror: torchIndexMirror.value })
      }
      // rec.*Label are i18n key fragments under settings.*
      const tr = (k: string): string => {
        try {
          return k ? t(`settings.${k}`) : ''
        } catch {
          return k
        }
      }
      mirrorProbeHint.value = t('install.mirrorsRecommended', {
        pip: tr(rec.pipLabel),
        torch: tr(rec.torchLabel),
        github: tr(rec.githubLabel)
      })
    } else {
      mirrorProbeHint.value = t('install.probeNoResult')
    }
  } catch (err) {
    mirrorProbeHint.value = err instanceof Error ? err.message : String(err)
  } finally {
    probingMirrors.value = false
  }
}

onUnmounted(() => {
  for (const off of offHandlers) off()
  if (preflightTimer) clearTimeout(preflightTimer)
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ $t('install.title') }}</h1>
        <p class="page-subtitle">{{ $t('install.subtitle') }}</p>
      </div>
      <NSpace>
        <NButton secondary @click="goInstances">{{ $t('install.goInstances') }}</NButton>
      </NSpace>
    </div>

    <div class="page-body">
      <NAlert v-if="isFailed" type="error" class="mb" :title="$t('install.failedTitle')">
        {{ progress?.error }}
      </NAlert>

      <NAlert v-else-if="isDone" type="success" class="mb" :title="$t('install.doneTitle')">
        {{ $t('install.doneBody', { name: plan.instanceName || 'ComfyUI' }) }}
        <div class="done-actions">
          <NButton type="primary" @click="launchNow">
            <template #icon><NIcon :component="RocketOutline" /></template>
            {{ $t('install.launchNow') }}
          </NButton>
          <NButton secondary @click="goInstances">{{ $t('install.goInstances') }}</NButton>
        </div>
      </NAlert>

      <section class="card hero">
        <div class="hero-top">
          <div class="hero-copy">
            <div class="hero-badge">
              <NIcon :size="16" :component="HardwareChipOutline" />
              <span>{{ gpuSentence || $t('install.torchChannel') }}</span>
            </div>
            <div class="hero-title">{{ $t('install.fullAuto') }}</div>
            <div class="hero-sub">{{ $t('install.subtitle') }}</div>
            <div class="hero-disk">
              <NTag size="small" round>{{ $t('install.needDisk', { n: fmtGb(diskNeedGb) }) }}</NTag>
              <NTag size="small" round>{{ $t('install.freeDisk', { n: fmtGb(diskFreeGb) }) }}</NTag>
              <NButton size="tiny" text type="primary" @click="detectGpu">
                {{ $t('install.redetectGpu') }}
              </NButton>
            </div>
          </div>

          <div class="hero-actions">
            <button
              type="button"
              class="cta-full-auto"
              :disabled="!canStartInstall"
              @click="startFullAuto"
            >
              <NIcon :size="20" :component="RocketOutline" class="cta-icon" />
              <span>{{ $t('install.fullAuto') }}</span>
            </button>
            <div class="cta-hint">{{ $t('install.idleHint') }}</div>
          </div>
        </div>

        <NCollapse class="advanced">
          <NCollapseItem :title="$t('install.advanced')" name="advanced">
            <div class="grid advanced-grid">
              <div class="field">
                <label>{{ $t('install.installRoot') }}</label>
                <NInput v-model:value="plan.installRoot" placeholder="ComfyPilotRuntimes">
                  <template #suffix>
                    <NButton size="tiny" secondary @click="pickRoot">
                      <template #icon><NIcon :component="FolderOpenOutline" /></template>
                    </NButton>
                  </template>
                </NInput>
              </div>

              <div class="field">
                <label>{{ $t('install.instanceName') }}</label>
                <NInput v-model:value="plan.instanceName" placeholder="ComfyUI" />
              </div>

              <div class="field">
                <label>{{ $t('install.torchChannel') }}</label>
                <NSelect v-model:value="plan.torchChannel" :options="torchOptions" />
              </div>

              <div class="field">
                <label>{{ $t('install.comfySource') }}</label>
                <NRadioGroup v-model:value="plan.comfySource">
                  <NRadio value="zip">{{ $t('install.sourceZip') }}</NRadio>
                  <NRadio value="git">{{ $t('install.sourceGit') }}</NRadio>
                </NRadioGroup>
              </div>

              <template v-if="plan.comfySource === 'git'">
                <div class="field">
                  <label>{{ $t('install.repo') }}</label>
                  <NInput v-model:value="plan.comfyRepo" />
                </div>
                <div class="field">
                  <label>{{ $t('install.branch') }}</label>
                  <NInput v-model:value="plan.comfyBranch" placeholder="master" />
                </div>
              </template>

              <div class="field">
                <label>{{ $t('settings.pipIndex') }}</label>
                <NSelect
                  :value="pipIndex"
                  :options="pipIndexOptions"
                  @update:value="savePipIndex"
                />
              </div>

              <div class="field">
                <label>{{ $t('settings.torchIndex') }}</label>
                <NSelect
                  :value="torchIndexMirror"
                  :options="torchIndexOptions"
                  @update:value="saveTorchIndex"
                />
              </div>

              <div class="field">
                <NButton
                  size="small"
                  secondary
                  :loading="probingMirrors"
                  @click="probeAndRecommendMirrors(false)"
                >
                  {{ $t('install.probeMirrors') }}
                </NButton>
                <div v-if="mirrorProbeHint" class="hint">{{ mirrorProbeHint }}</div>
              </div>

              <div class="field switch-field">
                <NSwitch v-model:value="plan.useUv" />
                <span class="hint">{{ $t('install.useUv') }}</span>
              </div>

              <div class="field switch-field">
                <NSwitch v-model:value="plan.autoStart" />
                <span class="hint">{{ $t('install.autoStart') }}</span>
              </div>

              <div class="field switch-field">
                <NSwitch v-model:value="plan.createDesktopShortcut" />
                <span class="hint">{{ $t('install.shortcut') }}</span>
              </div>

              <div class="field switch-field">
                <NSwitch v-model:value="plan.skipStarter" />
                <span class="hint">{{ $t('install.skipStarter') }}</span>
              </div>
            </div>

            <NSpace class="actions">
              <NButton secondary :loading="preflighting" @click="runPreflight">
                <template #icon><NIcon :component="FlashOutline" /></template>
                {{ $t('install.preflight') }}
              </NButton>
              <NButton
                type="primary"
                :disabled="!canStartInstall"
                :loading="installingNow"
                @click="startCustom"
              >
                {{ $t('install.start') }}
              </NButton>
              <NButton v-if="installingNow" type="error" secondary @click="cancelInstall">
                {{ $t('install.cancel') }}
              </NButton>
            </NSpace>
          </NCollapseItem>
        </NCollapse>
      </section>

      <div class="grid layout">
        <section class="card panel">
          <div class="panel-title">{{ $t('install.stepPreflight') }}</div>

          <div class="disk-row">
            <NTag size="small" round>{{ $t('install.needDisk', { n: fmtGb(diskNeedGb) }) }}</NTag>
            <NTag size="small" round>{{ $t('install.freeDisk', { n: fmtGb(diskFreeGb) }) }}</NTag>
          </div>

          <div v-if="preflight" class="preflight">
            <div v-for="c in preflight.checks" :key="c.id" class="check">
              <NIcon
                :size="16"
                :component="c.ok ? CheckmarkCircleOutline : CloseCircleOutline"
                :style="{ color: severityColor(c.ok ? 'ok' : 'error') }"
              />
              <span class="check-detail">{{ detailOf(c) }}</span>
              <NButton
                v-if="c.fixId"
                size="tiny"
                secondary
                type="primary"
                :loading="fixingId === c.fixId"
                @click="applyFix(c)"
              >
                {{ fixLabelOf(c) }}
              </NButton>
            </div>

            <div v-if="runtimeProg" class="runtime-line">
              <NIcon :size="14" :component="CloudDownloadOutline" />
              <span class="mono">
                {{ bytesText(runtimeProg) }}
              </span>
              <NTag v-if="runtimeProg.message" size="tiny" round>{{ runtimeProg.message }}</NTag>
            </div>
          </div>
          <div v-else class="hint">{{ preflighting ? '' : $t('install.idleHint') }}</div>
        </section>

        <section class="card panel">
          <div class="panel-head">
            <div class="panel-title">{{ $t('install.progress') }}</div>
            <NButton
              v-if="installingNow"
              size="small"
              type="error"
              secondary
              @click="cancelInstall"
            >
              {{ $t('install.cancel') }}
            </NButton>
          </div>

          <NProgress
            type="line"
            :percentage="clampPercent(progress?.percent ?? 0)"
            indicator-placement="inside"
            :processing="progress?.status === 'running'"
            class="mb"
          />

          <div v-if="progress?.bytes" class="bytes-line">
            <NIcon :size="14" :component="DownloadOutline" />
            <span class="mono">{{ bytesText(progress.bytes) }}</span>
            <NTag v-if="progress.bytes.label" size="tiny" round>{{ progress.bytes.label }}</NTag>
          </div>

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
                  :component="
                    s.status === 'done'
                      ? CheckmarkCircleOutline
                      : s.status === 'failed'
                        ? CloseCircleOutline
                        : DownloadOutline
                  "
                />
                <b>{{ $t(stepTitleKey(s.id)) }}</b>
                <NTag size="tiny" round :type="stepStatusTag(s.status)">{{ s.status }}</NTag>
              </div>
              <div v-if="s.detail || s.detailKey" class="step-detail">{{ detailOf(s) }}</div>
              <NCollapse
                v-if="s.log.length"
                class="log-collapse"
                :expanded-names="logExpandedNames(s.id)"
                @update:expanded-names="(names: Array<string | number>) => setLogExpanded(s.id, names)"
              >
                <NCollapseItem :title="$t('install.logCount', { n: s.log.length })" :name="s.id">
                  <div v-for="(line, i) in s.log" :key="i" class="mono log-line">{{ line }}</div>
                </NCollapseItem>
              </NCollapse>
            </div>

            <div v-if="!progress" class="hint">{{ $t('install.idleHint') }}</div>
          </div>
        </section>
      </div>

      <section v-if="isDone" class="card panel starter-card">
        <div class="panel-head">
          <div class="panel-title">{{ $t('models.starterTitle') }}</div>
          <div class="hint">{{ $t('models.starterHint') }}</div>
        </div>
        <div class="starter-list">
          <div v-for="s in starterModels" :key="s.id" class="starter-row">
            <div class="starter-info">
              <div class="starter-name">
                {{ s.name }}
                <NTag v-if="s.recommended" size="tiny" type="primary" round>
                  {{ $t('models.recommended') }}
                </NTag>
                <NTag size="tiny" round>{{ s.family }}</NTag>
                <NTag size="tiny" round>{{ $t('models.approx', { size: formatBytes(s.approxBytes) }) }}</NTag>
              </div>
              <div class="starter-desc">{{ $t(s.description) }}</div>
            </div>
            <NButton
              size="small"
              type="primary"
              secondary
              :loading="starterBusy === s.id"
              @click="installStarter(s)"
            >
              {{ $t('models.downloadStarter') }}
            </NButton>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.layout {
  grid-template-columns: 1fr 1.1fr;
  align-items: start;
  margin-top: 16px;
}

.advanced-grid {
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}

.panel {
  padding: 20px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;

  .panel-title {
    margin-bottom: 0;
  }
}

.panel-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 16px;
  color: $color-text;
}

.field {
  label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    color: $color-text-secondary;
    margin-bottom: 6px;
  }
}

.switch-field {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
}

.hint {
  font-size: 12px;
  color: $color-text-muted;
}

.actions {
  margin: 16px 0 4px;
}

/* ---- hero / primary CTA ---- */
.hero {
  padding: 22px 24px;
  background: $gradient-soft;
  border: 1px solid $color-border-strong;
}

.hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
}

.hero-copy {
  min-width: 240px;
  flex: 1;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-radius: 999px;
  background: $color-bg-glass;
  border: 1px solid $color-border;
  font-size: 12px;
  font-weight: 600;
  color: $color-text-secondary;
}

.hero-title {
  margin-top: 12px;
  font-size: 22px;
  font-weight: 800;
  color: $color-text;
  letter-spacing: -0.01em;
}

.hero-sub {
  margin-top: 6px;
  font-size: 13px;
  font-weight: 400;
  color: $color-text-secondary;
}

.hero-disk {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.hero-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.cta-full-auto {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 14px 30px;
  border: none;
  border-radius: 999px;
  background: $gradient-primary;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: $shadow-glow;
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    opacity 0.18s ease;

  &:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: $shadow-lg;
  }

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    box-shadow: $shadow-sm;
  }
}

.cta-icon {
  flex-shrink: 0;
}

.cta-hint {
  font-size: 12px;
  font-weight: 400;
  color: $color-text-muted;
  max-width: 320px;
  text-align: right;
}

.advanced {
  margin-top: 18px;
}

/* ---- preflight ---- */
.disk-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.preflight {
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

.check-detail {
  flex: 1;
  min-width: 0;
  color: $color-text-secondary;
}

.runtime-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 11.5px;
  color: $color-text-secondary;
}

/* ---- progress ---- */
.bytes-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -6px 0 12px;
  font-size: 12px;
  color: $color-text-secondary;
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
  font-weight: 500;

  b {
    font-weight: 600;
    flex: 1;
    min-width: 0;
  }
}

.step-detail {
  margin: 6px 0 4px;
  font-size: 12px;
  font-weight: 400;
  color: $color-text-muted;
}

.log-line {
  font-size: 11px;
  font-weight: 400;
  color: $color-text-secondary;
  line-height: 1.5;
}

/* ---- starter models ---- */
.starter-card {
  margin-top: 16px;
}

.starter-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.starter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid $color-border;
  border-radius: 12px;
}

.starter-info {
  flex: 1;
  min-width: 0;
}

.starter-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: $color-text;
  flex-wrap: wrap;
}

.starter-desc {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 400;
  color: $color-text-muted;
}

.mb {
  margin-bottom: 16px;
}

.done-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
</style>
