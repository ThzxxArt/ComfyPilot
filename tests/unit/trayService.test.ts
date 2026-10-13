/**
 * Tray actions (0.1.11): start-all/stop-all failures surface as system
 * notifications instead of being silently swallowed, and enablement tracks
 * the instance list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const h = vi.hoisted(() => ({
  notifications: [] as Array<{ title?: string; body?: string }>,
  template: null as Array<Record<string, unknown>> | null,
  instances: [] as unknown[],
  startAllImpl: null as null | (() => Promise<unknown>),
  startAllCalls: 0
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cp-tray-test', getAppPath: () => '/tmp/cp-tray-test' },
  Tray: class {
    on(): void {
      /* noop */
    }
    destroy(): void {
      /* noop */
    }
    setContextMenu(): void {
      /* noop */
    }
    setToolTip(): void {
      /* noop */
    }
  },
  Menu: {
    buildFromTemplate: (t: Array<Record<string, unknown>>) => {
      h.template = t
      return t
    }
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
    createEmpty: () => ({})
  },
  Notification: class {
    constructor(opts: { title?: string; body?: string }) {
      h.notifications.push(opts)
    }
    show(): void {
      /* noop */
    }
  },
  shell: { openExternal: async () => undefined },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../src/main/services/instance', () => {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>
  emitter.list = () => h.instances
  emitter.startAll = async () => {
    h.startAllCalls += 1
    return h.startAllImpl ? h.startAllImpl() : []
  }
  emitter.stopAll = async () => []
  emitter.launch = async () => undefined
  emitter.stop = async () => undefined
  return { instanceService: emitter }
})

import { createTray, refreshTray } from '../../src/main/services/tray'

const inst = (id: string, status: string): Record<string, unknown> => ({
  id,
  name: id,
  status,
  port: 8188,
  url: 'http://127.0.0.1:8188',
  listen: '127.0.0.1'
})

function findItem(label: string): Record<string, unknown> {
  const hit = (h.template || []).find((i) => i.label === label)
  expect(hit, `menu item "${label}"`).toBeTruthy()
  return hit!
}

describe('tray actions (0.1.11)', () => {
  beforeEach(() => {
    h.notifications.length = 0
    h.template = null
    h.instances = []
    h.startAllImpl = null
    h.startAllCalls = 0
  })

  it('start-all failure surfaces a system notification instead of silence', async () => {
    h.instances = [inst('a', 'stopped')]
    h.startAllImpl = async () => {
      throw new Error('boom-start')
    }
    createTray({ onShowWindow: () => undefined })
    await refreshTray()
    const item = findItem('启动全部实例')
    expect(item.enabled).toBe(true)
    ;(item.click as () => void)()
    await new Promise((r) => setTimeout(r, 20))
    expect(
      h.notifications.some((n) => n.title === '操作失败' && n.body?.includes('boom-start'))
    ).toBe(true)
  })

  it('start-all success calls the service without notifying', async () => {
    h.instances = [inst('a', 'stopped')]
    createTray({ onShowWindow: () => undefined })
    await refreshTray()
    ;(findItem('启动全部实例').click as () => void)()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.startAllCalls).toBe(1)
    expect(h.notifications.length).toBe(0)
  })

  it('stop-all enablement tracks running instances', async () => {
    h.instances = [inst('a', 'stopped')]
    createTray({ onShowWindow: () => undefined })
    await refreshTray()
    expect(findItem('停止全部实例').enabled).toBe(false)
    h.instances = [inst('a', 'running')]
    await refreshTray()
    expect(findItem('停止全部实例').enabled).toBe(true)
  })
})
