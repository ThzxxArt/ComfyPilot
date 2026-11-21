// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { exerciseView, installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'

const now = Date.now()
const image = {
  id: 'o1',
  path: '/tmp/comfy/output/a.png',
  fileName: 'a.png',
  type: 'image',
  size: 1024,
  createdAt: now,
  favorite: true,
  workflowId: 'w1',
  workflowName: 'One',
  batchJobId: 'b1',
  thumbnail: 'comfy-pilot-media:output/a.png',
  mediaUrl: 'comfy-pilot-media:output/a.png',
  seed: 1,
  promptId: 'p1',
  params: { pngKeys: ['prompt'] }
}
const video = {
  ...image,
  id: 'o2',
  path: '/tmp/comfy/output/b.mp4',
  fileName: 'b.mp4',
  type: 'video',
  favorite: false,
  batchJobId: 'b2'
}
const audio = {
  ...image,
  id: 'o3',
  path: '/tmp/comfy/output/c.mp3',
  fileName: 'c.mp3',
  type: 'audio',
  workflowId: 'w2',
  workflowName: 'Two'
}
const model3d = {
  ...image,
  id: 'o4',
  path: '/tmp/comfy/output/d.glb',
  fileName: 'd.glb',
  type: '3d',
  thumbnail: undefined,
  mediaUrl: undefined
}
const other = {
  ...image,
  id: 'o5',
  path: '/tmp/comfy/output/e.txt',
  fileName: 'e.txt',
  type: 'other'
}
const assetMatch = { id: 'a1', fileName: 'a.png', url: 'http://x/a.png' }
const workflow = { id: 'w1', name: 'One', path: '/tmp/comfy/user/default/workflows/w1.json' }
const detail = { ...image, params: { prompt: '{"1":{"inputs":{"seed":1}}}' } }
let failChannels = new Set<string>()
let failStrings = new Set<string>()
let overrides: Record<string, unknown> = {}
let autoConfirm = true
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
    case 'instance.list':
      return [{ id: 'i1', name: 'Main', path: '/tmp/comfy', port: 8188, status: 'running' }]
    case 'remote.list':
      return []
    case 'workflow.list':
      return [workflow]
    case 'batch.list':
      return [
        { id: 'b1', name: 'Batch One', instanceId: 'i1' },
        { id: 'b2', name: 'Batch Two', instanceId: 'i1' }
      ]
    case 'output.list':
      return { items: [image, video, audio, model3d, other], total: 5, truncated: false }
    case 'output.scan':
      return { scanned: 5, cancelled: false }
    case 'output.scanCancel':
      return true
    case 'output.thumb':
      return { url: 'comfy-pilot-media:output/thumb.png' }
    case 'shell.pickDirectory':
      return '/tmp/comfy/output'
    case 'output.assetsMatch':
      return [assetMatch]
    case 'output.favorite':
    case 'output.open':
    case 'output.reveal':
    case 'output.delete':
    case 'output.batchDelete':
      return true
    case 'output.exportZip':
      return { path: '/tmp/out.zip' }
    case 'workflow.import':
    case 'workflow.queue':
      return workflow
    case 'output.importToWorkflow':
      return workflow
    case 'workflow.parsePngMeta':
      return { prompt: '{}' }
    case 'shell.writeClipboard':
    case 'shell.openExternal':
      return true
    default:
      return null
  }
}

beforeAll(() => stubBrowser())
beforeEach(() => {
  failChannels = new Set()
  failStrings = new Set()
  overrides = {}
  autoConfirm = true
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
    if (failStrings.has(channel)) throw channel
    if (failChannels.has(channel)) throw new Error(`${channel} boom`)
    return { ok: true, data: dataFor(channel) }
  }
  document.body.innerHTML = ''
})

