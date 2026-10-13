/**
 * App store target resolution (0.1.10) + WS lifetime (0.1.11): activeTargetUrl
 * must point at the REMOTE baseUrl when a remote is selected, and the progress
 * WebSocket must follow instance STATUS transitions (running → connect,
 * stopped → disconnect) — a launch after app start used to leave it unconnected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const ipcMock = vi.hoisted(() => vi.fn(async (_channel: string, ..._args: unknown[]) => undefined))

vi.mock('@/composables/useIpc', () => ({
  ipc: ipcMock,
  onInstanceStatus: () => () => undefined,
  onMonitorTick: () => () => undefined,
  onIpc: () => () => undefined,
  onNotification: () => () => undefined,
  IPC_EVENTS: { monitorWs: 'event:monitor-ws', notification: 'event:notification' }
}))

describe('app store activeTargetUrl (0.1.10)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ipcMock.mockClear()
  })

  async function freshStore() {
    vi.resetModules()
    return (await import('@/stores/app')).useAppStore()
  }

  it('resolves to the local instance URL when no remote is selected', async () => {
    const store = await freshStore()
    store.$patch({
      instances: [
        {
          id: 'i1',
          name: 'Local',
          url: 'http://127.0.0.1:8188',
          status: 'running'
        } as never
      ]
    })
    store.activeInstanceId = 'i1'
    store.activeRemoteId = null
    expect(store.isRemoteActive).toBe(false)
    expect(store.activeTargetUrl).toBe('http://127.0.0.1:8188')
  })

  it('prefers the remote baseUrl when a remote is selected (and stays consistent)', async () => {
    const store = await freshStore()
    store.$patch({
      instances: [
        { id: 'i1', name: 'Local', url: 'http://127.0.0.1:8188', status: 'running' } as never
      ],
      remotes: [
        {
          id: 'r1',
          name: 'Remote',
          baseUrl: 'http://192.168.1.9:8188',
          label: '',
          enabled: true
        }
      ]
    })
    store.activeRemoteId = 'r1'
    expect(store.isRemoteActive).toBe(true)
    expect(store.activeTargetUrl).toBe('http://192.168.1.9:8188')
    expect(store.activeRemote?.name).toBe('Remote')
  })

  it('falls back to null when neither target has a URL', async () => {
    const store = await freshStore()
    store.$patch({ instances: [] })
    store.activeInstanceId = null
    store.activeRemoteId = null
    expect(store.activeTargetUrl).toBeNull()
  })
})

describe('app store WS lifetime (0.1.11)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ipcMock.mockClear()
  })

  async function freshStore() {
    vi.resetModules()
    return (await import('@/stores/app')).useAppStore()
  }

  it('connects when a stopped instance becomes running and drops the socket when it stops', async () => {
    const store = await freshStore()
    store.$patch({
      instances: [
        { id: 'i1', name: 'Local', url: 'http://127.0.0.1:8188', status: 'stopped' } as never
      ]
    })
    store.activeInstanceId = 'i1'
    await nextTick()
    // Stopped target → the store explicitly disconnects (no stale reconnect).
    expect(ipcMock).toHaveBeenCalledWith('monitor.disconnectWs')

    ipcMock.mockClear()
    // The status watch must fire on the running transition (the launch path
    // used to never connect: previews/progress stayed empty forever).
    store.instances[0] = {
      ...(store.instances[0] as Record<string, unknown>),
      status: 'running'
    } as never
    await nextTick()
    expect(ipcMock).toHaveBeenCalledWith('monitor.connectWs', 'http://127.0.0.1:8188')

    ipcMock.mockClear()
    store.instances[0] = {
      ...(store.instances[0] as Record<string, unknown>),
      status: 'stopped'
    } as never
    await nextTick()
    expect(ipcMock).toHaveBeenCalledWith('monitor.disconnectWs')
  })
})
