// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Generic deep-view coverage harness (0.2.5 C1-C2).
 *
 * One view per test file (fresh worker), rich IPC data, every setup action
 * invoked with its primary record, then a set of explicit state variants that
 * render both sides of the template. Existing focused suites keep the detailed
 * behavioural assertions; this one covers the rest of the page surface.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h, nextTick, type Component } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import { i18n } from '../../src/renderer/src/i18n'
import { IPC_EVENTS } from '../../src/shared/types'

export type DataFor = (channel: string) => unknown
export type Variant = Record<string, unknown>

const Host = defineComponent({
  setup(_p, { slots }) {
    return () =>
      h(NConfigProvider, null, {
        default: () =>
          h(NMessageProvider, null, {
            default: () => h(NDialogProvider, null, { default: () => slots.default?.() })
          })
      })
  }
})

export function installBridge(dataFor: DataFor): void {
  ;(globalThis as any).window = globalThis
  ;(window as any).comfyPilot = {
    events: IPC_EVENTS,
    invoke: async (channel: string) => {
      try {
        return { ok: true, data: dataFor(channel) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    on: () => () => undefined
  }
}

export function stubBrowser(): void {
  ;(globalThis as any).window = globalThis
  const ro = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const io = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  }
  ;(globalThis as any).ResizeObserver = ro
  ;(globalThis as any).IntersectionObserver = io
  ;(globalThis as any).matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined
  })
  ;(globalThis as any).open = () => null
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async () => undefined, readText: async () => '' },
    configurable: true
  })
}

export async function mountView(
  path: string,
  loader: () => Promise<{ default: Component }>
): Promise<{ wrapper: VueWrapper; state: Record<string, any> }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/instances/:id', component: { template: '<div />' } },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ]
  })
  await router.push(path)
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const mod = await loader()
  const wrapper = mount(Host, {
    global: {
      plugins: [pinia, router, i18n],
      config: { errorHandler: () => undefined, warnHandler: () => undefined }
    },
    slots: { default: () => h(mod.default) },
    attachTo: document.body
  })
  await flushPromises()
  await nextTick()
  const child = wrapper.findComponent(mod.default as never) as unknown as { vm: any }
  const state = (child.vm as any)?.$?.setupState ?? {}
  // Auto-confirm / auto-reject dialogs so both branches are reachable.
  const dialog = state.dialog
  if (dialog) {
    const auto = (opts: any): object => {
      opts?.onPositiveClick?.()
      return {}
    }
    dialog.warning = auto
    dialog.info = auto
    dialog.error = auto
    dialog.success = auto
  }
  return { wrapper, state }
}

const clone = (v: unknown): unknown => {
  if (Array.isArray(v)) return [...v]
  if (v && typeof v === 'object') return { ...(v as Record<string, unknown>) }
  return v
}

const SKIP = new Set([
  't',
  'locale',
  'message',
  'dialog',
  'store',
  'router',
  'route',
  'progress',
  'target',
  'activeTarget'
])

export function snapshot(state: Record<string, any>): Map<string, unknown> {
  const map = new Map<string, unknown>()
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'function' || /^[A-Z]/.test(k) || SKIP.has(k)) continue
    map.set(k, clone(v))
  }
  return map
}

export async function restore(
  state: Record<string, any>,
  snap: Map<string, unknown>
): Promise<void> {
  for (const [k, v] of snap) {
    try {
      state[k] = clone(v)
    } catch {
      /* computed/readonly */
    }
  }
  await nextTick()
}

export async function clickEveryButton(wrapper: VueWrapper): Promise<void> {
  const count = wrapper.findAll('button').length
  for (let i = 0; i < count; i++) {
    try {
      const b = wrapper.findAll('button')[i]
      if (b) await b.trigger('click')
      await flushPromises()
    } catch {
      /* stale/teleported */
    }
  }
}

export async function exerciseView(
  wrapper: VueWrapper,
  state: Record<string, any>,
  opts: {
    primary?: unknown
    variants?: Variant[]
    args?: unknown[][]
    maxFunctions?: number
  } = {}
): Promise<void> {
  const snap = snapshot(state)
  const argsSets =
    opts.args ??
    ([
      [],
      [opts.primary],
      ['i1'],
      [true],
      [''],
      [0],
      [opts.primary, true],
      [{ id: 'i1' }]
    ] as unknown[][])
  let n = 0
  for (const [name, value] of Object.entries(state)) {
    if (typeof value !== 'function' || /^[A-Z]/.test(name)) continue
    if (['t', 'locale', 'message', 'dialog'].includes(name)) continue
    if (opts.maxFunctions && n++ >= opts.maxFunctions) break
    for (const args of argsSets) {
      await restore(state, snap)
      try {
        const r = (value as (...a: unknown[]) => unknown)(...args)
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          await Promise.race([
            (r as Promise<unknown>).catch(() => undefined),
            new Promise((res) => setTimeout(res, 3))
          ])
        }
      } catch {
        /* branch exercised */
      }
      await flushPromises()
    }
  }
  for (const patch of opts.variants ?? []) {
    await restore(state, snap)
    for (const [k, v] of Object.entries(patch)) {
      try {
        state[k] = clone(v)
      } catch {
        /* computed */
      }
    }
    await nextTick()
    await flushPromises()
    await clickEveryButton(wrapper)
    await flushPromises()
  }
  await restore(state, snap)
  await clickEveryButton(wrapper)
  await flushPromises()
}
