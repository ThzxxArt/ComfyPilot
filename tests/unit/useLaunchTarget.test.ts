/**
 * 0.2.5 WP7 regression: the port-conflict dialog must patch ONLY the port.
 * The old code re-saved the whole instance record and silently dropped
 * pythonVersion / migrationState / migrationError.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const h = vi.hoisted(() => ({
  dialog: null as null | Record<string, unknown>,
  calls: [] as Array<{ channel: string; args: unknown[] }>,
  push: vi.fn(),
  refreshInstances: vi.fn(async () => undefined),
  syncWs: vi.fn()
}))

vi.mock('naive-ui', () => ({
  createDiscreteApi: () => ({
    message: {
      success: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warning: vi.fn()
    },
    dialog: {
      warning: (opts: Record<string, unknown>) => {
        h.dialog = opts
      }
    }
  })
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: h.push })
}))

vi.mock('@/composables/useIpc', () => {
  class ComfyPilotIpcError extends Error {
    code?: string
    suggestedPort?: number
    constructor(message: string, code?: string) {
      super(message)
      this.code = code
    }
  }
  const ipc = vi.fn(async (channel: string, ...args: unknown[]) => {
    h.calls.push({ channel, args })
    if (channel === 'instance.launch') {
      const first = h.calls.filter((c) => c.channel === 'instance.launch').length === 1
      if (first) {
        const err = new ComfyPilotIpcError('port busy', 'PORT_IN_USE')
        err.suggestedPort = 9999
        throw err
      }
      return {
        id: 'i1',
        name: 'Alpha',
        url: 'http://127.0.0.1:9999',
        status: 'running'
      }
    }
    return undefined
  })
  return { ipc, ComfyPilotIpcError }
})

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    refreshInstances: h.refreshInstances,
    syncWs: h.syncWs
  })
}))

vi.mock('@/i18n', () => ({
  i18n: { global: { t: (key: string) => key } }
}))

import { useLaunch } from '@/composables/useLaunch'
import type { ComfyInstanceInfo } from '@shared/types'

const info = {
  id: 'i1',
  name: 'Alpha',
  path: '/tmp/comfy',
  port: 8188,
  listen: '127.0.0.1',
  status: 'stopped',
  url: 'http://127.0.0.1:8188'
} as ComfyInstanceInfo

describe('useLaunch port conflict (0.2.5 WP7)', () => {
  beforeEach(() => {
    h.dialog = null
    h.calls = []
    h.refreshInstances.mockClear()
    h.syncWs.mockClear()
    h.push.mockClear()
  })

  it('persists only the suggested port and never rewrites the whole record', async () => {
    const { launch } = useLaunch()
    await launch(info)
    expect(h.dialog).toBeTruthy()
    const onClick = h.dialog!.onPositiveClick as () => void
    onClick()
    await flushPromises()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.calls.some((c) => c.channel === 'instance.setPort')).toBe(true)
    expect(h.calls.find((c) => c.channel === 'instance.setPort')?.args).toEqual(['i1', 9999])
    expect(h.calls.some((c) => c.channel === 'instance.save')).toBe(false)
    // The second launch is the explicit relocate path.
    expect(h.calls.filter((c) => c.channel === 'instance.launch')).toHaveLength(2)
  })

  it('does nothing when the user dismisses the relocation dialog', async () => {
    const { launch } = useLaunch()
    await launch(info)
    await flushPromises()
    await new Promise((r) => setTimeout(r, 10))
    expect(h.dialog).toBeTruthy()
    expect(h.calls.some((c) => c.channel === 'instance.setPort')).toBe(false)
    expect(h.calls.filter((c) => c.channel === 'instance.launch')).toHaveLength(1)
  })
})
