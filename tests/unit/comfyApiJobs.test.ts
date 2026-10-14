/**
 * ComfyApiClient /api/jobs + directed interrupt (0.1.10): request shapes,
 * limit enforcement and honest null/false fallbacks for older servers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('ComfyApiClient jobs API (0.1.10)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const calls: Array<{ url: string; init?: RequestInit }> = []

  beforeEach(() => {
    calls.length = 0
    fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const u = String(url)
      if (u.includes('/api/jobs/cancel')) return new Response('{}', { status: 200 })
      if (u.match(/\/api\/jobs\/[^/]+\/cancel$/)) return new Response('{}', { status: 200 })
      if (u.includes('/api/jobs')) {
        return new Response(
          JSON.stringify({
            jobs: [
              { id: 'j1', status: 'in_progress', workflow_id: 'wf-1', created_at: 123 },
              { id: 'j2', status: 'completed' }
            ]
          }),
          { status: 200 }
        )
      }
      if (u.includes('/interrupt')) return new Response('{}', { status: 200 })
      return new Response('nope', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('jobsList always sends an explicit limit and normalizes entries', async () => {
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://127.0.0.1:8188')
    const jobs = await client.jobsList(25, 'in_progress')
    expect(jobs).toEqual([
      { id: 'j1', status: 'in_progress', workflowId: 'wf-1', createdAt: 123 },
      { id: 'j2', status: 'completed', workflowId: undefined, createdAt: undefined }
    ])
    const url = calls[0].url
    expect(url).toContain('limit=25')
    expect(url).toContain('status=in_progress')
  })

  it('jobsList clamps the limit into 1..500', async () => {
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://127.0.0.1:8188')
    await client.jobsList(99999)
    expect(calls[0].url).toContain('limit=500')
  })

  it('jobsList returns null when the endpoint is missing (old server)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    )
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://127.0.0.1:8188')
    expect(await client.jobsList()).toBeNull()
  })

  it('jobsCancel posts and reports honestly (jobCancel removed in 0.1.11)', async () => {
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://127.0.0.1:8188')
    expect(await client.jobsCancel(['j1', 'j2'])).toBe(true)
    const cancelCall = calls.at(-1)!
    expect(cancelCall.url).toContain('/api/jobs/cancel')
    expect(JSON.parse(String(cancelCall.init?.body))).toEqual({ job_ids: ['j1', 'j2'] })

    // Empty list short-circuits without a request.
    const before = calls.length
    expect(await client.jobsCancel([])).toBe(true)
    expect(calls.length).toBe(before)
  })

  it('interrupt without an id is global; with an id sends the JSON body', async () => {
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://127.0.0.1:8188')
    await client.interrupt()
    expect(calls.at(-1)!.init?.body).toBeUndefined()
    await client.interrupt('p-9')
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({ prompt_id: 'p-9' })
  })

  it('queuePrompt sends workflow_metadata only when it fits into 256 bytes', async () => {
    const promptFetch = vi.fn(
      async (_u: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ prompt_id: 'pid-1' }), { status: 200, headers: {} })
    )
    vi.stubGlobal('fetch', promptFetch)
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://127.0.0.1:8188')

    await client.queuePrompt({ '1': { class_type: 'X', inputs: {} } }, 'cid', {
      metadata: { source: 'comfypilot', batchJobId: 'b1' }
    })
    const body = JSON.parse(String((promptFetch.mock.calls[0] as any[])[1]?.body))
    expect(body.workflow_metadata).toEqual({ source: 'comfypilot', batchJobId: 'b1' })

    await client.queuePrompt({ '1': {} }, 'cid', {
      metadata: { source: 'comfypilot', big: 'x'.repeat(300) }
    })
    const body2 = JSON.parse(String((promptFetch.mock.calls[1] as any[])[1]?.body))
    expect(body2.workflow_metadata).toBeUndefined()
  })

  it('freeMemory posts /free with unload flags; auth comes from the constructor (0.1.11)', async () => {
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    // Auth headers are injected on EVERY request (remote apiKey support).
    const client = new ComfyApiClient('http://127.0.0.1:8188', {
      headers: { Authorization: 'Bearer t' }
    })
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    })
    const ok = await client.freeMemory()
    expect(ok).toBe(true)
    const call = calls.find((c) => c.url.includes('/free'))!
    expect(call.init?.method).toBe('POST')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      unload_models: true,
      free_memory: true
    })
    expect((call.init?.headers as Record<string, string>).Authorization).toBe('Bearer t')
    // Server refusal → false (callers surface it, never a fake success).
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    expect(await client.freeMemory()).toBe(false)
  })

  it('auth headers travel on every API call, not just probes (0.1.11)', async () => {
    const { ComfyApiClient } = await import('../../src/main/services/comfyApi')
    const client = new ComfyApiClient('http://10.0.0.5:8188', {
      headers: { Authorization: 'Bearer k' }
    })
    await client.jobsList(5)
    await client.history(3)
    await client.deleteQueueItems(['p1'])
    await client.interrupt('p1')
    const authed = calls.filter(
      (c) => (c.init?.headers as Record<string, string> | undefined)?.Authorization
    )
    // jobsList + history + queue-delete + interrupt all carried the header.
    expect(authed.length).toBeGreaterThanOrEqual(4)
    // Per-call Content-Type survives the merge.
    const del = calls.find((c) => c.url.includes('/queue') && c.init?.method === 'POST')!
    expect((del.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})
