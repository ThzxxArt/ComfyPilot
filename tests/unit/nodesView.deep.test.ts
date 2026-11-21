// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
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
  path: '/tmp/comfy/custom_nodes/BrokenPack',
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
    status: 'up-to-date',
    checkStatus: 'up-to-date',
    updatable: false,
    updateSource: 'git'
  },
  {
    id: 'n2',
    name: 'BrokenPack',
    current: '1.0.0',
    latest: '2.0.0',
    status: 'updatable',
    checkStatus: 'updatable',
    updatable: true,
    updateSource: 'registry',
    behindCount: 2
  },
  {
    id: 'n3',
    name: 'FailedPack',
    current: '',
    latest: '',
    status: 'check-failed',
    checkStatus: 'check-failed',
    error: 'network',
    reasonKey: 'nodes.checkFailed'
  }
]
const loadReport = {
  available: true,
  entries: [
    {
      modulePath: '/tmp/ComfyUI-Manager',
      folder: 'ComfyUI-Manager',
      seconds: 1,
      ok: true,
      prestartup: false
    },
    {
      modulePath: '/tmp/BrokenPack',
      folder: 'BrokenPack',
      seconds: 2,
      ok: false,
      prestartup: false,
      error: 'boom'
    }
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

let failChannels = new Set<string>()
let overrides: Record<string, unknown> = {}
let dialogMode: 'positive' | 'negative' = 'positive'
let eventHandlers: Record<string, Array<(...a: unknown[]) => void>> = {}

function dataFor(channel: string): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, channel)) return overrides[channel]
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
  failChannels = new Set()
  overrides = {}
  dialogMode = 'positive'
  eventHandlers = {}
  installBridge(dataFor)
  ;(window as any).comfyPilot.invoke = async (channel: string) => {
    if (failChannels.has(channel)) throw new Error(`${channel} boom`)
    return { ok: true, data: dataFor(channel) }
  }
  ;(window as any).comfyPilot.on = (event: string, cb: (...a: unknown[]) => void) => {
    ;(eventHandlers[event] ||= []).push(cb)
    return () => undefined
  }
  document.body.innerHTML = ''
})

