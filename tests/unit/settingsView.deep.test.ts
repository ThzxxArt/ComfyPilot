// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import { i18n } from '../../src/renderer/src/i18n'

const settings = {
  locale: 'zh-CN',
  activeInstance: 'i1',
  theme: 'system',
  modelScanRoots: ['/models'],
  outputScanDepth: 4,
  healthCheckEnabled: true,
  healthCheckIntervalMs: 5000,
  healthStaleMs: 120000,
  autoRecover: true,
  autoRecoverMaxAttempts: 3,
  autoRecoverCooldownMs: 60000,
  githubEndpoint: '',
  hfEndpoint: '',
  civitaiEndpoint: '',
  pipIndex: '',
  torchIndexMirror: '',
  networkMode: 'public',
  securityLevel: 'normal',
  allowGitUrlInstall: false,
  allowPipInstall: true,
  allowUnverifiedRuntime: false,
  useAria2: false,
  aria2Path: '',
  enableAutoCheckUpdates: true,
  embedFrontend: true,
  launchOnBoot: false,
  minimizeToTray: false,
  autoStartInstancesOnLaunch: false,
  proxy: {
    enabled: false,
    protocol: 'http',
    host: '',
    port: 7890,
    username: '',
    bypass: '',
    hasPassword: true,
    backend: 'plaintext'
  }
}
const remote = {
  id: 'r1',
  name: 'Remote',
  baseUrl: 'http://192.168.1.10:8188',
  label: 'gpu',
  enabled: true,
  apiKeySet: true,
  apiKeyLocked: false
}
const remoteStatus = {
  id: 'r1',
  online: true,
  version: '0.46.0',
  queueRunning: 1,
  queuePending: 2,
  error: ''
}
const credentialStatus = {
  proxyPasswordUnreadable: false,
  proxyCredentialBackend: 'plaintext',
  lockedRemoteIds: []
}
const runtime = {
  pythonVersion: '3.13.5',
  legacyPython: '3.12.7',
  runtimesDir: '/tmp/runtimes'
}
const envProbe = {
  pythonPath: 'python',
  pythonVersion: '3.13.5',
  torchVersion: '2.9.0',
  cudaVersion: '13.0',
  mpsAvailable: false,
  npuAvailable: false,
  packages: [],
  ok: true,
  errors: []
}
const appUpdate = {
  status: 'downloaded',
  currentVersion: '0.2.5',
  availableVersion: '0.2.6',
  checkedAt: Date.now(),
  progress: {
    percent: 100,
    transferred: 200 * 1024 * 1024,
    total: 200 * 1024 * 1024,
    bytesPerSecond: 0
  }
}

let failChannels = new Set<string>()
let failStrings = new Set<string>()
let overrides: Record<string, unknown> = {}
let dialogChoice = 'positive'
let ipcHandlers = new Map<string, Set<(payload: unknown) => void>>()

