// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { installBridge, mountView, stubBrowser } from '../helpers/deepView'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

const manifest = {
  id: 'b1',
  name: 'Backup One',
  path: '/tmp/backups/b1',
  size: 1024,
  createdAt: 1000
}
const manifestB = { ...manifest, id: 'b2', name: 'Backup Two' }
const preview = {
  id: 'b1',
  name: 'Backup One',
  canRestore: true,
  counts: {
    settings: 1,
    instances: 2,
    nodePacks: 3,
    models: 0,
    workflows: 1,
    remotes: 0,
    snapshots: 1
  },
  invalidPaths: [],
  settingsChanged: ['locale', 'theme'],
  workflowFiles: [
    { id: 'w1', name: 'a.json', missing: true, remapped: false },
    { id: 'w2', name: 'b.json', missing: false, remapped: true },
    { id: 'w3', name: 'c.json', missing: false, remapped: false }
  ],
  warnings: ['one', 'two']
}
const restoreResult = {
  ok: true,
  restored: 3,
  failed: 0,
  warnings: ['warn'],
  preRestoreId: 'pre1'
}

let failChannels = new Set<string>()
let failStrings = new Set<string>()
let overrides: Record<string, unknown> = {}

function dataFor(channel: string): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, channel)) return overrides[channel]
  switch (channel) {
    case 'backup.list':
      return [manifest, manifestB]
    case 'backup.create':
      return { ...manifest, id: 'b3', name: 'new-backup' }
    case 'backup.preview':
      return preview
    case 'backup.restore':
      return restoreResult
    default:
      return true
  }
}

beforeAll(() => stubBrowser())
beforeEach(() => {
  failChannels = new Set()
  failStrings = new Set()
  overrides = {}
  installBridge(dataFor)
  ;(window as any).comfyPilot.invoke = async (channel: string) => {
    if (failChannels.has(channel)) throw new Error(`${channel} boom`)
    if (failStrings.has(channel)) throw channel
    return { ok: true, data: dataFor(channel) }
  }
  document.body.innerHTML = ''
})

describe('BackupView deep coverage', () => {
  async function mountBackup() {
    const { wrapper, state } = await mountView(
      '/backup',
      () => import('../../src/renderer/src/views/backup/BackupView.vue')
    )
    await state.refresh()
    await nextTick()
    return { wrapper, state }
  }

  it('exercises create, preview, restore, folder and delete flows', async () => {
    const { wrapper, state } = await mountBackup()
    try {
      expect(state.items).toHaveLength(2)
      expect(state.visibleSections).toContain('settings')
      for (const s of [
        'settings',
        'instances',
        'nodePacks',
        'models',
        'workflows',
        'remotes',
        'snapshots'
      ]) {
        expect(state.sectionLabel(s)).toBeTruthy()
      }
      state.showCreate = true
      state.name = ''
      state.notes = ''
      await state.create()
      expect(state.showCreate).toBe(false)
      state.showCreate = true
      state.name = 'Custom'
      state.notes = 'note'
      await state.create()

      await state.openRestore('b1')
      expect(state.preview).toBeTruthy()
      expect(state.selectedSections).toContain('settings')
      state.selectedSections = ['settings', 'workflows']
      await state.applyRestore()
      expect(state.preview).toBeNull()
      overrides['backup.restore'] = {
        ok: false,
        restored: 1,
        failed: 2,
        warnings: [],
        preRestoreId: ''
      }
      await state.openRestore('b1')
      await state.applyRestore()
      overrides = {}

      await state.openFolder('b1')
      await state.removeBackup('b1')

      overrides['backup.preview'] = { ...preview, canRestore: false, invalidPaths: ['/bad'] }
      await state.openRestore('b1')
      expect(state.preview?.canRestore).toBe(false)
      overrides = {}

      state.previewId = 'b1'
      state.previewLoading = true
      await state.openRestore('b2')
      state.previewId = 'other'
      await state.openRestore('b1')

      state.preview = preview
      state.selectedSections = ['settings']
      state.showCreate = false
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

  it('covers failure branches and empty/preview truth tables', async () => {
    const { wrapper, state } = await mountBackup()
    try {
      failChannels = new Set([
        'backup.list',
        'backup.create',
        'backup.preview',
        'backup.restore',
        'backup.openFolder',
        'backup.delete'
      ])
      await state.refresh()
      expect(state.loadError).toBeTruthy()
      await state.create()
      await state.openRestore('b1')
      state.preview = preview
      await state.applyRestore()
      await state.openFolder('b1')
      await state.removeBackup('b1')
      failChannels = new Set()

      failStrings = new Set([
        'backup.list',
        'backup.create',
        'backup.preview',
        'backup.restore',
        'backup.openFolder',
        'backup.delete'
      ])
      await state.refresh()
      await state.create()
      await state.openRestore('b1')
      state.preview = preview
      await state.applyRestore()
      await state.openFolder('b1')
      await state.removeBackup('b1')
      failStrings = new Set()

      state.items = []
      state.loadError = ''
      state.loading = false
      await nextTick()
      state.items = [manifest]
      state.preview = {
        ...preview,
        invalidPaths: [],
        settingsChanged: [],
        workflowFiles: [],
        warnings: []
      }
      state.selectedSections = []
      state.previewLoading = true
      state.restoring = true
      await nextTick()
      await nextTick()
      for (const sel of ['button', '.n-button', '.n-checkbox', '.n-popconfirm']) {
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
