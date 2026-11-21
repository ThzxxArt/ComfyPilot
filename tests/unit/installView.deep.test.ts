// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'
import { NCollapse, NInput, NPopconfirm, NRadioGroup, NSelect, NSwitch } from 'naive-ui'

const starter = {
  id: 's1',
  name: 'Starter',
  description: 'A starter model',
  url: 'https://example.com/a.safetensors',
  category: 'checkpoints',
  approxBytes: 100,
  family: 'SDXL',
  recommended: true
}
const gpu = {
  vendor: 'nvidia',
  model: 'RTX 4090',
  recommendedTorch: 'cu130',
  notes: ''
}
const preflight = {
  ok: true,
  checks: [
    { id: 'root', ok: true, detail: 'writable', detailKey: 'install.checkRoot' },
    {
      id: 'python',
      ok: false,
      detail: 'missing python',
      detailKey: 'install.checkPython',
      fixId: 'bootstrap-python',
      fixLabelKey: 'install.fixPython'
    },
    {
      id: 'git',
      ok: false,
      detail: 'missing git',
      fixId: 'bootstrap-mingit'
    },
    { id: 'uv', ok: false, detail: 'missing uv', fixId: 'bootstrap-uv' },
    { id: 'unknown', ok: false, detail: 'soft unknown', fixId: 'other-fix', fixLabel: 'Fix it' }
  ],
  diskNeedGb: 12.5,
  diskFreeGb: 100
}
const runtimeStatus = {
  runtimesDir: '/tmp/runtimes',
  components: [
    { kind: 'uv', path: '/tmp/uv', installed: true, origin: 'runtimes' },
    { kind: 'python', path: '', installed: false, origin: 'missing' },
    { kind: 'mingit', path: '', installed: false, origin: 'missing' },
    { kind: 'aria2', path: '', installed: false, origin: 'missing' }
  ],
  pythonPath: '/usr/bin/python3',
  pythonOrigin: 'system',
  pythonVersion: '3.13.5'
}
const progress = {
  runId: 'r1',
  step: 'python',
  status: 'running',
  message: 'working',
  percent: 40,
  steps: [
    {
      id: 'bootstrap',
      title: 'Bootstrap',
      status: 'done',
      detail: 'ok',
      log: ['line 1']
    },
    {
      id: 'python',
      title: 'Python',
      status: 'failed',
      detail: 'failed detail',
      detailKey: 'install.stepPython',
      log: ['err 1']
    }
  ],
  bytes: { receivedBytes: 10, totalBytes: 100, speedBps: 5, label: 'torch' }
}
const mirrorRec = {
  pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  torchIndexMirror: 'https://mirror.sjtu.edu.cn/pytorch-wheels',
  pipLabel: 'pipTsinghua',
  torchLabel: 'torchSjtu',
  githubLabel: 'mirrorAliyun'
}

let failChannels = new Set<string>()
let failStrings = new Set<string>()
let overrides: Record<string, unknown> = {}
let ipcHandlers = new Map<string, Set<(payload: unknown) => void>>()

