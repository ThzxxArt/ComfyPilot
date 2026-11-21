// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'

const record = {
  id: 'm1',
  name: 'SDXL Base',
  fileName: 'sdxl.safetensors',
  path: '/models/checkpoints/sdxl.safetensors',
  category: 'checkpoints',
  architecture: 'sdxl',
  size: 6_500_000_000,
  tags: ['base', 'sdxl'],
  duplicateOf: null,
  thumbnail: 'comfy-pilot-media:models/m1.png',
  createdAt: 1,
  mtime: 1
}
const lora = {
  ...record,
  id: 'm2',
  name: 'Detail LoRA',
  fileName: 'detail.safetensors',
  path: '/models/loras/detail.safetensors',
  category: 'loras',
  architecture: '',
  size: 120_000_000,
  tags: [],
  duplicateOf: 'm1',
  thumbnail: undefined
}
const vae = {
  ...record,
  id: 'm3',
  name: 'VAE',
  fileName: 'vae.safetensors',
  path: '/models/vae/vae.safetensors',
  category: 'vae',
  architecture: 'sd15',
  tags: [],
  duplicateOf: null
}
const download = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  fileName: `${id}.safetensors`,
  status,
  receivedBytes: 10,
  totalBytes: 100,
  speedBps: 5,
  error: status === 'error' ? 'network down' : '',
  ...extra
})
const downloads = [
  download('d1', 'running', { totalBytes: 100, receivedBytes: 10, speedBps: 5 }),
  download('d2', 'paused'),
  download('d3', 'queued'),
  download('d4', 'done'),
  download('d5', 'error', { totalBytes: 200, receivedBytes: 20, speedBps: 0 }),
  download('d6', 'cancelled'),
  download('slow', 'running', { totalBytes: 3_600_000, receivedBytes: 0, speedBps: 1 }),
  download('fast', 'running', { totalBytes: 120, receivedBytes: 0, speedBps: 10 })
]
const storage = [
  { category: 'total', count: 3, bytes: 7_000_000_000 },
  { category: 'checkpoints', count: 1, bytes: 6_500_000_000 },
  { category: 'loras', count: 1, bytes: 120_000_000 }
]
const duplicateGroup = {
  hash: 'abcdef0123456789abcdef',
  files: ['/models/checkpoints/sdxl.safetensors', '/models/checkpoints/copy.safetensors']
}
const reconcile = {
  ok: true,
  source: 'experiment',
  error: '',
  folders: [
    {
      folder: 'checkpoints',
      missingLocally: ['a.safetensors', 'b.safetensors'],
      extraLocally: ['c.safetensors'],
      formatHidden: ['d.gguf'],
      extensions: ['.safetensors', '.gguf'],
      instanceFolders: ['/models/checkpoints']
    },
    {
      folder: 'loras',
      missingLocally: [],
      extraLocally: [],
      formatHidden: [],
      extensions: [],
      instanceFolders: []
    }
  ],
  uncoveredRoots: ['/opt/comfy/models', '/srv/models']
}
const starter = {
  id: 's1',
  name: 'Starter',
  family: 'sdxl',
  description: 'models.starter.s1',
  recommended: true
}
const renameResult = [
  { from: 'a', to: 'b', ok: true },
  { from: 'c', to: 'd', ok: false, error: 'exists' }
]

let failChannels = new Set<string>()
let failStrings = new Set<string>()
let failIds = new Set<string>()
let overrides: Record<string, unknown> = {}
let autoConfirm = true
let dialogContents = 0
let ipcHandlers = new Map<string, Set<(payload: unknown) => void>>()

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
    case 'settings.set':
      return true
    case 'instance.list':
      return [
        {
          id: 'i1',
          name: 'Main',
          path: '/tmp/comfy',
          port: 8188,
          status: 'running',
          resolvedDirs: { models: '/tmp/comfy/models' }
        }
      ]
    case 'model.list':
    case 'model.scan':
      return [record, lora, vae]
    case 'model.storageStats':
      return storage
    case 'model.downloads':
      return downloads
    case 'model.findDuplicates':
      return [duplicateGroup]
    case 'model.ensureThumbs':
      return 3
    case 'model.batchRename':
      return renameResult
    case 'model.parseExtraPaths':
      return ['/models/a', '/models/b']
    case 'model.reconcile':
      return reconcile
    case 'model.fetchCivitaiMeta':
      return { id: 1, name: 'Civitai', tags: ['x'] }
    case 'installer.installStarter':
      return true
    case 'shell.pickDirectory':
      return '/models/moved'
    case 'shell.pickFile':
      return '/tmp/comfy/extra_model_paths.yaml'
    default:
      return true
  }
}

