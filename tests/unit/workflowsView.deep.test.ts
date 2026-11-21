// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

const workflow = {
  id: 'w1',
  name: 'Base',
  path: '/tmp/wf/base.json',
  format: 'json',
  nodeCount: 12,
  tags: ['tag', 'base'],
  description: 'desc',
  updatedAt: 1,
  missingNodes: ['MissingNode'],
  version: '1.0',
  seed: 42,
  modelUsed: 'sdxl.safetensors',
  params: {},
  origin: 'library',
  sourcePath: '/tmp/source/base.json',
  favorite: true,
  missing: false
}
const external = {
  ...workflow,
  id: 'w2',
  name: 'External',
  path: '/tmp/wf/ext.png',
  format: 'png',
  tags: [],
  missingNodes: [],
  origin: 'external',
  favorite: false,
  missing: true,
  seed: undefined,
  modelUsed: undefined,
  description: undefined,
  sourcePath: undefined
}
const instanceWf = {
  ...workflow,
  id: 'w3',
  name: 'Instance',
  path: '/tmp/wf/inst.json',
  origin: 'instance',
  favorite: false,
  missing: false
}
const compareResult = {
  a: { id: 'w1', name: 'Base' },
  b: { id: 'w3', name: 'Instance' },
  diffs: [
    { field: 'name', a: 'Base', b: 'Instance', changed: true },
    { field: 'nodeCount', a: '12', b: '12', changed: false },
    { field: 'other', a: 'x', b: 'y', changed: true }
  ],
  nodesOnlyA: ['NodeA'],
  nodesOnlyB: ['NodeB'],
  missingNodes: []
}
const modelPreflight = {
  available: true,
  required: 2,
  present: 1,
  missing: [{ name: 'missing.safetensors', nodeType: 'CheckpointLoader', present: false }]
}
const nodePreflight = { available: true, missingTypes: ['NodeA', 'NodeB'], nodeTypes: 10 }

let failChannels = new Set<string>()
let failStrings = new Set<string>()
let overrides: Record<string, unknown> = {}
let dialogChoice = 'positive'
let dialogContents = 0

function dataFor(channel: string): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, channel)) return overrides[channel]
  switch (channel) {
    case 'settings.get':
      return { locale: 'zh-CN', activeInstance: 'i1', modelScanRoots: [] }
    case 'instance.list':
      return [
        {
          id: 'i1',
          name: 'Main',
          path: '/tmp/comfy',
          port: 8188,
          status: 'running',
          enabled: true
        },
        {
          id: 'i2',
          name: 'Stopped',
          path: '/tmp/comfy2',
          port: 8189,
          status: 'stopped',
          enabled: true
        }
      ]
    case 'remote.list':
      return [{ id: 'r1', name: 'Remote', baseUrl: 'http://x', enabled: true }]
    case 'monitor.system':
      return { cpu: 1, memory: 1 }
    case 'workflow.list':
      return [workflow, external, instanceWf]
    case 'workflow.libraryInfo':
      return { root: '/tmp/library', missing: 1 }
    case 'workflow.importMany':
      return { ok: [{ name: 'Base' }], errors: [] }
    case 'workflow.importDefault':
      return workflow
    case 'workflow.checkModels':
      return modelPreflight
    case 'workflow.preflight':
      return nodePreflight
    case 'workflow.queue':
      return 'p1'
    case 'workflow.compare':
      return compareResult
    case 'workflow.exportZip':
    case 'workflow.copyToInstance':
    case 'workflow.openInFrontend':
      return { path: '/tmp/out.zip', mode: 'embed', instanceName: 'Main' }
    case 'batch.create':
      return { id: 'b1' }
    case 'shell.pickFiles':
      return ['/tmp/a.json', '/tmp/b.png']
    case 'shell.pickDirectory':
      return '/tmp/export'
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
  dialogContents = 0
  installBridge(dataFor)
  ;(window as any).comfyPilot.invoke = async (channel: string) => {
    if (failChannels.has(channel)) throw new Error(`${channel} boom`)
    if (failStrings.has(channel)) throw channel
    return { ok: true, data: dataFor(channel) }
  }
  document.body.innerHTML = ''
})

