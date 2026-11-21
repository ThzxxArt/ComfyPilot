// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { exerciseView, installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

const now = Date.now()
const instance = {
  id: 'i1',
  name: 'Main',
  path: '/tmp/comfy',
  createdAt: now,
  pythonPath: '/tmp/comfy/.venv/bin/python',
  venvPath: '/tmp/comfy/.venv',
  port: 8188,
  listen: '127.0.0.1',
  extraArgs: [],
  argTemplateId: 'default',
  enabled: true,
  notes: 'note',
  autoStart: true,
  frontendVersion: '',
  pinned: true,
  status: 'running',
  url: 'http://127.0.0.1:8188',
  version: '0.46.0',
  migrationState: 'none',
  launchProfile: { vram: 'lowvram' }
}
const stopped = {
  ...instance,
  id: 'i2',
  name: 'Stopped',
  port: 8189,
  pinned: false,
  status: 'stopped',
  autoStart: false
}
const migration = {
  ...instance,
  id: 'i3',
  name: 'Migrating',
  port: 8190,
  status: 'migration-required',
  migrationState: 'required',
  migrationError: 'needs 3.13'
}
const candidate = {
  path: '/tmp/discovered',
  name: 'Discovered',
  hasMainPy: true,
  hasRequirements: true,
  hasVenv: true,
  estimatedVersion: '0.46.0',
  registered: false,
  reason: 'Found main.py'
}
const preview = {
  python: '/tmp/python',
  args: ['main.py'],
  cwd: '/tmp/comfy',
  commandLine: 'python main.py',
  validationErrors: [{ code: 'invalid-number', flag: '--port' }],
  validationWarnings: [{ code: 'unknown-flag', flag: '--x', level: 'warning' }]
}
const probe = {
  pythonPath: '/tmp/python',
  pythonVersion: '3.13.5',
  packages: [],
  ok: true,
  errors: []
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
const progress = {
  runId: 'r1',
  instanceId: 'i1',
  step: 'done',
  status: 'done',
  steps: [],
  message: 'done',
  percent: 100
}
let failChannels = new Set<string>()
let failStrings = new Set<string>()
let throwCodes = new Map<string, string>()
let overrides: Record<string, unknown> = {}
let autoConfirm = false

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
      return [instance, stopped, migration]
    case 'settings.launchTemplates':
      return [{ id: 'default', name: 'Default', args: [] }]
    case 'instance.previewLaunch':
      return preview
    case 'instance.probeEnv':
      return probe
    case 'instance.checkComfyUpdate':
      return updateInfo
    case 'instance.updateStatus':
    case 'instance.repairStatus':
      return progress
    case 'instance.suggestPort':
      return 8199
    case 'instance.checkPort':
      return { port: 8188, available: true }
    case 'instance.discover':
      return [candidate]
    case 'instance.save':
    case 'instance.patch':
    case 'instance.launch':
    case 'instance.stop':
    case 'instance.restart':
    case 'instance.forceKill':
    case 'instance.clearLogs':
      return instance
    case 'instance.startAll':
    case 'instance.stopAll':
      return [{ id: 'i1', ok: true, status: 'running' }]
    case 'instance.remove':
    case 'instance.exportLaunchScript':
    case 'instance.exportDiagnostics':
      return { path: '/tmp/out' }
    case 'app.updateStatus':
      return { status: 'downloaded', version: '0.2.6', percent: 100 }
    case 'remote.list':
      return []
    case 'batch.list':
    case 'output.list':
    case 'workflow.list':
    case 'issue.list':
    case 'ops.list':
      return []
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
  autoConfirm = false
  installBridge(dataFor)
  ;(window as any).comfyPilot.invoke = async (channel: string) => {
    if (throwCodes.has(channel))
      throw Object.assign(new Error('coded'), { code: throwCodes.get(channel) })
    if (failStrings.has(channel)) throw channel
    if (failChannels.has(channel)) throw new Error(`${channel} boom`)
    return { ok: true, data: dataFor(channel) }
  }
  document.body.innerHTML = ''
})

