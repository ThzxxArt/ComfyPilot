// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { exerciseView, installBridge, mountView, stubBrowser } from '../helpers/deepView'

const now = Date.now()
const pack = {
  id: 'n1',
  name: 'ComfyUI-Manager',
  version: '4.4.2',
  latestVersion: '4.4.2',
  installSource: 'git',
  status: 'active',
  enabled: true,
  locked: false,
  path: '/tmp/comfy/custom_nodes/ComfyUI-Manager',
  repository: 'https://github.com/Comfy-Org/ComfyUI-Manager',
  nodeList: ['Manager'],
  tags: ['manager'],
  issues: [],
  pipDeps: ['requests']
}
const broken = {
  ...pack,
  id: 'n2',
  name: 'BrokenPack',
  version: '1.0.0',
  latestVersion: '2.0.0',
  installSource: 'registry',
  status: 'update-available',
  locked: true,
  repository: 'https://example.invalid/broken',
  nodeList: [],
  issues: [
    {
      id: 'i1',
      packId: 'n2',
      code: 'install-failed',
      severity: 'error',
      message: 'missing dependency',
      suggestion: 'Install deps',
      fixable: true,
      fixId: 'deps',
      pipFailed: true
    }
  ],
  pipDeps: []
}
const conflict = { nodeName: 'KSampler', packs: ['ComfyUI-Manager', 'BrokenPack'] }
const snapshot = { id: 's1', name: 'snap', createdAt: now, packs: [{ name: 'ComfyUI-Manager' }] }
const recovery = [
  { name: 'ComfyUI-Manager.bak-1', kind: 'backup', sizeBytes: 1024, liveExists: false },
  { name: 'tmp-dir', kind: 'temp', sizeBytes: 0, liveExists: true }
]
const checks = [
  {
    id: 'n1',
    name: 'ComfyUI-Manager',
    current: '4.4.2',
    latest: '4.4.2',
    status: 'up-to-date'
  },
  {
    id: 'n2',
    name: 'BrokenPack',
    current: '1.0.0',
    latest: '2.0.0',
    status: 'updatable'
  },
  {
    id: 'n3',
    name: 'FailedPack',
    current: '',
    latest: '',
    status: 'check-failed',
    error: 'network',
    reasonKey: 'nodes.checkFailed'
  }
]
const loadReport = {
  available: true,
  entries: [
    { module: 'ComfyUI-Manager', folder: 'ComfyUI-Manager', status: 'ok', seconds: 1 },
    { module: 'BrokenPack', folder: 'BrokenPack', status: 'failed', seconds: 2, error: 'boom' }
  ]
}
const audit = {
  ok: false,
  error: 'pip mismatch',
  pipCheck: { ok: false, message: 'pip missing' },
  packs: [
    {
      id: 'n2',
      name: 'BrokenPack',
      ok: false,
      missing: ['x'],
      mismatched: ['y'],
      skipped: ['z'],
      unsupported: ['w']
    }
  ],
  unverifiable: ['u']
}
const settings = {
  locale: 'zh-CN',
  activeInstance: 'i1',
  modelScanRoots: [],
  securityLevel: 'normal',
  networkMode: 'public',
  proxy: { enabled: false, protocol: 'http', host: '', port: 7890, bypass: '' }
}
const instances = [{ id: 'i1', name: 'Test', path: '/tmp/comfy', port: 8188, status: 'running' }]
const remotes = [{ id: 'r1', name: 'Remote', baseUrl: 'http://192.168.1.9:8188', enabled: true }]
const market = {
  items: [
    {
      id: 'm1',
      name: 'MarketPack',
      repository: 'https://example.invalid/pack',
      tags: ['tag'],
      status: 'flagged'
    }
  ],
  total: 1,
  totalPages: 1,
  page: 1,
  scanned: 1,
  needsIndex: false
}

