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
          h(NMessageProvider, null, {
            default: () => h(NDialogProvider, null, { default: () => slots.default?.() })
          })
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

  it('rejects a broken view loader instead of rendering an empty shell', async () => {
    await expect(
      mountView('/', async () => {
        throw new Error('view load failed')
      })
    ).rejects.toThrow('view load failed')
  })
})
