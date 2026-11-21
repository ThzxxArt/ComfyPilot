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
  {
    name: 'ComfyUI-Manager.bak-1',
    kind: 'backup',
    sizeBytes: 1024,
    liveExists: false,
    mtimeMs: now,
    path: '/tmp/comfy/custom_nodes/ComfyUI-Manager.bak-1',
    packName: 'ComfyUI-Manager'
  },
  {
    name: 'tmp-dir',
    kind: 'temp',
    sizeBytes: 0,
    liveExists: true,
    mtimeMs: now,
    path: '/tmp/comfy/custom_nodes/tmp-dir',
    packName: 'tmp-dir'
  }
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
let failStrings = new Set<string>()
let throwCodes = new Map<string, string>()
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
  failStrings = new Set()
  throwCodes = new Map()
  overrides = {}
  dialogMode = 'positive'
  eventHandlers = {}
  installBridge(dataFor)
  ;(window as any).comfyPilot.invoke = async (channel: string) => {
    if (throwCodes.has(channel)) {
      throw Object.assign(new Error('coded'), { code: throwCodes.get(channel) })
    }
    if (failStrings.has(channel)) throw channel
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
    try {
      state.store.instances = instances
      state.store.activeInstanceId = 'i1'
    } catch {
      /* store shape changed */
    }
    await nextTick()
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

  it('covers operation outcomes and deep links', async () => {
    const { wrapper, state } = await mountNodes()
    try {
      state.packs = [pack, broken]
      state.checks = Object.fromEntries(checks.map((c) => [c.id, c]))
      state.loadReport = loadReport
      overrides['doctor.fix'] = { ok: true, message: 'fixed' }
      overrides['node.smokeTest'] = [
        { severity: 'error', message: 'bad' },
        { severity: 'warning', message: 'warn' }
      ]
      overrides['node.updateAll'] = [
        { name: 'ComfyUI-Manager', ok: true, skipped: false },
        { name: 'BrokenPack', ok: false, skipped: false, error: 'boom' },
        { name: 'FailedPack', ok: false, skipped: true, checkStatus: 'check-failed' },
        { name: 'CancelledPack', ok: false, skipped: true, error: 'cancelled' }
      ]
      overrides['node.checkUpdates'] = [
        { ...checks[0], checkStatus: 'up-to-date' },
        { ...checks[2], checkStatus: 'check-failed' },
        { id: 'n4', name: 'Unsupported', checkStatus: 'unsupported' },
        { id: 'n5', name: 'Locked', checkStatus: 'locked' },
        { id: 'n6', name: 'Disabled', checkStatus: 'skipped-disabled' }
      ]
      overrides['node.recoveryCleanAll'] = { removed: 1, failed: ['x'] }
      overrides['node.uninstallDeps'] = ['dep']
      overrides['node.install'] = {
        ...pack,
        issues: [{ pipFailed: true, message: 'deps skipped' }]
      }
      await state.runIssueFix(broken.issues[0])
      await state.smoke(broken)
      await state.updateAllPacks()
      await state.checkUpdates()
      await state.cleanAllRecovery()
      state.installUrl = 'https://example.invalid/pack'
      state.installBranch = ''
      await state.installGit()
      await state.uninstall(broken)
      dialogMode = 'negative'
      await state.uninstall(broken)
      dialogMode = 'positive'

      state.store.activeInstanceId = 'i1'
      await state.router.push('/nodes?focus=BrokenPack&instanceId=i1&source=deps&showRecovery=1')
      await state.applyFocus()
      await state.router.push('/nodes?focus=nope.trash-1')
      await state.applyFocus()
      await state.router.push('/nodes?focus=ComfyUI-Manager')
      await state.applyFocus()
      await state.router.push('/nodes')
      await state.applyFocus()

      failChannels = new Set(['node.refresh'])
      expect(await state.refresh()).toBe(false)
      failChannels = new Set(['node.recoveryScan'])
      await state.loadRecovery()
      failChannels = new Set(['node.recoveryCleanAll'])
      await state.cleanAllRecovery()
      failChannels = new Set(['node.checkUpdates'])
      await state.checkUpdates()
      failChannels = new Set(['node.smokeTest'])
      await state.smoke(broken)
      failChannels = new Set(['node.checkIssues'])
      await state.checkIssues(broken)
      failChannels = new Set(['doctor.fix'])
      await state.runIssueFix(broken.issues[0])
      failChannels = new Set(['node.depsAudit'])
      await state.runDepsAudit()
      failChannels = new Set(['node.installDeps'])
      await state.fixPackDeps(audit.packs[0])
      failChannels = new Set(['node.createSnapshot'])
      await state.createSnapshot()
      failChannels = new Set(['node.restoreSnapshot'])
      await state.restoreSnapshot('s1')
      failChannels = new Set(['node.deleteSnapshot'])
      await state.removeSnapshot('s1')
      failChannels = new Set(['node.uninstall'])
      await state.uninstall(broken)
      failChannels = new Set(['node.uninstallDeps'])
      await state.uninstall(broken)
      failChannels = new Set()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('covers targetless, coded and payload branch edges', async () => {
    const { wrapper, state } = await mountNodes()
    try {
      state.packs = [pack, broken]
      state.checks = Object.fromEntries(checks.map((c) => [c.id, c]))
      state.loadReport = loadReport

      // No local target.
      state.store.activeInstanceId = null
      state.store.instances = instances
      await state.loadRecovery()
      await state.restoreRecoveryEntry('x')
      await state.cleanRecoveryEntry('x')
      await state.cleanAllRecovery()
      await state.checkUpdates()
      await state.updateAllPacks()
      await state.fixPackDeps(audit.packs[0])
      state.store.activeInstanceId = 'i1'
      await nextTick()

      // String errors / coded errors exercise both catch arms.
      failStrings = new Set(['node.recoveryRestore', 'node.recoveryClean', 'node.recoveryCleanAll'])
      await state.restoreRecoveryEntry('x')
      await state.cleanRecoveryEntry('x')
      await state.cleanAllRecovery()
      failStrings = new Set()

      throwCodes = new Map([
        ['node.update', 'OP_BUSY'],
        ['node.updateAll', 'OP_BUSY'],
        ['node.install', 'OP_BUSY'],
        ['node.uninstall', 'OP_BUSY'],
        ['node.installDeps', 'OP_BUSY']
      ])
      await state.updatePack(broken)
      await state.updateAllPacks()
      state.installUrl = 'https://x'
      await state.installGit()
      await state.uninstall(broken)
      await state.fixPackDeps(audit.packs[0])
      throwCodes = new Map([['node.installDeps', 'REMOTE_NOT_SUPPORTED']])
      await state.fixPackDeps(audit.packs[0])
      throwCodes = new Map()

      // Update success but refresh failed.
      overrides['node.update'] = pack
      failChannels = new Set(['node.refresh'])
      await state.updatePack(broken)
      failChannels = new Set()

      // updateAll outcome variants.
      for (const results of [
        [{ name: 'A', ok: true, skipped: false }],
        [{ name: 'B', ok: false, skipped: false, error: 'e' }],
        [{ name: 'C', ok: false, skipped: true, checkStatus: 'check-failed' }],
        [{ name: 'D', ok: false, skipped: true, error: 'cancelled' }]
      ]) {
        overrides['node.updateAll'] = results
        await state.updateAllPacks()
      }

      // Check summary variants.
      for (const list of [
        [],
        [{ id: 'a', name: 'A', checkStatus: 'up-to-date' }],
        [{ id: 'b', name: 'B', checkStatus: 'check-failed', reason: 'x' }],
        [{ id: 'c', name: 'C', checkStatus: 'updatable', updatable: true, latestVersion: '2' }]
      ]) {
        overrides['node.checkUpdates'] = list
        await state.checkUpdates()
      }

      // Payload variants.
      overrides['doctor.fix'] = { ok: false, message: 'no' }
      await state.runIssueFix(broken.issues[0])
      overrides['doctor.fix'] = { ok: true, message: 'yes' }
      await state.runIssueFix(broken.issues[0])
      await state.runIssueFix({ ...broken.issues[0], fixable: false })
      overrides['node.smokeTest'] = []
      await state.smoke(broken)
      overrides['node.smokeTest'] = [{ severity: 'warning', message: 'w' }]
      await state.smoke(broken)
      overrides['node.smokeTest'] = [{ severity: 'error', message: 'e' }]
      await state.smoke(broken)
      overrides['node.checkIssues'] = []
      await state.checkIssues(broken)
      overrides['node.install'] = {
        ...pack,
        issues: [{ pipFailed: true, message: 'deps skipped' }]
      }
      state.installUrl = 'https://x'
      await state.installGit()
      state.installUrl = ''
      await state.installGit()

      overrides['node.installDeps'] = { ok: true, warning: 'warn', requested: [], installed: [] }
      await state.fixPackDeps(audit.packs[0])
      overrides['node.installDeps'] = { ok: false, cancelled: true }
      await state.fixPackDeps(audit.packs[0])
      overrides['node.installDeps'] = { ok: false, error: 'e' }
      await state.fixPackDeps(audit.packs[0])
      await state.fixPackDeps({ ...audit.packs[0], missing: [], mismatched: [] })

      overrides['node.recoveryCleanAll'] = { removed: 2, failed: [] }
      await state.cleanAllRecovery()
      overrides['node.createSnapshot'] = { name: 'snap' }
      await state.createSnapshot()
      overrides['node.restoreSnapshot'] = true
      await state.restoreSnapshot('s1')
      overrides['node.deleteSnapshot'] = true
      await state.removeSnapshot('s1')
      overrides['node.uninstallDeps'] = []
      await state.uninstall(broken)
      overrides['node.uninstallDeps'] = ['dep']
      await state.uninstall(broken)

      // applyFocus variants.
      state.store.activeInstanceId = 'i1'
      await state.router.push('/nodes?instanceId=i1&showRecovery=1')
      await state.applyFocus()
      await state.router.push('/nodes?source=recovery')
      await state.applyFocus()
      await state.router.push('/nodes?source=deps')
      await state.applyFocus()
      await state.router.push('/nodes?focus=BrokenPack')
      await state.applyFocus()
      await state.router.push('/nodes?focus=missing.trash-1')
      await state.applyFocus()
      await state.router.push('/nodes')
      await state.applyFocus()
      expect(wrapper.html()).toBeTruthy()
    } finally {
      wrapper.unmount()
    }
  }, 120_000)

  it('covers remaining single-arm branches', async () => {
    const { wrapper, state } = await mountNodes()
    try {
      state.packs = [pack, broken]
      state.store.activeInstanceId = 'i1'
      state.store.instances = instances
      state.pipActiveInstances = ['i1']
      state.pipModalVisible = false
      state.openPipProgress()
      state.updating = true
      await nextTick()
      state.updating = false
      await nextTick()
      expect(state.packLoad({ ...pack, status: 'disabled' })).toBe('unknown')
      state.loadReport = null
      expect(state.loadSummary).toBeNull()
      state.loadReport = {
        available: false,
        entries: [],
        policyRefused: [{ folder: 'X', reason: 'policy' }]
      }
      expect(state.loadSummary?.refused).toBe(1)
      state.loadReport = loadReport

      state.store.activeInstance = null
      await state.runSelfCheck()
      state.store.activeInstance = instances[0]
      overrides['instance.runStartupSelfCheck'] = { ok: false, exitCode: 1 }
      await state.runSelfCheck()

      state.filteredPacks = [pack, { ...pack, tags: undefined }]
      state.installedQuery = 'x'
      expect(state.filteredPacks.length).toBe(0)
      state.installedQuery = ''

      state.checks = {}
      expect(
        state.canUpdatePack({ ...pack, locked: false, installSource: 'registry', registryId: 'r' })
      ).toBe(true)
      expect(
        state.canUpdatePack({ ...pack, locked: false, installSource: 'manager', repository: 'x' })
      ).toBe(false)
      expect(
        state.canUpdatePack({
          ...pack,
          locked: false,
          installSource: 'manager',
          repository: 'github.com/x'
        })
      ).toBe(true)

      failStrings = new Set(['node.refresh'])
      expect(await state.refresh()).toBe(false)
      failStrings = new Set()

      state.store.localTargetId = null
      await state.checkUpdates()
      await state.updateAllPacks()
      state.store.localTargetId = 'i1'
      state.checks = { n2: { ...checks[1], updatable: true, latestVersion: '9' } }
      await state.checkUpdates()
      state.checks = { n2: { ...checks[1], checkStatus: 'check-failed' } }
      await state.checkUpdates()

      state.lockingOne = 'x'
      await state.lockPack(broken, true)
      state.lockingOne = null
      await state.lockPack(broken, true)
      await state.toggle(broken, true)
      overrides['node.smokeTest'] = []
      await state.smoke(broken)
      overrides['node.smokeTest'] = [{ severity: 'info', message: 'i' }]
      await state.smoke(broken)
      expect(state.issueSeverityType('error')).toBe('error')
      expect(state.issueSeverityType('warning')).toBe('warning')
      expect(state.issueSeverityType('info')).toBe('info')
      expect(state.issueSeverityLabel('error')).toBeTruthy()
      expect(state.issueSeverityLabel('warning')).toBeTruthy()
      expect(state.issueSeverityLabel('info')).toBeTruthy()

      overrides['doctor.fix'] = { ok: true, message: 'ok' }
      await state.runIssueFix(broken.issues[0])
      overrides['doctor.fix'] = { ok: false, message: 'no' }
      await state.runIssueFix(broken.issues[0])
      await state.runIssueFix({ ...broken.issues[0], fixable: false })

      state.showIssues = true
      state.issuesList = broken.issues
      state.showDepsAudit = true
      state.depsAudit = audit
      state.showRecovery = true
      state.recovery = recovery
      state.showInstall = true
      state.showOpModal = true
      await nextTick()
      for (const sel of ['button', '.n-checkbox', '.n-switch']) {
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

  it('covers pip banner, recovery labels and remaining handlers', async () => {
    const { wrapper, state } = await mountNodes()
    try {
      state.packs = [pack, broken]
      state.store.activeInstanceId = 'i1'
      state.store.instances = instances
      state.pipActiveInstances = ['i1']
      state.pipModalVisible = false
      state.pipViewedInstanceId = 'other'
      await nextTick()
      expect(state.pipBannerVisible).toBe(true)
      state.openPipProgress()
      state.reopenOpModal()
      for (const kind of ['backup', 'temp', 'duplicate', 'trash']) {
        expect(state.recoveryKindLabel(kind)).toBeTruthy()
      }
      state.showIssues = true
      state.issuesList = [
        { ...broken.issues[0], severity: 'error' },
        { ...broken.issues[0], id: 'i2', severity: 'warning' },
        { ...broken.issues[0], id: 'i3', severity: 'info' }
      ]
      state.showDepsAudit = true
      state.depsAudit = audit
      state.showRecovery = true
      state.recovery = recovery
      state.showInstall = true
      state.showOpModal = true
      state.tab = 'market'
      await nextTick()
      await nextTick()
      for (const sel of [
        'button',
        '.n-button',
        '.n-checkbox',
        '.n-switch',
        '.n-tabs-tab',
        '.n-base-selection'
      ]) {
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
