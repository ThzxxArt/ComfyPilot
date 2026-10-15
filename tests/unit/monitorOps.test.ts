/**
 * Monitor runtime operations (0.1.15): clear queue / interrupt / free memory.
 * Covers the ComfyApiClient request shapes, the monitor service orchestration
 * (trust check + remote auth passthrough + honest results) and the renderer's
 * injectable runMonitorOp branch behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  state: {
    remotes: [] as Array<{ id: string; name: string; baseUrl: string; apiKey?: string }>
  }
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => [],
  listRemotes: () => h.state.remotes
}))

describe('ComfyApiClient.clearQueue (0.1.15)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const calls: Array<{ url: string; init?: RequestInit }> = []

  beforeEach(() => {
    calls.length = 0
    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('posts {"clear": true} to /queue and reports acceptance', async () => {
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://127.0.0.1:8188')
    expect(await client.clearQueue()).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/queue')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ clear: true })
  })

  it('returns false on server error and on network failure', async () => {
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://127.0.0.1:8188')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    )
    expect(await client.clearQueue()).toBe(false)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    expect(await client.clearQueue()).toBe(false)
  })
})

describe('monitorService runtime operations (0.1.15)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const calls: Array<{ url: string; init?: RequestInit }> = []

  beforeEach(() => {
    calls.length = 0
    h.state.remotes = []
    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const u = String(url)
      if (u.includes('/interrupt') || u.includes('/free') || u.endsWith('/queue')) {
        return new Response('{}', { status: 200 })
      }
      return new Response('nope', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('clearQueue calls the local queue endpoint and returns ok', async () => {
    const { monitorService } = await import('../../src/main/services/monitor')
    expect(await monitorService.clearQueue('http://127.0.0.1:8188')).toEqual({ ok: true })
    expect(calls[0].url).toContain('/queue')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ clear: true })
  })

  it('interrupt sends prompt_id when given and bare POST otherwise', async () => {
    const { monitorService } = await import('../../src/main/services/monitor')
    expect(await monitorService.interrupt('http://127.0.0.1:8188', 'p-1')).toEqual({ ok: true })
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ prompt_id: 'p-1' })

    calls.length = 0
    expect(await monitorService.interrupt('http://127.0.0.1:8188')).toEqual({ ok: true })
    expect(calls[0].init?.body).toBeUndefined()
  })

  it('freeMemory posts unload_models + free_memory', async () => {
    const { monitorService } = await import('../../src/main/services/monitor')
    expect(await monitorService.freeMemory('http://127.0.0.1:8188')).toEqual({ ok: true })
    expect(calls[0].url).toContain('/free')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      unload_models: true,
      free_memory: true
    })
  })

  it('refuses untrusted origins with an honest error (never silent)', async () => {
    const { monitorService } = await import('../../src/main/services/monitor')
    const r = await monitorService.clearQueue('http://evil.example.com:8188')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('attaches remote bearer auth for a configured remote origin', async () => {
    h.state.remotes = [
      { id: 'r1', name: 'rig', baseUrl: 'http://192.168.1.50:8188', apiKey: 'secret-token' }
    ]
    const { monitorService } = await import('../../src/main/services/monitor')
    const r = await monitorService.interrupt('http://192.168.1.50:8188', 'p-9')
    expect(r).toEqual({ ok: true })
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret-token')
  })

  it('reports server refusal with the endpoint in the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 }))
    )
    const { monitorService } = await import('../../src/main/services/monitor')
    const r = await monitorService.freeMemory('http://127.0.0.1:8188')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('127.0.0.1:8188')
  })
})

describe('runMonitorOp orchestration (renderer util)', () => {
  it('refreshes live state BEFORE reporting success', async () => {
    const order: string[] = []
    const { runMonitorOp } = await import('../../src/renderer/src/utils/monitorOps')
    const ok = await runMonitorOp({
      run: async () => {
        order.push('run')
        return { ok: true }
      },
      refresh: async () => {
        order.push('refresh')
      },
      onSuccess: () => order.push('success'),
      onError: () => order.push('error')
    })
    expect(ok).toBe(true)
    expect(order).toEqual(['run', 'refresh', 'success'])
  })

  it('surfaces the real error and does NOT refresh on ok:false', async () => {
    const { runMonitorOp } = await import('../../src/renderer/src/utils/monitorOps')
    const refresh = vi.fn(async () => undefined)
    const onError = vi.fn()
    const ok = await runMonitorOp({
      run: async () => ({ ok: false, error: 'queue clear was not accepted' }),
      refresh,
      onSuccess: () => undefined,
      onError
    })
    expect(ok).toBe(false)
    expect(onError).toHaveBeenCalledWith('queue clear was not accepted')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when ok:false carries no error', async () => {
    const { runMonitorOp } = await import('../../src/renderer/src/utils/monitorOps')
    const onError = vi.fn()
    await runMonitorOp({
      run: async () => ({ ok: false }),
      refresh: async () => undefined,
      onSuccess: () => undefined,
      onError
    })
    expect(onError).toHaveBeenCalledWith('operation was not accepted')
  })

  it('catches transport rejections (ipc throw) into onError', async () => {
    const { runMonitorOp } = await import('../../src/renderer/src/utils/monitorOps')
    const onError = vi.fn()
    const ok = await runMonitorOp({
      run: async () => {
        throw new Error('Blocked untrusted monitor URL')
      },
      refresh: async () => undefined,
      onSuccess: () => undefined,
      onError
    })
    expect(ok).toBe(false)
    expect(onError).toHaveBeenCalledWith('Blocked untrusted monitor URL')
  })
})
