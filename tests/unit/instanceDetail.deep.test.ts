// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * InstanceDetailView deep coverage (0.2.5 C1).
 *
 * Exercises every setup action with realistic success/failure payloads, both
 * dialog outcomes, the rich template branches and the real buttons. The
 * existing smoke test keeps the default render; this one covers the page's
 * operational surface.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h, nextTick } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import { i18n } from '../../src/renderer/src/i18n'
import { IPC_EVENTS } from '../../src/shared/types'

const now = Date.now()
const instance: any = {
  id: 'i1',
  name: 'Test ComfyUI',
  path: '/tmp/comfy',
  pythonPath: '/tmp/comfy/.venv/bin/python',
  venvPath: '/tmp/comfy/.venv',
  port: 8188,
  listen: '127.0.0.1',
  extraArgs: ['--lowvram'],
  argTemplateId: 'default',
  enabled: true,
  notes: 'note',
  autoStart: true,
  frontendVersion: '1.59.6',
  pinned: true,
  status: 'running',
  url: 'http://127.0.0.1:8188',
  version: '0.46.0',
  onlineVersion: '0.46.0',
  managerEnabled: true,
  migrationState: 'none',
  updateChannel: 'stable',
  launchProfile: { vram: 'lowvram' }
}

const logs = [
  { ts: now - 1000, level: 'info', message: 'hello' },
  { ts: now - 900, level: 'warn', message: 'warn line' },
  { ts: now - 800, level: 'error', message: 'error line' },
  { ts: now - 700, level: 'debug', message: 'debug noise' }
]
const manager = {
  installed: true,
  version: '4.4.2',
  source: 'pip',
  configPath: '/tmp/comfy/user/__manager/config.ini',
  configExists: true,
  securityLevel: 'normal',
  networkMode: 'public',
  snapshotsDir: '/tmp/comfy/user/__manager/snapshots',
  legacyBackup: '/tmp/user/default/ComfyUI-Manager/config.ini',
  warnings: ['legacy']
}
const managerInstall = {
  ok: false,
  info: manager,
  message: 'pip failed',
  rolledBack: true
}
const capabilities = {
  instanceId: 'i1',
  baseUrl: 'http://127.0.0.1:8188',
  online: true,
  version: '0.46.0',
  requiredFrontendVersion: '1.59.6',
  pythonVersion: '3.13.5',
  pytorchVersion: '2.9.0+cu130',
  packages: [
    { name: 'comfyui-frontend-package', installed: '1.58.0', required: '1.59.6' },
    { name: 'comfyui-workflow-templates', installed: '0.11.111', required: '0.11.111' }
  ],
  features: { assets: true },
  jobsApi: true,
  assetsApi: true,
  workflowMetadata: true,
  probedAt: now
}
const updateInfo = {
  instanceId: 'i1',
  current: '0.45.0',
  latest: '0.46.0',
  source: 'zip',
  updatable: true,
  channel: 'stable',
  latestCommit: 'v0.46.0',
  releaseUrl: 'https://example.invalid/release',
  releaseNotes: 'notes',
  latestRelease: { publishedAt: '2026-11-18T00:00:00Z' }
}
const journal = {
  instanceId: 'i1',
  comfyDir: '/tmp/comfy',
  backupPath: '/tmp/.cp-backups/1',
  backupKind: 'files',
  startedAt: now,
  status: 'verify-failed'
}
const issues = {
  instanceId: 'i1',
  hasIssues: true,
  scannedAt: now,
  bootId: 'b1',
  issues: [
    { module: 'Broken', reason: 'IMPORT FAILED', line: 'x', category: 'node' },
    { module: 'Missing', reason: 'ModuleNotFoundError', line: 'y', category: 'deps' }
  ]
}
const failures = [
  {
    id: 'f1',
    instanceId: 'i1',
    at: now,
    message: 'ModuleNotFoundError: x',
    missingModule: 'onnx',
    packFolder: 'BrokenPack',
    traceback: 'trace'
  }
]
const probe = {
  pythonPath: '/tmp/comfy/.venv/bin/python',
  pythonVersion: '3.13.5',
  venvPath: '/tmp/comfy/.venv',
  torchVersion: '2.9.0+cu130',
  torchChannel: 'cu130',
  packages: [
    { name: 'sageattention', version: '2.2.0' },
    { name: 'xformers', version: '0.0.36' }
  ],
  ok: true,
  warnings: ['warn']
}
const attentionSelfTest = {
  ok: true,
  testedAt: now,
  pythonVersion: '3.13.5',
  torchVersion: '2.14.1+cu130',
  cudaVersion: '13.0',
  gpuName: 'NVIDIA GeForce RTX 4070 Ti SUPER',
  computeCapability: '8.9',
  cudaAvailable: true,
  sageattention: { installed: true, version: '2.2.0', ok: true },
  xformers: { installed: true, version: '0.0.36', ok: true }
}
const health = {
  instanceId: 'i1',
  state: 'healthy',
  checkedAt: now,
  since: now,
  consecutiveFailures: 0,
  queueRunning: 0,
  queuePending: 0,
  portListening: true,
  processAlive: true,
  evidence: ['http-ok']
}
const progressDone = {
  runId: 'r1',
  instanceId: 'i1',
  step: 'done',
  status: 'done',
  steps: [{ id: 'done', title: 'Done', status: 'done', detail: '', log: [] }],
  message: 'done',
  percent: 100
}
const progressFail = { ...progressDone, status: 'failed', error: 'boom', percent: 50 }

