/**
 * App store target resolution (0.1.10): activeTargetUrl must point at the
 * REMOTE baseUrl when a remote is selected, and at the local instance URL
 * otherwise — the fact the monitor/dashboard views consume.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/composables/useIpc', () => ({
  ipc: vi.fn(async () => undefined),
  onInstanceStatus: () => () => undefined,
  onMonitorTick: () => () => undefined,
  onIpc: () => () => undefined,
  onNotification: () => () => undefined,
  IPC_EVENTS: { monitorWs: 'event:monitor-ws', notification: 'event:notification' }
}))

describe('app store activeTargetUrl (0.1.10)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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