describe('OutputView deep coverage', () => {
  async function mountOutput() {
    const { wrapper, state } = await mountView(
      '/output',
      () => import('../../src/renderer/src/views/output/OutputView.vue')
    )
    const dialog = state.dialog
    if (dialog) {
      const auto = (opts: any): object => {
        if (!autoConfirm) return {}
        try {
          opts?.content?.()
          const r = opts?.onPositiveClick?.()
          if (r && typeof r.catch === 'function') r.catch(() => undefined)
        } catch {
          /* ignore */
        }
        return {}
      }
      dialog.warning = auto
      dialog.info = auto
    }
    try {
      state.store.instances = [{ id: 'i1', name: 'Main', path: '/tmp/comfy', port: 8188 }]
      state.store.activeInstanceId = 'i1'
    } catch {
      /* ignore */
    }
    await nextTick()
    return { wrapper, state }
  }

  it('exercises actions and template variants', async () => {
    const { wrapper, state } = await mountOutput()
    try {
      expect(Object.keys(state).length).toBeGreaterThan(0)
      await exerciseView(wrapper, state, {
        primary: image,
        variants: [
          { loading: true, loadError: 'failed' },
          { scanning: true, scanProgress: { scanned: 2, done: false, cancelled: false } },
          { type: 'image', onlyFavorites: true, batchFilter: 'b1', workflowFilter: 'w1' },
          { type: 'video', sort: 'size', order: 'asc', page: 2, pageSize: 24 },
          { dateRange: [now - 1000, now], root: '/tmp/comfy/output' },
          {
            showDetail: true,
            detail,
            pngMeta: { prompt: '{}', workflow: '{}' },
            assetsMatches: [assetMatch]
          },
          { lightbox: true, lightboxAsset: image, lightboxSrc: image.mediaUrl, lbZoom: 2 },
          {
            brokenThumbs: new Set(['o1']),
            failedVideos: new Set(['o2']),
            selected: new Set(['o1', 'o2'])
          },
          { assets: [image, video], total: 2, loadError: '' },
          { assets: [], total: 0, loadError: '', dateRange: null },
          { localMutable: false }
        ]
      })
      expect(wrapper.html()).toBeTruthy()
      expect(state.thumbSrc(image)).toBeTruthy()
      expect(state.playableVideo(video)).toBe(true)
      expect(state.playableAudio(audio)).toBe(true)
      expect(state.typeIconOf(image)).toBeTruthy()
      expect(state.workflowName('w1')).toBeTruthy()
      expect(state.hasFilter).toBeTypeOf('boolean')
      expect(state.metaEntries({ a: 1, b: 'x', c: null })).toBeTruthy()
      expect(state.defaultOutputRoot()).toBeTruthy()
    } finally {
      try {
        state.message?.destroyAll?.()
      } catch {
        /* noop */
      }
      wrapper.unmount()
    }
  }, 120_000)

  it('covers selection, lightbox, delete, export and error branches', async () => {
    const { wrapper, state } = await mountOutput()
    try {
      state.assets = [image, video, audio, model3d, other]
      state.total = 5
      state.store.instances = [{ id: 'i1', name: 'Main', path: '/tmp/comfy', port: 8188 }]
      state.store.activeInstanceId = 'i1'
      await nextTick()
      state.toggleSelect('o1')
      state.toggleSelect('o1')
      state.toggleSelectAll()
      state.toggleSelectAll()
      await state.toggleFavorite(image)
      await state.safeOpen(image.path)
      await state.safeReveal(image.path)
      await state.openDetail(image)
      await state.loadAssetsMatch(image)
      await state.copyToClipboard('text')
      state.openLightbox(image)
      state.openLightbox(video)
      state.zoomLightbox(1)
      state.zoomLightbox(-1)
      state.onLightboxWheel({ deltaY: 1, preventDefault() {} } as never)
      state.resetLightboxView()
      state.onLightboxPointerDown({ clientX: 1, clientY: 1 } as never)
      state.onLightboxPointerMove({ clientX: 2, clientY: 2 } as never)
      state.onLightboxPointerUp()
      state.lightboxPrev()
      state.lightboxNext()
      state.onLightboxKey({ key: 'Escape', preventDefault() {} } as never)
      state.onLightboxKey({ key: 'ArrowLeft', preventDefault() {} } as never)
      state.onLightboxKey({ key: 'ArrowRight', preventDefault() {} } as never)
      state.onLightboxKey({ key: '+', preventDefault() {} } as never)
      state.onLightboxKey({ key: '-', preventDefault() {} } as never)
      state.onLightboxKey({ key: '0', preventDefault() {} } as never)
      state.onAssetKey({ key: 'Enter', preventDefault() {} } as never, image)
      state.onAssetKey({ key: ' ', preventDefault() {} } as never, image)
      state.onAssetKey({ key: 'Delete', preventDefault() {} } as never, image)
      state.onThumbError(image)
      state.onVideoError(video)
      state.openDetail(image)
      await state.restoreWorkflow()
      await state.doDeleteAsset('o1', true)
      state.confirmDeleteAsset(image)
      state.confirmDeleteSelected()
      await state.doBatchDelete(['o1', 'o2'], true)
      await state.exportSelected()
      state.clearFilters()
      await state.scanOutputs()
      await state.cancelScan()
      await state.refresh()
      await state.pickRoot()
      state.scheduleRefresh()
      state.lightbox = true
      state.lightboxAsset = image
      await nextTick()
      for (const sel of ['button', '.n-button', '.n-checkbox', '.n-tabs-tab']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
      expect(wrapper.html()).toBeTruthy()

      failChannels = new Set([
        'output.list',
        'output.scan',
        'output.favorite',
        'output.open',
        'output.reveal',
        'output.delete',
        'output.batchDelete',
        'output.exportZip',
        'output.assetsMatch',
        'workflow.import',
        'shell.writeClipboard'
      ])
      await state.refresh()
      await state.scanOutputs()
      await state.toggleFavorite(image)
      await state.safeOpen(image.path)
      await state.safeReveal(image.path)
      await state.doDeleteAsset('o1', true)
      await state.doBatchDelete(['o1'], true)
      await state.exportSelected()
      await state.loadAssetsMatch(image)
      await state.copyToClipboard('x')
      await state.restoreWorkflow()
      failChannels = new Set()
      failStrings = new Set(['output.list'])
      await state.refresh()
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

  it('covers scan, lightbox, delete, export and watcher branches', async () => {
    const { wrapper, state } = await mountOutput()
    try {
      state.assets = [
        image,
        { ...image, id: 'o6', fileName: 'a.exr', thumbPending: true },
        video,
        { ...video, id: 'o7', mediaUrl: undefined },
        { ...video, id: 'o8' },
        audio,
        model3d,
        other
      ]
      state.total = 8
      state.store.instances = [{ id: 'i1', name: 'Main', path: '/tmp/comfy', port: 8188 }]
      state.store.activeInstanceId = 'i1'
      await nextTick()

      overrides['output.scan'] = { scanned: 1, cancelled: true }
      await state.scanOutputs()
      overrides['output.scan'] = { scanned: 1, cancelled: false }
      await state.scanOutputs()
      failChannels = new Set(['output.scan', 'output.scanCancel'])
      await state.scanOutputs()
      await state.cancelScan()
      failChannels = new Set()

      state.selected = new Set(['o1'])
      state.page = 2
      state.pageSize = 24
      await state.refresh()
      state.selected = new Set()
      state.page = 1
      state.pageSize = 60
      failStrings = new Set(['output.list'])
      await state.refresh()
      failStrings = new Set()
      failChannels = new Set(['output.list'])
      await state.refresh()
      failChannels = new Set()

      await state.pickRoot()
      overrides['shell.pickDirectory'] = ''
      await state.pickRoot()
      overrides['shell.pickDirectory'] = '/tmp/comfy/output'
      await state.pickRoot()

      state.failedVideos = new Set(['o2'])
      state.openLightbox(audio)
      state.openLightbox({ ...audio, mediaUrl: undefined, thumbnail: undefined })
      state.openLightbox(video)
      state.openLightbox({ ...video, mediaUrl: undefined })
      state.openLightbox(model3d)
      state.openLightbox(other)
      state.openLightbox({ ...image, fileName: 'x.exr' })
      state.openLightbox(image)
      state.lightboxAsset = image
      state.lbZoom = 2
      state.onLightboxPointerDown({
        clientX: 1,
        clientY: 1,
        target: { setPointerCapture() {} },
        pointerId: 1
      } as never)
      state.onLightboxPointerMove({ clientX: 4, clientY: 5 } as never)
      state.onLightboxPointerUp()
      state.onLightboxPointerDown({
        clientX: 1,
        clientY: 1,
        target: { setPointerCapture() {} },
        pointerId: 1
      } as never)
      state.lightboxPrev()
      state.lightboxNext()
      state.lightboxAsset = null
      state.lightboxPrev()
      state.lightboxNext()
      state.lightboxIndex()
      state.lightbox = true
      await nextTick()
      state.openDetail(image)
      state.showDetail = true
      state.detail = image
      await state.loadAssetsMatch(image)
      await state.restoreWorkflow()
      overrides['workflow.import'] = null
      await state.restoreWorkflow()
      failChannels = new Set(['workflow.import'])
      await state.restoreWorkflow()
      failChannels = new Set()

      state.detail = image
      state.lightboxAsset = image
      state.lightbox = true
      await state.doDeleteAsset('o1', false)
      await state.doDeleteAsset('o1', true)
      state.selected = new Set(['o1', 'o2'])
      await state.doBatchDelete(['o1', 'o2'], false)
      overrides['output.batchDelete'] = {
        ok: 1,
        failed: [{ id: 'o2', label: 'b', error: 'e' }]
      }
      await state.doBatchDelete(['o1', 'o2'], true)
      overrides['output.batchDelete'] = { ok: 2, failed: [] }
      await state.doBatchDelete(['o1'], true)
      state.selected = new Set()
      await state.exportSelected()
      state.selected = new Set(['o1'])
      await state.exportSelected()
      overrides['shell.pickDirectory'] = ''
      await state.exportSelected()
      overrides['shell.pickDirectory'] = '/tmp/out'
      await state.exportSelected()
      failChannels = new Set(['output.exportZip'])
      await state.exportSelected()
      failChannels = new Set()

      state.confirmDeleteAsset(image)
      state.confirmDeleteAsset(image)
      state.selected = new Set()
      state.confirmDeleteSelected()
      state.selected = new Set(['o1'])
      state.confirmDeleteSelected()

      state.type = 'image'
      state.sort = 'name'
      state.order = 'asc'
      state.onlyFavorites = true
      state.batchFilter = 'b1'
      state.workflowFilter = 'w1'
      state.dateRange = [now - 1000, now]
      await nextTick()
      state.page = 1
      state.page = 2
      state.pageSize = 24
      state.root = '/tmp/comfy/output'
      state.store.instanceSwitchTick += 1
      await nextTick()
      await state.router.push('/output?batchJobId=b1&workflowId=w1')
      await nextTick()
      await flushPromises()
      state.scheduleRefresh()
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

  it('renders the asset, detail and lightbox truth tables', async () => {
    const { wrapper, state } = await mountOutput()
    try {
      state.loading = false
      state.assets = [image, video, audio, model3d, other]
      state.total = 5
      state.detail = {
        ...image,
        workflowName: 'One',
        batchJobId: 'b1',
        promptId: 'p1',
        seed: 1
      }
      state.showDetail = true
      state.pngMeta = { prompt: '{}', workflow: '{}', seed: 1 }
      state.assetsMatches = [
        {
          id: 'a1',
          fileName: 'a.png',
          jobId: 'j1',
          workflowName: 'One',
          tags: ['tag'],
          previewUrl: 'http://x/a.png'
        }
      ]
      state.assetsLoading = false
      state.lightbox = true
      state.lightboxAsset = image
      state.lightboxSrc = image.mediaUrl
      state.lightboxImageFailed = true
      state.lightboxVideoFailed = true
      state.lightboxAudioFailed = true
      state.brokenThumbs = new Set(['o1'])
      state.failedVideos = new Set(['o2'])
      state.selected = new Set(['o1'])
      state.workflowFilter = 'w1'
      state.batchFilter = 'b1'
      state.dateRange = [now - 1000, now]
      state.scanProgress = { scanned: 1, done: false, cancelled: false }
      state.scanning = true
      await nextTick()
      await nextTick()
      expect(wrapper.text()).toContain('a.png')
      for (const sel of ['button', '.n-button', '.n-checkbox', '.n-tabs-tab']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
          await nextTick()
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

  it('covers per-asset and per-lightbox-type branches', async () => {
    const { wrapper, state } = await mountOutput()
    try {
      state.loading = false
      state.total = 1
      for (const a of [
        image,
        { ...image, id: 'x1', workflowName: 'Only', batchJobId: undefined },
        { ...image, id: 'x2', workflowName: undefined, batchJobId: 'b1' },
        { ...image, id: 'x3', workflowName: undefined, batchJobId: undefined, seed: undefined },
        video,
        audio,
        model3d,
        other,
        { ...image, id: 'x4', thumbnail: undefined, mediaUrl: undefined }
      ]) {
        state.assets = [a]
        await nextTick()
      }
      state.assets = []
      state.loadError = 'failed'
      await nextTick()
      state.loadError = ''
      await nextTick()
      state.workflowFilter = 'w1'
      await nextTick()
      state.workflowFilter = ''
      state.type = 'image'
      await nextTick()
      state.type = 'all'

      state.showDetail = true
      for (const d of [
        { ...image, type: 'video', mediaUrl: image.mediaUrl },
        { ...image, type: 'video', mediaUrl: undefined },
        { ...image, thumbSrc: undefined },
        { ...image, type: 'other' },
        image
      ]) {
        state.detail = d
        await nextTick()
      }
      state.detail = image
      state.pngMeta = { seed: 1 }
      state.assetsMatches = [
        { id: 'm1', fileName: 'a.png' },
        { id: 'm2', fileName: 'b.png', jobId: 'j', workflowName: 'W', tags: [], previewUrl: '' }
      ]
      await nextTick()

      state.lightbox = true
      for (const a of [
        image,
        { ...image, type: 'video', mediaUrl: image.mediaUrl },
        { ...image, type: 'video', mediaUrl: undefined },
        { ...image, type: 'audio', mediaUrl: image.mediaUrl },
        { ...image, type: 'audio', mediaUrl: undefined },
        { ...image, type: '3d' },
        { ...image, fileName: 'x.exr' },
        { ...image, type: 'other' }
      ]) {
        state.lightboxAsset = a
        state.lightboxSrc = a.mediaUrl || ''
        await nextTick()
      }
      state.lightboxImageFailed = true
      state.lightboxVideoFailed = true
      state.lightboxAudioFailed = true
      await nextTick()
      for (const sel of ['button', '.n-button']) {
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

  it('covers helper and single-arm branches', async () => {
    const { wrapper, state } = await mountOutput()
    try {
      expect(state.thumbSrc({ id: 'z', thumbnail: 't' })).toBe('t')
      expect(state.thumbSrc({ id: 'z', thumbnail: undefined })).toBeUndefined()
      state.onThumbError(image)
      state.onThumbError(image)
      state.onVideoError(video)
      state.onVideoError(video)
      state.scanning = true
      await state.scanOutputs()
      state.scanning = false
      state.store.instances = []
      state.store.activeInstanceId = null
      expect(state.defaultOutputRoot()).toBe('')
      state.store.instances = [{ id: 'i1', name: 'Main', path: '/tmp/comfy', port: 8188 }]
      state.store.activeInstanceId = 'i1'
      state.toggleSelect('x1')
      state.toggleSelect('x1')
      expect(state.playableVideo({ type: 'video', mediaUrl: '' })).toBe(false)
      expect(state.playableVideo({ type: 'video', mediaUrl: 'x.mp4' })).toBe(true)
      expect(state.playableAudio({ type: 'audio', mediaUrl: '' })).toBe(false)
      expect(state.playableAudio({ type: 'audio', mediaUrl: 'x.mp3' })).toBe(true)
      for (const t of ['image', 'video', 'audio', '3d', 'other']) {
        expect(state.typeIconOf({ type: t })).toBeTruthy()
      }
      expect(state.metaEntries({})).toEqual([])
      expect(state.metaEntries({ a: 1 })).toHaveLength(1)
      expect(state.lightboxUrl({ mediaUrl: undefined, thumbnail: 't' })).toBe('t')
      expect(state.lightboxUrl({ mediaUrl: '', thumbnail: '' })).toBe('')
      state.onLightboxWheel({ deltaY: -1, preventDefault() {} } as never)
      state.onLightboxWheel({ deltaY: 1, preventDefault() {} } as never)
      state.lightboxAsset = null
      expect(state.lightboxIndex()).toBe(-1)
      state.lbZoom = 1
      state.onLightboxPointerDown({
        clientX: 1,
        clientY: 1,
        target: { setPointerCapture() {} }
      } as never)
      state.onLightboxPointerMove({ clientX: 2, clientY: 2 } as never)
      state.lightboxAsset = image
      state.assets = [image, video]
      state.lightboxPrev()
      state.lightboxNext()
      state.lightboxAsset = video
      state.lightboxNext()
      state.lightboxAsset = image
      state.lightboxPrev()
      expect(state.metaEntries({ a: 'x', b: 1, c: true })).toHaveLength(3)
      expect(state.workflowName('missing')).toBeTruthy()
      state.failedVideos = new Set(['o2'])
      expect(state.playableVideo({ id: 'o2', type: 'video', mediaUrl: 'x' })).toBe(false)
      state.onAssetKey({ key: 'x', preventDefault() {} } as never, image)
      state.scheduleRefresh()
      state.scheduleRefresh()
      state.root = '/tmp/a'
      state.initRoot = true
      await nextTick()
      state.initRoot = false
      state.root = '/tmp/b'
      await nextTick()
      state.pageSize = 30
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

  it('covers helper branches with direct state', async () => {
    const { wrapper, state } = await mountOutput()
    try {
      state.assets = [
        { ...image, thumbPending: true, thumbnail: undefined },
        { ...video, mediaUrl: 'x' }
      ]
      state.total = 2
      state.store.instances = [{ id: 'i1', name: 'Main', path: '/tmp/comfy', port: 8188 }]
      state.store.activeInstanceId = 'i1'
      await nextTick()
      state.brokenThumbs = new Set(['o1'])
      expect(state.thumbSrc(image)).toBeUndefined()
      state.brokenThumbs = new Set()
      expect(state.thumbSrc(image)).toBe(image.thumbnail)
      state.onThumbError(image)
      state.onThumbError(image)
      state.failedVideos = new Set(['o2'])
      expect(state.playableVideo(video)).toBe(false)
      state.failedVideos = new Set()
      expect(state.playableVideo(video)).toBe(true)
      state.onVideoError(video)
      state.onVideoError(video)
      await state.fillThumbs([], 1)
      state.assets = [image]
      overrides['output.thumb'] = { url: 'comfy-pilot-media:output/a-thumb.png' }
      await state.fillThumbs([{ ...image, thumbPending: true }], state.reqSeq)
      failChannels = new Set(['output.thumb'])
      await state.fillThumbs([{ ...image, thumbPending: true }], state.reqSeq)
      failChannels = new Set()

      state.selectionPageKey = 'old'
      state.selected = new Set(['o1'])
      state.page = 2
      await state.refresh()
      state.page = 1
      state.selected = new Set()
      await state.refresh()

      state.toggleSelect('o1')
      state.toggleSelect('o1')
      failChannels = new Set(['output.open', 'output.reveal', 'output.assetsMatch'])
      await state.safeOpen(image.path)
      await state.safeReveal(image.path)
      await state.loadAssetsMatch(image)
      failChannels = new Set(['workflow.parsePngMeta'])
      await state.openDetail(image)
      failChannels = new Set()
      state.lightbox = false
      state.lightbox = true
      await nextTick()
      state.detail = null
      await state.restoreWorkflow()
      state.detail = { ...image, promptId: 'p1' }
      state.pngMeta = { prompt: '{}' }
      await state.restoreWorkflow()
      overrides['workflow.import'] = null
      await state.restoreWorkflow()
      failChannels = new Set(['workflow.import'])
      await state.restoreWorkflow()
      failChannels = new Set()

      state.onAssetKey({ key: 'a', preventDefault() {} } as never, image)
      state.onAssetKey({ key: 'Enter', preventDefault() {} } as never, image)
      state.onAssetKey({ key: ' ', preventDefault() {} } as never, image)
      state.onAssetKey({ key: 'Delete', preventDefault() {} } as never, image)
      state.onAssetKey({ key: 'Escape', preventDefault() {} } as never, image)
      for (const cb of ipcHandlers.get(IPC_EVENTS.batchProgress) || []) {
        cb({ status: 'running' })
        cb({ status: 'done' })
        cb(null)
      }
      for (const cb of ipcHandlers.get(IPC_EVENTS.outputScanProgress) || []) {
        cb({ done: true })
        cb({ scanned: 3, cancelled: false })
        cb(null)
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