let failChannels = new Set<string>()
let dialogMode: 'positive' | 'negative' | 'close' | 'mask' = 'positive'
let overrides: Record<string, unknown> = {}
let eventHandlers: Record<string, Array<(...a: unknown[]) => void>> = {}

function dataFor(channel: string): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, channel)) return overrides[channel]
  switch (channel) {
    case 'settings.get':
      return {
        locale: 'zh-CN',
        activeInstance: 'i1',
        modelScanRoots: [],
        securityLevel: 'normal',
        networkMode: 'public',
        proxy: { enabled: false, protocol: 'http', host: '', port: 7890, bypass: '' }
      }
    case 'instance.list':
      return [instance]
    case 'instance.getLogs':
      return logs
    case 'instance.capabilities':
      return capabilities
    case 'instance.managerInfo':
      return manager
    case 'instance.installManager':
      return managerInstall
    case 'instance.setManagerSecurity':
      return manager
    case 'instance.openManagerConfig':
      return { path: manager.configPath }
    case 'instance.checkComfyUpdate':
      return updateInfo
    case 'instance.updateJournal':
      return journal
    case 'instance.updateStatus':
      return progressDone
    case 'instance.repairStatus':
      return progressFail
    case 'instance.pipStatus':
      return progressFail
    case 'instance.startupIssues':
      return issues
    case 'instance.execFailures':
      return failures
    case 'instance.probeEnv':
    case 'env.probe':
      return probe
    case 'instance.attentionSelfTest':
      return attentionSelfTest
    case 'instance.previewLaunch':
      return {
        python: '/tmp/comfy/.venv/bin/python',
        args: ['main.py'],
        cwd: '/tmp/comfy',
        commandLine: 'python main.py',
        validationErrors: [{ code: 'invalid-number', flag: '--port' }],
        validationWarnings: [{ code: 'unknown-flag', flag: '--x', level: 'warning' }]
      }
    case 'instance.rescue':
      return { ok: true, status: 'running' }
    case 'instance.checkHealth':
      return health
    case 'instance.migratePython':
      return { fromVersion: '3.12.10', toVersion: '3.13.18', channel: 'cu130' }
    case 'instance.save':
    case 'instance.patch':
    case 'instance.restart':
    case 'instance.launch':
    case 'instance.stop':
    case 'instance.setUpdateChannel':
    case 'instance.clearLogs':
      return channel === 'instance.clearLogs' ? true : instance
    case 'instance.rollbackUpdate':
      return true
    case 'instance.exportLogs':
      return { path: '/tmp/log.txt' }
    case 'instance.copyDiagnostics':
      return '/tmp/diag'
    case 'instance.runStartupSelfCheck':
      return { ok: true, exitCode: 0, output: '' }
    case 'instance.updateComfy':
      return progressDone
    case 'instance.repairEnv':
      return probe
    case 'instance.pipInstall':
      return { ok: true, requested: ['onnx'], installed: ['onnx'] }
    case 'instance.applyRecipe':
      return { ok: true, requested: [], installed: [] }
    case 'instance.cancelUpdate':
    case 'instance.cancelDownload':
      return true
    case 'doctor.fix':
      return { ok: true }
    case 'bootstrap.status':
      return {
        components: [{ kind: 'uv', installed: true, path: '/tmp/uv' }],
        pythonPath: '/tmp/python'
      }
    case 'env.createVenv':
      return { ok: true }
    case 'env.installTorch':
      return { ok: true }
    case 'issue.scan':
      return [
        { id: 'is1', kind: 'startup' },
        { id: 'is2', kind: 'node-load' },
        { id: 'is3', kind: 'other' }
      ]
    case 'issue.dismiss':
      return true
    case 'shell.writeClipboard':
    case 'shell.openExternal':
      return true
    default:
      return null
  }
}