beforeAll(() => stubBrowser())
beforeEach(() => {
  failChannels = new Set()
  failStrings = new Set()
  failIds = new Set()
  overrides = {}
  autoConfirm = true
  dialogContents = 0
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
  ;(window as any).comfyPilot.invoke = async (channel: string, ...args: unknown[]) => {
    if (failChannels.has(channel)) throw new Error(`${channel} boom`)
    if (failStrings.has(channel)) throw channel
    if (failIds.has(String(args[0]))) throw new Error('one failed')
    return { ok: true, data: dataFor(channel) }
  }
  document.body.innerHTML = ''
})

describe('ModelsView deep coverage', () => {
  async function mountModels() {
    const { wrapper, state } = await mountView(
      '/models',
      () => import('../../src/renderer/src/views/models/ModelsView.vue')
    )
    const dialog = state.dialog
    if (dialog) {
      const auto = (opts: any): object => {
        if (!autoConfirm) return {}
        try {
          if (opts?.content) {
            dialogContents += 1
            opts.content()
          }
          const r = opts?.onPositiveClick?.()
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
        resolvedDirs: { models: '/tmp/comfy/models' }
      }
    ]
    state.store.activeInstanceId = 'i1'
    state.store.settings = { modelScanRoots: [] }
    await state.refresh()
    await nextTick()
    return { wrapper, state }
  }

  it('exercises filters, helpers and template variants', async () => {
    const { wrapper, state } = await mountModels()
    try {
      state.models = [record, lora, vae]
      state.storage = storage
      state.downloads = downloads
      state.duplicates = [duplicateGroup]
      state.reconcileResult = reconcile
      state.extraPathsResult = ['/models/a']
      state.scanProgress = 'scanning 1/3'
      state.renameResult = renameResult
      state.keyword = 'SDXL'
      expect(state.filtered.length).toBe(1)
      state.keyword = 'sdxl.safetensors'
      expect(state.filtered.length).toBeGreaterThan(0)
      state.keyword = 'loras'
      expect(state.filtered.length).toBeGreaterThan(0)
      state.keyword = 'sd15'
      expect(state.filtered.length).toBeGreaterThan(0)
      state.keyword = 'base'
      expect(state.filtered.length).toBeGreaterThan(0)
      state.keyword = 'nothing'
      expect(state.filtered.length).toBe(0)
      state.keyword = ''
      state.tab = 'loras'
      expect(state.filtered.length).toBe(1)
      state.archFilter = 'sd15'
      expect(state.filtered.length).toBe(0)
      state.archFilter = null
      state.tab = 'all'

      for (const key of ['checkpoints', 'loras', 'not-a-real-category']) {
        expect(state.catLabel(key)).toBeTruthy()
      }
      for (const status of [
        'running',
        'done',
        'error',
        'cancelled',
        'queued',
        'paused',
        'unknown'
      ]) {
        expect(state.dlStatusLabel(status)).toBeTruthy()
      }
      for (const d of [
        download('e1', 'running', { speedBps: 0 }),
        download('e2', 'running', { totalBytes: 0 }),
        download('e3', 'running', { receivedBytes: 0, totalBytes: 30, speedBps: 10 }),
        download('e4', 'running', { receivedBytes: 0, totalBytes: 600, speedBps: 1 }),
        download('e5', 'running', { receivedBytes: 0, totalBytes: 7_200, speedBps: 1 }),
        download('e6', 'running', { receivedBytes: 999, totalBytes: 100, speedBps: 1 })
      ]) {
        expect(state.etaOf(d)).toBeTypeOf('string')
      }
      expect(state.categorySelectOptions.length).toBeGreaterThan(1)
      expect(state.quickCategories.length).toBeGreaterThan(0)
      expect(state.architectureOptions.length).toBeGreaterThan(0)
      expect(state.storageTotal).toBeTruthy()
      expect(state.storageByCategory).toHaveLength(2)
      expect(state.hasFinishedDownloads).toBe(true)
      expect(state.batchTargetSummary()).toBeTypeOf('string')
      state.selection.setChecked(['m1', 'm2'])
      expect(state.checkedRowKeys.length).toBe(2)
      expect(state.selectedModels.length).toBe(2)
      expect(state.batchTargetSummary()).toBeTruthy()
      state.models = [record, lora, vae, { ...vae, id: 'm4', name: 'Extra' }]
      state.selection.setChecked(['m1', 'm2', 'm3', 'm4'])
      expect(state.batchTargetSummary()).toContain('+')
      state.clearFilters()
      expect(state.hasFilter).toBe(false)
      expect(state.defaultExtraPathsFile()).toBe('/tmp/comfy/extra_model_paths.yaml')

      state.showRename = true
      state.showDownload = true
      state.showRenameOne = true
      state.showDetail = true
      state.detailTarget = record
      state.civitaiResult = { id: 1 }
      state.civitaiLoading = true
      state.reconciling = true
      state.starterBusy = 's1'
      state.batchBusy = true
      state.loading = true
      state.scanning = true
      state.extraPathsLoading = true
      await nextTick()
      await nextTick()
      expect(wrapper.html()).toBeTruthy()
      expect(state.civitaiJson).toContain('"id"')
    } finally {
      try {
        state.message?.destroyAll?.()
      } catch {
        /* noop */
      }
      wrapper.unmount()
    }
  }, 120_000)

  it('covers every action with success, cancel and failure outcomes', async () => {
    const { wrapper, state } = await mountModels()
    try {
      state.models = [record, lora, vae]
      state.selection.setChecked(['m1', 'm2'])
      await state.findDuplicates()
      await state.ensureThumbs()
      await state.refresh()

      state.detailTarget = null
      await state.saveTags()
      await state.fetchCivitai()
      state.detailTarget = record
      state.tagsValue = ['base']
      await state.saveTags()
      await state.fetchCivitai()

      state.renameOneTarget = lora
      state.renameOneValue = '   '
      await state.doSymlink(lora)
      await state.doRenameOne()
      state.renameOneValue = 'Renamed LoRA'
      await state.doRenameOne()
      await state.doSymlink(lora)
      overrides['shell.pickDirectory'] = ''
      await state.doSymlink(lora)
      overrides['shell.pickDirectory'] = '/models/moved'

      await state.doDelete('m1', true)
      await state.doDelete('m1', false)
      await state.confirmDelete(record)
      expect(dialogContents).toBeGreaterThan(0)

      state.renamePattern = '{name}'
      await state.batchRename(true)
      await state.batchRename(false)
      overrides['model.batchRename'] = [{ from: 'a', to: 'b', ok: true }]
      await state.batchRename(false)
      overrides['model.batchRename'] = [{ from: 'a', to: 'b', ok: false, error: 'x' }]
      await state.batchRename(false)

      state.selection.setChecked(['m1', 'm2', 'm3'])
      state.confirmBatchDelete()
      await flushPromises()
      expect(dialogContents).toBeGreaterThan(0)
      state.batchBusy = false
      await state.doBatchDelete(true)
      state.selection.setChecked([])
      await state.doBatchDelete(true)
      state.confirmBatchDelete()
      state.selection.setChecked(['m1', 'm2'])
      await state.batchMove()
      overrides['shell.pickDirectory'] = ''
      await state.batchMove()
      overrides['shell.pickDirectory'] = '/models/moved'
      failIds = new Set(['m2'])
      await state.doBatchDelete(true)
      await state.batchMove()
      failIds = new Set()

      for (const id of ['d1', 'd2', 'd3']) {
        await state.pauseDl(id)
        await state.resumeDl(id)
        await state.cancelDl(id)
        await state.prioritizeDl(id)
      }
      state.downloads = downloads
      await state.pauseAllDl()
      await state.resumeAllDl()
      await state.cancelAllDl()
      await state.clearFinishedDl()

      state.downloadUrl = '   '
      await state.startDownload()
      state.downloadUrl = 'https://example.com/model.safetensors'
      await state.startDownload()

      state.extraPathsFile = ''
      await state.parseExtraPaths()
      state.extraPathsFile = '/tmp/comfy/extra_model_paths.yaml'
      await state.parseExtraPaths()
      await state.pickExtraFile()
      overrides['shell.pickFile'] = ''
      await state.pickExtraFile()
      overrides['shell.pickFile'] = '/tmp/comfy/extra_model_paths.yaml'

      for (const s of [
        starter,
        { ...starter, id: 's2', recommended: false },
        { ...starter, id: 's3', description: 'plain text' }
      ]) {
        await state.downloadStarter(s)
      }

      state.reconcileResult = reconcile
      await state.runReconcile()
      await state.addUncoveredRoots()
      state.reconcileResult = { ...reconcile, uncoveredRoots: [] }
      await state.addUncoveredRoots()

      state.store.settings = { modelScanRoots: ['/srv/models'] }
      expect(state.currentScanRoots()).toEqual(['/srv/models'])
      state.store.settings = { modelScanRoots: [] }
      state.models = [record, lora, vae]
      await state.scan(false)
      await state.scan(true)
      state.scanning = true
      state.pendingRescan = true
      await state.scan(false)
      state.scanning = false
      state.pendingRescan = false
      await (wrapper.vm as any).$router.push('/models?q=SDXL')
      await nextTick()
      expect(state.keyword).toBe('SDXL')

      state.checkedRowKeys = ['m1']
      await nextTick()
      for (const sel of ['button', '.n-button', '.n-checkbox', '.n-tag']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
      expect(wrapper.html()).toBeTruthy()

      failChannels = new Set([
        'model.list',
        'model.storageStats',
        'model.scan',
        'model.findDuplicates',
        'model.ensureThumbs',
        'model.delete',
        'model.rename',
        'model.symlink',
        'model.move',
        'model.tag',
        'model.fetchCivitaiMeta',
        'model.parseExtraPaths',
        'model.pauseDownload',
        'model.resumeDownload',
        'model.cancelDownload',
        'model.prioritizeDownload',
        'model.downloads',
        'model.clearFinishedDownloads',
        'model.download',
        'installer.installStarter',
        'model.reconcile',
        'settings.get',
        'settings.set',
        'shell.pickDirectory',
        'shell.pickFile'
      ])
      await state.refresh()
      await state.scan(false)
      await state.findDuplicates()
      await state.ensureThumbs()
      await state.doDelete('m1', true)
      state.renameOneTarget = record
      state.renameOneValue = 'X'
      await state.doRenameOne()
      await state.doSymlink(record)
      await state.saveTags()
      await state.fetchCivitai()
      await state.parseExtraPaths()
      await state.pickExtraFile()
      await state.pauseDl('d1')
      await state.resumeDl('d1')
      await state.cancelDl('d1')
      await state.prioritizeDl('d1')
      await state.clearFinishedDl()
      await state.startDownload()
      await state.downloadStarter(starter)
      await state.runReconcile()
      await state.addUncoveredRoots()
      state.selection.setChecked(['m1'])
      await state.batchMove()
      await state.doBatchDelete(true)
      state.downloads = downloads
      await state.pauseAllDl()
      await state.resumeAllDl()
      await state.cancelAllDl()
      failChannels = new Set()
      failStrings = new Set(['model.list'])
      await state.refresh()
      failStrings = new Set()

      state.store.settings = { modelScanRoots: [] }
      state.store.activeInstanceId = 'i1'
      state.models = [record, lora, vae]
      state.selection.setChecked(['m1'])
      state.renameOneTarget = null
      await state.doRenameOne()
      state.openDetail({ ...record, tags: undefined })
      state.reconcileResult = null
      expect(state.reconcileDiff).toEqual([])
      await state.addUncoveredRoots()
      state.store.activeInstanceId = null
      await state.runReconcile()
      await state.downloadStarter(starter)
      state.store.activeInstanceId = 'i1'
      state.reconcileResult = reconcile
      overrides['settings.get'] = {}
      await state.addUncoveredRoots()
      overrides = {}
      state.store.settings = null
      await state.addUncoveredRoots()
      state.store.settings = { modelScanRoots: [] }
      expect(state.currentScanRoots()).toEqual(['/tmp/comfy/models'])
      state.store.instances = [{ id: 'i1', name: 'Main', path: '/tmp/comfy' }]
      expect(state.currentScanRoots()).toEqual([])
      state.store.instances = [
        {
          id: 'i1',
          name: 'Main',
          path: '/tmp/comfy',
          resolvedDirs: { models: '/tmp/comfy/models' }
        }
      ]

      state.batchBusy = true
      await state.doBatchDelete(true)
      await state.batchMove()
      state.batchBusy = false
      await state.doBatchDelete(false)
      state.models = [record, lora, vae]
      state.selection.setChecked(['m1', 'ghost'])
      state.confirmBatchDelete()
      expect(dialogContents).toBeGreaterThan(0)
      state.selection.setChecked(['m1'])

      const p1 = state.refresh()
      const p2 = state.refresh()
      await Promise.all([p1, p2])
      const s1 = state.scan(false)
      const s2 = state.scan(false)
      await Promise.all([s1, s2])
      await flushPromises()

      function walk(node: any, fn: (onClick: (...args: any[]) => unknown) => void): void {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) {
          node.forEach((n) => walk(n, fn))
          return
        }
        if (node.props?.onClick) fn(node.props.onClick)
        if (node.children) walk(node.children, fn)
      }
      const actionCol = state.columns.find((c: any) => c.key === 'actions')
      overrides['shell.pickDirectory'] = ''
      walk(actionCol.render(record), (fn) => void fn())
      await flushPromises()
      overrides['shell.pickDirectory'] = '/models/moved'
      walk(actionCol.render(record), (fn) => void fn())
      await flushPromises()
      failStrings = new Set(['model.move'])
      walk(actionCol.render(record), (fn) => void fn())
      await flushPromises()
      failStrings = new Set()
      overrides = {}

      failStrings = new Set([
        'model.list',
        'model.storageStats',
        'model.scan',
        'model.findDuplicates',
        'model.ensureThumbs',
        'model.delete',
        'model.rename',
        'model.symlink',
        'model.move',
        'model.tag',
        'model.fetchCivitaiMeta',
        'model.parseExtraPaths',
        'model.pauseDownload',
        'model.resumeDownload',
        'model.cancelDownload',
        'model.prioritizeDownload',
        'model.downloads',
        'model.clearFinishedDownloads',
        'model.download',
        'installer.installStarter',
        'model.reconcile',
        'settings.get',
        'settings.set',
        'shell.pickDirectory',
        'shell.pickFile'
      ])
      await state.refresh()
      await state.scan(false)
      await state.findDuplicates()
      await state.ensureThumbs()
      await state.doDelete('m1', true)
      state.renameOneTarget = record
      state.renameOneValue = 'X'
      await state.doRenameOne()
      await state.doSymlink(record)
      await state.saveTags()
      await state.fetchCivitai()
      await state.parseExtraPaths()
      await state.pickExtraFile()
      await state.pauseDl('d1')
      await state.resumeDl('d1')
      await state.cancelDl('d1')
      await state.prioritizeDl('d1')
      await state.clearFinishedDl()
      await state.startDownload()
      await state.downloadStarter(starter)
      await state.runReconcile()
      await state.addUncoveredRoots()
      state.selection.setChecked(['m1'])
      await state.batchMove()
      await state.doBatchDelete(true)
      state.downloads = downloads
      await state.pauseAllDl()
      await state.resumeAllDl()
      await state.cancelAllDl()
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

  it('renders table cells, status rows and progress events', async () => {
    const { wrapper, state } = await mountModels()
    try {
      state.models = [record, lora, vae]
      state.storage = storage
      state.downloads = downloads
      state.duplicates = [duplicateGroup]
      await nextTick()
      for (const col of state.columns) {
        if (typeof col.render === 'function') {
          for (const row of [record, lora, vae]) col.render(row)
        }
      }
      state.loading = false
      state.loadError = 'load failed'
      await nextTick()
      state.loadError = ''
      state.models = []
      state.keyword = 'none'
      await nextTick()
      state.keyword = ''
      await nextTick()
      state.reconcileResult = { ...reconcile, ok: false, error: 'offline' }
      await nextTick()
      state.reconcileResult = { ...reconcile, ok: false, error: '' }
      await nextTick()
      state.reconcileResult = {
        ...reconcile,
        folders: [
          {
            folder: 'checkpoints',
            missingLocally: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
            extraLocally: [],
            formatHidden: [],
            extensions: [],
            instanceFolders: []
          }
        ]
      }
      await nextTick()
      state.reconcileResult = {
        ...reconcile,
        source: 'legacy',
        folders: []
      }
      await nextTick()
      for (const cb of ipcHandlers.get(IPC_EVENTS.modelScanProgress) || []) {
        cb({ scanned: 2, total: 10, phase: 'walking' })
      }
      for (const cb of ipcHandlers.get(IPC_EVENTS.downloadProgress) || []) {
        cb({ id: 'd1', status: 'running' })
      }
      await flushPromises()
      state.showRename = true
      state.renameResult = renameResult
      state.showDownload = true
      state.starterModels = [
        starter,
        { ...starter, id: 's2', recommended: false },
        { ...starter, id: 's3' }
      ]
      state.showRenameOne = true
      state.renameOneTarget = record
      state.showDetail = true
      state.detailTarget = lora
      state.civitaiResult = null
      state.civitaiLoading = false
      state.extraPathsResult = []
      state.reconcileResult = reconcile
      state.duplicates = []
      state.downloads = [download('only', 'paused', { error: 'x' })]
      await nextTick()
      await nextTick()
      for (const sel of ['button', '.n-button', '.n-tag', '.n-input']) {
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
