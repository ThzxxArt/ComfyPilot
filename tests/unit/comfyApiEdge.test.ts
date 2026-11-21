/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init?: any }>,
  handler: null as null | ((url: string, init?: any) => Response | Promise<Response>)
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyFetch: async (url: string, init?: any) => {
    h.calls.push({ url: String(url), init })
    if (!h.handler) throw new Error('no handler')
    return h.handler(String(url), init)
  }
}))

import { ComfyApiClient } from '../../src/main/services/comfyApi'

function res(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: () => null }
  } as unknown as Response
}

beforeEach(() => {
  h.calls = []
  h.handler = null
})

describe('ComfyApiClient edge branches', () => {
  it('merges auth headers under per-call headers', async () => {
    h.handler = () => res({ ok: true })
    const noAuth = new ComfyApiClient('http://x/')
    await noAuth.systemStats()
    expect(h.calls[0].url).toBe('http://x/system_stats')
    expect(h.calls[0].init).toEqual({ signal: expect.anything() })

    h.calls = []
    const auth = new ComfyApiClient('http://x/', {
      headers: { Authorization: 'Bearer t', 'Content-Type': 'custom' }
    })
    await auth.queuePrompt({ a: 1 }, 'cid')
    expect(h.calls[0].init.headers.Authorization).toBe('Bearer t')
    expect(h.calls[0].init.headers['Content-Type']).toBe('application/json')
  })

  it('reads system stats and tolerates HTTP/network failures', async () => {
    const c = new ComfyApiClient('http://x')
    h.handler = () => res({ system: {} })
    expect(await c.systemStats()).toEqual({ system: {} })
    h.handler = () => res('', { ok: false, status: 500 })
    expect(await c.systemStats()).toBeNull()
    h.handler = () => {
      throw new Error('offline')
    }
    expect(await c.systemStats()).toBeNull()
  })

  it('normalizes queue rows and handles non-array payloads', async () => {
    const c = new ComfyApiClient('http://x')
    h.handler = () =>
      res({
        queue_running: [[0, 'r1'], 'str', [0, ''], [0]],
        queue_pending: undefined
      })
    expect(await c.queueState()).toEqual({ running: ['r1'], pending: [] })
    h.handler = () => res('', { ok: false })
    expect(await c.queueState()).toEqual({ running: [], pending: [] })
    h.handler = () => {
      throw new Error('down')
    }
    expect(await c.queueState()).toEqual({ running: [], pending: [] })
  })

  it('attaches workflow metadata only when it is small and serializable', async () => {
    const c = new ComfyApiClient('http://x')
    h.handler = () => res({ prompt_id: 'p1' })
    expect(await c.queuePrompt({}, 'cid', { metadata: { a: 1 } })).toBe('p1')
    const body = JSON.parse(h.calls[0].init.body)
    expect(body.workflow_metadata).toEqual({ a: 1 })

    h.calls = []
    await c.queuePrompt({}, 'cid', { metadata: { big: 'x'.repeat(400) } })
    expect(JSON.parse(h.calls[0].init.body).workflow_metadata).toBeUndefined()

    h.calls = []
    await c.queuePrompt({}, 'cid', { metadata: { n: 1n } as never })
    expect(JSON.parse(h.calls[0].init.body).workflow_metadata).toBeUndefined()

    h.calls = []
    h.handler = () => res({})
    expect(await c.queuePrompt({}, 'cid')).toBeNull()
  })

  it('surfaces ComfyUI prompt rejection details', async () => {
    const c = new ComfyApiClient('http://x')
    h.handler = () => res({ error: { message: 'bad prompt' } }, { ok: false, status: 400 })
    await expect(c.queuePrompt({}, 'cid')).rejects.toThrow(/bad prompt/)

    h.handler = () => res({ error: { details: 'detail' } }, { ok: false, status: 400 })
    await expect(c.queuePrompt({}, 'cid')).rejects.toThrow(/detail/)

    h.handler = () => res({ node_errors: { NodeA: {}, NodeB: {} } }, { ok: false, status: 400 })
    await expect(c.queuePrompt({}, 'cid')).rejects.toThrow(/node errors: NodeA, NodeB/)

    h.handler = () => res('plain failure', { ok: false, status: 500 })
    await expect(c.queuePrompt({}, 'cid')).rejects.toThrow(/plain failure/)

    h.handler = () => res('', { ok: false, status: 500 })
    await expect(c.queuePrompt({}, 'cid')).rejects.toThrow(/no detail/)

    h.handler = () => {
      throw new Error('socket hang up')
    }
    await expect(c.queuePrompt({}, 'cid')).rejects.toThrow(/queuePrompt failed: socket hang up/)
  })

  it('parses history entries, statuses, timestamps and every output kind', async () => {
    const c = new ComfyApiClient('http://x')
    expect(await c.historyItem('')).toBeNull()
    h.handler = () => res({}, { ok: false })
    expect(await c.historyItem('p')).toBeNull()
    h.handler = () => res({})
    expect(await c.historyItem('p')).toBeNull()

    h.handler = () =>
      res({
        p: {
          status: {
            status_str: 'success',
            messages: [
              'not-an-array',
              ['execution_success', { timestamp: 123 }],
              ['execution_error', { timestamp: 100 }],
              ['progress', { timestamp: 50 }]
            ]
          },
          outputs: {
            n1: {
              images: [{ filename: 'a.png', type: 'temp' }],
              gifs: [{ filename: 'b.gif', subfolder: 's' }],
              videos: [{ filename: 'c.mp4' }],
              audio: [{ filename: 'd.flac' }, { subfolder: 'no-file' }],
              other: 'not-array'
            },
            n2: 'not-an-object'
          }
        }
      })
    const item = (await c.historyItem('p'))!
    expect(item.status).toBe('success')
    expect(item.completedAt).toBe(100)
    expect(item.outputs.map((o) => o.filename)).toEqual(['a.png', 'b.gif', 'c.mp4', 'd.flac'])
    expect(item.outputs[0].type).toBe('temp')
    expect(item.outputs[1].subfolder).toBe('s')

    h.handler = () => res({ p: { status: { completed: true } } })
    expect((await c.historyItem('p'))?.status).toBe('success')
    h.handler = () => res({ p: { status: {} } })
    expect((await c.historyItem('p'))?.status).toBe('unknown')
    h.handler = () => {
      throw new Error('down')
    }
    expect(await c.historyItem('p')).toBeNull()

    h.handler = () => res({ a: { status: { status_str: 'error' } }, b: {} })
    expect(await c.history()).toHaveLength(2)
    h.handler = () => res('', { ok: false })
    expect(await c.history()).toEqual([])
    h.handler = () => {
      throw new Error('down')
    }
    expect(await c.history()).toEqual([])
  })

  it('handles queue delete/interrupt operations honestly', async () => {
    const c = new ComfyApiClient('http://x')
    expect(await c.deleteQueueItems([])).toBe(true)
    expect(await c.jobsCancel([])).toBe(true)
    h.handler = () => res('')
    expect(await c.deleteQueueItems(['p'])).toBe(true)
    expect(await c.clearQueue()).toBe(true)
    expect(await c.interrupt()).toBe(true)
    expect(await c.interrupt('p', 10)).toBe(true)
    expect(await c.jobsCancel(['j'])).toBe(true)
    expect(await c.freeMemory()).toBe(true)
    expect(h.calls.some((x) => x.url.endsWith('/interrupt') && x.init.body === undefined)).toBe(
      true
    )
    expect(
      h.calls.some(
        (x) =>
          x.url.endsWith('/interrupt') && x.init?.body && JSON.parse(x.init.body).prompt_id === 'p'
      )
    ).toBe(true)

    h.handler = () => res('', { ok: false })
    expect(await c.deleteQueueItems(['p'])).toBe(false)
    expect(await c.clearQueue()).toBe(false)
    expect(await c.interrupt('p')).toBe(false)
    expect(await c.jobsCancel(['j'])).toBe(false)
    expect(await c.freeMemory()).toBe(false)

    h.handler = () => {
      throw new Error('down')
    }
    expect(await c.deleteQueueItems(['p'])).toBe(false)
    expect(await c.clearQueue()).toBe(false)
    expect(await c.interrupt()).toBe(false)
    expect(await c.jobsCancel(['j'])).toBe(false)
    expect(await c.freeMemory()).toBe(false)
  })

  it('maps /api/jobs and clamps the limit', async () => {
    const c = new ComfyApiClient('http://x')
    h.handler = () => res({ jobs: [{ id: 1, status: 'done', workflow_id: 'w', created_at: 5 }] })
    expect(await c.jobsList(9999, 'done')).toEqual([
      { id: '1', status: 'done', workflowId: 'w', createdAt: 5 }
    ])
    expect(h.calls[0].url).toContain('limit=500')
    expect(h.calls[0].url).toContain('status=done')

    h.calls = []
    await c.jobsList(0)
    expect(h.calls[0].url).toContain('limit=1')
    expect(h.calls[0].url).not.toContain('status=')

    h.handler = () => res({ jobs: 'nope' })
    expect(await c.jobsList()).toBeNull()
    h.handler = () => res('', { ok: false })
    expect(await c.jobsList()).toBeNull()
    h.handler = () => {
      throw new Error('down')
    }
    expect(await c.jobsList()).toBeNull()
  })

  it('returns only object default workflows and tolerates failures', async () => {
    const c = new ComfyApiClient('http://x')
    h.handler = () => res({ nodes: [] })
    expect(await c.defaultWorkflow()).toEqual({ nodes: [] })
    h.handler = () => res([1, 2])
    expect(await c.defaultWorkflow()).toBeNull()
    h.handler = () => res('', { ok: false })
    expect(await c.defaultWorkflow()).toBeNull()
    h.handler = () => {
      throw new Error('down')
    }
    expect(await c.defaultWorkflow()).toBeNull()
  })
})