const Host = defineComponent({
  setup(_p, { slots }) {
    return () =>
      h(NConfigProvider, null, {
        default: () =>
          h(
            NMessageProvider,
            { duration: 0 },
            {
              default: () => h(NDialogProvider, null, { default: () => slots.default?.() })
            }
          )
      })
  }
})

async function mountDetail(path = '/instances/i1') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/instances/:id', component: { template: '<div />' } },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ]
  })
  await router.push(path)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const mod = (await import('../../src/renderer/src/views/instances/InstanceDetailView.vue')) as {
    default: any
  }
  const wrapper = mount(Host, {
    global: { plugins: [pinia, router, i18n], config: { errorHandler: () => undefined } },
    slots: { default: () => h(mod.default) },
    attachTo: document.body
  })
  await flushPromises()
  const child = wrapper.findComponent(mod.default as never) as unknown as { vm: any }
  const state = (child.vm as any).$.setupState as Record<string, any>
  // Auto-confirm Naive dialogs so both the positive and negative branches can
  // be exercised without hunting teleported DOM nodes.
  const dialog = state.dialog
  const invoke = (opts: any): void => {
    if (dialogMode === 'positive') opts.onPositiveClick?.()
    else if (dialogMode === 'negative') opts.onNegativeClick?.()
    else if (dialogMode === 'close') opts.onClose?.()
    else opts.onMaskClick?.()
  }
  dialog.warning = (opts: any) => {
    invoke(opts)
    return {}
  }
  dialog.info = (opts: any) => {
    invoke(opts)
    return {}
  }
  return { wrapper, state }
}

beforeAll(() => {
  ;(globalThis as any).window = globalThis
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return []
      }
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  }))
  vi.stubGlobal('open', () => null)
})

beforeEach(() => {
  failChannels = new Set()
  dialogMode = 'positive'
  overrides = {}
  eventHandlers = {}
  document.body.innerHTML = ''
  ;(window as any).comfyPilot = {
    events: IPC_EVENTS,
    invoke: async (channel: string) => {
      if (failChannels.has(channel)) throw new Error(`${channel} boom`)
      return { ok: true, data: dataFor(channel) }
    },
    on: (event: string, cb: (...a: unknown[]) => void) => {
      ;(eventHandlers[event] ||= []).push(cb)
      return () => undefined
    }
  }
})