function dataFor(channel: string): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, channel)) return overrides[channel]
  switch (channel) {
    case 'installer.status':
      return null
    case 'installer.suggestInstallRoot':
      return { path: '/home/user/ComfyUI', freeGb: 120 }
    case 'installer.starterModels':
      return [starter]
    case 'installer.detectGpu':
      return [gpu]
    case 'installer.preflight':
      return preflight
    case 'installer.start':
      return { runId: 'r1' }
    case 'installer.reset':
    case 'installer.cancel':
    case 'installer.installStarter':
      return true
    case 'bootstrap.download':
      return true
    case 'bootstrap.status':
      return runtimeStatus
    case 'bootstrap.ensure':
      return runtimeStatus
    case 'net.recommendMirrors':
      return mirrorRec
    case 'settings.get':
      return {
        locale: 'zh-CN',
        activeInstance: 'i1',
        pipIndex: '',
        torchIndexMirror: '',
        modelScanRoots: []
      }
    case 'settings.set':
      return true
    case 'instance.list':
      return [
        {
          id: 'i1',
          name: 'ComfyUI',
          path: '/home/user/ComfyUI',
          port: 8188,
          status: 'stopped',
          enabled: true,
          url: 'http://127.0.0.1:8188'
        }
      ]
    case 'instance.launch':
      return {
        id: 'i1',
        name: 'ComfyUI',
        path: '/home/user/ComfyUI',
        port: 8188,
        status: 'running',
        url: 'http://127.0.0.1:8188'
      }
    case 'instance.repairEnv':
      return { pythonVersion: '3.13.5', ok: true, packages: [], errors: [] }
    case 'monitor.system':
      return { cpu: 1, memory: 1 }
    case 'shell.pickFile':
      return '/usr/bin/python3'
    case 'shell.pickDirectory':
      return '/new/ComfyUI'
    case 'shell.openExternal':
      return true
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

describe('InstallView deep coverage', () => {
  async function mountInstall() {
    const { wrapper, state } = await mountView(
      '/install',
      () => import('../../src/renderer/src/views/install/InstallView.vue')
    )
    state.store.instances = [
      {
        id: 'i1',
        name: 'ComfyUI',
        path: '/home/user/ComfyUI',
        port: 8188,
        status: 'stopped',
        enabled: true
      }
    ]
    state.store.activeInstanceId = 'i1'
    await nextTick()
    return { wrapper, state }
  }

  it('exercises actions, helpers, progress and preflight flows', async () => {
    const { wrapper, state } = await mountInstall()
    try {
      expect(state.detailOf({ detail: 'plain' })).toBe('plain')
      expect(state.detailOf({ detailKey: 'install.checkRoot' })).toBeTruthy()
      expect(state.detailOf({ detailKey: 'missing.key', detail: 'fallback' })).toBe('missing.key')
      for (const kind of ['uv', 'python', 'mingit', 'aria2', 'other']) {
        expect(state.runtimeKindLabel(kind)).toBeTruthy()
      }
      for (const origin of ['system', 'runtimes', 'missing']) {
        expect(state.runtimeOriginLabel(origin)).toBeTruthy()
      }
      expect(state.pythonRuntimeSourceKey).toBeTruthy()
      expect(state.pythonRuntimePin).toBeTruthy()
      const ua = navigator.userAgent
      for (const value of [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X arm64)',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X x64)',
        'Mozilla/5.0 (X11; Linux aarch64)',
        'Mozilla/5.0 (X11; Linux x86_64)'
      ]) {
        Object.defineProperty(navigator, 'userAgent', { value, configurable: true })
        expect(state.pythonRuntimeSourceKey).toBeTruthy()
      }
      Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })

      state.plan = { ...state.plan, installRoot: '/home/user/ComfyUI', instanceName: 'ComfyUI' }
      expect(state.canStart).toBe(true)
      state.plan = { ...state.plan, instanceName: '  ', installRoot: '  ' }
      expect(state.canStart).toBe(false)
      state.plan = { ...state.plan, installRoot: '/home/user/ComfyUI', instanceName: 'ComfyUI' }

      for (const n of [NaN, Infinity, -1, 0.44, 9.55, 12.5, 100]) {
        expect(state.fmtGb(n)).toBeTypeOf('string')
      }
      expect(state.bytesText({ receivedBytes: 1, totalBytes: 2, speedBps: 3 })).toBeTruthy()
      for (const s of ['done', 'failed', 'cancelled', 'interrupted', 'running', 'pending']) {
        expect(state.stepStatusLabel(s)).toBeTypeOf('string')
        expect(state.stepStatusTag(s)).toBeTypeOf('string')
      }
      for (const id of [
        'bootstrap',
        'preflight',
        'python',
        'venv',
        'comfyui',
        'torch',
        'requirements',
        'register',
        'starter',
        'done'
      ]) {
        expect(state.stepTitleKey(id)).toBeTruthy()
      }
      expect(state.stepTitleKey('other')).toBe('other')
      for (const ch of ['cu130', 'cu126', 'rocm7.2', 'rocm10.0', 'xpu', 'mps', 'cpu']) {
        expect(state.torchLabel(ch)).toBeTruthy()
      }
      expect(state.pipIndexOptions.length).toBeGreaterThan(0)
      expect(state.torchIndexOptions.length).toBeGreaterThan(0)

      await state.resetInstall()
      await state.pickPythonPath()
      expect(state.plan.pythonPath).toBe('/usr/bin/python3')
      await state.pickRoot()
      expect(state.plan.installRoot).toBe('/new/ComfyUI')
      overrides['shell.pickFile'] = ''
      overrides['shell.pickDirectory'] = ''
      await state.pickPythonPath()
      await state.pickRoot()
      overrides = {}

      await state.detectGpu()
      expect(state.gpuSentence).toBeTruthy()
      for (const vendor of ['none', 'unknown', 'amd']) {
        overrides['installer.detectGpu'] = [{ ...gpu, vendor, model: '' }]
        await state.detectGpu()
        expect(state.gpuSentence).toBeTruthy()
      }
      overrides['installer.detectGpu'] = []
      await state.detectGpu()
      overrides = {}

      expect(state.errText({ code: 'OP_BUSY' })).toBeTruthy()
      expect(state.errText(new Error('x'))).toBe('x')
      expect(state.errText('y')).toBe('y')

      await state.runPreflight()
      expect(state.preflightReady).toBe(true)
      await state.runPreflight()
      state.plan.installRoot = '  '
      await state.runPreflight()
      state.plan.installRoot = '/home/user/ComfyUI'
      state.schedulePreflight(0)
      await new Promise((r) => setTimeout(r, 30))
      await flushPromises()

      await state.applyFix({ id: 'x', ok: false, detail: '' })
      await state.applyFix({ id: 'x', ok: false, detail: '', fixId: 'other' })
      await state.applyFix({ id: 'x', ok: false, detail: '', fixId: 'bootstrap-python' })
      state.fixingId = null
      expect(state.fixLabelOf({ id: 'x', ok: false, detail: '' })).toBeTruthy()
      expect(
        state.fixLabelOf({ id: 'x', ok: false, detail: '', fixId: 'bootstrap-uv' })
      ).toBeTruthy()
      expect(
        state.fixLabelOf({ id: 'x', ok: false, detail: '', fixLabelKey: 'install.fixGit' })
      ).toBeTruthy()
      expect(state.fixLabelOf({ id: 'x', ok: false, detail: '', fixLabel: 'Fix' })).toBe('Fix')

      state.plan = {
        ...state.plan,
        installRoot: '  /home/user/ComfyUI  ',
        instanceName: '  ',
        comfyRepo: '  ',
        comfyBranch: '  ',
        comfySource: 'git',
        pythonPath: ''
      }
      const built = state.buildPlan({ skipStarter: true })
      expect(built.installRoot).toBe('/home/user/ComfyUI')
      expect(built.instanceName).toBe('ComfyUI')
      expect(built.comfyRepo).toBeTruthy()

      state.preflight = preflight
      state.plan = { ...state.plan, installRoot: '/home/user/ComfyUI', instanceName: 'ComfyUI' }
      await nextTick()
      state.preflightReady = true
      state.preflighting = false
      state.installing = false
      state.startFullAuto()
      await flushPromises()
      expect(state.installRunId).toBe('r1')
      state.installing = false
      state.startCustom()
      await flushPromises()
      state.installing = false
      await state.startInstall({ fullAuto: false })
      expect(state.installRunId).toBe('r1')
      state.installing = false
      state.progress = null
      state.preflight = { ok: false, checks: [{ id: 'root', ok: false, detail: 'bad' }] }
      state.startInstall({})
      expect(state.installing).toBe(false)
      state.preflight = preflight
      await state.cancelInstall()

      state.installRunId = 'r1'
      state.onProgress(null)
      state.onProgress({ ...progress, runId: 'other' })
      state.onProgress(progress)
      expect(state.expandedLogIds).toContain('python')
      const before = state.expandedLogIds.length
      state.onProgress(progress)
      expect(state.expandedLogIds.length).toBe(before)
      for (const status of ['done', 'cancelled', 'failed', 'error']) {
        state.onProgress({ ...progress, status, error: status === 'failed' ? 'boom' : '' })
      }
      state.installing = true
      state.onProgress({ ...progress, status: 'cancelled' })
      expect(state.installing).toBe(false)

      state.onRuntimeProgress(null)
      expect(state.runtimeProg).toBeNull()
      state.onRuntimeProgress({ kind: 'uv', phase: 'done' })
      expect(state.runtimeProg).toBeNull()
      state.onRuntimeProgress({
        kind: 'uv',
        phase: 'download',
        receivedBytes: 1,
        totalBytes: 2,
        speedBps: 3
      })
      expect(state.runtimeProg).toBeTruthy()

      state.setLogExpanded('python', ['python'])
      expect(state.expandedLogIds).toContain('python')
      state.setLogExpanded('python', ['python'])
      state.setLogExpanded('python', [])
      expect(state.logExpandedNames('python')).toEqual([])
      state.setLogExpanded('python', ['python'])
      expect(state.logExpandedNames('python')).toEqual(['python'])

      await state.syncStoreSettings()
      await state.savePipIndex('x')
      expect(state.userChoseMirror).toBe(true)
      await state.saveTorchIndex('y')

      state.store.instances = [
        {
          id: 'i1',
          name: 'ComfyUI',
          path: '/home/user/ComfyUI',
          port: 8188,
          status: 'stopped',
          enabled: true
        }
      ]
      state.progress = { ...progress, instanceId: 'i1' }
      expect(state.findInstalledInstance()?.id).toBe('i1')
      state.progress = { ...progress, instanceId: 'missing' }
      expect(state.findInstalledInstance()?.id).toBe('i1')
      state.progress = null
      state.plan = { ...state.plan, instanceName: 'ComfyUI' }
      expect(state.findInstalledInstance()?.id).toBe('i1')
      state.plan = { ...state.plan, instanceName: 'Other', installRoot: '/home/user/ComfyUI' }
      expect(state.findInstalledInstance()?.id).toBe('i1')
      state.store.instances = []
      expect(state.findInstalledInstance()).toBeNull()

      state.store.instances = [
        {
          id: 'i1',
          name: 'ComfyUI',
          path: '/home/user/ComfyUI',
          port: 8188,
          status: 'stopped',
          enabled: true,
          url: 'http://127.0.0.1:8188'
        }
      ]
      state.progress = { ...progress, instanceId: 'i1' }
      await state.launchNow()
      state.progress = null
      state.store.instances = []
      await state.launchNow()
      state.goInstances()
      await flushPromises()

      await state.installStarter(starter)
      expect(state.starterBusy).toBeNull()
      state.starterBusy = 'busy'
      await state.installStarter(starter)
      state.starterBusy = null

      state.userChoseMirror = false
      await state.probeAndRecommendMirrors(true)
      expect(state.pipIndex).toBeTruthy()
      state.userChoseMirror = true
      await state.probeAndRecommendMirrors(true)
      await state.probeAndRecommendMirrors(false)
      overrides['net.recommendMirrors'] = {}
      await state.probeAndRecommendMirrors(false)
      overrides = {}

      for (const cb of ipcHandlers.get(IPC_EVENTS.installProgress) || []) {
        cb(progress)
        cb({ ...progress, status: 'done' })
      }
      for (const cb of ipcHandlers.get(IPC_EVENTS.runtimeProgress) || []) {
        cb({ kind: 'uv', phase: 'download', receivedBytes: 1, totalBytes: 2, speedBps: 3 })
        cb({ kind: 'uv', phase: 'done' })
      }

      await state.loadRuntimeStatus()
      expect(state.runtimeStatus).toBeTruthy()
      state.runtimeStatus = runtimeStatus
      expect(state.missingRuntimeKinds.length).toBe(3)
      await state.ensureMissingRuntimes()
      state.runtimeStatus = { ...runtimeStatus, components: [] }
      await state.ensureMissingRuntimes()
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

  it('covers every failure branch', async () => {
    const { wrapper, state } = await mountInstall()
    try {
      failChannels = new Set([
        'installer.status',
        'installer.suggestInstallRoot',
        'installer.starterModels',
        'installer.detectGpu',
        'installer.preflight',
        'installer.start',
        'installer.reset',
        'installer.cancel',
        'installer.installStarter',
        'bootstrap.download',
        'bootstrap.status',
        'bootstrap.ensure',
        'net.recommendMirrors',
        'settings.get',
        'settings.set',
        'instance.list',
        'instance.launch',
        'instance.repairEnv',
        'shell.pickFile',
        'shell.pickDirectory'
      ])
      await state.resetInstall()
      await state.pickPythonPath()
      await state.pickRoot()
      await state.detectGpu()
      state.plan = { ...state.plan, installRoot: '/x' }
      await state.runPreflight()
      await state.applyFix({ id: 'x', ok: false, detail: '', fixId: 'bootstrap-python' })
      state.installRunId = ''
      state.onProgress(progress)
      state.installing = true
      state.startInstall({})
      await state.cancelInstall()
      await state.syncStoreSettings()
      await state.savePipIndex('x')
      await state.saveTorchIndex('y')
      await state.ensureMissingRuntimes()
      state.runtimeStatus = runtimeStatus
      await state.ensureMissingRuntimes()
      await state.loadRuntimeStatus()
      await state.installStarter(starter)
      await state.probeAndRecommendMirrors(false)
      state.userChoseMirror = false
      await state.probeAndRecommendMirrors(true)
      await state.launchNow()
      state.store.instances = []
      await state.launchNow()
      await state.repairInstance({ id: 'i1', name: 'Main' })
      expect(state.showRepairModal).toBe(true)
      state.showRepairModal = false
      await state.runPreflight()
      failChannels = new Set()

      failStrings = new Set([
        'installer.detectGpu',
        'installer.preflight',
        'installer.start',
        'installer.reset',
        'installer.cancel',
        'installer.installStarter',
        'bootstrap.download',
        'bootstrap.status',
        'bootstrap.ensure',
        'net.recommendMirrors',
        'settings.get',
        'settings.set',
        'instance.list',
        'instance.launch',
        'instance.repairEnv',
        'shell.pickFile',
        'shell.pickDirectory'
      ])
      state.plan = { ...state.plan, installRoot: '/x' }
      await state.resetInstall()
      await state.pickPythonPath()
      await state.pickRoot()
      await state.detectGpu()
      await state.runPreflight()
      await state.applyFix({ id: 'x', ok: false, detail: '', fixId: 'bootstrap-python' })
      state.startInstall({})
      await state.cancelInstall()
      await state.syncStoreSettings()
      await state.savePipIndex('x')
      await state.saveTorchIndex('y')
      await state.ensureMissingRuntimes()
      await state.loadRuntimeStatus()
      await state.installStarter(starter)
      await state.probeAndRecommendMirrors(false)
      await state.launchNow()
      await state.repairInstance({ id: 'i1', name: 'Main' })
      failStrings = new Set()

      overrides['installer.reset'] = true
      failStrings = new Set()
      failChannels = new Set(['installer.reset'])
      await state.resetInstall()
      failChannels = new Set()
      overrides['installer.reset'] = undefined
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

  it('renders install progress, runtime and preflight truth tables', async () => {
    const { wrapper, state } = await mountInstall()
    try {
      state.plan = {
        ...state.plan,
        installRoot: '/home/user/ComfyUI',
        instanceName: 'ComfyUI',
        comfySource: 'git',
        skipStarter: false,
        useUv: true
      }
      state.preflight = preflight
      state.preflightReady = true
      state.runtimeStatus = runtimeStatus
      state.runtimeStatusLoading = false
      state.probingMirrors = true
      state.mirrorProbeHint = 'recommended'
      state.fixingId = 'bootstrap-python'
      state.starterModels = [starter, { ...starter, id: 's2', recommended: false }]
      state.starterBusy = 's1'
      state.repairingId = 'i1'
      state.showRepairModal = true
      state.runtimeProg = {
        kind: 'uv',
        phase: 'download',
        receivedBytes: 1,
        totalBytes: 2,
        speedBps: 3,
        message: 'downloading'
      }
      state.expandedLogIds = ['python']
      for (const status of ['interrupted', 'failed', 'done', 'running', 'cancelled']) {
        state.progress = { ...progress, status, error: status === 'failed' ? 'boom' : '' }
        await nextTick()
      }
      state.progress = {
        ...progress,
        steps: [
          { id: 'bootstrap', title: 'B', status: 'pending', detail: '', log: [] },
          {
            id: 'python',
            title: 'P',
            status: 'failed',
            detail: '',
            detailKey: 'install.stepPython',
            detailParams: { version: '3.13' },
            log: ['a', 'b']
          }
        ]
      }
      await nextTick()
      await nextTick()
      for (const el of Array.from(document.querySelectorAll('.n-collapse-item__header-main'))) {
        ;(el as HTMLElement).click()
        await flushPromises()
      }
      const inputValues = ['/tmp/install', 'ComfyUI', '/usr/bin/python3', 'https://repo', 'main']
      wrapper.findAllComponents(NInput).forEach((c, i) => {
        c.vm.$emit('update:value', inputValues[i] ?? '/tmp/input')
      })
      wrapper.findAllComponents(NSelect).forEach((c, i) => {
        c.vm.$emit('update:value', i === 0 ? 'cu126' : i === 1 ? 'x' : 'y')
      })
      wrapper.findAllComponents(NSwitch).forEach((c, i) => {
        c.vm.$emit('update:value', i % 2 === 0)
      })
      for (const c of wrapper.findAllComponents(NRadioGroup)) {
        c.vm.$emit('update:value', 'git')
        await nextTick()
        c.vm.$emit('update:value', 'zip')
      }
      for (const c of wrapper.findAllComponents(NPopconfirm)) {
        c.vm.$emit('positive-click')
      }
      for (const c of wrapper.findAllComponents(NCollapse)) {
        c.vm.$emit('update:expanded-names', ['python'])
      }
      await flushPromises()
      state.schedulePreflight(0)
      await new Promise((r) => setTimeout(r, 500))
      await flushPromises()
      for (const sel of ['button', '.n-button', '.n-switch', '.n-radio', '.n-collapse-item']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
      state.progress = null
      state.preflight = null
      state.runtimeStatus = null
      state.plan = { ...state.plan, comfySource: 'zip', skipStarter: true }
      await nextTick()
      await nextTick()
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

  it('restores an in-flight install on mount', async () => {
    overrides['installer.status'] = {
      ...progress,
      status: 'running',
      runId: 'r9',
      steps: [{ id: 'venv', title: 'V', status: 'failed', detail: '', log: [] }]
    }
    overrides['settings.get'] = { pipIndex: 'x', torchIndexMirror: 'y' }
    const { wrapper, state } = await mountInstall()
    try {
      expect(state.installRunId).toBe('r9')
      expect(state.progress?.status).toBe('running')
      expect(state.installing).toBe(true)
      expect(state.userChoseMirror).toBe(true)
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

describe('InstallView fallback and race branches', () => {
  async function mountInstall() {
    const { wrapper, state } = await mountView(
      '/install',
      () => import('../../src/renderer/src/views/install/InstallView.vue')
    )
    state.store.instances = [
      {
        id: 'i1',
        name: 'ComfyUI',
        path: '/home/user/ComfyUI',
        port: 8188,
        status: 'stopped',
        enabled: true
      }
    ]
    state.store.activeInstanceId = 'i1'
    await nextTick()
    return { wrapper, state }
  }

  it('falls back for unknown channels, statuses and empty preflight data', async () => {
    const { wrapper, state } = await mountInstall()
    try {
      state.preflight = { ok: true, checks: [] }
      state.plan = { ...state.plan, torchChannel: 'bogus' }
      expect(state.diskNeedGb).toBe(7)
      state.preflight = { ok: true, checks: [], diskNeedGb: 1.234, diskFreeGb: 0 }
      expect(state.diskNeedGb).toBe(1.234)
      expect(state.diskFreeGb).toBe(0)
      state.suggestFreeGb = 8
      state.preflight = { ok: true, checks: [] }
      expect(state.diskFreeGb).toBe(8)
      expect(state.stepStatusLabel('bogus' as never)).toBe('bogus')
      for (const status of ['pending', 'running', 'done', 'failed', 'skipped', 'cancelled']) {
        expect(state.stepStatusTag(status)).toBeTruthy()
      }
      expect(state.runtimeKindLabel('uv')).toBeTruthy()
      expect(state.runtimeKindLabel('bogus' as never)).toBe('bogus')
      for (const origin of ['system', 'runtimes', 'missing', 'bogus']) {
        expect(state.runtimeOriginLabel(origin)).toBeTruthy()
      }
    } finally {
      wrapper.unmount()
    }
  }, 60_000)

  it('discards stale preflight responses and reports a busy reset', async () => {
    const { wrapper, state } = await mountInstall()
    try {
      let releaseFirst: (() => void) | null = null
      state.preflight = null
      const result = { ok: true, checks: [], diskNeedGb: 1, diskFreeGb: 2 }
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'installer.preflight') {
          if (!releaseFirst) {
            await new Promise<void>((r) => {
              releaseFirst = r
            })
            return { ok: true, data: result }
          }
          return { ok: true, data: result }
        }
        if (channel === 'settings.get') return { ok: true, data: {} }
        if (channel === 'installer.reset') {
          return { ok: false, error: 'Installer already running' }
        }
        return { ok: true, data: null }
      }
      const first = state.runPreflight()
      await Promise.resolve()
      const second = state.runPreflight()
      await second
      releaseFirst?.()
      await first
      state.installing = true
      await state.resetInstall()
      state.installing = false
      expect(state.preflightReady).toBe(true)
    } finally {
      wrapper.unmount()
    }
  }, 60_000)
})