function dataFor(channel: string): unknown {
  switch (channel) {
    case 'settings.get':
      return settings
    case 'instance.list':
      return instances
    case 'remote.list':
    case 'remote.listStatus':
      return remotes
    case 'node.list':
    case 'node.refresh':
      return [pack, broken]
    case 'node.managerChannel':
      return [pack]
    case 'node.conflicts':
      return [conflict]
    case 'node.snapshots':
      return [snapshot]
    case 'node.recoveryScan':
      return recovery
    case 'node.checkUpdates':
      return checks
    case 'node.loadReport':
      return loadReport
    case 'node.checkIssues':
      return broken.issues
    case 'node.depsAudit':
      return audit
    case 'node.smokeTest':
      return { ok: true }
    case 'node.getOpProgress':
    case 'node.opStatus':
      return { status: 'running', percent: 50, message: 'working', instanceId: 'i1' }
    case 'node.installDeps':
    case 'node.update':
    case 'node.toggle':
    case 'node.lock':
    case 'node.restoreRecovery':
    case 'node.cleanRecovery':
    case 'node.recoveryRestore':
    case 'node.recoveryClean':
    case 'node.uninstall':
    case 'node.snapshotRestore':
    case 'node.snapshotDelete':
    case 'node.createSnapshot':
      return pack
    case 'workflow.list':
      return []
    case 'batch.list':
      return []
    case 'output.list':
      return { items: [], total: 0, truncated: false }
    case 'issue.list':
      return []
    case 'market.list':
      return market
    case 'registry.indexStatus':
      return { ready: true, updatedAt: now, total: 1, pages: 1, count: 1 }
    case 'ops.list':
      return []
    case 'monitor.system':
      return { gpus: [], cpuUsage: 1, ramTotal: 1, ramUsed: 1, diskFree: 1, diskTotal: 1 }
    case 'monitor.queue':
    case 'monitor.history':
      return { running: [], pending: [], doneCount: 0, history: [] }
    case 'app.updateStatus':
      return null
    default:
      return null
  }
}

beforeAll(() => stubBrowser())
beforeEach(() => {
  installBridge(dataFor)
  document.body.innerHTML = ''
})

describe('NodesView deep coverage', () => {
  it('exercises setup actions and template variants', async () => {
    const { wrapper, state } = await mountView(
      '/nodes',
      () => import('../../src/renderer/src/views/nodes/NodesView.vue')
    )
    try {
      expect(Object.keys(state).length).toBeGreaterThan(0)
      await exerciseView(wrapper, state, {
        primary: broken,
        variants: [
          { loading: true, loadError: 'load failed' },
          { loadError: '', showInstall: true, installUrl: 'https://x', installBranch: 'main' },
          {
            checks: Object.fromEntries(checks.map((c) => [c.id, c])),
            includeCheckFailed: true,
            installedQuery: 'Broken'
          },
          { checks: {}, includeCheckFailed: false, loadFailedOnly: true },
          { conflicts: [conflict], snapshots: [snapshot] },
          { recovery: [], showRecovery: true },
          { showIssues: true, issuesList: broken.issues, issuesPackTitle: 'BrokenPack' },
          { showDepsAudit: true, depsAudit: audit, depsAuditLoading: false },
          { showDepsAudit: true, depsAudit: { ...audit, ok: true } },
          { tab: 'market' },
          {
            focusedPackId: 'n2',
            focusMissing: true,
            focusTerm: 'Broken',
            installedQuery: 'Broken'
          },
          { nodeUpdatingPack: 'n2', nodeInstallingPack: 'n1', nodeBatchActive: true },
          { packs: [], loadError: '', loading: false },
          { localMutable: false }
        ]
      })
      expect(wrapper.html()).toBeTruthy()
      // Negative policy/state checks keep a failure path in this file too.
      expect(state.canUpdatePack({ ...broken, locked: true })).toBe(false)
      expect(state.canUpdatePack({ ...pack, locked: false, status: 'disabled' })).toBe(false)
      expect(state.packPolicyRefused({ ...broken, status: 'disabled' })).toBe(false)
    } finally {
      wrapper.unmount()
    }
  }, 120_000)
})