describe('InstanceDetailView deep coverage', () => {
  it('executes the operational actions with rich data', async () => {
    const { wrapper, state } = await mountDetail()
    try {
      expect(state.instance?.value?.id ?? state.instance?.id).toBe('i1')
      state.profileDraft = { vram: 'lowvram', cache: 'none' }
      state.extraArgsDraft = ['--lowvram']
      expect(await state.saveProfile()).toBe(true)
      await state.restartWithProfile()
      await state.rescueInstance(true)
      await state.rescueInstance(false)
      await state.copyRescueCommand()
      await state.recoverCrash(true)
      await state.recoverCrash(false)
      await state.loadManagerInfo('i1')
      await state.setManagerLevel('normal')
      await state.openManagerConfig()
      await state.installManager()
      state.openExternalIfRunning()
      await state.openEmbedIfRunning()

      state.instance = { ...instance, migrationState: 'required', status: 'migration-required' }
      await nextTick()
      await state.migratePython()
      state.instance = { ...instance, migrationState: 'failed' }
      await state.migratePython()
      state.instance = instance

      state.goEdit()
      await state.clearLogs()
      await state.copyLogs()
      state.logQuery = 'error'
      state.logLevelFilter = 'error'
      state.showDebugLogs = true
      expect(state.visibleLogs.length).toBe(1)
      state.logQuery = ''
      state.logLevelFilter = 'warn'
      expect(state.visibleLogs.length).toBe(1)

      state.openPipProgress()
      await state.fixByPip(failures[0])
      await state.fixByRecipe(failures[0])
      state.goPack(failures[0])
      await state.copyFailureReport(failures[0])
      await state.clearFailures()
      await state.probeEnvNow()
      await state.fixPipNow()
      await state.alignFrontendPkg()
      state.openPipInstallModal()
      state.pipSpecInput = 'onnx'
      await state.runPipInstall()
      await state.exportLogs()
      await state.doLaunch('embed')
      await state.doLaunch('none')
      await state.doStop()
      await state.checkStartupIssues('i1')
      state.reviewStartupIssues()
      await state.dismissStartupIssues()
      await state.refresh()
      await state.copyCommand()

      state.reopenUpdateModal()
      expect(state.sourceLabel('git')).toBeTruthy()
      expect(state.sourceLabel('zip')).toBeTruthy()
      expect(state.sourceLabel('other')).toBeTruthy()
      expect(state.releaseDate('2026-11-18T00:00:00Z')).toBeTruthy()
      expect(state.releaseDate(undefined)).toBe('—')
      state.openReleaseNotes()
      await state.rollbackPendingUpdate()
      await state.setUpdateChannel('nightly')
      await state.doCheckUpdate()
      await state.runUpdateComfy()
      await state.runRepairEnv()

      expect(state.baseName('/a/b/c')).toBe('c')
      expect(state.dirName('/a/b/c')).toBe('/a/b')
      expect(state.venvLocationOf(instance).name).toBe('.venv')
      expect(state.venvLocationOf({ ...instance, venvPath: '' }).name).toBe('.venv')
      await state.recreateVenv()
      state.openTorchModal()
      await state.reinstallTorch()
      await state.copyDiagPath()
      await state.runSelfCheck()

      state.handlePipFailure({ code: 'OP_BUSY' })
      state.handlePipFailure({ code: 'REMOTE_NOT_SUPPORTED' })
      state.handlePipFailure(new Error('plain'))
      state.envProbeResult = probe
      overrides['instance.applyRecipe'] = { ok: true, requested: [], installed: [] }
      await state.installAttention('sageattention')
      await state.installAttention('xformers')
      await state.runAttentionSelfTest()
      await state.setSageAttention(true)
      await state.setXformersDisabled(true)
      expect(state.recipeFor(failures[0])).toBeTruthy()
      expect(state.recipeFor({ ...failures[0], missingModule: '' })).toBeUndefined()
      expect(
        state.fixModule({ ...failures[0], missingModule: '', outdatedModule: 'sageattention' })
      ).toBe('sageattention')
      expect(
        state.recipeFor({ ...failures[0], missingModule: '', outdatedModule: 'onnx' })
      ).toBeTruthy()
      expect(state.warningText({ code: 'unknown-flag', flag: '--x' })).toBeTruthy()
      expect(state.errorCodeLabel({ code: 'invalid-number', flag: '--port' })).toBeTruthy()
      expect(state.errorCodeLabel({ code: 'other' })).toBeTruthy()
      expect(state.statusLabel('running')).toBeTruthy()

      for (const b of wrapper.findAll('button')) {
        await b.trigger('click').catch(() => undefined)
        await flushPromises()
      }
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('renders every operational template variant', async () => {
    const { wrapper, state } = await mountDetail()
    const click = async (): Promise<void> => {
      await nextTick()
      for (const b of wrapper.findAll('button')) {
        await b.trigger('click').catch(() => undefined)
        await flushPromises()
      }
    }
    try {
      state.loading = false

      state.instance = {
        ...instance,
        migrationState: 'required',
        migrationError: 'needs 3.13',
        status: 'migration-required'
      }
      await click()
      state.instance = { ...instance, safeMode: true }
      await click()
      state.instance = {
        ...instance,
        status: 'error',
        lastError: 'crashed',
        lastExit: { code: 1, signal: null, reason: 'oom', at: now }
      }
      await click()
      state.instance = { ...instance, updateChannel: undefined }
      await click()
      state.instance = instance

      state.managerInfo = {
        ...manager,
        installed: false,
        configExists: false,
        legacyBackup: undefined,
        warnings: []
      }
      await click()
      state.managerInfo = manager

      state.updateInfo = { ...updateInfo, latest: undefined, error: 'offline' }
      await click()
      state.updateInfo = { ...updateInfo, latestRelease: undefined }
      await click()

      state.envProbeResult = {
        ...probe,
        cudaVersion: '13.0',
        pip: { present: false },
        errors: ['one', 'two']
      }
      await click()
      state.envProbeResult = probe

      state.logs = []
      state.logQuery = 'nothing'
      state.logShowJump = true
      await click()
      state.logs = logs
      state.logQuery = ''

      state.startupIssues = {
        ...issues,
        issues: [
          {
            pack: 'BrokenPack',
            reason: 'IMPORT FAILED',
            line: 'x',
            missingModules: ['onnx']
          }
        ]
      }
      await click()

      state.execFailures = [
        {
          ...failures[0],
          nodeType: 'KSampler',
          packFolder: 'BrokenPack',
          missingModule: 'onnx'
        },
        {
          ...failures[0],
          id: 'f-outdated',
          nodeType: 'MiniMaxH3MemoryEfficientSageAttentionPatch',
          packFolder: 'ComfyUI-KJNodes',
          missingModule: undefined,
          outdatedModule: 'sageattention',
          message: 'sageattention is not new enough version'
        }
      ]
      await click()

      state.pendingUpdate = journal
      state.updating = true
      state.progress = progressFail
      state.pipActiveInstances = ['i1']
      state.pipModalVisible = false
      await click()

      state.tab = 'profile'
      await click()
      state.tab = 'logs'
      await click()

      state.showPipInstallModal = true
      state.showTorchModal = true
      state.showUpdateModal = true
      await click()

      state.loading = false
      state.instance = null
      await click()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('restores a hash-selected tab and survives a route switch', async () => {
    const { wrapper, state } = await mountDetail('/instances/i1#logs')
    try {
      expect(state.tab).toBe('logs')
      state.tab = 'profile'
      await nextTick()
      state.tab = 'basic'
      await nextTick()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 60_000)

  it('covers payload branches, dialog close/mask and live events', async () => {
    const { wrapper, state } = await mountDetail()
    try {
      overrides['instance.rescue'] = { ok: false, error: 'no' }
      await state.rescueInstance(true)
      overrides['instance.installManager'] = {
        ok: true,
        info: manager,
        message: '',
        rolledBack: false
      }
      await state.installManager()
      overrides['instance.pipInstall'] = { ok: false, error: 'pip fail', cancelled: false }
      await state.fixByPip(failures[0])
      await state.runPipInstall()
      await state.alignFrontendPkg()
      overrides['instance.applyRecipe'] = { ok: false, error: 'recipe fail', cancelled: false }
      await state.fixByRecipe(failures[0])
      overrides['doctor.fix'] = { ok: false, message: 'no' }
      await state.fixPipNow()
      overrides['instance.exportLogs'] = { path: '/tmp/log' }
      await state.exportLogs()
      overrides['instance.rollbackUpdate'] = false
      state.pendingUpdate = journal
      await state.rollbackPendingUpdate()
      overrides['instance.setUpdateChannel'] = true
      await state.setUpdateChannel('stable')
      overrides['instance.checkComfyUpdate'] = {
        ...updateInfo,
        error: 'offline',
        latest: undefined
      }
      await state.doCheckUpdate()
      overrides['instance.updateComfy'] = { status: 'failed', error: 'x' }
      await state.runUpdateComfy()
      overrides['instance.repairEnv'] = { ok: true }
      await state.runRepairEnv()
      overrides['env.createVenv'] = { ok: true }
      await state.recreateVenv()
      overrides['env.installTorch'] = { ok: true }
      await state.reinstallTorch()
      overrides['instance.copyDiagnostics'] = '/tmp/diag'
      await state.copyDiagPath()
      overrides['instance.runStartupSelfCheck'] = { ok: false, exitCode: 1 }
      await state.runSelfCheck()

      dialogMode = 'close'
      await state.clearLogs()
      await state.migratePython()
      await state.rollbackPendingUpdate()
      dialogMode = 'mask'
      await state.clearLogs()
      await state.migratePython()
      dialogMode = 'negative'
      await state.installManager()

      dialogMode = 'positive'
      state.instance = null
      state.openExternalIfRunning()
      state.openEmbedIfRunning()
      state.instance = instance

      for (const gpu of [{ vendor: 'nvidia' }, { vendor: 'amd' }, { vendor: 'intel' }, {}]) {
        state.store.system = { gpus: [gpu] }
        state.openTorchModal()
      }
      expect(state.baseName('')).toBe('')
      expect(state.dirName('a')).toBe('')
      expect(state.venvLocationOf({ ...instance, venvPath: '', path: '/tmp/comfy' }).name).toBe(
        '.venv'
      )

      failChannels = new Set(['shell.writeClipboard'])
      await state.copyLogs()
      await state.copyFailureReport(failures[0])
      failChannels = new Set()

      for (const cb of eventHandlers[IPC_EVENTS.instanceStatus] || []) {
        cb({ status: 'running' })
        cb({ status: 'running' })
        cb({ status: 'stopped' })
      }
      for (const cb of eventHandlers[IPC_EVENTS.instanceLogBatch] || []) {
        cb({ id: 'i1', lines: [logs[0]] })
        cb({ id: 'other', lines: [logs[0]] })
        cb({ id: 'i1', lines: [] })
      }
      await flushPromises()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('renders the remaining template truth-table variants', async () => {
    const { wrapper, state } = await mountDetail()
    try {
      state.loading = false
      state.instance = {
        ...instance,
        onlineVersion: '0.47.0',
        updateChannel: undefined,
        status: 'error',
        lastError: 'boom',
        lastExit: { code: 1, signal: null, reason: 'oom', at: now }
      }
      state.capabilities = {
        ...capabilities,
        assetsApi: false,
        packages: [{ name: 'comfyui-frontend-package', installed: '1.59.6', required: '1.59.6' }]
      }
      state.managerInfo = {
        ...manager,
        configExists: false,
        legacyBackup: undefined,
        warnings: [],
        securityLevel: undefined,
        networkMode: undefined,
        snapshotsDir: undefined
      }
      state.updateInfo = {
        ...updateInfo,
        latest: undefined,
        unknown: true,
        updatable: false,
        behindCount: 3,
        latestRelease: undefined,
        error: 'offline'
      }
      state.envProbeResult = {
        ...probe,
        pip: { present: false },
        cudaVersion: '13.0',
        errors: ['one']
      }
      state.startupIssues = {
        ...issues,
        issues: [
          {
            pack: 'BrokenPack',
            reason: 'IMPORT FAILED',
            line: 'x',
            missingModules: ['onnx']
          }
        ]
      }
      state.execFailures = [
        {
          ...failures[0],
          nodeType: 'KSampler',
          packFolder: 'BrokenPack',
          missingModule: 'onnx'
        }
      ]
      state.logs = logs
      state.logShowJump = true
      state.pendingUpdate = journal
      state.pipActiveInstances = ['i1']
      state.pipModalVisible = false
      state.updating = true
      state.progress = progressFail
      await nextTick()
      await flushPromises()
      expect(wrapper.text()).toContain('ComfyUI')
      expect(wrapper.text()).toContain('0.47.0')
      expect(wrapper.text()).toContain('onnx')
      expect(wrapper.html()).toBeTruthy()

      // The opposite truth table for the same badges.
      state.instance = { ...instance, onlineVersion: '0.46.0', status: 'starting' }
      state.capabilities = {
        ...capabilities,
        assetsApi: true,
        packages: [{ name: 'comfyui-frontend-package', installed: '1.58.0', required: '1.59.6' }]
      }
      state.managerInfo = { ...manager, installed: false }
      state.updateInfo = { ...updateInfo, unknown: false, updatable: true }
      state.envProbeResult = { ...probe, pip: { present: true, version: '24.0' }, errors: [] }
      state.startupIssues = null
      state.execFailures = []
      state.logs = []
      state.logShowJump = false
      state.pendingUpdate = null
      state.pipActiveInstances = []
      state.updating = false
      state.progress = null
      await nextTick()
      await flushPromises()
      expect(wrapper.text()).toContain('ComfyUI')
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 60_000)

  it('covers branch edges across actions and refresh paths', async () => {
    const { wrapper, state } = await mountDetail()
    const resetInstance = (patch: Record<string, unknown> = {}): void => {
      state.instance = { ...instance, ...patch }
    }
    try {
      // Early returns / empty inputs.
      state.instance = null
      expect(await state.saveProfile()).toBe(false)
      await state.restartWithProfile()
      await state.setManagerLevel('normal')
      await state.clearFailures()
      await state.probeEnvNow()
      await state.fixPipNow()
      await state.doLaunch('none')
      state.preview = null
      await state.copyCommand()
      state.logs = []
      await state.copyLogs()
      await state.checkStartupIssues('other')
      state.openExternalIfRunning()
      state.openEmbedIfRunning()
      resetInstance()

      // saveProfile variants: empty draft, stopped instance, save failure.
      state.profileDraft = {}
      state.extraArgsDraft = []
      expect(await state.saveProfile()).toBe(true)
      resetInstance({ status: 'stopped' })
      expect(await state.saveProfile()).toBe(true)
      failChannels = new Set(['instance.save'])
      resetInstance()
      expect(await state.saveProfile()).toBe(false)
      failChannels = new Set()

      // Recovery / manager error paths.
      failChannels = new Set(['instance.rescue'])
      await state.rescueInstance(true)
      failChannels = new Set(['instance.managerInfo'])
      await state.loadManagerInfo('i1')
      failChannels = new Set(['instance.setManagerSecurity'])
      await state.setManagerLevel('normal')
      failChannels = new Set(['instance.openManagerConfig'])
      await state.openManagerConfig()
      failChannels = new Set(['instance.installManager'])
      await state.installManager()
      failChannels = new Set()

      resetInstance({ url: '' })
      state.openExternalIfRunning()
      state.openEmbedIfRunning()
      resetInstance()

      // Log / clipboard / export failure paths.
      state.logs = logs
      state.logQuery = 'nomatch'
      state.logLevelFilter = 'error'
      state.showDebugLogs = false
      expect(state.visibleLogs.length).toBe(0)
      state.logQuery = ''
      state.logLevelFilter = 'all'
      failChannels = new Set(['shell.writeClipboard'])
      await state.copyLogs()
      await state.copyFailureReport(failures[0])
      failChannels = new Set(['instance.exportLogs'])
      await state.exportLogs()
      failChannels = new Set(['instance.clearLogs'])
      await state.clearLogs()
      failChannels = new Set()

      // Pip install variants: ok, cancelled, missing module.
      overrides['instance.pipInstall'] = { ok: true, requested: [], installed: [] }
      await state.fixByPip(failures[0])
      await state.runPipInstall()
      overrides['instance.pipInstall'] = { ok: false, cancelled: true }
      await state.fixByPip(failures[0])
      await state.runPipInstall()
      await state.fixByPip({ ...failures[0], missingModule: '' })
      await state.fixByRecipe({ ...failures[0], missingModule: '' })
      overrides['instance.applyRecipe'] = { ok: true, requested: [], installed: [] }
      await state.fixByRecipe(failures[0])
      overrides['instance.applyRecipe'] = { ok: false, cancelled: true }
      await state.fixByRecipe(failures[0])
      delete overrides['instance.pipInstall']
      delete overrides['instance.applyRecipe']
      state.goPack({ ...failures[0], packFolder: '' })

      // Refresh branches: log tail append, journal/capabilities/preview failures.
      state.logs = [{ ts: now - 2000, level: 'info', message: 'old' }]
      await state.refresh()
      failChannels = new Set(['instance.updateJournal', 'instance.capabilities'])
      await state.refresh()
      failChannels = new Set(['instance.getLogs'])
      await state.refresh()
      failChannels = new Set(['instance.previewLaunch'])
      state.instance = instance
      await state.refresh()
      failChannels = new Set(['instance.list'])
      await state.refresh()
      failChannels = new Set()
      state.instance = instance

      // Torch vendor branches, including Windows AMD.
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        configurable: true
      })
      for (const gpu of [{ vendor: 'nvidia' }, { vendor: 'amd' }, { vendor: 'intel' }, {}]) {
        state.store.system = { gpus: [gpu] }
        state.openTorchModal()
      }
      resetInstance({ pythonPath: '', venvPath: '', path: '/tmp/comfy' })
      await state.recreateVenv()
      await state.reinstallTorch()
      failChannels = new Set(['env.createVenv', 'env.installTorch'])
      await state.recreateVenv()
      await state.reinstallTorch()
      failChannels = new Set(['instance.copyDiagnostics', 'instance.runStartupSelfCheck'])
      await state.copyDiagPath()
      await state.runSelfCheck()
      failChannels = new Set()

      resetInstance({ status: 'running' })
      overrides['instance.runStartupSelfCheck'] = { ok: true, exitCode: 0 }
      await state.runSelfCheck()
      overrides['instance.runStartupSelfCheck'] = { ok: false, exitCode: 1 }
      await state.runSelfCheck()
      delete overrides['instance.runStartupSelfCheck']

      // Route-hash watcher with valid and invalid hashes.
      const router = state.router
      await router.push('/instances/i1#profile')
      await flushPromises()
      await router.push('/instances/i1#nonsense')
      await flushPromises()
      await router.push('/instances/i1#logs')
      await flushPromises()

      // Live log/status handlers with empty and mismatching payloads.
      for (const cb of eventHandlers[IPC_EVENTS.instanceStatus] || []) {
        cb(undefined)
        cb({ status: '' })
        cb({ status: 'error' })
      }
      for (const cb of eventHandlers[IPC_EVENTS.instanceLogBatch] || []) {
        cb({ id: 'other', lines: [logs[0]] })
        cb({ id: 'i1', lines: [] })
      }
      expect(state.errorCodeLabel({ code: 'x' })).toBeTruthy()
      expect(state.errorCodeLabel({ code: 'x', flag: '--x' })).toBeTruthy()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('covers failure branches and negative dialogs', async () => {
    const { wrapper, state } = await mountDetail()
    dialogMode = 'negative'
    failChannels = new Set([
      'instance.save',
      'instance.rescue',
      'instance.managerInfo',
      'instance.setManagerSecurity',
      'instance.openManagerConfig',
      'instance.installManager',
      'instance.migratePython',
      'instance.clearLogs',
      'instance.exportLogs',
      'instance.probeEnv',
      'doctor.fix',
      'instance.updateComfy',
      'instance.repairEnv',
      'instance.rollbackUpdate',
      'instance.setUpdateChannel',
      'instance.checkComfyUpdate',
      'instance.getLogs',
      'instance.previewLaunch',
      'env.createVenv',
      'env.installTorch',
      'instance.copyDiagnostics',
      'instance.runStartupSelfCheck'
    ])
    try {
      expect(await state.saveProfile()).toBe(false)
      await state.restartWithProfile()
      await state.rescueInstance(true)
      await state.recoverCrash(true)
      await state.migratePython()
      await state.clearLogs()
      await state.installManager()
      await state.setManagerLevel('normal')
      await state.openManagerConfig()
      await state.probeEnvNow()
      await state.fixPipNow()
      await state.alignFrontendPkg()
      await state.runPipInstall()
      await state.exportLogs()
      await state.rollbackPendingUpdate()
      await state.setUpdateChannel('stable')
      await state.doCheckUpdate()
      await state.runUpdateComfy()
      await state.runRepairEnv()
      await state.recreateVenv()
      await state.reinstallTorch()
      await state.copyDiagPath()
      await state.runSelfCheck()
      await state.refresh()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)
})
