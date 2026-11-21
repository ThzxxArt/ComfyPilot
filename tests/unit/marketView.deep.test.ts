// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { IPC_EVENTS } from '../../src/shared/types'

const marketItem = {
  id: 'm1',
  name: 'ComfyUI-Test',
  displayName: 'Test Pack',
  description: 'A test pack',
  author: 'tester',
  version: '1.2.3',
  category: 'utils',
  tags: ['tag'],
  downloads: 100,
  stars: 5,
  installed: false,
  repository: 'https://github.com/tester/ComfyUI-Test',
  rating: 4
}
const marketItemB = {
  ...marketItem,
  id: 'm2',
  name: 'Other',
  displayName: '',
  description: '',
  author: '',
  version: '',
  category: '',
  tags: [],
  downloads: 0,
  stars: 0,
  rating: 0,
  repository: '',
  installed: true
}
const pageResult = {
  items: [marketItem, marketItemB],
  total: 2,
  page: 1,
  pageSize: 40,
  totalPages: 2,
  scanned: 2,
  clientFiltered: false,
  needsIndex: false
}
const managerPack = {
  id: 'p1',
  name: 'PackOne',
  displayName: 'Pack One',
  description: 'manager pack',
  author: 'author',
  latestVersion: '2.0.0',
  repository: 'https://github.com/a/b',
  tags: ['tag1'],
  downloads: 3,
  score: 4
}
const nodePack = {
  id: 'local1',
  name: 'PackOne',
  displayName: 'Pack One',
  registryId: 'p1',
  repository: 'https://github.com/a/b.git',
  locked: false
}
const indexStatus = { ready: true, updatedAt: 1000, total: 2, pages: 1, count: 2 }

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
      return [
        {
          id: 'i1',
          name: 'Main',
          path: '/tmp/comfy',
          port: 8188,
          status: 'running',
          enabled: true
        }
      ]
    case 'remote.list':
      return []
    case 'monitor.system':
      return { cpu: 1, memory: 1 }
    case 'registry.indexStatus':
      return indexStatus
    case 'registry.ensureIndex':
    case 'registry.refreshIndex':
      return indexStatus
    case 'registry.cancelIndex':
      return true
    case 'market.list':
      return pageResult
    case 'node.managerChannel':
      return [managerPack]
    case 'node.list':
      return [nodePack]
    case 'market.install':
    case 'node.install':
      return { issues: [] }
    case 'node.update':
      return true
    default:
      return true
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

