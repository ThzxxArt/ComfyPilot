// @vitest-environment happy-dom
/* eslint-disable vue/one-component-per-file */
/**
 * 0.2.3: component-surface smoke tests.
 *
 * Every component is mounted once under the same Naive providers the app uses,
 * so setup(), watchers, modal branches and default template paths are measured.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h, nextTick } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import { IPC_EVENTS } from '../../src/shared/types'
import { i18n } from '../../src/renderer/src/i18n'

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

function installBridge(): void {
  ;(globalThis as { window?: unknown }).window = globalThis
  ;(window as unknown as { comfyPilot: unknown }).comfyPilot = {
    events: IPC_EVENTS,
    invoke: async (channel: string) => {
      if (channel === 'instance.launchArgCatalog') return { ok: true, data: [] }
      if (channel === 'ops.list') return { ok: true, data: [] }
      if (channel === 'settings.get') {
        return { ok: true, data: { locale: 'zh-CN', proxy: { backend: 'plaintext' } } }
      }
      return { ok: true, data: null }
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
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  }))
})

beforeEach(() => setActivePinia(createPinia()))

function testRouter() {
  const Blank = defineComponent({ template: '<div />' })
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: Blank }]
  })
}

async function show(component: unknown, props: Record<string, unknown> = {}, slot?: () => unknown) {
  const router = testRouter()
  await router.push('/')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(ViewHost, {
    global: { plugins: [pinia, router, i18n] },
    slots: {
      default: () => h(component as never, props, slot ? { default: slot } : undefined)
    },
    attachTo: document.body
  })
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('component smoke', () => {
  it('mounts ComfyUpdateProgressModal', async () => {
    const C = (await import('../../src/renderer/src/components/ComfyUpdateProgressModal.vue'))
      .default
    const w = await show(C, { show: true, title: 'Update' })
    expect(w.html()).toBeTruthy()
    w.unmount()
  })

  it('mounts NodeOpProgressModal', async () => {
    const C = (await import('../../src/renderer/src/components/NodeOpProgressModal.vue')).default
    const w = await show(C, { show: true, title: 'Nodes', mode: 'single' })
    expect(w.html()).toBeTruthy()
    w.unmount()
  })

  it('mounts CommandPalette', async () => {
    const C = (await import('../../src/renderer/src/components/CommandPalette.vue')).default
    const w = await show(C)
    expect(w.html()).toBeTruthy()
    w.unmount()
  })

  it('mounts NotificationCenter', async () => {
    const C = (await import('../../src/renderer/src/components/NotificationCenter.vue')).default
    const w = await show(C)
    expect(w.html()).toBeTruthy()
    w.unmount()
  })

  it('mounts TargetBanner', async () => {
    const C = (await import('../../src/renderer/src/components/TargetBanner.vue')).default
    const w = await show(C)
    expect(w.html()).toBeTruthy()
    w.unmount()
  })

  it('mounts TaskCenter', async () => {
    const C = (await import('../../src/renderer/src/components/TaskCenter.vue')).default
    const w = await show(C)
    expect(w.html()).toBeTruthy()
    w.unmount()
  })

  it('mounts PipOpModal', async () => {
    const C = (await import('../../src/renderer/src/components/PipOpModal.vue')).default
    const w = await show(C)
    expect(w.html()).toBeTruthy()
    w.unmount()
  })

  it('mounts LaunchProfileEditor', async () => {
    const C = (await import('../../src/renderer/src/components/LaunchProfileEditor.vue')).default
    const w = await show(C, {
      modelValue: {},
      extraArgs: [],
      gpus: [{ vramTotal: 16 * 1024 ** 3 }],
      version: '0.3.0'
    })
    expect(w.html()).toBeTruthy()
    w.unmount()
  })

  it('mounts ListSkeleton / StatCard / IndeterminateBar / ErrorBoundary', async () => {
    const Skeleton = (await import('../../src/renderer/src/components/ListSkeleton.vue')).default
    const Stat = (await import('../../src/renderer/src/components/StatCard.vue')).default
    const Bar = (await import('../../src/renderer/src/components/IndeterminateBar.vue')).default
    const Error = (await import('../../src/renderer/src/components/ErrorBoundary.vue')).default
    const a = await show(Skeleton, { rows: 2, variant: 'card' })
    const b = await show(Stat, { label: 'CPU', value: 1, hint: 'x' })
    const c = await show(Bar, { height: 6, label: 'loading' })
    const d = await show(Error, {}, () => h('div', 'ok'))
    expect(a.html()).toBeTruthy()
    expect(b.html()).toContain('CPU')
    expect(c.html()).toContain('loading')
    expect(d.html()).toContain('ok')
    a.unmount()
    b.unmount()
    c.unmount()
    d.unmount()
  })

  it('propagates a broken component instead of swallowing the error', async () => {
    const Broken = defineComponent({
      setup() {
        throw new Error('component blew up')
      }
    })
    await expect(show(Broken)).rejects.toThrow('component blew up')
  })
})
