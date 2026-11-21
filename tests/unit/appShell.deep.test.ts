// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'
import { discreteUi } from '../../src/renderer/src/utils/discrete'

const instance = {
  id: 'i1',
  name: 'Main',
  path: '/tmp/comfy',
  port: 8188,
  status: 'running',
  enabled: true,
  url: 'http://127.0.0.1:8188'
}
const remote = {
  id: 'r1',
  name: 'Remote',
  baseUrl: 'http://remote:8188',
  label: 'gpu',
  enabled: true
}
const previousExit = { clean: false, at: 1 }

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
      return [remote]
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
    case 'data.migrationState':
      return { ok: true, migratedFiles: 0 }
    case 'data.retryMigration':
      return { ok: true, migratedFiles: 1 }
    case 'issue.list':
      return [{ id: 'x', status: 'open' }]
    case 'instance.pipStatus':
      return null
    case 'app.previousExit':
      return { clean: true }
    case 'app.exportDiagnostics':
      return { path: '/tmp/diag.zip' }
    case 'settings.logsDir':
      return '/tmp/logs'
    case 'ops.list':
      return []
    case 'shell.openExternal':
    case 'shell.openPath':
    case 'monitor.connectWs':
    case 'monitor.disconnectWs':
    case 'instance.launch':
    case 'instance.stop':
      return true
    default:
      return []
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