describe('MarketView deep coverage', () => {
  async function mountMarket(path = '/market') {
    const { wrapper, state } = await mountView(
      path,
      () => import('../../src/renderer/src/views/nodes/MarketView.vue')
    )
    state.store.instances = [
      {
        id: 'i1',
        name: 'Main',
        path: '/tmp/comfy',
        port: 8188,
        status: 'running',
        enabled: true
      }
    ]
    state.store.activeInstanceId = 'i1'
    await state.load(true)
    await nextTick()
    return { wrapper, state }
  }

  it('exercises search, paging, indexes, install and update flows', async () => {
    const { wrapper, state } = await mountMarket()
    try {
      await state.refreshLocalPackKeys()
      expect(state.isInstalled(marketItem)).toBe(false)
      expect(state.isInstalled(marketItemB)).toBe(true)
      expect(
        state.isInstalled({
          ...marketItem,
          installed: false,
          name: 'nope',
          displayName: 'nope',
          repository: ''
        })
      ).toBe(false)
      state.localPackKeys = new Set(['local1'])
      expect(
        state.isInstalled({
          ...marketItem,
          installed: false,
          name: 'x',
          displayName: 'y',
          repository: ''
        })
      ).toBe(false)

      for (const q of ['test', 'pack', 'a test pack', 'tester', 'utils', 'tag']) {
        state.activeQuery = q
        expect(state.filteredItems.length).toBeGreaterThan(0)
      }
      state.activeQuery = 'nothing'
      expect(state.filteredItems).toHaveLength(0)
      state.activeQuery = ''
      state.sourceTab = 'registry'
      expect(state.displayItems).toHaveLength(2)
      expect(state.displayTotal).toBe(2)
      expect(state.displayPages).toBe(2)
      state.sourceTab = 'manager'
      expect(state.displayItems).toHaveLength(2)
      expect(state.displayPages).toBe(1)
      state.sourceTab = 'registry'

      state.loading = true
      expect(state.hint()).toBeTruthy()
      state.loading = false
      state.activeQuery = 'x'
      expect(state.hint()).toBeTruthy()
      state.activeQuery = ''
      state.sourceTab = 'manager'
      expect(state.hint()).toBeTruthy()
      state.page = 1
      expect(state.hint()).toBeTruthy()
      state.sourceTab = 'registry'
      state.indexCount = 5
      state.indexUpdatedAt = 1000
      expect(state.hint()).toBeTruthy()
      state.indexUpdatedAt = 0
      expect(state.hint()).toBeTruthy()
      state.indexCount = 0
      expect(state.hint()).toBeTruthy()

      state.query = 'x'
      state.clearSearch()
      expect(state.query).toBe('')

      expect(state.mapRegistryItem(marketItem).source).toBe('registry')
      const minimal = state.mapRegistryItem({ id: 'x', name: 'x' })
      expect(minimal.displayName).toBe('x')
      expect(minimal.tags).toEqual([])
      expect(minimal.downloads).toBe(0)
      const mappedManager = state.mapManagerItem(managerPack)
      expect(mappedManager.source).toBe('manager')
      expect(state.mapManagerItem({ id: 'y', name: '', displayName: 'Y' }).name).toBe('Y')
      overrides['node.list'] = [
        { id: 'n1', name: 'OnlyName' },
        { id: 'n2', displayName: 'OnlyDisplay' },
        { id: 'n3', registryId: 'rx' },
        { id: 'n4', repository: 'https://gitlab.com/a/b' }
      ]
      await state.refreshLocalPackKeys()
      overrides = {}
      expect(
        state.mapRegistryItem({ ...marketItem, displayName: '', tags: [], stars: 0, rating: 3 })
          .stars
      ).toBe(3)
      expect(state.mapManagerItem({ ...managerPack, name: '', tags: [] }).name).toBe('Pack One')

      await state.loadIndexStatus()
      await state.buildIndex()
      state.indexing = true
      await state.buildIndex()
      state.indexing = false
      await state.cancelIndexBuild()
      await state.refreshIndex()
      state.activeQuery = 'x'
      await state.refreshIndex()
      state.activeQuery = ''

      await state.load(true)
      await state.load(false)
      state.page = 1
      await state.loadMore()
      state.page = 2
      state.totalPages = 2
      await state.loadMore()
      state.sourceTab = 'manager'
      state.page = 1
      await state.loadMore()
      state.page = 2
      await state.loadCurrentPage()
      state.sourceTab = 'registry'
      state.page = 1
      await state.loadCurrentPage()
      await state.loadManager()
      overrides['node.managerChannel'] = []
      await state.loadManager()
      overrides = {}

      state.sourceTab = 'registry'
      await state.install(marketItem)
      expect(state.showOpModal).toBe(true)
      state.sourceTab = 'manager'
      await state.install(state.mapManagerItem(managerPack))
      state.sourceTab = 'registry'
      overrides['market.install'] = { issues: [{ code: 'pip-disabled' }] }
      await state.install(marketItem)
      overrides = {}

      state.store.activeInstanceId = null
      await state.install(marketItem)
      await state.install(state.mapManagerItem(managerPack))
      state.store.activeInstanceId = 'i1'

      state.nodeInstallingPack = 'pkg'
      state.nodeUpdatingPack = 'pkg'
      await nextTick()
      state.nodeInstallingPack = null
      state.nodeUpdatingPack = null
      await nextTick()

      const managerItem = state.mapManagerItem(managerPack)
      const local = await state.resolveLocalPack(managerItem)
      expect(local.id).toBe('local1')
      overrides['node.list'] = [{ ...nodePack, name: 'PACKONE', registryId: '', repository: '' }]
      expect((await state.resolveLocalPack(managerItem)).id).toBe('local1')
      overrides['node.list'] = [{ ...nodePack, name: '', registryId: 'm1', repository: '' }]
      expect((await state.resolveLocalPack(state.mapRegistryItem(marketItem))).id).toBe('local1')
      overrides['node.list'] = [{ ...nodePack, name: '', registryId: '', repository: '', id: 'm1' }]
      expect((await state.resolveLocalPack(state.mapRegistryItem(marketItem))).id).toBe('m1')
      overrides['node.list'] = []
      expect(await state.resolveLocalPack(managerItem)).toBeNull()
      overrides = {}

      await state.updateItem(marketItem)
      const originalInvoke = (window as any).comfyPilot.invoke
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'node.list') state.store.activeInstanceId = null
        return { ok: true, data: dataFor(channel) }
      }
      await state.updateItem(state.mapManagerItem(managerPack))
      state.store.activeInstanceId = 'i1'
      ;(window as any).comfyPilot.invoke = originalInvoke
      state.updatingItem = 'x'
      await state.updateItem(marketItem)
      state.updatingItem = null
      overrides['node.list'] = [{ ...nodePack, locked: true }]
      await state.updateItem(marketItem)
      overrides['node.list'] = []
      await state.updateItem(marketItem)
      overrides = {}

      overrides['market.list'] = {
        items: [],
        total: 0,
        page: 1,
        pageSize: 40,
        totalPages: 1,
        scanned: 0,
        clientFiltered: false,
        needsIndex: false
      }
      state.activeQuery = ''
      await state.load(true)
      state.query = 'x'
      await state.load(true)
      state.query = ''
      overrides = {}
      const p1 = state.load(true)
      const p2 = state.load(true)
      await Promise.all([p1, p2])
      const orig = (window as any).comfyPilot.invoke
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'market.list') state.sourceTab = 'manager'
        return { ok: true, data: dataFor(channel) }
      }
      state.sourceTab = 'registry'
      await state.load(true)
      state.sourceTab = 'manager'
      await state.loadManager()
      ;(window as any).comfyPilot.invoke = orig
      state.allItems = Array.from({ length: 41 }, (_, i) => ({
        ...state.mapManagerItem(managerPack),
        id: `p${i}`
      }))
      state.sourceTab = 'manager'
      state.page = 1
      await state.loadMore()
      expect(state.page).toBe(2)

      await state.router.push('/market?q=test')
      await nextTick()
      expect(state.query).toBe('test')
      await state.router.push('/market')
      await nextTick()
      state.query = 'pack'
      state.load(true)
      await flushPromises()
      state.activeQuery = 'x'
      await nextTick()
      state.store.instanceSwitchTick += 1
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

  it('covers cancellation, failure and stale response branches', async () => {
    const { wrapper, state } = await mountMarket()
    try {
      const cancelled = Object.assign(new Error('cancelled by user'))
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'registry.ensureIndex' || channel === 'registry.refreshIndex')
          throw cancelled
        return { ok: true, data: dataFor(channel) }
      }
      await state.buildIndex()
      await state.refreshIndex()
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'registry.ensureIndex' || channel === 'registry.refreshIndex')
          throw new Error('boom')
        return { ok: true, data: dataFor(channel) }
      }
      await state.buildIndex()
      await state.refreshIndex()
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (failChannels.has(channel)) throw new Error(`${channel} boom`)
        if (failStrings.has(channel)) throw channel
        return { ok: true, data: dataFor(channel) }
      }

      failChannels = new Set([
        'registry.indexStatus',
        'registry.cancelIndex',
        'market.list',
        'node.managerChannel',
        'node.list',
        'market.install',
        'node.install',
        'node.update'
      ])
      await state.refreshLocalPackKeys()
      await state.loadIndexStatus()
      await state.cancelIndexBuild()
      await state.load(true)
      expect(state.sourceError).toBeTruthy()
      await state.loadCurrentPage()
      await state.loadManager()
      await state.install(marketItem)
      await state.install(state.mapManagerItem(managerPack))
      await state.updateItem(marketItem)
      await state.router.push('/market?q=fail')
      await flushPromises()
      state.store.instanceSwitchTick += 1
      await nextTick()
      failChannels = new Set()

      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'market.install')
          throw Object.assign(new Error('busy'), { code: 'OP_BUSY' })
        return { ok: true, data: dataFor(channel) }
      }
      await state.install(state.mapRegistryItem(marketItem))
      expect(state.showOpModal).toBe(false)
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'node.update') throw new Error('rollback FAILED, backup at /tmp/backup')
        return { ok: true, data: dataFor(channel) }
      }
      await state.updateItem(marketItem)
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'node.update') throw new Error('plain failure')
        return { ok: true, data: dataFor(channel) }
      }
      await state.updateItem(marketItem)
      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (channel === 'node.update') throw Object.assign(new Error('busy'), { code: 'OP_BUSY' })
        return { ok: true, data: dataFor(channel) }
      }
      await state.updateItem(marketItem)

      ;(window as any).comfyPilot.invoke = async (channel: string) => {
        if (failChannels.has(channel)) throw new Error(`${channel} boom`)
        if (failStrings.has(channel)) throw channel
        return { ok: true, data: dataFor(channel) }
      }
      failStrings = new Set([
        'market.list',
        'node.managerChannel',
        'market.install',
        'node.install',
        'node.update'
      ])
      await state.load(true)
      await state.loadCurrentPage()
      await state.loadManager()
      await state.install(marketItem)
      await state.updateItem(marketItem)
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

  it('renders results, index progress, manager page and empty states', async () => {
    const { wrapper, state } = await mountMarket()
    try {
      state.loading = false
      state.sourceTab = 'registry'
      state.page = 1
      state.totalPages = 2
      state.needsIndex = true
      state.indexing = true
      state.indexProgress = { done: 1, total: 2, count: 3 }
      state.nodeInstallingPack = 'pkg'
      state.nodeInstallMessage = 'installing'
      await nextTick()
      state.nodeInstallingPack = null
      state.nodeUpdatingPack = 'pkg'
      state.nodeUpdateMessage = 'updating'
      await nextTick()
      state.nodeUpdatingPack = null
      for (const sel of ['button', '.n-button', '.n-tag', '.n-popconfirm']) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          ;(el as HTMLElement).click()
          await flushPromises()
        }
      }
      state.sourceTab = 'manager'
      state.page = 1
      await nextTick()
      state.loading = false
      state.sourceError = 'failed'
      await nextTick()
      state.sourceError = ''
      state.activeQuery = 'nothing'
      await nextTick()
      state.activeQuery = ''
      state.allItems = []
      await nextTick()
      state.needsIndex = false
      state.indexing = false
      state.indexProgress = null
      await nextTick()

      for (const cb of ipcHandlers.get(IPC_EVENTS.registryIndexProgress) || []) {
        cb({ done: 1, total: 2, count: 3, ready: false })
        cb({ done: 2, total: 2, count: 3, ready: false })
        cb({ done: 0, total: 0, count: 0, ready: true })
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
