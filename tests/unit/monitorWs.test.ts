/**
 * Monitor WS protocol tests (0.1.10): feature-flag negotiation, preview frame
 * decoding (both generations), progress_state parsing and throttling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

class FakeWS {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  static count = 0
  static last: FakeWS | null = null
  handlers: Record<string, Array<(...a: unknown[]) => void>> = {}
  sent: string[] = []
  readyState = 1
  url: string
  options: unknown
  constructor(url: string, options?: unknown) {
    this.url = url
    this.options = options
    FakeWS.last = this
    FakeWS.count += 1
    queueMicrotask(() => this.fire('open'))
  }
  on(ev: string, cb: (...a: unknown[]) => void): void {
    ;(this.handlers[ev] ||= []).push(cb)
  }
  once(ev: string, cb: (...a: unknown[]) => void): void {
    ;(this.handlers[ev] ||= []).push(cb)
  }
  removeAllListeners(): void {
    this.handlers = {}
  }
  close(): void {
    this.readyState = 2
  }
  send(s: string): void {
    this.sent.push(s)
  }
  fire(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers[ev] || []) cb(...args)
  }
}

vi.mock('ws', () => ({ default: FakeWS }))

const h = vi.hoisted(() => ({
  remotes: [] as Array<Record<string, unknown>>,
  instances: [] as Array<Record<string, unknown>>
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => h.instances,
  listRemotes: () => h.remotes
}))

function legacyPreviewFrame(imgType: number, bytes: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(1, 0)
  head.writeUInt32BE(imgType, 4)
  return Buffer.concat([head, bytes])
}

function metadataPreviewFrame(meta: Record<string, unknown>, bytes: Buffer): Buffer {
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf-8')
  const head = Buffer.alloc(8)
  head.writeUInt32BE(4, 0)
  head.writeUInt32BE(metaBuf.length, 4)
  return Buffer.concat([head, metaBuf, bytes])
}

describe('monitor WS protocol (0.1.10)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
    vi.resetModules()
    FakeWS.last = null
    FakeWS.count = 0
    h.remotes = []
    h.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function connect(): Promise<{
    svc: import('../../src/main/services/monitor').MonitorService
    ws: FakeWS
    events: Array<Record<string, unknown>>
  }> {
    const { MonitorService } = await import('../../src/main/services/monitor')
    const svc = new MonitorService()
    const events: Array<Record<string, unknown>> = []
    svc.on('ws', (e) => events.push(e as Record<string, unknown>))
    svc.connectWs('http://127.0.0.1:8188')
    await Promise.resolve()
    await Promise.resolve()
    return { svc, ws: FakeWS.last!, events }
  }

  it('negotiates supports_preview_metadata on open (first message)', async () => {
    const { ws } = await connect()
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: 'feature_flags',
      data: { supports_preview_metadata: true }
    })
  })

  it('keeps the live socket when connectWs repeats for the same target (0.1.11.1)', async () => {
    const { svc, ws } = await connect()
    expect(svc.connectWs('http://127.0.0.1:8188')).toBe(true)
    expect(FakeWS.count).toBe(1)
    expect(FakeWS.last).toBe(ws)
    expect(ws.sent).toHaveLength(1) // no re-negotiation on repeat subscribes
  })

  it('serializes reconnects: replacement opens only after the old socket closes (0.1.11.1)', async () => {
    const { svc, ws } = await connect()
    svc.connectWs('http://127.0.0.1:9999')
    // Old socket is closing — the replacement must NOT exist yet. Overlapping
    // sockets under one stable clientId corrupt the ComfyUI session tables.
    expect(FakeWS.count).toBe(1)
    expect(ws.readyState).toBe(2)
    ws.fire('close')
    await vi.advanceTimersByTimeAsync(249)
    expect(FakeWS.count).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWS.count).toBe(2)
    expect(FakeWS.last!.url).toContain('/ws?clientId=comfy-pilot')
  })

  it('falls back to the safety timer when the old socket never reports close (0.1.11.1)', async () => {
    const { svc } = await connect()
    svc.connectWs('http://127.0.0.1:9999')
    expect(FakeWS.count).toBe(1)
    await vi.advanceTimersByTimeAsync(1250)
    expect(FakeWS.count).toBe(2)
  })

  it('decodes legacy preview frames (event=1, 8-byte header)', async () => {
    const { ws, events } = await connect()
    ws.fire('message', legacyPreviewFrame(2, Buffer.from([1, 2, 3])))
    const preview = events.find((e) => e.type === 'preview')!
    expect(String(preview.image)).toMatch(/^data:image\/png;base64,/)
    // imgType 1 → jpeg
    vi.setSystemTime(1_000_500)
    ws.fire('message', legacyPreviewFrame(1, Buffer.from([9])))
    const jpegs = events.filter((e) => e.type === 'preview')
    expect(String(jpegs[1].image)).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('decodes metadata preview frames (event=4) incl. node/prompt ids', async () => {
    const { ws, events } = await connect()
    ws.fire(
      'message',
      metadataPreviewFrame(
        { image_type: 'image/jpeg', node_id: '12', prompt_id: 'p-1' },
        Buffer.from([7, 7])
      )
    )
    const preview = events.find((e) => e.type === 'preview')!
    expect(String(preview.image)).toMatch(/^data:image\/jpeg;base64,/)
    expect(preview.nodeId).toBe('12')
    expect(preview.promptId).toBe('p-1')
  })

  it('throttles previews to one frame per 300ms', async () => {
    const { ws, events } = await connect()
    ws.fire('message', legacyPreviewFrame(2, Buffer.from([1])))
    ws.fire('message', legacyPreviewFrame(2, Buffer.from([2])))
    expect(events.filter((e) => e.type === 'preview')).toHaveLength(1)
    vi.setSystemTime(1_000_400)
    ws.fire('message', legacyPreviewFrame(2, Buffer.from([3])))
    expect(events.filter((e) => e.type === 'preview')).toHaveLength(2)
  })

  it('parses progress_state into per-node progress', async () => {
    const { ws, events } = await connect()
    ws.fire(
      'message',
      JSON.stringify({
        type: 'progress_state',
        data: {
          prompt_id: 'p-9',
          nodes: {
            '3': { value: 5, max: 20, state: 'running', prompt_id: 'p-9' },
            '7': { value: 10, max: 10, state: 'finished' }
          }
        }
      })
    )
    const evt = events.find((e) => e.type === 'progress_state')!
    expect(evt.nodes).toMatchObject({
      '3': { nodeId: '3', value: 5, max: 20, state: 'running' },
      '7': { value: 10, max: 10, state: 'finished' }
    })
    // current node convenience = last running node
    expect(evt.nodeId).toBe('3')
  })

  it('keeps legacy JSON events working and exposes cached nodes', async () => {
    const { ws, events } = await connect()
    ws.fire(
      'message',
      JSON.stringify({ type: 'progress', data: { value: 3, max: 9, prompt_id: 'p1', node: '4' } })
    )
    ws.fire('message', JSON.stringify({ type: 'execution_cached', data: { nodes: ['1', '2'] } }))
    const progress = events.find((e) => e.type === 'progress')!
    expect(progress).toMatchObject({ value: 3, max: 9, nodeId: '4', promptId: 'p1' })
    const cached = events.find((e) => e.type === 'execution_cached')!
    expect(cached.cachedNodes).toEqual(['1', '2'])
  })

  it('drops truncated/metadata frames safely without throwing', async () => {
    const { ws, events } = await connect()
    // event 4 with a meta length that exceeds the buffer
    const bad = Buffer.alloc(8)
    bad.writeUInt32BE(4, 0)
    bad.writeUInt32BE(9999, 4)
    expect(() => ws.fire('message', bad)).not.toThrow()
    // event 1 with only the header
    const short = Buffer.alloc(8)
    short.writeUInt32BE(1, 0)
    expect(() => ws.fire('message', short)).not.toThrow()
    expect(events.filter((e) => e.type === 'preview')).toHaveLength(0)
  })

  it('passes the FULL execution_error payload through (0.1.12)', async () => {
    const { ws, events } = await connect()
    ws.fire(
      'message',
      JSON.stringify({
        type: 'execution_error',
        data: {
          prompt_id: 'p-48',
          node_id: '48',
          node_type: 'PathchSageAttentionKJ',
          executed: ['1'],
          exception_type: 'ModuleNotFoundError',
          exception_message: "No module named 'sageattention'",
          traceback: [
            'Traceback (most recent call last):',
            '  File "...edge.py", line 1',
            'ModuleNotFoundError'
          ],
          current_inputs: {},
          current_outputs: []
        }
      })
    )
    const evt = events.find((e) => e.type === 'execution_error')!
    expect(evt.nodeId).toBe('48')
    expect(evt.nodeType).toBe('PathchSageAttentionKJ')
    expect(evt.promptId).toBe('p-48')
    expect(evt.errorType).toBe('ModuleNotFoundError')
    expect(evt.errorMessage).toBe("No module named 'sageattention'")
    expect(Array.isArray(evt.errorTraceback)).toBe(true)
    expect((evt.errorTraceback as string[]).length).toBe(3)
    // Routing metadata for failure diagnosis (URL → instance mapping).
    expect(evt.baseUrl).toBe('http://127.0.0.1:8188')
  })

  it('maps execution_interrupted without failure fields (0.1.12)', async () => {
    const { ws, events } = await connect()
    ws.fire(
      'message',
      JSON.stringify({
        type: 'execution_interrupted',
        data: { prompt_id: 'p-9', node_id: '5', node_type: 'KSampler', executed: [] }
      })
    )
    const evt = events.find((e) => e.type === 'execution_interrupted')!
    expect(evt.nodeId).toBe('5')
    expect(evt.nodeType).toBe('KSampler')
    expect(evt.errorType).toBeUndefined()
    expect(evt.errorMessage).toBeUndefined()
  })
})

// =====================================================================
// Additional protocol branches: ignored/truncated binary events, metadata
// fallbacks, remote bearer auth and reconnect/disconnect edges.
// =====================================================================
describe('monitor WS protocol edge branches', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
    vi.resetModules()
    FakeWS.last = null
    FakeWS.count = 0
    h.remotes = []
    h.instances = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function connect(): Promise<{
    svc: import('../../src/main/services/monitor').MonitorService
    ws: FakeWS
    events: Array<Record<string, unknown>>
  }> {
    const { MonitorService } = await import('../../src/main/services/monitor')
    const svc = new MonitorService()
    const events: Array<Record<string, unknown>> = []
    svc.on('ws', (e) => events.push(e as Record<string, unknown>))
    svc.connectWs('http://127.0.0.1:8188')
    await Promise.resolve()
    await Promise.resolve()
    return { svc, ws: FakeWS.last!, events }
  }

  function frame(event: number, extra?: Buffer): Buffer {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(event, 0)
    if (extra && extra.length >= 4) extra.copy(head, 4)
    return Buffer.concat([head, extra && extra.length > 4 ? extra.subarray(4) : Buffer.alloc(0)])
  }

  it('ignores progress-text and truncated preview frames', async () => {
    const { ws, events } = await connect()
    events.length = 0
    ws.fire('message', frame(3, Buffer.from([0, 0, 0, 1, 9, 9])))
    expect(events).toHaveLength(0)

    ws.fire('message', frame(1))
    expect(events).toHaveLength(0)
    ws.fire('message', frame(2, Buffer.from([0, 0, 0, 1])))
    expect(events).toHaveLength(0)
    ws.fire(
      'message',
      (() => {
        const head = Buffer.alloc(4)
        head.writeUInt32BE(4, 0)
        return Buffer.concat([head])
      })()
    )
    expect(events).toHaveLength(0)
  })

  it('decodes JPEG event 2 and defaults metadata for malformed JSON', async () => {
    const { ws, events } = await connect()
    events.length = 0
    const head = Buffer.alloc(8)
    head.writeUInt32BE(2, 0)
    head.writeUInt32BE(1, 4)
    ws.fire('message', Buffer.concat([head, Buffer.from([1, 2, 3])]))
    expect(events.at(-1)).toMatchObject({ type: 'preview' })
    expect(String((events.at(-1) as { image?: string }).image)).toMatch(/^data:image\/jpeg;base64,/)

    await vi.advanceTimersByTimeAsync(350)
    const badMeta = Buffer.from('{bad')
    const metaHead = Buffer.alloc(8)
    metaHead.writeUInt32BE(4, 0)
    metaHead.writeUInt32BE(badMeta.length, 4)
    ws.fire('message', Buffer.concat([metaHead, badMeta, Buffer.from([4, 5])]))
    expect(events.at(-1)).toMatchObject({ type: 'preview' })
    expect(String((events.at(-1) as { image?: string }).image)).toMatch(/^data:image\/png;base64,/)

    const emptyImage = Buffer.alloc(8)
    emptyImage.writeUInt32BE(4, 0)
    emptyImage.writeUInt32BE(2, 4)
    ws.fire('message', Buffer.concat([emptyImage, Buffer.from('{}')]))
    const count = events.length
    ws.fire('message', Buffer.concat([emptyImage, Buffer.from('{}')]))
    expect(events.length).toBe(count)
  })

  it('drops malformed JSON frames without crashing the socket', async () => {
    const { ws, events } = await connect()
    events.length = 0
    ws.fire('message', Buffer.from('{not json'))
    ws.fire('message', Buffer.from([0, 0, 0, 9, 1, 2]))
    expect(events).toHaveLength(0)
  })

  it('handles status, cached, interrupted and progress_state payload variants', async () => {
    const { ws, events } = await connect()
    events.length = 0
    ws.fire('message', Buffer.from(JSON.stringify({ type: 'status', data: {} })))
    expect(events.at(-1)).toMatchObject({ type: 'status', baseUrl: 'http://127.0.0.1:8188' })

    ws.fire(
      'message',
      Buffer.from(JSON.stringify({ type: 'execution_cached', data: { nodes: [1, '2'] } }))
    )
    expect(events.at(-1)).toMatchObject({ cachedNodes: ['1', '2'] })
    ws.fire('message', Buffer.from(JSON.stringify({ type: 'execution_cached', data: {} })))
    expect((events.at(-1) as { cachedNodes?: unknown }).cachedNodes).toBeUndefined()

    ws.fire(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'execution_interrupted',
          data: { node_id: 7, prompt_id: 'p', node_type: 'KSampler' }
        })
      )
    )
    expect(events.at(-1)).toMatchObject({ nodeId: '7', promptId: 'p', nodeType: 'KSampler' })

    ws.fire(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'progress_state',
          data: {
            nodes: {
              a: null,
              b: { value: 2, max: 4, state: 'running', prompt_id: 'p', display_node_id: 3 },
              c: { state: 'done' }
            }
          }
        })
      )
    )
    const progress = events.at(-1) as { nodes: Record<string, unknown>; nodeId?: string }
    expect(progress.nodeId).toBe('b')
    expect(progress.nodes.a).toBeUndefined()
    expect(progress.nodes.b).toMatchObject({ displayNodeId: '3', promptId: 'p' })
  })

  it('attaches bearer auth only for a matching configured remote', async () => {
    h.remotes = [
      { id: 'r1', baseUrl: 'not a url', apiKey: 'x' },
      { id: 'r2', baseUrl: 'https://remote.example', apiKey: 'secret' }
    ]
    const { svc } = await connect()
    svc.disconnectWs()
    svc.connectWs('https://remote.example')
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWS.last?.options).toEqual({ headers: { Authorization: 'Bearer secret' } })

    h.remotes = []
    svc.connectWs('http://127.0.0.1:9999')
    FakeWS.last?.fire('close')
    await vi.advanceTimersByTimeAsync(300)
    expect(FakeWS.last?.options).toBeUndefined()
  })

  it('reconnects with backoff, stops after disconnect and tolerates missing baseUrl', async () => {
    const { svc, ws } = await connect()
    ws.fire('error')
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWS.count).toBe(2)
    FakeWS.last!.fire('error')
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWS.count).toBe(3)

    svc.disconnectWs()
    FakeWS.count = 0
    h.remotes = []
    // A close after disconnect must not schedule a reconnect.
    const before = FakeWS.count
    await vi.advanceTimersByTimeAsync(70000)
    expect(FakeWS.count).toBe(before)
  })
})