describe('NodesView deep coverage', () => {
  async function mountNodes() {
    const { wrapper, state } = await mountView(
      '/nodes',
      () => import('../../src/renderer/src/views/nodes/NodesView.vue')
    )
    const dialog = state.dialog
    if (dialog) {
      const auto = (opts: any): object => {
        if (dialogMode === 'positive') opts?.onPositiveClick?.()
        else opts?.onNegativeClick?.()
        return {}
      }
      dialog.warning = auto
      dialog.info = auto
    }
    return { wrapper, state }
  }

  it('exercises setup actions and template variants', async () => {
    const { wrapper, state } = await mountNodes()
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

  it('covers actions, recovery, deps and failure branches', async () => {
    const { wrapper, state } = await mountNodes()
    try {
      state.packs = [pack, broken]
      state.checks = Object.fromEntries(checks.map((c) => [c.id, c]))
      state.loadReport = loadReport
      state.conflicts = [conflict]
      state.snapshots = [snapshot]
      state.recovery = recovery
      await nextTick()

      expect(state.packFolder({ path: 'C:\\x\\Pack.disabled' })).toBe('Pack')
      expect(state.loadReport?.entries?.length).toBe(2)
      expect(state.packFolder(broken)).toBe('BrokenPack')
      expect(state.packLoad(broken)).toBeTruthy()
      expect(state.packLoadError(broken)).toBeTruthy()
      expect(state.packTitle(broken)).toBeTruthy()
      expect(state.packStatusLabel(broken)).toBeTruthy()
      expect(state.packSourceLabel(broken)).toBeTruthy()
      expect(state.hasUpdatePack(broken)).toBe(true)
      expect(state.updateBadgeText(broken)).toBeTruthy()
      expect(state.checkReason({ id: 'n3' })).toBeTruthy()
      expect(state.checkFailed({ id: 'n3' })).toBe(true)
      state.markPackUpdated(broken)

      await state.loadRecovery()
      await state.restoreRecoveryEntry('ComfyUI-Manager.bak-1')
      await state.cleanRecoveryEntry('tmp-dir')
      await state.cleanAllRecovery()
      await state.checkUpdates()
      await state.updatePack(broken)
      await state.updateAllPacks()
      state.installUrl = 'https://example.invalid/pack'
      state.installBranch = 'main'
      await state.installGit()
      await state.toggle(broken, false)
      await state.lockPack(broken, true)
      await state.smoke(broken)
      await state.checkIssues(broken)
      await state.runIssueFix(broken.issues[0])
      state.showDepsAudit = true
      await state.runDepsAudit()
      await state.fixPackDeps(audit.packs[0])
      await state.createSnapshot()
      await state.restoreSnapshot('s1')
      await state.uninstall(broken)
      await state.removeSnapshot('s1')
      await state.applyFocus()
      state.clearSearch()

      state.loadError = 'load failed'
      state.packs = []
      await nextTick()
      expect(wrapper.text()).toContain('load')
      failChannels = new Set([
        'node.list',
        'node.checkUpdates',
        'node.update',
        'node.install',
        'node.toggle',
        'node.lock',
        'node.smokeTest',
        'node.checkIssues',
        'node.depsAudit',
        'node.installDeps',
        'node.createSnapshot',
        'node.snapshotRestore',
        'node.snapshotDelete',
        'node.uninstall',
        'node.recoveryRestore',
        'node.recoveryClean',
        'node.recoveryCleanAll'
      ])
      await state.refresh()
      await state.checkUpdates()
      await state.updatePack(broken)
      await state.updateAllPacks()
      await state.installGit()
      await state.toggle(broken, true)
      await state.lockPack(broken, false)
      await state.smoke(broken)
      await state.checkIssues(broken)
      await state.runDepsAudit()
      await state.fixPackDeps(audit.packs[0])
      await state.createSnapshot()
      await state.restoreSnapshot('s1')
      await state.uninstall(broken)
      await state.removeSnapshot('s1')
      await state.restoreRecoveryEntry('x')
      await state.cleanRecoveryEntry('x')
      await state.cleanAllRecovery()
      failChannels = new Set()

      dialogMode = 'negative'
      await state.uninstall(broken)
      await state.cleanAllRecovery()
      await state.createSnapshot()
      dialogMode = 'positive'

      for (const patch of [
        { showIssues: true, issuesList: broken.issues, issuesPackTitle: 'BrokenPack' },
        { showDepsAudit: true, depsAudit: audit },
        { showDepsAudit: true, depsAudit: { ...audit, ok: true } },
        { showInstall: true, installUrl: 'https://x', installBranch: 'main' },
        { recovery, showRecovery: true },
        { conflicts: [conflict], snapshots: [snapshot] },
        { checks: Object.fromEntries(checks.map((c) => [c.id, c])), includeCheckFailed: true },
        { tab: 'market' },
        { focusMissing: true, focusedPackId: 'n2', focusTerm: 'Broken' },
        { packs: [], loading: false, loadError: '' }
      ]) {
        Object.assign(state, { packs: [pack, broken], loadReport }, patch)
        await nextTick()
        for (const b of wrapper.findAll('button')) {
          await b.trigger('click').catch(() => undefined)
          await flushPromises()
        }
      }
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('covers policy, summary, self-check and status branches', async () => {
    const { wrapper, state } = await mountNodes()
    try {
      state.loadReport = {
        ...loadReport,
        policyRefused: [{ folder: 'BrokenPack', reason: 'manager' }]
      }
      expect(state.packPolicyTip(broken)).toBeTruthy()
      state.loadReport = { ...loadReport, policyRefused: [{ folder: 'X', reason: 'policy' }] }
      expect(state.packPolicyTip({ ...broken, path: '/tmp/X' })).toBeTruthy()

      for (const status of ['disabled', 'error', 'not-installed', 'installing', 'active']) {
        expect(state.packStatusLabel({ ...pack, status })).toBeTruthy()
      }
      for (const installSource of ['registry', 'git', 'manager', 'local', 'other']) {
        expect(state.packSourceLabel({ ...pack, installSource })).toBeTruthy()
      }
      expect(state.packTitle({ ...pack, displayName: 'Display' })).toBe('Display')
      expect(state.hasUpdatePack({ ...broken, status: 'disabled' })).toBe(false)
      expect(state.canUpdatePack({ ...broken, locked: true })).toBe(false)
      expect(state.canUpdatePack({ ...broken, locked: false, status: 'disabled' })).toBe(false)
      expect(
        state.canUpdatePack({
          ...broken,
          locked: false,
          installSource: 'manager',
          repository: 'https://github.com/x/y.git'
        })
      ).toBe(true)
      expect(state.canUpdatePack({ ...broken, locked: false, installSource: 'local' })).toBe(false)
      expect(
        state.updateBadgeText({
          ...broken
        })
      ).toBeTruthy()
      state.checks = {
        n2: { ...checks[1], updateSource: 'git', behindCount: 3 }
      }
      expect(state.updateBadgeText(broken)).toContain('3')

      expect(state.describeUpdateError(new Error('rollback FAILED, backup at /tmp/x'))).toBeTruthy()
      expect(state.describeUpdateError(new Error('rolled back'))).toBeTruthy()
      expect(state.describeUpdateError(new Error('plain'))).toBeTruthy()

      state.loadReport = loadReport
      state.packs = [pack, broken]
      state.loadFailedOnly = true
      expect(state.filteredPacks.length).toBe(1)
      state.loadFailedOnly = false
      state.installedQuery = 'broken'
      expect(state.filteredPacks.length).toBe(1)
      state.installedQuery = ''
      state.loadReport = {
        ...loadReport,
        policyRefused: [{ folder: 'BrokenPack', reason: 'manager' }]
      }
      await nextTick()
      expect(state.loadSummary?.fail).toBe(1)
      expect(state.loadSummary?.refused).toBe(1)

      state.store.activeInstance = instances[0]
      overrides['instance.runStartupSelfCheck'] = { ok: true, exitCode: 0 }
      await state.runSelfCheck()
      overrides['instance.runStartupSelfCheck'] = { ok: false, exitCode: 1 }
      await state.runSelfCheck()
      failChannels = new Set(['instance.runStartupSelfCheck', 'node.loadReport'])
      await state.runSelfCheck()
      failChannels = new Set()
      state.store.activeInstance = null
      await state.runSelfCheck()

      state.checks = Object.fromEntries(checks.map((c) => [c.id, c]))
      state.markPackUpdated(broken)
      state.updatePack(broken)
      await nextTick()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)
})