describe('WorkflowsView deep coverage', () => {
  async function mountWorkflows() {
    const { wrapper, state } = await mountView(
      '/workflows',
      () => import('../../src/renderer/src/views/workflows/WorkflowsView.vue')
    )
    const dialog = state.dialog
    if (dialog) {
      const auto = (opts: any): object => {
        try {
          if (typeof opts?.content === 'function') {
            dialogContents += 1
            opts.content()
          }
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
    state.store.instances = [
      {
        id: 'i1',
        name: 'Main',
        path: '/tmp/comfy',
        port: 8188,
        status: 'running',
        enabled: true
      },
      {
        id: 'i2',
        name: 'Stopped',
        path: '/tmp/comfy2',
        port: 8189,
        status: 'stopped',
        enabled: true
      }
    ]
    state.store.activeInstanceId = 'i1'
    state.store.remotes = [{ id: 'r1', name: 'Remote', baseUrl: 'http://x', enabled: true }]
    await state.refresh()
    await nextTick()
    return { wrapper, state }
  }

  it('exercises filters, cards, import, detail and compare actions', async () => {
    const { wrapper, state } = await mountWorkflows()
    try {
      expect(state.filtered.length).toBe(3)
      state.keyword = 'base'
      expect(state.filtered.length).toBeGreaterThan(0)
      state.keyword = 'tag'
      expect(state.filtered.length).toBeGreaterThan(0)
      state.keyword = '/tmp/wf/ext.png'
      expect(state.filtered.length).toBe(1)
      state.keyword = 'none'
      expect(state.filtered.length).toBe(0)
      state.keyword = ''
      state.onlyFavorites = true
      expect(state.filtered.length).toBe(1)
      expect(state.hasFilter).toBe(true)
      state.clearFilters()
      expect(state.hasFilter).toBe(false)
      for (const o of ['library', 'instance', 'external']) expect(state.originLabel(o)).toBeTruthy()
      expect(state.cmpFieldLabel('name')).toBeTruthy()
      expect(state.cmpFieldLabel('custom')).toBe('custom')
      expect(state.compareOptions).toHaveLength(3)
      for (const o of ['library', 'instance', 'external']) {
        expect(state.deleteConfirmText({ ...workflow, origin: o })).toBeTruthy()
      }
      expect(state.queueOptions.length).toBeGreaterThan(0)
      expect(state.needInstanceHint).toBeTruthy()
      expect(state.queueEntryReady).toBe(true)

      await state.toggleFavorite(workflow)
      state.openRename(workflow)
      expect(state.showRename).toBe(true)
      state.renameValue = '   '
      await state.doRename()
      expect(state.showRename).toBe(true)
      state.renameValue = 'Renamed'
      await state.doRename()
      expect(state.showRename).toBe(false)
      state.openTags(workflow)
      expect(state.showTags).toBe(true)
      state.tagsValue = ['x']
      await state.doTags()
      expect(state.showTags).toBe(false)
      state.tagsTarget = null
      await state.doTags()

      await state.removeRow(workflow)
      await state.removeRow(instanceWf)
      await state.removeRow(external)

      await state.exportZip(workflow)
      overrides['shell.pickDirectory'] = ''
      await state.exportZip(workflow)
      overrides = {}
      await state.copyToInstance(workflow)
      state.store.activeInstanceId = null
      await state.copyToInstance(workflow)
      state.store.activeInstanceId = 'i1'

      await state.openInFrontend(workflow)
      state.openingFrontend = true
      await state.openInFrontend(workflow)
      state.openingFrontend = false
      state.store.instances = [{ ...state.store.instances[0], status: 'stopped' }]
      await state.openInFrontend(workflow)
      overrides['workflow.openInFrontend'] = { mode: 'browser', instanceName: 'Main' }
      state.store.instances = [
        { ...state.store.instances[0], status: 'running' },
        state.store.instances[1]
      ]
      await state.openInFrontend(workflow)
      overrides = {}
      await state.reveal(workflow)
      state.openDetail(workflow)
      expect(state.showDetail).toBe(true)
      await state.safeRevealPath('/tmp/library')

      await state.importFile()
      overrides['shell.pickFiles'] = []
      await state.importFile()
      overrides['shell.pickFiles'] = ['/tmp/a.json']
      await state.importFile()
      overrides['workflow.importMany'] = {
        ok: [{ name: 'Base' }],
        errors: [{ path: '/tmp/a.json', message: 'bad' }]
      }
      await state.importFile()
      expect(dialogContents).toBeGreaterThan(0)
      overrides = {}
      state.store.activeInstanceId = null
      await state.importFile()
      state.store.activeInstanceId = 'i1'

      await state.importDefaultWorkflow()
      state.importingDefault = true
      await state.importDefaultWorkflow()
      state.importingDefault = false
      const unsupported = Object.assign(new Error('old'), { code: 'DEFAULT_WORKFLOW_UNSUPPORTED' })
      failChannels = new Set()
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'workflow.importDefault') throw unsupported
        return { ok: true, data: dataFor(channel) }
      }
      await state.importDefaultWorkflow()
      state.store.activeInstanceId = null
      await state.importDefaultWorkflow()
      state.store.activeInstanceId = 'i1'
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (failChannels.has(channel)) throw new Error(`${channel} boom`)
        if (failStrings.has(channel)) throw channel
        return { ok: true, data: dataFor(channel) }
      }

      state.openCompare()
      expect(state.showCompare).toBe(true)
      state.openCompare(workflow)
      expect(state.compareA).toBe('w1')
      state.compareB = 'w1'
      state.openCompare(workflow)
      expect(state.compareB).toBeNull()
      state.compareA = null
      state.compareB = 'w3'
      await state.runCompare()
      expect(state.compareResult).toBeNull()
      state.compareA = 'w1'
      await state.runCompare()
      expect(state.compareResult).toBeTruthy()
      state.comparing = true
      await state.runCompare()
      state.comparing = false

      await state.checkDeps(workflow)
      expect(state.depResult.models).toBeTruthy()
      state.store.activeInstanceId = null
      await state.checkDeps(workflow)
      state.store.activeInstanceId = 'i1'
      state.goMissingModel('missing.safetensors')
      state.goMissingNodes()
      await flushPromises()

      state.openQueue(workflow)
      expect(state.showQueue).toBe(true)
      state.closeQueue()
      expect(state.showQueue).toBe(false)
      state.store.activeRemoteId = 'r1'
      state.openQueue(workflow)
      expect(state.queueInstanceId.startsWith('remote:')).toBe(true)
      state.closeQueue()
      state.store.activeRemoteId = null
      state.store.activeInstanceId = null
      state.openQueue(workflow)
      expect(state.queueInstanceId).toBe('i1')
      state.closeQueue()
      state.store.instances = [{ ...state.store.instances[0], status: 'stopped' }]
      state.openQueue(workflow)
      expect(state.queueInstanceId).toBe('remote:r1')
      state.closeQueue()

      state.queueTarget = workflow
      state.queueInstanceId = 'i2'
      await state.doQueue()
      state.queuing = true
      await state.doQueue()
      state.queuing = false
      state.queueTarget = null
      await state.doQueue()

      state.queueTarget = workflow
      state.queueInstanceId = 'i1'
      await state.doQueue()
      expect(dialogContents).toBeGreaterThan(0)
      overrides['workflow.preflight'] = { available: true, missingTypes: ['X'], nodeTypes: 1 }
      await state.doQueue()
      dialogChoice = 'negative'
      await state.doQueue()
      dialogChoice = 'close'
      await state.doQueue()
      dialogChoice = 'mask'
      await state.doQueue()
      dialogChoice = 'positive'
      overrides['workflow.queue'] = ''
      await state.doQueue()
      overrides['workflow.queue'] = null
      await state.doQueue()
      overrides = {}

      await state.sendToBatch(workflow)
      state.store.activeInstanceId = null
      await state.sendToBatch(workflow)
      state.store.activeInstanceId = 'i1'

      state.items = [workflow, external]
      state.keyword = 'Base'
      expect(state.filtered).toHaveLength(1)
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

  it('covers failure branches for every action', async () => {
    const { wrapper, state } = await mountWorkflows()
    try {
      failChannels = new Set([
        'workflow.list',
        'workflow.libraryInfo',
        'workflow.importMany',
        'workflow.importDefault',
        'workflow.favorite',
        'workflow.rename',
        'workflow.tag',
        'workflow.delete',
        'workflow.reveal',
        'workflow.exportZip',
        'workflow.copyToInstance',
        'workflow.openInFrontend',
        'workflow.checkModels',
        'workflow.preflight',
        'workflow.queue',
        'workflow.compare',
        'batch.create',
        'shell.pickFiles',
        'shell.pickDirectory',
        'shell.reveal'
      ])
      await state.refresh()
      expect(state.loadError).toBeTruthy()
      await state.importFile()
      await state.importDefaultWorkflow()
      await state.toggleFavorite(workflow)
      state.renameTarget = workflow
      state.renameValue = 'R'
      await state.doRename()
      state.tagsTarget = workflow
      await state.doTags()
      await state.removeRow(workflow)
      await state.exportZip(workflow)
      await state.copyToInstance(workflow)
      await state.openInFrontend(workflow)
      await state.reveal(workflow)
      await state.checkDeps(workflow)
      await state.runCompare()
      state.compareA = 'w1'
      state.compareB = 'w3'
      await state.runCompare()
      state.queueTarget = workflow
      state.queueInstanceId = 'i1'
      await state.doQueue()
      await state.safeRevealPath('/tmp/x')
      await state.sendToBatch(workflow)
      failChannels = new Set()

      failStrings = new Set([
        'workflow.list',
        'workflow.libraryInfo',
        'workflow.importMany',
        'workflow.importDefault',
        'workflow.favorite',
        'workflow.rename',
        'workflow.tag',
        'workflow.delete',
        'workflow.reveal',
        'workflow.exportZip',
        'workflow.copyToInstance',
        'workflow.openInFrontend',
        'workflow.queue',
        'workflow.compare',
        'batch.create',
        'shell.pickFiles',
        'shell.pickDirectory',
        'shell.reveal'
      ])
      await state.refresh()
      await state.importFile()
      await state.importDefaultWorkflow()
      await state.toggleFavorite(workflow)
      state.renameTarget = workflow
      state.renameValue = 'R'
      await state.doRename()
      state.tagsTarget = workflow
      await state.doTags()
      await state.removeRow(workflow)
      await state.exportZip(workflow)
      await state.copyToInstance(workflow)
      await state.openInFrontend(workflow)
      await state.reveal(workflow)
      state.compareA = 'w1'
      state.compareB = 'w3'
      await state.runCompare()
      await state.doQueue()
      await state.safeRevealPath('/tmp/x')
      await state.sendToBatch(workflow)
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

  it('renders card, modal, dependency and compare truth tables', async () => {
    const { wrapper, state } = await mountWorkflows()
    try {
      state.loading = false
      state.items = [
        workflow,
        external,
        { ...instanceWf, missingNodes: [], seed: 0, sourcePath: '/src' }
      ]
      await nextTick()
      state.showQueue = true
      state.queueTarget = workflow
      state.queueInstanceId = 'remote:r1'
      state.seed = 1
      state.showRename = true
      state.renameTarget = workflow
      state.showTags = true
      state.tagsTarget = workflow
      state.tagsValue = ['a']
      state.showDetail = true
      state.detail = {
        ...workflow,
        seed: 0,
        modelUsed: 'm',
        description: 'd',
        missingNodes: ['A', 'B']
      }
      state.depModal = true
      state.depResult = { record: workflow, models: modelPreflight, nodes: nodePreflight }
      state.depBusy = 'w1'
      state.showCompare = true
      state.compareA = 'w1'
      state.compareB = 'w3'
      state.compareResult = compareResult
      state.comparing = true
      state.openingFrontend = true
      state.importingDefault = true
      state.queuing = true
      await nextTick()
      await nextTick()
      for (const sel of ['button', '.n-button', '.n-tag', '.n-switch', '.n-collapse-item']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }

      state.depResult = {
        record: workflow,
        models: { ...modelPreflight, available: false, error: 'offline' },
        nodes: { available: false, missingTypes: [], nodeTypes: 0 }
      }
      await nextTick()
      state.depResult = {
        record: workflow,
        models: { ...modelPreflight, missing: [] },
        nodes: { available: true, missingTypes: [], nodeTypes: 1 }
      }
      await nextTick()
      state.depResult = { record: workflow, models: null, nodes: null }
      await nextTick()
      state.compareResult = {
        ...compareResult,
        nodesOnlyA: [],
        nodesOnlyB: []
      }
      await nextTick()
      state.showCompare = false
      state.loading = false
      state.items = []
      state.loadError = 'failed'
      await nextTick()
      state.loadError = ''
      state.keyword = 'nothing'
      await nextTick()
      state.keyword = ''
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
})
