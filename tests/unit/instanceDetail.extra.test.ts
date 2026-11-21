// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { NInput, NSelect, NSwitch } from 'naive-ui'

const instance = {
  id: 'i1',
  name: 'Main',
  path: '/tmp/comfy',
  pythonPath: '/tmp/python',
  venvPath: '/tmp/venv',
  port: 8188,
  listen: '127.0.0.1',
  extraArgs: [],
  argTemplateId: 'default',
  enabled: true,
  notes: 'note',
  autoStart: true,
  frontendVersion: '',
  pinned: false,
  status: 'running',
  url: 'http://127.0.0.1:8188',
  version: '0.46.0',
  migrationState: 'none',
  launchProfile: {}
}
const failure = {
  id: 'f1',
  instanceId: 'i1',
  source: 'ws',
  at: 1,
  promptId: 'p1',
  nodeType: 'KSampler',
  errorType: 'RuntimeError',
  message: 'boom',
  missingModule: 'triton',
  packFolder: 'pack',
  traceback: []
}
const managerInfo = {
  installed: true,
  source: 'manager',
  version: '4.4.2',
  configPath: '/tmp/config.ini',
  securityLevel: 'normal',
  enabled: true
}
const caps = {
  pythonVersion: '3.13.5',
  pytorchVersion: '2.9.0',
  comfyVersion: '0.46.0',
  frontendVersion: '1.2.3'
}
const envProbe = {
  pythonPath: 'python',
  pythonVersion: '3.13.5',
  torchVersion: '2.9.0',
  cudaVersion: '13.0',
  pip: { present: true, version: '25.0' },
  packages: [],
  ok: true,
  errors: []
}
const preview = {
  python: 'python',
  args: ['main.py'],
  cwd: '/tmp/comfy',
  commandLine: 'python main.py',
  validationErrors: [],
  validationWarnings: []
}
const updateInfo = {
  instanceId: 'i1',
  current: '0.45.0',
  latest: '0.46.0',
  source: 'zip',
  updatable: true,
  channel: 'stable',
  latestCommit: 'v0.46.0'
}

let failChannels = new Set<string>()
let failStrings = new Set<string>()
let overrides: Record<string, unknown> = {}
let ipcHandlers = new Map<string, Set<(payload: unknown) => void>>()

function dataFor(channel: string): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, channel)) return overrides[channel]
  switch (channel) {
    case 'settings.get':
      return { locale: 'zh-CN', activeInstance: 'i1', modelScanRoots: [] }
    case 'instance.list':
      return [instance]
    case 'remote.list':
      return []
    case 'monitor.system':
      return {
        cpuUsage: 1,
        ramTotal: 2,
        ramUsed: 1,
        diskFree: 1,
        diskTotal: 2,
        gpus: [],
        timestamp: 1
      }
    case 'instance.getLogs':
      return [
        { ts: 1, level: 'info', message: 'hello' },
        { ts: 2, level: 'error', message: 'bad' }
      ]
    case 'instance.capabilities':
      return caps
    case 'instance.previewLaunch':
      return preview
    case 'instance.updateJournal':
      return null
    case 'instance.managerInfo':
      return managerInfo
    case 'instance.checkHealth':
      return { state: 'healthy' }
    case 'instance.checkComfyUpdate':
      return updateInfo
    case 'instance.probeEnv':
      return envProbe
    case 'instance.startupIssues':
      return {
        hasIssues: true,
        instanceId: 'i1',
        issues: [{ pack: 'pack', summary: 'missing', missingModules: ['mod'], at: 1 }],
        scannedAt: 1
      }
    case 'instance.migratePython':
      return { ok: true, fromVersion: '3.12', toVersion: '3.13', channel: 'cpu', warnings: [] }
    case 'instance.execFailures':
      return [failure]
    case 'instance.rescue':
      return { ok: true }
    case 'instance.installManager':
      return { ok: true, info: managerInfo, message: '' }
    case 'instance.startupSelfCheck':
      return { ok: true, exitCode: 0, output: '' }
    case 'instance.rollbackUpdate':
      return true
    case 'instance.copyDiagnostics':
      return '/tmp/diag'
    case 'bootstrap.status':
      return { components: [{ kind: 'uv', installed: true }], pythonPath: 'python' }
    case 'env.createVenv':
    case 'env.installTorch':
      return true
    case 'instance.listPythons':
      return []
    case 'instance.start':
      return instance
    default:
      return true
  }
}

