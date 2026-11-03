/**
 * 0.2.3: the preload bridge is the only renderer→main door.
 *
 * It used to be outside the coverage denominator entirely. These tests pin the
 * channel/event allow-list, structured-clone flattening and unsubscribe path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  exposed: null as unknown,
  invokes: [] as Array<{ channel: string; args: unknown[] }>,
  listeners: new Map<string, (...a: unknown[]) => void>(),
  removed: [] as Array<[string, (...a: unknown[]) => void]>
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      h.exposed = api
    }
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      h.invokes.push({ channel, args })
      return { ok: true, data: { channel, args } }
    },
    on: (event: string, cb: (...a: unknown[]) => void) => {
      h.listeners.set(event, cb)
    },
    removeListener: (event: string, cb: (...a: unknown[]) => void) => {
      h.removed.push([event, cb])
    }
  }
}))

type Bridge = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (event: string, listener: (...args: unknown[]) => void) => () => void
  events: Record<string, string>
  toPlainIpcArg?: <T>(v: T) => T
}

async function bridge(): Promise<Bridge> {
  await import('../../src/preload/index')
  return h.exposed as Bridge
}

beforeEach(() => {
  h.invokes.length = 0
  h.listeners.clear()
  h.removed.length = 0
})

describe('preload bridge', () => {
  it('exposes only invoke/on/events', async () => {
    const api = await bridge()
    expect(Object.keys(api).sort()).toEqual(['events', 'invoke', 'on'])
    expect(api.events.instanceStatus).toBeTruthy()
  })

  it('forwards an allowed channel after flattening Vue proxies', async () => {
    const api = await bridge()
    const raw = { theme: 'light', nested: { port: 8188 } }
    const proxy = new Proxy(raw, {
      get: (target, prop, receiver) => Reflect.get(target, prop, receiver)
    })
    const res = await api.invoke('settings.set', proxy)
    expect(res).toEqual({
      ok: true,
      data: { channel: 'settings.set', args: [{ theme: 'light', nested: { port: 8188 } }] }
    })
    expect(h.invokes[0].channel).toBe('settings.set')
  })

  it('blocks an unknown channel without touching ipcRenderer', async () => {
    const api = await bridge()
    const res = (await api.invoke('settings.nukeEverything')) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Unknown IPC channel')
    expect(h.invokes).toHaveLength(0)
  })

  it('subscribes to a known event and returns an idempotent unsubscribe', async () => {
    const api = await bridge()
    const fn = vi.fn()
    const off = api.on('event:instance-status', fn)
    const registered = h.listeners.get('event:instance-status')!
    registered({}, { id: 'i1' })
    expect(fn).toHaveBeenCalledWith({ id: 'i1' })
    off()
    expect(h.removed).toHaveLength(1)
  })

  it('ignores an unknown event name', async () => {
    const api = await bridge()
    const fn = vi.fn()
    const off = api.on('event:not-real', fn)
    expect(h.listeners.size).toBe(0)
    expect(off()).toBeUndefined()
  })
})