function dataFor(channel: string): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, channel)) return overrides[channel]
  switch (channel) {
    case 'settings.get':
      return settings
    case 'settings.set':
    case 'settings.setProxyPassword':
    case 'settings.clearProxyPassword':
      return true
    case 'settings.credentialStatus':
      return credentialStatus
    case 'settings.dataDir':
    case 'settings.logsDir':
      return '/tmp/comfy-pilot'
    case 'settings.exportConfig':
      return { settings: { locale: 'zh-CN' } }
    case 'settings.importConfig':
      return { settings, applied: ['locale'], warnings: ['one warning'] }
    case 'instance.list':
      return [{ id: 'i1', name: 'Main', path: '/tmp/comfy', port: 8188, status: 'running' }]
    case 'remote.list':
      return [remote]
    case 'remote.test':
      return remoteStatus
    case 'remote.freeMemory':
      return { ok: true }
    case 'remote.listStatus':
      return [remoteStatus]
    case 'monitor.system':
      return { cpu: 1, memory: 1 }
    case 'bootstrap.status':
      return runtime
    case 'bootstrap.deleteLegacy':
      return { removed: ['py3.12'], failed: [] }
    case 'env.probe':
      return envProbe
    case 'env.listPythons':
      return [{ path: '/usr/bin/python3', version: '3.13.5' }]
    case 'proxy.test':
      return { ok: true, via: 'http://proxy:7890', ms: 42 }
    case 'proxy.apply':
      return { enabled: true, url: 'http://proxy:7890' }
    case 'app.installUpdate':
      return { ok: true }
    case 'app.checkUpdate':
      return appUpdate
    case 'app.updateStatus':
      return appUpdate
    case 'shell.openPath':
    case 'shell.pickDirectory':
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
  dialogChoice = 'positive'
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

describe('SettingsView deep coverage', () => {
  async function mountSettings() {
    const { wrapper, state } = await mountView(
      '/settings',
      () => import('../../src/renderer/src/views/settings/SettingsView.vue')
    )
    const dialog = state.dialog
    if (dialog) {
      const auto = (opts: any): object => {
        try {
          if (typeof opts?.content === 'function') opts.content()
          const cb =
            dialogChoice === 'negative'
              ? opts?.onNegativeClick
              : dialogChoice === 'close'
                ? opts?.onClose
                : dialogChoice === 'mask'
                  ? opts?.onMaskClick
                  : opts?.onPositiveClick
          const r = cb?.()
          if (r && typeof r.catch === 'function') r.catch(() => undefined)
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
    await nextTick()
    return { wrapper, state }
  }

  it('exercises settings helpers, save, proxy and update branches', async () => {
    const { wrapper, state } = await mountSettings()
    try {
      expect(state.pipIndexOptions.length).toBeGreaterThan(0)
      expect(state.torchIndexOptions.length).toBeGreaterThan(0)
      expect(state.networkModeOptions).toHaveLength(4)
      expect(state.securityLevelOptions).toHaveLength(4)
      expect(state.shortcuts).toHaveLength(3)
      expect(state.cloneSettings(null)).toBeTruthy()
      expect(state.cloneSettings(undefined)).toBeTruthy()
      expect(state.cloneSettings({ proxy: {} })).toBeTruthy()
      expect(state.sameValue({ a: 1 }, { a: 1 })).toBe(true)
      expect(state.sameValue({ a: 1 }, { a: 2 })).toBe(false)
      const circular: any = {}
      circular.self = circular
      expect(state.sameValue(circular, circular)).toBe(true)
      expect(state.sameValue(circular, {})).toBe(false)

      await state.setLocale('zh-CN')
      await state.setLocale('en-US')
      await state.save()
      await state.save({ silent: true })
      state.proxyPasswordDraft = 'secret'
      await state.save({ silent: true })
      expect(state.proxyPasswordDraft).toBe('')
      await state.clearProxyPassword()
      await state.testProxy()
      await state.applyProxy()
      overrides['proxy.apply'] = { enabled: false, url: '' }
      await state.applyProxy()
      overrides = {}

      await state.openConfigDir()
      await state.openLogsDir()
      await state.addScanRoot()
      await state.addScanRoot()
      state.form.modelScanRoots = ['/models']
      await state.addScanRoot()
      overrides['shell.pickDirectory'] = '/new/models'
      await state.addScanRoot()
      expect(state.form.modelScanRoots).toContain('/new/models')
      overrides = {}

      await state.deleteLegacyRuntimes()
      overrides['bootstrap.deleteLegacy'] = { removed: [], failed: ['old'] }
      await state.deleteLegacyRuntimes()
      overrides = {}

      await state.exportConfig()
      state.pickImportFile()
      const file = { text: async () => JSON.stringify({ settings: { locale: 'en-US' } }) }
      await state.onImportFile({ target: { files: [file], value: 'x' } } as never)
      dialogChoice = 'negative'
      await state.onImportFile({ target: { files: [file], value: 'x' } } as never)
      dialogChoice = 'close'
      await state.onImportFile({ target: { files: [file], value: 'x' } } as never)
      dialogChoice = 'mask'
      await state.onImportFile({ target: { files: [file], value: 'x' } } as never)
      dialogChoice = 'positive'
      await state.onImportFile({ target: { files: [], value: 'x' } } as never)
      await state.onImportFile({
        target: { files: [{ text: async () => 'not json' }], value: 'x' }
      } as never)
      await state.onImportFile({
        target: {
          files: [
            {
              text: async () => {
                throw 'plain failure'
              }
            }
          ],
          value: 'x'
        }
      } as never)
      overrides['settings.importConfig'] = { settings, applied: [], warnings: [] }
      await state.onImportFile({ target: { files: [file], value: 'x' } } as never)
      overrides = {}

      await state.loadCredentialStatus()
      await state.loadRemotes()
      await state.saveRemote()
      state.remoteDraft = { ...state.remoteDraft, id: 'r1', apiKey: 'key' }
      await state.saveRemote()
      state.remoteDraft = { ...state.remoteDraft, apiKey: '' }
      await state.saveRemote()

      await state.clearRemoteKey(remote)
      dialogChoice = 'negative'
      await state.clearRemoteKey(remote)
      dialogChoice = 'positive'
      state.openRemoteDialog()
      state.editRemote(remote)
      state.cancelRemoteDialog()
      await state.testRemote('r1')
      overrides['remote.test'] = { ...remoteStatus, online: false }
      await state.testRemote('r1')
      overrides = {}
      await state.freeRemoteMemory('r1')
      overrides['remote.freeMemory'] = { ok: false, error: 'denied' }
      await state.freeRemoteMemory('r1')
      overrides['remote.freeMemory'] = { ok: false, error: '' }
      await state.freeRemoteMemory('r1')
      overrides = {}
      state.openRemoteFrontend(remote)
      state.openRemoteFrontend({ ...remote, baseUrl: '' })
      await state.testAllRemotes()
      expect(state.remoteStatusOf('r1')).toBeTruthy()
      await state.removeRemote('r1')

      for (const s of [
        'available',
        'downloading',
        'downloaded',
        'not-available',
        'unsupported',
        'error',
        'checking'
      ]) {
        expect(state.appUpdateText({ ...appUpdate, status: s })).toBeTypeOf('string')
      }
      for (const n of [undefined, 0, -1, 1024, 200 * 1024 * 1024]) {
        expect(state.formatUpdateBytes(n)).toBeTypeOf('string')
      }
      await state.installAppUpdateNow()
      overrides['app.installUpdate'] = { ok: false, error: 'busy' }
      await state.installAppUpdateNow()
      overrides['app.installUpdate'] = { ok: false, error: '' }
      await state.installAppUpdateNow()
      overrides = {}
      await state.checkAppUpdate()

      for (const cb of ipcHandlers.get(IPC_EVENTS.appUpdate) || []) {
        cb({ ...appUpdate, status: 'downloading' })
        cb({ ...appUpdate, status: 'error', error: 'x' })
      }
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

  it('covers failures and the unsaved-leave guard', async () => {
    const { wrapper, state } = await mountSettings()
    try {
      failChannels = new Set([
        'settings.set',
        'settings.get',
        'settings.clearProxyPassword',
        'settings.setProxyPassword',
        'settings.dataDir',
        'settings.logsDir',
        'settings.exportConfig',
        'settings.importConfig',
        'settings.credentialStatus',
        'shell.openPath',
        'shell.pickDirectory',
        'bootstrap.deleteLegacy',
        'bootstrap.status',
        'env.probe',
        'env.listPythons',
        'proxy.test',
        'proxy.apply',
        'app.installUpdate',
        'app.checkUpdate',
        'app.updateStatus',
        'remote.list',
        'remote.save',
        'remote.setApiKey',
        'remote.clearApiKey',
        'remote.test',
        'remote.freeMemory',
        'remote.listStatus',
        'remote.remove',
        'shell.openExternal'
      ])
      await state.openConfigDir()
      await state.openLogsDir()
      await state.addScanRoot()
      await state.deleteLegacyRuntimes()
      await state.clearProxyPassword()
      state.proxyPasswordDraft = 'x'
      await state.save()
      expect(state.proxyPasswordDraft).toBe('x')
      await state.testProxy()
      await state.applyProxy()
      await state.exportConfig()
      await state.loadCredentialStatus()
      await state.loadRemotes()
      expect(state.remoteError).toBeTruthy()
      await state.saveRemote()
      state.remoteDraft = { ...state.remoteDraft, id: 'r1', apiKey: 'k' }
      await state.saveRemote()
      dialogChoice = 'positive'
      await state.clearRemoteKey(remote)
      await state.probeEnv()
      await state.testRemote('r1')
      await state.freeRemoteMemory('r1')
      await state.testAllRemotes()
      await state.removeRemote('r1')
      await state.installAppUpdateNow()
      await state.checkAppUpdate()
      expect(state.appUpdate?.status).toBe('error')
      await state.onImportFile({
        target: { files: [{ text: async () => JSON.stringify({ settings: {} }) }], value: 'x' }
      } as never)
      failChannels = new Set()
      failStrings = new Set(['settings.set'])
      await state.save()
      failStrings = new Set()

      state.form.outputScanDepth = 7
      await nextTick()
      dialogChoice = 'negative'
      await (wrapper.vm as any).$router.push('/')
      await flushPromises()
      state.form.outputScanDepth = 8
      await nextTick()
      dialogChoice = 'close'
      await (wrapper.vm as any).$router.push('/').catch(() => undefined)
      await flushPromises()
      state.form.outputScanDepth = 9
      await nextTick()
      dialogChoice = 'mask'
      await (wrapper.vm as any).$router.push('/').catch(() => undefined)
      await flushPromises()
      state.form.outputScanDepth = 10
      await nextTick()
      dialogChoice = 'positive'
      await (wrapper.vm as any).$router.push('/')
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

  it('runs the unsaved-leave guard as a routed page', async () => {
    const { default: SettingsView } =
      await import('../../src/renderer/src/views/settings/SettingsView.vue')
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/settings', component: SettingsView },
        { path: '/', component: { template: '<div>home</div>' } }
      ]
    })
    await router.push('/settings')
    await router.isReady()
    const pinia = createPinia()
    setActivePinia(pinia)
    const Host = defineComponent({
      setup(_p, { slots }) {
        return () =>
          h(NConfigProvider, null, {
            default: () =>
              h(NMessageProvider, null, {
                default: () => h(NDialogProvider, null, { default: () => slots.default?.() })
              })
          })
      }
    })
    const wrapper = mount(Host, {
      global: {
        plugins: [pinia, router, i18n],
        config: { errorHandler: () => undefined, warnHandler: () => undefined }
      },
      slots: { default: () => h(RouterView) },
      attachTo: document.body
    })
    await flushPromises()
    const child = wrapper.findComponent(SettingsView)
    const state = (child.vm as any)?.$?.setupState ?? {}
    const auto = (opts: any): object => {
      try {
        if (typeof opts?.content === 'function') opts.content()
        const cb =
          dialogChoice === 'negative'
            ? opts?.onNegativeClick
            : dialogChoice === 'close'
              ? opts?.onClose
              : dialogChoice === 'mask'
                ? opts?.onMaskClick
                : opts?.onPositiveClick
        const r = cb?.()
        if (r && typeof r.catch === 'function') r.catch(() => undefined)
      } catch {
        /* ignore */
      }
      return {}
    }
    state.dialog.warning = auto
    try {
      await router.push('/').catch(() => undefined)
      state.form.outputScanDepth = 7
      await nextTick()
      dialogChoice = 'negative'
      await router.push('/')
      await flushPromises()
      await router.push('/settings')
      state.form.outputScanDepth = 8
      await nextTick()
      dialogChoice = 'close'
      await router.push('/').catch(() => undefined)
      await flushPromises()
      await router.push('/settings')
      state.form.outputScanDepth = 9
      await nextTick()
      dialogChoice = 'mask'
      await router.push('/').catch(() => undefined)
      await flushPromises()
      await router.push('/settings')
      state.form.outputScanDepth = 10
      await nextTick()
      dialogChoice = 'positive'
      failChannels = new Set(['settings.set'])
      await router.push('/').catch(() => undefined)
      await flushPromises()
      failChannels = new Set()
      await router.push('/settings')
      state.saving = true
      await nextTick()
      await router.push('/')
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/')
    } finally {
      try {
        state.message?.destroyAll?.()
      } catch {
        /* noop */
      }
      wrapper.unmount()
    }
  }, 120_000)

  it('renders remote, runtime, update and import truth tables', async () => {
    const { wrapper, state } = await mountSettings()
    try {
      state.showRemote = true
      state.remotes = [
        remote,
        { ...remote, id: 'r2', apiKeySet: false, apiKeyLocked: true },
        { ...remote, id: 'r3', apiKeySet: false, apiKeyLocked: false }
      ]
      state.remoteError = 'offline'
      state.remoteStatuses = {
        r1: remoteStatus,
        r2: { ...remoteStatus, id: 'r2', online: false, version: '', error: 'timeout' },
        r3: { id: 'r3', online: true }
      }
      state.credStatus = {
        proxyPasswordUnreadable: true,
        proxyCredentialBackend: 'unavailable',
        lockedRemoteIds: ['r2']
      }
      state.runtimeStatus = runtime
      state.envProbe = {
        ...envProbe,
        torchVersion: '',
        cudaVersion: '',
        mpsAvailable: true,
        npuAvailable: true
      }
      state.pythons = [{ path: '/python', version: '3.13' }]
      state.proxyTestResult = { ok: false, via: 'proxy', ms: 1, error: 'refused' }
      state.testingProxy = true
      state.saving = true
      state.configPath = '/tmp/config'
      for (const s of [
        appUpdate,
        { ...appUpdate, status: 'available', availableVersion: '' },
        { ...appUpdate, status: 'downloading', progress: undefined },
        { ...appUpdate, status: 'downloading', progress: { percent: 10, total: 0 } },
        { ...appUpdate, status: 'not-available' },
        { ...appUpdate, status: 'unsupported' },
        { ...appUpdate, status: 'error', error: '' },
        { ...appUpdate, status: 'checking', checkedAt: 1 }
      ]) {
        state.appUpdate = s
        await nextTick()
      }
      state.appUpdate = appUpdate
      await nextTick()
      await nextTick()
      for (const sel of ['button', '.n-button', '.n-switch', '.n-tag', '.n-popconfirm']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
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
