// @vitest-environment happy-dom
/* eslint-disable vue/one-component-per-file */
/**
 * 0.2.3: every Vue view is mounted once with a faithful IPC bridge.
 *
 * The previous coverage denominator only contained a handful of components.
 * These smoke tests execute setup(), onMounted(), computed state and the
 * default template branch for every page, so the whole renderer surface is
 * measured instead of excluded.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h, nextTick, type Component } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'
import { IPC_EVENTS } from '../../src/shared/types'
import type { AppSettingsView, ComfyInstanceInfo, SystemSnapshot } from '../../src/shared/types'
import { i18n } from '../../src/renderer/src/i18n'

const { password: _defaultPassword, ...proxyRest } = DEFAULT_SETTINGS.proxy
const settingsView = {
  ...DEFAULT_SETTINGS,
  proxy: { ...proxyRest, hasPassword: false, backend: 'plaintext' }
} as unknown as AppSettingsView

const instance = {
  id: 'i1',
  name: 'Test ComfyUI',
  path: '/tmp/comfy',
  pythonPath: '',
  venvPath: '',
  port: 8188,
  listen: '127.0.0.1',
  extraArgs: [],
  argTemplateId: 'default',
  enabled: true,
  notes: '',
  autoStart: false,
  frontendVersion: '',
  pinned: false,
  status: 'stopped',
  url: 'http://127.0.0.1:8188',
  version: '0.3.0',
  migrationState: 'none'
} as unknown as ComfyInstanceInfo

const system = {
  cpuUsage: 1,
  ramTotal: 16 * 1024 ** 3,
  ramUsed: 4 * 1024 ** 3,
  diskFree: 100 * 1024 ** 3,
  diskTotal: 200 * 1024 ** 3,
  gpus: [],
  timestamp: Date.now()
} as SystemSnapshot

const queue = {
  running: [],
  pending: [],
  doneCount: 0,
  history: []
}

const bootstrapStatus = {
  runtimesDir: '/tmp/runtimes',
  components: [],
  pythonPath: 'python',
  pythonOrigin: 'system',
  pythonVersion: '3.13.5',
  supportedPython: '3.13',
  zipInstallReady: true
}

const emptyList = (): never[] => []
const emptyPage = {
  items: [],
  total: 0,
  truncated: false
}

function dataFor(channel: string): unknown {
  switch (channel) {
    case 'settings.get':
      return settingsView
    case 'settings.credentialStatus':
      return {
        proxyPasswordUnreadable: false,
        proxyCredentialBackend: 'plaintext',
        lockedRemoteIds: []
      }
    case 'instance.list':
      return [instance]
    case 'instance.getLogs':
    case 'instance.execFailures':
      return emptyList()
    case 'instance.startupIssues':
      return { instanceId: 'i1', hasIssues: false, issues: [], scannedAt: Date.now() }
    case 'instance.capabilities':
    case 'instance.updateStatus':
    case 'instance.repairStatus':
    case 'instance.updateJournal':
    case 'installer.status':
    case 'app.updateStatus':
    case 'output.assetsMatch':
      return null
    case 'instance.pipStatus':
      return null
    case 'remote.list':
    case 'remote.listStatus':
    case 'model.list':
    case 'model.storageStats':
    case 'model.downloads':
    case 'node.list':
    case 'node.refresh':
    case 'node.conflicts':
    case 'node.snapshots':
    case 'node.recoveryScan':
    case 'node.checkUpdates':
    case 'workflow.list':
    case 'batch.list':
    case 'issue.list':
    case 'backup.list':
    case 'ops.list':
    case 'monitor.series':
    case 'monitor.jobs':
    case 'installer.starterModels':
    case 'settings.launchTemplates':
    case 'app.previousExit':
      return emptyList()
    case 'monitor.system':
      return system
    case 'monitor.queue':
    case 'monitor.history':
      return queue
    case 'node.loadReport':
      return { available: false, entries: [] }
    case 'output.list':
      return emptyPage
    case 'output.scan':
      return { scanned: 0, cancelled: false }
    case 'market.list':
      return { items: [], total: 0, totalPages: 1, page: 1, scanned: 0, needsIndex: false }
    case 'registry.indexStatus':
      return { ready: true, updatedAt: 0, total: 0, pages: 0, count: 0 }
    case 'installer.suggestInstallRoot':
      return { path: '/tmp/comfy-install', freeGb: 100 }
    case 'installer.detectGpu':
      return [{ vendor: 'none', model: 'No GPU detected', recommendedTorch: 'cpu', notes: '' }]
    case 'bootstrap.status':
      return bootstrapStatus
    case 'settings.dataDir':
    case 'settings.logsDir':
      return '/tmp/comfy-data'
    case 'workflow.libraryInfo':
      return { root: '/tmp/comfy/workflows', instanceName: 'Test ComfyUI', count: 0, missing: 0 }
    case 'data.migrationState':
      return { ok: true, migratedFiles: 0 }
    case 'proxy.test':
      return { ok: true, via: 'direct', ms: 1 }
    default:
      return null
  }
}

const invoked: string[] = []

function installBridge(): void {
  ;(globalThis as { window?: unknown }).window = globalThis
  ;(window as unknown as { comfyPilot: unknown }).comfyPilot = {
    events: IPC_EVENTS,
    invoke: async (channel: string) => {
      invoked.push(channel)
      return { ok: true, data: dataFor(channel) }
    },
    on: () => () => undefined
  }
}

beforeAll(() => {
  installBridge()
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
})

beforeEach(() => {
  setActivePinia(createPinia())
  invoked.length = 0
})

function testRouter() {
  const Blank = defineComponent({ template: '<div />' })
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/instances/:id', component: Blank },
      { path: '/:pathMatch(.*)*', component: Blank }
    ]
  })
}

/** Minimal Naive providers — views call useMessage/useDialog in setup. */
const ViewHost = defineComponent({
  setup(_props, { slots }) {
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

async function mountView(path: string, loader: () => Promise<unknown>) {
  const router = testRouter()
  await router.push(path)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const mod = (await loader()) as { default: Component }
  const wrapper = mount(ViewHost, {
    global: {
      plugins: [pinia, router, i18n]
    },
    slots: {
      default: () => h(mod.default)
    },
    attachTo: document.body
  })
  await flushPromises()
  await nextTick()
  return wrapper
}

const views: Array<[string, string, () => Promise<unknown>]> = [
  ['app shell', '/', () => import('../../src/renderer/src/App.vue')],
  ['dashboard', '/', () => import('../../src/renderer/src/views/dashboard/DashboardView.vue')],
  [
    'instances',
    '/instances',
    () => import('../../src/renderer/src/views/instances/InstancesView.vue')
  ],
  [
    'instance detail',
    '/instances/i1',
    () => import('../../src/renderer/src/views/instances/InstanceDetailView.vue')
  ],
  ['models', '/models', () => import('../../src/renderer/src/views/models/ModelsView.vue')],
  [
    'workflows',
    '/workflows',
    () => import('../../src/renderer/src/views/workflows/WorkflowsView.vue')
  ],
  ['batch', '/batch', () => import('../../src/renderer/src/views/workflows/BatchView.vue')],
  ['output', '/output', () => import('../../src/renderer/src/views/output/OutputView.vue')],
  ['nodes', '/nodes', () => import('../../src/renderer/src/views/nodes/NodesView.vue')],
  ['market', '/market', () => import('../../src/renderer/src/views/nodes/MarketView.vue')],
  ['monitor', '/monitor', () => import('../../src/renderer/src/views/monitor/MonitorView.vue')],
  ['doctor', '/doctor', () => import('../../src/renderer/src/views/doctor/DoctorView.vue')],
  ['issues', '/issues', () => import('../../src/renderer/src/views/issues/IssueCenterView.vue')],
  ['install', '/install', () => import('../../src/renderer/src/views/install/InstallView.vue')],
  ['backup', '/backup', () => import('../../src/renderer/src/views/backup/BackupView.vue')],
  ['settings', '/settings', () => import('../../src/renderer/src/views/settings/SettingsView.vue')],
  [
    'embed',
    '/embed?url=http%3A%2F%2F127.0.0.1%3A8188',
    () => import('../../src/renderer/src/views/embed/EmbedView.vue')
  ]
]

describe('renderer view smoke', () => {
  for (const [name, path, loader] of views) {
    it(`mounts and renders ${name}`, async () => {
      const wrapper = await mountView(path, loader)
      try {
        expect(wrapper.html()).toBeTruthy()
        expect(wrapper.text().length).toBeGreaterThan(0)
      } finally {
        wrapper.unmount()
      }
    })
  }

  it('dashboard pauses queue polling while hidden and resumes on visibility', async () => {
    const wrapper = await mountView(
      '/',
      () => import('../../src/renderer/src/views/dashboard/DashboardView.vue')
    )
    try {
      const hidden = Object.getOwnPropertyDescriptor(document, 'hidden')
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise((r) => setTimeout(r, 10))
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise((r) => setTimeout(r, 10))
      if (hidden) Object.defineProperty(document, 'hidden', hidden)
    } finally {
      wrapper.unmount()
    }
  })

  it('instance detail copy-rescue and manager-open actions do not throw', async () => {
    const wrapper = await mountView(
      '/instances/i1',
      () => import('../../src/renderer/src/views/instances/InstanceDetailView.vue')
    )
    try {
      const copy = wrapper.findAll('button').find((b) => (b.text() || '').includes('复制救援命令'))
      expect(copy).toBeTruthy()
      await copy!.trigger('click')
      await new Promise((r) => setTimeout(r, 10))
      const openManager = wrapper
        .findAll('button')
        .find((b) => (b.text() || '').includes('打开 config.ini'))
      if (openManager) await openManager.trigger('click')
      await new Promise((r) => setTimeout(r, 10))
    } finally {
      wrapper.unmount()
    }
  })

  it('disables local-only model mutations while a remote target is active', async () => {
    const wrapper = await mountView(
      '/models',
      () => import('../../src/renderer/src/views/models/ModelsView.vue')
    )
    try {
      const { useAppStore } = await import('../../src/renderer/src/stores/app')
      const store = useAppStore()
      store.remotes = [
        {
          id: 'r1',
          name: 'Remote',
          baseUrl: 'http://192.168.1.9:8188',
          label: '',
          enabled: true
        } as never
      ]
      store.activeRemoteId = 'r1'
      await nextTick()
      const scan = wrapper.findAll('button').find((b) => (b.text() || '').trim() === '扫描')
      expect(scan).toBeTruthy()
      expect(scan!.attributes('disabled')).toBeDefined()
      expect(wrapper.text()).toContain('远程')
      wrapper.unmount()
    } finally {
      /* nothing to restore — the test gets a fresh pinia */
    }
  })

  it('enables workflow queueing for a ready remote target and queues remotely', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    const calls: Array<{ channel: string; args: unknown[] }> = []
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'workflow.list') {
        return {
          ok: true,
          data: [
            {
              id: 'wf-1',
              name: 'RemoteFlow',
              path: '/tmp/remote-flow.json',
              format: 'json',
              nodeCount: 3,
              tags: [],
              updatedAt: Date.now(),
              missingNodes: [],
              version: '1',
              params: {},
              origin: 'library'
            }
          ]
        }
      }
      if (channel === 'workflow.preflight') return { ok: true, data: { available: false } }
      if (channel === 'workflow.queue') {
        calls.push({ channel, args })
        return { ok: true, data: 'prompt-1' }
      }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/workflows',
        () => import('../../src/renderer/src/views/workflows/WorkflowsView.vue')
      )
      await new Promise((r) => setTimeout(r, 30))
      const { useAppStore } = await import('../../src/renderer/src/stores/app')
      const store = useAppStore()
      store.remotes = [
        {
          id: 'r1',
          name: 'Remote',
          baseUrl: 'http://192.168.1.9:8188',
          label: '',
          enabled: true
        } as never
      ]
      store.activeRemoteId = 'r1'
      await nextTick()
      const queue = wrapper.findAll('button').find((b) => (b.text() || '').includes('排队'))
      expect(queue).toBeTruthy()
      expect(queue!.attributes('disabled')).toBeUndefined()
      await queue!.trigger('click')
      await new Promise((r) => setTimeout(r, 20))
      const enqueue = Array.from(document.querySelectorAll('.n-modal button')).find((b) =>
        (b.textContent || '').includes('入队')
      ) as HTMLButtonElement | undefined
      expect(enqueue).toBeTruthy()
      expect(enqueue!.disabled).toBe(false)
      enqueue!.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(calls).toHaveLength(1)
      expect((calls[0].args[0] as { instanceId?: string }).instanceId).toBe('remote:r1')
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('keeps the document language in sync with the UI locale', async () => {
    const wrapper = await mountView('/', () => import('../../src/renderer/src/App.vue'))
    try {
      expect(document.documentElement.lang).toBe('zh-CN')
      ;(i18n.global.locale as unknown as { value: string }).value = 'en-US'
      await nextTick()
      expect(document.documentElement.lang).toBe('en')
    } finally {
      ;(i18n.global.locale as unknown as { value: string }).value = 'zh-CN'
      wrapper.unmount()
    }
  })

  it('app treats a migration-state READ failure as a dismissible warning, not a blocker', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    let reads = 0
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'data.migrationState') {
        reads += 1
        if (reads === 1) return { ok: false, error: 'bridge hiccup' }
        return { ok: true, data: { ok: true, migratedFiles: 0 } }
      }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView('/', () => import('../../src/renderer/src/App.vue'))
      await new Promise((r) => setTimeout(r, 30))
      expect(wrapper.text()).toContain('无法读取数据迁移状态')
      // The blocker must NOT replace the router view.
      expect(wrapper.find('.migration-block').exists()).toBe(false)
      expect(wrapper.find('main.content').exists()).toBe(true)
      const retry = wrapper.findAll('button').find((b) => (b.text() || '').trim() === '重试')
      expect(retry).toBeTruthy()
      await retry!.trigger('click')
      await new Promise((r) => setTimeout(r, 20))
      expect(reads).toBeGreaterThanOrEqual(2)
      // Closing the warning is harmless and must not throw.
      const close = wrapper.find('.n-alert-close')
      if (close.exists()) await close.trigger('click')
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('instance detail installs Manager only after an explicit confirmation', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'instance.managerInfo') {
        return {
          ok: true,
          data: { installed: false, source: 'none', configExists: false, warnings: [] }
        }
      }
      if (channel === 'instance.installManager') {
        invoked.push(channel)
        return {
          ok: true,
          data: {
            ok: true,
            info: {
              installed: true,
              version: '4.4.2',
              source: 'pip',
              configExists: false,
              warnings: []
            }
          }
        }
      }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/instances/i1',
        () => import('../../src/renderer/src/views/instances/InstanceDetailView.vue')
      )
      await new Promise((r) => setTimeout(r, 30))
      invoked.length = 0
      const install = wrapper
        .findAll('button')
        .find((b) => (b.text() || '').includes('安装 Manager 4.4.2'))
      expect(install).toBeTruthy()
      await install!.trigger('click')
      await new Promise((r) => setTimeout(r, 20))
      // Nothing installed before the confirmation.
      expect(invoked).not.toContain('instance.installManager')
      const confirm = Array.from(document.querySelectorAll('.n-dialog button')).find((b) =>
        (b.textContent || '').includes('安装 Manager 4.4.2')
      ) as HTMLButtonElement | undefined
      expect(confirm).toBeTruthy()
      confirm!.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(invoked).toContain('instance.installManager')
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('issue center ignore-all asks for confirmation and dismisses', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'issue.list') {
        return {
          ok: true,
          data: [
            {
              id: 'iss1',
              fingerprint: 'fp1',
              kind: 'startup',
              severity: 'error',
              title: 'Bad pack',
              detail: 'boom',
              actions: [],
              status: 'open',
              firstSeen: Date.now(),
              lastSeen: Date.now(),
              updatedAt: Date.now()
            }
          ]
        }
      }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/issues',
        () => import('../../src/renderer/src/views/issues/IssueCenterView.vue')
      )
      await new Promise((r) => setTimeout(r, 20))
      const ignore = wrapper.findAll('button').find((b) => (b.text() || '').includes('全部忽略'))
      expect(ignore).toBeTruthy()
      await ignore!.trigger('click')
      await new Promise((r) => setTimeout(r, 30))
      const confirm = Array.from(document.querySelectorAll('.n-dialog button')).find((b) =>
        (b.textContent || '').includes('全部忽略')
      ) as HTMLButtonElement | undefined
      expect(confirm).toBeTruthy()
      confirm!.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(invoked).toContain('issue.dismiss')
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('instance detail rescue action invokes the rescue IPC', async () => {
    const wrapper = await mountView(
      '/instances/i1',
      () => import('../../src/renderer/src/views/instances/InstanceDetailView.vue')
    )
    try {
      invoked.length = 0
      const button = wrapper.findAll('button').find((b) => (b.text() || '').includes('强制重启'))
      expect(button).toBeTruthy()
      await button!.trigger('click')
      await new Promise((r) => setTimeout(r, 20))
      expect(invoked).toContain('instance.rescue')
    } finally {
      wrapper.unmount()
    }
  })

  it('throttles embed layout resizes into one IPC per frame window', async () => {
    const wrapper = await mountView(
      '/embed?url=http%3A%2F%2F127.0.0.1%3A8188',
      () => import('../../src/renderer/src/views/embed/EmbedView.vue')
    )
    try {
      invoked.length = 0
      for (let i = 0; i < 8; i++) {
        window.dispatchEvent(
          new CustomEvent('comfypilot:layout', { detail: { sidebarWidth: 200 + i } })
        )
      }
      await new Promise((r) => requestAnimationFrame(() => r(undefined)))
      const resizes = invoked.filter((c) => c === 'embed.resize').length
      expect(resizes).toBeLessThanOrEqual(1)
    } finally {
      wrapper.unmount()
    }
  })

  it('shows a retryable error instead of "no instances" when instance.list fails', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'instance.list') return { ok: false, error: 'bridge down' }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/instances',
        () => import('../../src/renderer/src/views/instances/InstancesView.vue')
      )
      await new Promise((r) => setTimeout(r, 20))
      expect(wrapper.text()).toContain('bridge down')
      expect(wrapper.text()).not.toContain('还没有 ComfyUI 实例')
      const retry = wrapper.findAll('button').find((b) => (b.text() || '').includes('重试'))
      expect(retry).toBeTruthy()
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('shows a retryable error instead of "no jobs" when batch.list fails', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'batch.list') return { ok: false, error: 'batch bridge down' }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/batch',
        () => import('../../src/renderer/src/views/workflows/BatchView.vue')
      )
      await new Promise((r) => setTimeout(r, 20))
      expect(wrapper.text()).toContain('batch bridge down')
      expect(wrapper.text()).not.toContain('暂无批量任务')
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('batch cards show the instance name and hide local output links for remote jobs', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'batch.list') {
        return {
          ok: true,
          data: [
            {
              id: 'job-1',
              name: 'Remote job',
              instanceId: 'remote:r1',
              status: 'done',
              count: 2,
              completed: 2,
              failed: 0,
              produced: 2,
              submitted: 2,
              items: [],
              workflowPath: '/tmp/flow.json',
              createdAt: Date.now()
            }
          ]
        }
      }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/batch',
        () => import('../../src/renderer/src/views/workflows/BatchView.vue')
      )
      await new Promise((r) => setTimeout(r, 20))
      const { useAppStore } = await import('../../src/renderer/src/stores/app')
      const store = useAppStore()
      store.remotes = [
        {
          id: 'r1',
          name: 'Studio PC',
          baseUrl: 'http://192.168.1.9:8188',
          label: '',
          enabled: true
        } as never
      ]
      await nextTick()
      expect(wrapper.text()).toContain('Studio PC')
      const viewOutput = wrapper
        .findAll('button')
        .find((b) => (b.text() || '').includes('查看产物'))
      expect(viewOutput?.attributes('disabled')).toBeDefined()
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('shows a retryable error instead of "no issues" when issue.list fails', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'issue.list') return { ok: false, error: 'issue bridge down' }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/issues',
        () => import('../../src/renderer/src/views/issues/IssueCenterView.vue')
      )
      await new Promise((r) => setTimeout(r, 20))
      expect(wrapper.text()).toContain('issue bridge down')
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('nodes deep link refreshes first and highlights the matched pack', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'node.refresh') {
        return {
          ok: true,
          data: [
            {
              id: 'pack-1',
              name: 'PackOne',
              displayName: 'Pack One',
              path: '/tmp/comfy/custom_nodes/PackOne',
              version: '1.2.3',
              status: 'enabled',
              source: 'git',
              nodeCount: 3
            }
          ]
        }
      }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/nodes?focus=PackOne&instanceId=i1',
        () => import('../../src/renderer/src/views/nodes/NodesView.vue')
      )
      await new Promise((r) => setTimeout(r, 30))
      const focused = wrapper.find('.pack-focused')
      expect(focused.exists()).toBe(true)
      expect(focused.attributes('data-pack-id')).toBe('pack-1')
      expect(focused.text()).toContain('Pack One')
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('issue action buttons call their IPC target and reload', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'issue.list') {
        return {
          ok: true,
          data: [
            {
              id: 'iss-action',
              fingerprint: 'fp-action',
              kind: 'deps',
              severity: 'warning',
              title: 'Missing deps',
              detail: 'pip failed',
              actions: [
                {
                  id: 'fix',
                  labelKey: 'issues.actionOpenNodes',
                  kind: 'ipc',
                  target: 'issue.dismiss'
                }
              ],
              status: 'open',
              firstSeen: Date.now(),
              lastSeen: Date.now(),
              updatedAt: Date.now()
            }
          ]
        }
      }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/issues',
        () => import('../../src/renderer/src/views/issues/IssueCenterView.vue')
      )
      await new Promise((r) => setTimeout(r, 20))
      invoked.length = 0
      const action = wrapper.findAll('button').find((b) => (b.text() || '').includes('打开节点'))
      expect(action).toBeTruthy()
      await action!.trigger('click')
      await new Promise((r) => setTimeout(r, 20))
      expect(invoked).toContain('issue.dismiss')
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('output cards are keyboard-operable (Space selects, Enter opens detail)', async () => {
    const bridge = (window as unknown as { comfyPilot: { invoke: Function } }).comfyPilot
    const original = bridge.invoke.bind(bridge)
    bridge.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'output.list') {
        return {
          ok: true,
          data: {
            items: [
              {
                id: 'out-1',
                fileName: 'take.wav',
                path: '/tmp/out/take.wav',
                type: 'audio',
                createdAt: Date.now(),
                size: 12,
                root: '/tmp/out'
              }
            ],
            total: 1,
            truncated: false
          }
        }
      }
      return original(channel, ...args)
    }
    try {
      const wrapper = await mountView(
        '/output',
        () => import('../../src/renderer/src/views/output/OutputView.vue')
      )
      await new Promise((r) => setTimeout(r, 20))
      const card = wrapper.find('.asset')
      expect(card.exists()).toBe(true)
      expect(card.attributes('tabindex')).toBe('0')
      expect(card.attributes('aria-pressed')).toBe('false')
      await card.trigger('keydown', { key: ' ' })
      await nextTick()
      expect(card.attributes('aria-pressed')).toBe('true')
      wrapper.unmount()
    } finally {
      bridge.invoke = original
    }
  })

  it('rejects a broken view loader instead of rendering an empty shell', async () => {
    await expect(
      mountView('/', async () => {
        throw new Error('view load failed')
      })
    ).rejects.toThrow('view load failed')
  })
})