describe('App shell deep coverage', () => {
  async function mountApp(path = '/') {
    const { wrapper, state } = await mountView(path, () => import('../../src/renderer/src/App.vue'))
    state.store.instances = [instance]
    state.store.remotes = [remote]
    state.store.activeInstanceId = 'i1'
    await nextTick()
    return { wrapper, state }
  }

  it('exercises shell state, navigation, migration, toasts and shortcuts', async () => {
    const { wrapper, state } = await mountApp()
    try {
      expect(state.nav.length).toBeGreaterThan(0)
      expect(state.navGroups.length).toBe(3)
      expect(state.themeOverrides.common.primaryColor).toBeTruthy()
      expect(state.naiveLocale).toBeTruthy()
      expect(state.naiveDateLocale).toBeTruthy()
      expect(document.documentElement.lang).toBe('zh-CN')
      state.locale = 'en-US'
      await nextTick()
      expect(document.documentElement.lang).toBe('en')
      state.locale = 'zh-CN'
      await nextTick()

      await state.router.push('/embed')
      await nextTick()
      expect(state.activeKey).toBe('embed')
      await state.router.push('/models/sub')
      await nextTick()
      expect(state.activeKey).toBe('models')
      await state.router.push('/unknown')
      await nextTick()
      expect(state.activeKey).toBe('dashboard')

      expect(state.runningCount).toBe(1)
      expect(state.instanceOptions.length).toBe(2)
      expect(state.selectedInstanceId).toBe('i1')
      state.selectedInstanceId = 'remote:r1'
      expect(state.store.activeRemoteId).toBe('r1')
      expect(state.store.activeInstanceId).toBeNull()
      expect(state.selectedInstanceId).toBe('remote:r1')
      state.selectedInstanceId = 'i1'
      expect(state.store.activeRemoteId).toBeNull()
      state.selectedInstanceId = null
      expect(state.store.activeInstanceId).toBeNull()
      state.store.activeInstanceId = 'i1'

      expect(state.remoteReady).toBe(false)
      expect(state.activeStatus).toBe('running')
      expect(state.instanceRunning).toBe(true)
      expect(state.activeStatusLabel).toBeTruthy()
      state.store.activeRemoteId = 'r1'
      expect(state.remoteReady).toBe(true)
      expect(state.activeStatus).toBe('running')
      expect(state.instanceRunning).toBe(true)
      expect(state.activeStatusLabel).toBeTruthy()
      state.store.activeRemoteId = 'missing'
      expect(state.remoteReady).toBe(false)
      expect(state.activeStatus).toBe('unknown')
      expect(state.instanceRunning).toBe(false)
      expect(state.activeStatusLabel).toBeTruthy()
      state.store.activeRemoteId = null

      expect(state.sidebarWidth).toBe(240)
      state.toggleCollapse()
      expect(state.collapsed).toBe(true)
      expect(state.sidebarWidth).toBe(72)
      state.onLayoutRequest()
      state.notifyEmbedLayout()
      window.dispatchEvent(new CustomEvent('comfypilot:layout-request'))

      const ui = discreteUi()
      const calls: Array<{ type: string; text: unknown; opts: any }> = []
      for (const type of ['error', 'warning', 'success', 'info'] as const) {
        ;(ui.message as any)[type] = (text: unknown, opts: any) => {
          calls.push({ type, text, opts })
          return { destroy: () => undefined }
        }
      }
      for (let i = 0; i < 5; i++) {
        state.store.pushNotification({
          type: i === 1 ? 'error' : i === 2 ? 'warning' : i === 3 ? 'success' : 'info',
          title: `title ${i}`,
          message: `msg ${i}`,
          duration: 100
        })
      }
      await nextTick()
      expect(calls.length).toBe(3)
      calls[0].opts.onClose()
      await nextTick()
      expect(calls.length).toBeGreaterThan(3)
      state.store.pushNotification({
        type: 'info',
        titleKey: 'nav.dashboard',
        messageKey: 'nav.models'
      })
      await nextTick()

      await state.loadMigrationState()
      expect(state.migrationReadError).toBe('')
      state.migration = { ok: false, error: 'migrate failed', migratedFiles: 0 }
      expect(state.migrationBlocked).toBe(true)
      state.migrationReadError = 'read failed'
      expect(state.migrationBlocked).toBe(false)
      state.migrationReadError = ''
      await state.retryMigration()
      expect(state.migration?.ok).toBe(true)
      state.migration = { ok: false, snapshot: '/tmp/snap', migratedFiles: 0 }
      await state.openMigrationSnapshot()
      state.migration = { ok: false, migratedFiles: 0 }
      await state.openMigrationSnapshot()
      state.migration = null
      await state.openMigrationSnapshot()

      await state.refreshIssueCount()
      expect(state.issueCount).toBe(1)
      state.store.bootstrapError = 'boom'
      await state.retryBootstrap()
      expect(state.store.bootstrapError).toBe('')
      await state.openLogsDir()
      overrides['settings.logsDir'] = ''
      await state.openLogsDir()
      overrides = {}

      await state.checkPreviousExit()
      overrides['app.previousExit'] = previousExit
      const uiDialog = discreteUi().dialog
      const warns: any[] = []
      ;(uiDialog as any).warning = (opts: any) => {
        warns.push(opts)
        opts.onPositiveClick?.()
        return { destroy: () => undefined }
      }
      await state.checkPreviousExit()
      expect(warns.length).toBe(1)
      await state.exportAppDiagnostics()
      overrides = {}

      state.onKeydown({ ctrlKey: false, key: ',' } as never)
      state.onKeydown({ ctrlKey: true, key: ',', preventDefault() {} } as never)
      for (const key of ['1', '2', '9']) {
        state.onKeydown({ ctrlKey: true, key, preventDefault() {} } as never)
      }
      state.onKeydown({ ctrlKey: true, key: '0', preventDefault() {} } as never)
      state.onKeydown({
        ctrlKey: true,
        key: 'Enter',
        target: { tagName: 'INPUT' },
        preventDefault() {}
      } as never)
      state.onKeydown({
        ctrlKey: true,
        key: 'Enter',
        target: { tagName: 'TEXTAREA' },
        preventDefault() {}
      } as never)
      state.onKeydown({
        ctrlKey: true,
        key: 'Enter',
        target: { isContentEditable: true },
        preventDefault() {}
      } as never)
      state.onKeydown({ ctrlKey: true, key: 'Enter', target: null, preventDefault() {} } as never)
      state.onKeydown({ metaKey: true, key: 'Enter', target: null, preventDefault() {} } as never)

      state.store.activeInstanceId = null
      state.store.remotes = []
      await state.launchActive()
      state.store.instances = [instance]
      state.store.activeInstanceId = 'i1'
      state.store.remotes = [remote]
      await state.launchActive()
      state.store.activeRemoteId = 'r1'
      await state.launchActive()
      expect(state.currentFrontendUrl()).toBeTruthy()
      state.store.activeRemoteId = 'missing'
      expect(state.currentFrontendUrl()).toBeNull()
      state.store.activeRemoteId = null

      state.store.instances = [{ ...instance, status: 'stopped' }]
      state.openComfy()
      state.openEmbed()
      state.store.instances = [instance]
      state.openComfy()
      state.openEmbed()
      state.store.remotes = [{ ...remote, baseUrl: '' }]
      state.store.activeRemoteId = 'r1'
      state.openComfy()
      state.openEmbed()
      state.store.activeRemoteId = null
      state.store.remotes = [remote]
      state.openGithub()
      state.toggleCollapse()
      state.toggleCollapse()

      state.store.activeInstanceId = null
      await state.toggleInstanceRun()
      state.store.activeInstanceId = 'i1'
      state.store.instances = [{ ...instance, status: 'running' }]
      await state.toggleInstanceRun()
      state.store.instances = [{ ...instance, status: 'stopped' }]
      await state.toggleInstanceRun()
      state.store.instances = [instance]

      for (const cb of ipcHandlers.get(IPC_EVENTS.issuesChanged) || []) {
        cb([{ status: 'open' }, { status: 'closed' }])
        cb(null)
      }
      for (const cb of ipcHandlers.get(IPC_EVENTS.instanceStatus) || []) {
        cb({ id: 'i1', status: 'starting' })
      }
      for (const cb of ipcHandlers.get(IPC_EVENTS.notification) || []) {
        cb({ type: 'info', title: 'n', message: 'm' })
      }
      state.store.toastQueue = []
      await nextTick()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('covers shell failure branches', async () => {
    const { wrapper, state } = await mountApp()
    try {
      failChannels = new Set([
        'data.migrationState',
        'data.retryMigration',
        'shell.openPath',
        'issue.list',
        'app.previousExit',
        'app.exportDiagnostics',
        'settings.logsDir',
        'instance.list',
        'shell.openExternal',
        'instance.launch',
        'instance.stop'
      ])
      await state.loadMigrationState()
      expect(state.migrationReadError).toBeTruthy()
      state.migration = { ok: false, snapshot: '/tmp/snap', migratedFiles: 0 }
      await state.retryMigration()
      expect(state.migrationReadError).toBeTruthy()
      await state.openMigrationSnapshot()
      await state.refreshIssueCount()
      await state.openLogsDir()
      failChannels = new Set()

      failStrings = new Set([
        'data.migrationState',
        'data.retryMigration',
        'shell.openPath',
        'issue.list',
        'app.previousExit',
        'app.exportDiagnostics',
        'settings.logsDir',
        'instance.list',
        'shell.openExternal',
        'instance.launch',
        'instance.stop'
      ])
      await state.loadMigrationState()
      await state.retryMigration()
      await state.openMigrationSnapshot()
      await state.refreshIssueCount()
      await state.openLogsDir()
      await state.exportAppDiagnostics()
      await state.openComfy()
      await state.openGithub()
      await state.toggleInstanceRun()
      failStrings = new Set()

      state.migration = { ok: false, error: 'bad', snapshot: '', migratedFiles: 0 }
      state.migrationReadError = ''
      await nextTick()
      state.store.bootstrapError = 'bootstrap failed'
      state.migration = null
      state.migrationReadError = 'read error'
      state.issueCount = 120
      state.store.instances = [instance]
      await nextTick()
      for (const sel of ['button', '.n-button']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)
})