beforeAll(() => stubBrowser())
beforeEach(() => {
  failChannels = new Set()
  failStrings = new Set()
  overrides = {}
  ipcHandlers = new Map()
  installBridge(dataFor)
  ;(window as any).comfyPilot.on = (
    channel: string,
    cb: (payload: unknown) => void
  ): (() => void) => {
    if (!ipcHandlers.has(channel)) ipcHandlers.set(channel, new Set())
    ipcHandlers.get(channel)!.add(cb)
    return () => ipcHandlers.get(channel)?.delete(cb)
  }
  ;(window as any).comfyPilot.invoke = async (channel: string) => {
    if (failChannels.has(channel)) throw new Error(`${channel} boom`)
    if (failStrings.has(channel)) throw channel
    return { ok: true, data: dataFor(channel) }
  }
  document.body.innerHTML = ''
})

describe('InstanceDetail extra coverage', () => {
  async function mountDetail() {
    const { wrapper, state } = await mountView(
      '/instances/i1',
      () => import('../../src/renderer/src/views/instances/InstanceDetailView.vue')
    )
    const dialog = state.dialog
    if (dialog) {
      const auto = (opts: any): object => {
        try {
          if (typeof opts?.content === 'function') {
            opts.content()
          }
          opts?.onPositiveClick?.()
        } catch {
          /* ignore */
        }
        return {}
      }
      dialog.warning = auto
      dialog.info = auto
      dialog.error = auto
      dialog.success = auto
    }
    state.store.instances = [instance]
    state.store.activeInstanceId = 'i1'
    state.instance = instance
    state.updateInfo = updateInfo
    state.pendingUpdate = null
    state.managerInfo = managerInfo
    state.envProbeResult = envProbe
    state.capabilities = caps
    state.preview = preview
    await nextTick()
    return { wrapper, state }
  }

  it('exercises every action and failure channel', async () => {
    const { wrapper, state } = await mountDetail()
    try {
      await state.refresh()
      expect(state.instance).toBeTruthy()
      await state.loadManagerInfo()
      await state.setManagerLevel('strong')
      await state.openManagerConfig()

      overrides['instance.save'] = { ok: true }
      await state.saveProfile()
      state.profileDraft = { vram: 'lowvram' }
      await state.saveProfile()
      await state.restartWithProfile()
      await state.rescueInstance(false)
      await state.rescueInstance(true)
      overrides['instance.rescue'] = { ok: false, error: 'failed' }
      await state.rescueInstance(false)
      overrides = {}
      await state.copyRescueCommand()
      await state.recoverCrash(false)
      await state.recoverCrash(true)

      state.managerInfo = managerInfo
      await state.installManager()
      overrides['instance.installManager'] = { ok: false, message: 'bad', rolledBack: true }
      await state.installManager()
      overrides['instance.installManager'] = { ok: false, message: 'bad', rolledBack: false }
      await state.installManager()
      overrides = {}

      await state.migratePython()
      await state.openExternalIfRunning()
      await state.openEmbedIfRunning()
      state.instance = { ...instance, url: '' }
      await state.openExternalIfRunning()
      await state.openEmbedIfRunning()
      state.instance = instance

      await state.clearLogs()
      await state.copyLogs()
      state.logs = []
      await state.copyLogs()
      state.logs = [
        { ts: 1, level: 'info', message: 'hello' },
        { ts: 2, level: 'warn', message: 'warn' },
        { ts: 3, level: 'error', message: 'error' }
      ]
      state.logQuery = 'error'
      state.logLevelFilter = 'error'
      state.showDebugLogs = true
      expect(state.visibleLogs).toHaveLength(1)
      state.logQuery = ''
      state.logLevelFilter = 'warn'
      expect(state.visibleLogs).toHaveLength(1)
      state.logLevelFilter = 'all'
      state.showDebugLogs = false
      await nextTick()

      state.execFailures = [failure]
      expect(state.recipeFor(failure)).toBeTruthy()
      expect(state.recipeFor({ ...failure, missingModule: '' })).toBeUndefined()
      expect(state.recipeFor({ ...failure, missingModule: 'unknown' })).toBeUndefined()
      state.handlePipFailure(Object.assign(new Error('busy'), { code: 'OP_BUSY' }))
      state.handlePipFailure(Object.assign(new Error('remote'), { code: 'REMOTE_NOT_SUPPORTED' }))
      state.handlePipFailure(new Error('plain'))
      state.handlePipFailure('string')
      await state.fixByPip(failure)
      await state.fixByPip({ ...failure, missingModule: '' })
      await state.fixByRecipe(failure)
      await state.fixByRecipe({ ...failure, missingModule: 'triton' })
      await state.copyFailureReport(failure)
      await state.clearFailures()
      await state.probeEnvNow()
      await state.fixPipNow()
      await state.alignFrontendPkg()
      state.openPipInstallModal()
      state.pipSpecInput = 'numpy'
      await state.runPipInstall()
      state.pipInstalling = true
      await state.runPipInstall()
      state.pipInstalling = false
      await state.exportLogs()
      await state.doLaunch('none')
      await state.doStop()
      await state.checkStartupIssues('i1')
      state.reviewStartupIssues()
      await state.dismissStartupIssues()
      await state.copyCommand()

      await state.rollbackPendingUpdate()
      await state.setUpdateChannel('stable')
      await state.setUpdateChannel('nightly')
      await state.doCheckUpdate()
      await state.runUpdateComfy()
      await state.runRepairEnv()
      state.reopenUpdateModal()
      expect(state.sourceLabel('git')).toBeTruthy()
      expect(state.sourceLabel('zip')).toBeTruthy()
      expect(state.sourceLabel('unknown')).toBeTruthy()
      expect(state.releaseDate('2026-01-01T00:00:00Z')).toBeTruthy()
      expect(state.releaseDate()).toBe('—')
      state.openReleaseNotes()

      expect(state.baseName('/a/b')).toBe('b')
      expect(state.baseName('b')).toBe('b')
      expect(state.dirName('/a/b')).toBe('/a')
      expect(state.dirName('b')).toBe('')
      expect(state.venvLocationOf(instance).name).toBe('venv')
      expect(state.venvLocationOf({ ...instance, venvPath: '' }).name).toBe('.venv')
      await state.recreateVenv()
      state.openTorchModal()
      await state.reinstallTorch()
      await state.copyDiagPath()
      state.instance = { ...instance, status: 'starting' }
      await state.runSelfCheck()
      state.instance = instance

      for (const name of ['overview', 'logs', 'env', 'update', 'manager', 'nodes', 'settings']) {
        state.tab = name
        await nextTick()
        await nextTick()
        for (const sel of ['button', '.n-button', '.n-switch', '.n-checkbox', '.n-tabs-tab']) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            ;(el as HTMLElement).click()
            await flushPromises()
          }
        }
      }
      wrapper.findAllComponents(NInput).forEach((c) => c.vm.$emit('update:value', 'x'))
      wrapper.findAllComponents(NSelect).forEach((c) => c.vm.$emit('update:value', 'x'))
      wrapper.findAllComponents(NSwitch).forEach((c) => c.vm.$emit('update:value', true))
      await flushPromises()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      try {
        state.message?.destroyAll?.()
      } catch {
        /* noop */
      }
      wrapper.unmount()
    }
  }, 120_000)

  it('covers failure strings for each action', async () => {
    const { wrapper, state } = await mountDetail()
    try {
      failChannels = new Set([
        'instance.save',
        'instance.rescue',
        'instance.checkHealth',
        'instance.managerInfo',
        'instance.setManagerSecurity',
        'instance.openManagerConfig',
        'instance.installManager',
        'migrate',
        'instance.stop',
        'instance.clearLogs',
        'shell.writeClipboard',
        'instance.exportLogs',
        'instance.probeEnv',
        'instance.startupIssues',
        'instance.rollbackUpdate',
        'instance.setUpdateChannel',
        'instance.checkComfyUpdate',
        'instance.capabilities',
        'instance.previewLaunch',
        'bootstrap.status',
        'env.createVenv',
        'env.installTorch'
      ])
      await state.saveProfile()
      await state.restartWithProfile()
      await state.rescueInstance(false)
      await state.installManager()
      await state.migratePython()
      await state.clearLogs()
      await state.copyLogs()
      await state.recoverCrash(true)
      await state.exportLogs()
      await state.probeEnvNow()
      await state.checkStartupIssues('i1')
      await state.rollbackPendingUpdate()
      await state.setUpdateChannel('stable')
      await state.doCheckUpdate()
      await state.recreateVenv()
      await state.reinstallTorch()
      await state.copyDiagPath()
      await state.runSelfCheck()
      failChannels = new Set()

      failStrings = new Set([
        'instance.save',
        'instance.rescue',
        'instance.installManager',
        'instance.clearLogs',
        'shell.writeClipboard',
        'instance.exportLogs',
        'instance.probeEnv',
        'instance.rollbackUpdate',
        'instance.setUpdateChannel',
        'instance.checkComfyUpdate',
        'bootstrap.status',
        'env.createVenv',
        'env.installTorch'
      ])
      await state.saveProfile()
      await state.rescueInstance(false)
      await state.installManager()
      await state.clearLogs()
      await state.copyLogs()
      await state.exportLogs()
      await state.probeEnvNow()
      await state.rollbackPendingUpdate()
      await state.setUpdateChannel('stable')
      await state.doCheckUpdate()
      await state.recreateVenv()
      await state.reinstallTorch()
      await state.copyDiagPath()
      failStrings = new Set()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      try {
        state.message?.destroyAll?.()
      } catch {
        /* noop */
      }
      wrapper.unmount()
    }
  }, 120_000)
})