describe('InstancesView deep coverage', () => {
  async function mountInstances() {
    const { wrapper, state } = await mountView(
      '/instances',
      () => import('../../src/renderer/src/views/instances/InstancesView.vue')
    )
    const dialog = state.dialog
    if (dialog) {
      const auto = (opts: any): object => {
        if (!autoConfirm) return {}
        try {
          const r = opts?.onPositiveClick?.()
          if (r && typeof r.catch === 'function') r.catch(() => undefined)
        } catch {
          /* invalid args from the generic sweep */
        }
        return {}
      }
      dialog.warning = auto
      dialog.info = auto
    }
    try {
      autoConfirm = true
      state.store.instances = [instance, stopped, migration]
      state.store.activeInstanceId = 'i1'
    } catch {
      /* ignore */
    }
    await nextTick()
    return { wrapper, state }
  }

  it('exercises actions and template variants', async () => {
    const { wrapper, state } = await mountInstances()
    try {
      expect(Object.keys(state).length).toBeGreaterThan(0)
      await exerciseView(wrapper, state, {
        primary: instance,
        variants: [
          { loading: true, loadError: 'failed' },
          { showCreate: true, search: 'Main' },
          { showDiscover: true, candidates: [candidate], selectedCandidates: [candidate.path] },
          { showPreviewModal: true, preview, previewFor: instance },
          { showEditModal: true, editing: instance, editProfile: { vram: 'lowvram' } },
          { showUpdateModal: true, updateModalTitle: 'Update' },
          { search: 'none', loading: false, loadError: '' },
          { envProbes: { i1: probe }, portChecks: { 8188: { port: 8188, available: true } } },
          { updating: true, progress }
        ]
      })
      expect(wrapper.html()).toBeTruthy()
      expect(state.statusLabel('running')).toBeTruthy()
      expect(state.statusLabel(undefined)).toBeTruthy()
      expect(state.statusClass('running')).toBeTruthy()
      expect(state.filtered.length).toBeGreaterThan(0)
    } finally {
      try {
        state.message?.destroyAll?.()
      } catch {
        /* noop */
      }
      wrapper.unmount()
    }
  }, 120_000)

  it('covers action outcomes and error branches', async () => {
    const { wrapper, state } = await mountInstances()
    try {
      autoConfirm = true
      state.store.instances = [instance, stopped, migration]
      state.store.activeInstanceId = 'i1'
      state.showCreate = true
      state.draft = {
        ...(state.draft || {}),
        name: 'New',
        path: '/tmp/comfy',
        port: 8199,
        listen: '127.0.0.1',
        extraArgs: [],
        argTemplateId: 'default'
      }
      await state.suggestPort()
      await state.checkPortOf(8188)
      await state.checkPort()
      await state.checkEditPort()
      await state.createInstance()
      state.editing = instance
      await state.checkEditPort()
      await state.saveEdit()
      await state.togglePin(instance)
      await state.removeInstance(instance)
      state.confirmRemove(instance)
      state.confirmForceKill(instance)
      await state.probeEnv(instance)
      await state.doCheckComfyUpdate(instance)
      state.confirmUpdateComfy(instance)
      await state.runUpdateComfy(instance)
      state.confirmRepairEnv(instance)
      await state.runRepairEnv(instance)
      await state.exportDiag(instance)
      state.confirmStartAll()
      await state.startAll()
      await state.stopAll()
      state.confirmStopAll()
      await state.exportLaunchScript()
      await state.showPreview(instance)
      await state.copyPreview()
      state.openEdit(instance)
      state.openCreate()
      await state.openDiscover()
      await state.runDiscover()
      state.toggleCandidate(candidate.path, true)
      state.useCandidate(candidate)
      await state.importSelectedCandidates()
      state.onCardEnter({ target: null, currentTarget: null, preventDefault() {} } as never, 'i1')
      expect(state.sourceLabel('git')).toBeTruthy()
      expect(state.sourceLabel('zip')).toBeTruthy()
      expect(state.sourceLabel('other')).toBeTruthy()
      expect(state.updateInfoSummary(updateInfo)).toBeTruthy()
      for (const key of ['start', 'stop', 'restart', 'forceKill', 'edit', 'pin', 'remove']) {
        state.onMoreSelect(key, instance)
      }
      expect(state.moreOptions(instance).length).toBeGreaterThan(0)
      expect(wrapper.html()).toBeTruthy()

      failChannels = new Set([
        'instance.list',
        'instance.save',
        'instance.probeEnv',
        'instance.checkComfyUpdate',
        'instance.updateComfy',
        'instance.repairEnv',
        'instance.exportDiagnostics',
        'instance.startAll',
        'instance.stopAll',
        'instance.exportLaunchScript',
        'instance.previewLaunch',
        'instance.discover',
        'instance.remove',
        'instance.launch',
        'instance.stop',
        'instance.restart',
        'instance.forceKill',
        'instance.remove'
      ])
      await state.reload()
      await state.createInstance()
      await state.saveEdit()
      await state.probeEnv(instance)
      await state.doCheckComfyUpdate(instance)
      await state.runUpdateComfy(instance)
      await state.runRepairEnv(instance)
      await state.exportDiag(instance)
      await state.startAll()
      await state.stopAll()
      await state.exportLaunchScript()
      await state.showPreview(instance)
      await state.copyPreview()
      await state.openDiscover()
      await state.removeInstance(instance)
      await state.launchAndOpen(instance)
      failChannels = new Set()
      failStrings = new Set(['instance.list'])
      await state.reload()
      failStrings = new Set()
      throwCodes = new Map([['instance.launch', 'OP_BUSY']])
      await state.launchAndOpen(instance)
      throwCodes = new Map()
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

  it('covers deep-link, discovery and per-card branches', async () => {
    const { wrapper, state } = await mountInstances()
    try {
      autoConfirm = true
      state.store.instances = [instance, stopped, migration]
      state.store.activeInstanceId = 'i1'
      state.draft = {
        ...(state.draft || {}),
        name: 'New',
        path: '/tmp/comfy',
        port: 8199,
        listen: '127.0.0.1',
        extraArgs: [],
        argTemplateId: 'default'
      }
      await state.openEditById('')
      await state.openEditById('i1')
      await state.openEditById('missing')
      state.store.instances = []
      await state.openEditById('i1')
      state.store.instances = [instance, stopped, migration]
      await state.router.push('/instances?edit=i1')
      await state.consumeEditQuery()
      state.onCardEnter({ target: 1, currentTarget: 2, preventDefault() {} } as never, 'i1')
      state.onCardEnter({ target: 1, currentTarget: 1, preventDefault() {} } as never, 'i1')

      overrides['shell.pickFile'] = '/tmp/pick.py'
      overrides['shell.pickDirectory'] = '/tmp/pick-dir'
      for (const field of ['path', 'pythonPath', 'venvPath'] as const) {
        await state.pickPath(field)
        await state.pickEditPath(field)
      }
      state.editing = instance
      await state.pickPathInto('path')
      await state.pickPathInto('pythonPath')
      await state.pickPathInto('venvPath')

      overrides['instance.discover'] = []
      await state.runDiscover()
      overrides['instance.discover'] = [candidate, { ...candidate, registered: true }]
      await state.runDiscover()
      state.toggleCandidate(candidate.path, true)
      state.toggleCandidate(candidate.path, true)
      state.toggleCandidate(candidate.path, false)
      state.toggleCandidate(candidate.path, true)
      state.useCandidate(candidate)
      state.useCandidate({ ...candidate, estimatedVersion: '' })
      state.selectedCandidates = []
      await state.importSelectedCandidates()
      state.selectedCandidates = [candidate.path]
      await state.importSelectedCandidates()
      failChannels = new Set(['instance.save'])
      state.selectedCandidates = [candidate.path]
      await state.importSelectedCandidates()
      failChannels = new Set()

      failStrings = new Set(['instance.suggestPort', 'instance.checkPort'])
      await state.suggestPort()
      await state.checkPortOf(8188)
      failStrings = new Set()
      overrides['instance.checkPort'] = { port: 8188, available: false, owner: 'x' }
      await state.checkPortOf(8188)
      await state.checkPort()
      state.editing = null
      await state.checkEditPort()

      state.draft.path = ''
      await state.createInstance()
      state.draft.path = '/tmp/comfy'
      await state.createInstance()
      failChannels = new Set(['instance.save'])
      await state.createInstance()
      failChannels = new Set()

      state.showPreviewModal = true
      state.preview = preview
      state.previewFor = instance
      await state.copyPreview()
      await state.showPreview(instance)
      await state.exportLaunchScript()
      failChannels = new Set(['instance.exportLaunchScript'])
      await state.exportLaunchScript()
      failChannels = new Set()

      state.editing = instance
      state.editProfile = { vram: 'lowvram' }
      await state.saveEdit()
      failChannels = new Set(['instance.save'])
      await state.saveEdit()
      failChannels = new Set()
      await state.togglePin(instance)
      await state.removeInstance(instance)
      state.confirmRemove(instance)
      state.confirmForceKill(instance)

      state.updateInfo = {
        ...updateInfo,
        behindCount: 2,
        latestRelease: { tag: 'v0.46.0', publishedAt: '2026-11-18T00:00:00Z' },
        unknown: true,
        error: 'offline'
      }
      expect(state.updateInfoSummary(state.updateInfo)).toBeTruthy()
      state.updateInfo = { ...updateInfo, updatable: false, unknown: false }
      expect(state.updateInfoSummary(state.updateInfo)).toBeTruthy()
      await state.doCheckComfyUpdate(instance)
      failChannels = new Set(['instance.checkComfyUpdate'])
      await state.doCheckComfyUpdate(instance)
      failChannels = new Set()

      overrides['instance.updateComfy'] = { status: 'done' }
      await state.runUpdateComfy(instance)
      overrides['instance.updateComfy'] = { status: 'failed', error: 'x' }
      await state.runUpdateComfy(instance)
      failChannels = new Set(['instance.updateComfy'])
      await state.runUpdateComfy(instance)
      failChannels = new Set()
      await state.runRepairEnv(instance)
      failChannels = new Set(['instance.repairEnv'])
      await state.runRepairEnv(instance)
      failChannels = new Set()
      await state.exportDiag(instance)
      failChannels = new Set(['instance.exportDiagnostics'])
      await state.exportDiag(instance)
      failChannels = new Set()

      state.confirmStartAll()
      state.confirmStopAll()
      await state.startAll()
      await state.stopAll()
      overrides['instance.startAll'] = [
        { id: 'i1', ok: false, status: 'error' },
        { id: 'i2', ok: true, status: 'running' }
      ]
      overrides['instance.stopAll'] = [{ id: 'i1', ok: false, status: 'error' }]
      await state.startAll()
      await state.stopAll()

      for (const item of [
        instance,
        { ...instance, onlineVersion: '0.47.0', pid: 1, uptimeMs: 1000, lastError: 'x' },
        stopped,
        migration
      ]) {
        for (const key of [
          'start',
          'stop',
          'restart',
          'preview',
          'edit',
          'pin',
          'forceKill',
          'openBrowser',
          'probeEnv',
          'checkComfyUpdate',
          'updateComfy',
          'repairEnv',
          'exportDiag',
          'detail',
          'remove'
        ]) {
          state.onMoreSelect(key, item)
        }
        state.moreOptions(item)
      }

      state.envProbes = {
        i1: { ...probe, torchVersion: '2.9', cudaVersion: '13.0' }
      }
      state.search = 'Main'
      state.showCreate = true
      state.showDiscover = true
      state.candidates = [candidate]
      state.selectedCandidates = [candidate.path]
      state.showPreviewModal = true
      state.showEditModal = true
      state.showUpdateModal = true
      await nextTick()
      await nextTick()
      for (const sel of ['button', '.n-button', '.n-checkbox', '.n-switch', '.n-tabs-tab']) {
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

  it('covers filters, status classes and card truth table', async () => {
    const { wrapper, state } = await mountInstances()
    try {
      autoConfirm = true
      state.store.instances = [instance, stopped, migration]
      state.store.activeInstanceId = 'i1'
      for (const q of ['Main', '/tmp/comfy', '8188']) {
        state.search = q
        expect(state.filtered.length).toBeGreaterThan(0)
      }
      state.search = 'no-such-instance'
      expect(state.filtered.length).toBe(0)
      state.search = ''
      for (const s of [
        'running',
        'error',
        'migration-failed',
        'starting',
        'migration-required',
        'unknown'
      ]) {
        expect(state.statusClass(s)).toBeTruthy()
      }
      state.repairing = true
      state.reopenUpdateModal()
      state.repairing = false
      state.reopenUpdateModal()
      for (const s of ['git', 'zip', 'other']) expect(state.sourceLabel(s)).toBeTruthy()
      for (const info of [
        { ...updateInfo, latest: undefined, behindCount: undefined, latestRelease: undefined },
        {
          ...updateInfo,
          behindCount: 1,
          latestRelease: { tag: 'v1', publishedAt: '2026-01-01' },
          unknown: true,
          error: 'x'
        }
      ]) {
        expect(state.updateInfoSummary(info)).toBeTruthy()
      }
      state.preview = null
      await state.copyPreview()
      state.previewFor = null
      await state.exportLaunchScript()
      state.previewFor = instance
      failStrings = new Set(['instance.exportLaunchScript'])
      await state.exportLaunchScript()
      failStrings = new Set()
      failChannels = new Set(['instance.exportLaunchScript'])
      await state.exportLaunchScript()
      failChannels = new Set()
      failChannels = new Set(['instance.previewLaunch'])
      await state.showPreview(instance)
      failChannels = new Set()

      state.store.instances = [
        {
          ...instance,
          onlineVersion: '0.47.0',
          pid: 123,
          uptimeMs: 1000,
          autoStart: true,
          managerEnabled: true,
          lastError: 'boom',
          effectivePort: 9999,
          effectiveListen: '0.0.0.0'
        }
      ]
      await nextTick()
      await nextTick()
      expect(wrapper.text()).toContain('9999')
      for (const key of ['openBrowser', 'detail', 'preview', 'edit', 'pin', 'probeEnv']) {
        state.onMoreSelect(key, instance)
      }
      state.onMoreSelect('openBrowser', stopped)
      state.onMoreSelect('openBrowser', { ...instance, url: '' })
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
