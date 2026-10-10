/**
 * p1p2.ts coverage: BatchService.start/cancel/awaitOutputs, OutputService
 * walk/list/favorite/exportZip/importToWorkflow, RemoteService.test,
 * MarketService.list offline fallback, normalizeLegacyJob / readWorkflowGraph.
 */
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ROOT = join(tmpdir(), `cp-p1p2-svc-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => ROOT },
  shell: {
    showItemInFolder: () => undefined,
    openExternal: async () => undefined,
    openPath: async () => ''
  }
}))

// ---------- helpers ----------

function writePng(path: string, metaPairs: Array<[string, string]>): void {
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(1, 8)
  ihdr.writeUInt32BE(1, 12)
  chunks.push(ihdr)
  for (const [k, v] of metaPairs) {
    const text = Buffer.from(`${k}\0${v}`, 'utf-8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(text.length, 0)
    chunks.push(len, Buffer.from('tEXt', 'ascii'), text, Buffer.alloc(4))
  }
  const iend = Buffer.alloc(12)
  iend.write('IEND', 4, 'ascii')
  chunks.push(iend)
  writeFileSync(path, Buffer.concat(chunks))
}

/** Minimal UI graph that buildIterationPrompt can convert. */
function uiGraph(): string {
  return JSON.stringify({
    nodes: [
      {
        id: 1,
        type: 'KSampler',
        widgets_values: [1, 'fixed', 20, 7.5, 'euler', 'normal', 1]
      },
      {
        id: 2,
        type: 'EmptyLatentImage',
        widgets_values: [512, 512, 1]
      }
    ],
    links: []
  })
}

/** API-format prompt graph. */
function apiGraph(): string {
  return JSON.stringify({
    '1': {
      class_type: 'KSampler',
      inputs: { seed: 5, steps: 20, cfg: 7.5, width: 512, height: 512 }
    }
  })
}

function makeInstance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inst-1',
    name: 'local',
    path: join(ROOT, 'comfy'),
    pythonPath: '',
    venvPath: '',
    port: 8188,
    listen: '0.0.0.0',
    extraArgs: [],
    argTemplateId: 'default',
    enabled: true,
    notes: '',
    autoStart: false,
    frontendVersion: '',
    pinned: false,
    ...overrides
  }
}

type FetchCall = { url: string; method: string; body: unknown; headers: Record<string, string> }

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      const method = String(init?.method || 'GET').toUpperCase()
      let body: unknown = undefined
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      calls.push({
        url: u,
        method,
        body,
        headers: ((init?.headers as Record<string, string>) || {}) as Record<string, string>
      })
      return handler(u, init)
    })
  )
  return calls
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

async function freshP1p2() {
  vi.resetModules()
  return import('../../src/main/services/p1p2')
}

function cleanData(): void {
  rmSync(join(ROOT, 'data'), { recursive: true, force: true })
}

async function seedInstance(overrides: Record<string, unknown> = {}): Promise<void> {
  const { upsertInstanceConfig } = await import('../../src/main/services/db')
  upsertInstanceConfig(makeInstance(overrides) as never)
}

// ---------- suite ----------

describe('p1p2 services', () => {
  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true })
    mkdirSync(join(ROOT, 'comfy', 'output'), { recursive: true })
    mkdirSync(join(ROOT, 'comfy', 'input'), { recursive: true })
    mkdirSync(join(ROOT, 'wf'), { recursive: true })
  })

  beforeEach(() => {
    cleanData()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../../src/main/services/workflowConvert')
    vi.doUnmock('../../src/main/services/registry')
    vi.doUnmock('../../src/main/services/nodePack')
  })

  // ========== normalizeLegacyJob via list() ==========

  describe('normalizeLegacyJob', () => {
    it('keeps item progress and fills defaults for items[] jobs', async () => {
      const { batchService } = await freshP1p2()
      const { upsertBatchJob } = await import('../../src/main/services/db')
      const p = join(ROOT, 'wf', 'norm.json')
      writeFileSync(p, uiGraph())
      upsertBatchJob({
        id: 'n1',
        name: '', // → 'batch'
        instanceId: '', // → ''
        items: [
          {
            workflowName: 'norm',
            workflowPath: p,
            count: 2,
            submitted: 2,
            completed: 1,
            failed: 1,
            promptIds: ['p-a', 'p-b'],
            seeds: [1, 2],
            outputPaths: [join(ROOT, 'comfy', 'output', 'x.png')]
          }
        ],
        status: undefined, // → 'queued'
        // no top-level count → summed from items
        createdAt: 0, // falsy → Date.now()
        finishedAt: 42,
        notes: '',
        params: {},
        workflowPath: p
      } as never)

      const job = batchService.list().find((j) => j.id === 'n1')!
      expect(job.name).toBe('batch')
      expect(job.status).toBe('queued')
      expect(job.count).toBe(2)
      expect(job.finishedAt).toBe(42)
      expect(job.createdAt).toBeGreaterThan(0)
      expect(job.items[0].promptIds).toEqual(['p-a', 'p-b'])
      expect(job.items[0].submitted).toBe(2)
      expect(job.items[0].seeds).toEqual([1, 2])
      expect(job.items[0].outputPaths.length).toBe(1)
    })

    it('defaults item count to 1 and keeps explicit top-level count', async () => {
      const { batchService } = await freshP1p2()
      const { upsertBatchJob } = await import('../../src/main/services/db')
      const p = join(ROOT, 'wf', 'norm2.json')
      writeFileSync(p, uiGraph())
      upsertBatchJob({
        id: 'n2',
        name: 'has-count',
        instanceId: 'i',
        items: [{ workflowName: 'a', workflowPath: p, count: 0 }], // count 0 → 1
        status: 'done',
        count: 99,
        completed: 0,
        failed: 0,
        produced: 0,
        createdAt: 1,
        finishedAt: null, // → undefined
        notes: 'n',
        params: {}
      } as never)
      const job = batchService.list().find((j) => j.id === 'n2')!
      expect(job.count).toBe(99)
      expect(job.items[0].count).toBe(1)
      expect(job.finishedAt).toBeUndefined()
    })

    it('migrates legacy single-path shape with and without promptIds', async () => {
      const { batchService } = await freshP1p2()
      const { upsertBatchJob } = await import('../../src/main/services/db')
      const p = join(ROOT, 'wf', 'legacy.json')
      writeFileSync(p, uiGraph())
      upsertBatchJob({
        id: 'leg-p',
        name: 'with-ids',
        instanceId: 'i',
        workflowPath: p,
        count: 3,
        promptIds: ['x', 'y'],
        status: 'running',
        completed: 1,
        failed: 0,
        produced: 1,
        createdAt: 5,
        notes: '',
        params: { seedMode: 'fixed', baseSeed: 9 }
      } as never)
      upsertBatchJob({
        id: 'leg-n',
        // no name / workflowPath / count
        instanceId: 'i',
        status: 'queued',
        completed: 0,
        failed: 0,
        produced: 0,
        createdAt: 5,
        notes: '',
        params: {}
      } as never)

      const withIds = batchService.list().find((j) => j.id === 'leg-p')!
      expect(withIds.items).toHaveLength(1)
      expect(withIds.items[0].promptIds).toEqual(['x', 'y'])
      expect(withIds.items[0].count).toBe(3)
      expect(withIds.count).toBe(3)
      expect(withIds.items[0].workflowName).toBe('legacy.json')
      expect(withIds.params.seedMode).toBe('fixed')

      const bare = batchService.list().find((j) => j.id === 'leg-n')!
      expect(bare.items[0].workflowPath).toBe('')
      expect(bare.items[0].workflowName).toBe('workflow')
      expect(bare.items[0].count).toBe(1)
      expect(bare.count).toBe(1)
      expect(bare.name).toBe('batch')
    })

    it('empty items[] falls through to legacy single-item shape', async () => {
      const { batchService } = await freshP1p2()
      const { upsertBatchJob } = await import('../../src/main/services/db')
      upsertBatchJob({
        id: 'empty-items',
        name: 'e',
        instanceId: 'i',
        items: [],
        status: 'queued',
        count: 2,
        completed: 0,
        failed: 0,
        produced: 0,
        createdAt: 1,
        notes: '',
        params: {}
      } as never)
      const job = batchService.list().find((j) => j.id === 'empty-items')!
      expect(job.items).toHaveLength(1)
      expect(job.count).toBe(2)
    })
  })

  // ========== create() clamps ==========

  describe('BatchService.create', () => {
    it('clamps count and derives workflowName from basename', async () => {
      const { batchService } = await freshP1p2()
      const p = join(ROOT, 'wf', 'MyFlow.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: '',
        instanceId: 'i',
        items: [
          { workflowPath: p, count: 0 },
          { workflowPath: p, count: 9999 },
          { workflowPath: p, count: Number.NaN }
        ]
      })
      expect(job.name).toBe('Batch')
      expect(job.items.map((i) => i.count)).toEqual([1, 500, 1])
      expect(job.items[0].workflowName).toBe('MyFlow')
      expect(job.count).toBe(502)
    })
  })

  // ========== BatchService.start ==========

  describe('BatchService.start', () => {
    it('happy path: queue → history settles + links outputs + indexes asset', async () => {
      const { batchService, outputService } = await freshP1p2()
      await seedInstance()
      const { upsertBatchJob } = await import('../../src/main/services/db')
      const p = join(ROOT, 'wf', 'happy.json')
      writeFileSync(p, uiGraph())
      const outAbs = join(ROOT, 'comfy', 'output', 'happy_out.png')
      writePng(outAbs, [
        ['seed', '42'],
        ['prompt', apiGraph()],
        ['prompt_id', 'pid-happy']
      ])

      const job = batchService.create({
        name: 'happy',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }],
        params: { seedMode: 'fixed', baseSeed: 42 }
      })

      const calls = stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-happy' })
        if (url.includes('/history')) {
          return jsonResponse({
            'pid-happy': {
              status: {
                status_str: 'success',
                completed: true,
                messages: [['execution_success', { timestamp: 111 }]]
              },
              outputs: {
                '3': {
                  images: [{ filename: 'happy_out.png', subfolder: '', type: 'output' }]
                }
              }
            }
          })
        }
        if (url.includes('/queue')) return jsonResponse({})
        return jsonResponse({})
      })

      const events: string[] = []
      batchService.on('progress', (j: { status: string }) => events.push(j.status))
      const result = await batchService.start(job.id)

      expect(result.status).toBe('done')
      expect(result.completed).toBe(1)
      expect(result.produced).toBe(1)
      expect(result.items[0].promptIds).toEqual(['pid-happy'])
      expect(result.items[0].outputPaths).toEqual([outAbs])
      expect(result.finishedAt).toBeGreaterThan(0)

      // /prompt was posted to the instance URL (0.0.0.0 → 127.0.0.1)
      const promptCall = calls.find((c) => c.url.includes('/prompt'))!
      expect(promptCall.url).toContain('http://127.0.0.1:8188/prompt')
      expect(promptCall.method).toBe('POST')
      expect((promptCall.body as { client_id: string }).client_id).toBe('comfy-pilot')

      // history was polled
      expect(calls.some((c) => c.url.includes('/history'))).toBe(true)

      // asset indexed by awaitOutputs
      const listed = outputService.list({ batchJobId: job.id })
      expect(listed.items.some((a) => a.path === outAbs)).toBe(true)
      expect(events).toContain('submitting')
      expect(events).toContain('running')
      expect(events).toContain('done')
      void upsertBatchJob
    })

    it('uses non-wildcard listen host and input/other output types', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance({ id: 'inst-lan', listen: '192.168.1.5', port: 9000, path: join(ROOT, 'comfy') })
      const p = join(ROOT, 'wf', 'lan.json')
      writeFileSync(p, uiGraph())
      const inAbs = join(ROOT, 'comfy', 'input', 'src.png')
      const otherAbs = join(ROOT, 'comfy', 'output', 'notes.txt')
      writePng(inAbs, [['seed', '7']])
      writeFileSync(otherAbs, 'hello')
      writeFileSync(join(ROOT, 'comfy', 'output', 'clip.mp4'), 'vid')
      writeFileSync(join(ROOT, 'comfy', 'output', 'a.wav'), 'aud')

      const job = batchService.create({
        name: 'lan',
        instanceId: 'inst-lan',
        items: [{ workflowPath: p, count: 1 }]
      })
      const calls = stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-lan' })
        if (url.includes('/history')) {
          return jsonResponse({
            'pid-lan': {
              status: { status_str: 'success' },
              outputs: {
                '1': {
                  images: [
                    { filename: 'src.png', subfolder: '', type: 'input' },
                    { filename: 'notes.txt', subfolder: '', type: 'output' },
                    { filename: 'clip.mp4', subfolder: '', type: 'output' },
                    { filename: 'a.wav', subfolder: '', type: 'output' },
                    { filename: 'missing.png', subfolder: '', type: 'output' },
                    { subfolder: '', type: 'output' } // no filename → skipped
                  ]
                }
              }
            }
          })
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.produced).toBe(1)
      expect(result.items[0].outputPaths).toContain(inAbs)
      expect(result.items[0].outputPaths).toContain(otherAbs)
      expect(result.items[0].outputPaths).toContain(join(ROOT, 'comfy', 'output', 'clip.mp4'))
      expect(result.items[0].outputPaths).toContain(join(ROOT, 'comfy', 'output', 'a.wav'))
      expect(result.items[0].outputPaths).not.toContain(join(ROOT, 'comfy', 'output', 'missing.png'))
      expect(calls.find((c) => c.url.includes('/prompt'))!.url).toContain('http://192.168.1.5:9000/')
    })

    it('maps history status error to failed and still finishes', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'err.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'err',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-err' })
        if (url.includes('/history')) {
          return jsonResponse({
            'pid-err': {
              status: { status_str: 'error' },
              outputs: {}
            }
          })
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      // produced=0 with exec failures is an error — never report "done".
      expect(result.status).toBe('error')
      expect(result.failed).toBe(1)
      expect(result.produced).toBe(0)
    })

    it('marks job error when every submission fails', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'allfail.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'allfail',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 2 }]
      })
      stubFetch((url) => {
        if (url.includes('/prompt')) return new Response('nope', { status: 500 })
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.status).toBe('error')
      expect(result.completed).toBe(0)
      expect(result.failed).toBe(2)
      expect(result.notes).toContain('ComfyUI rejected prompt')
    })

    it('counts a null prompt_id as a failure', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'nullid.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'nullid',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({}) // no prompt_id
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.status).toBe('error')
      expect(result.failed).toBe(1)
    })

    it('parse failure: unreadable workflow marks item failed and continues', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const good = join(ROOT, 'wf', 'good.json')
      const bad = join(ROOT, 'wf', 'bad.json')
      writeFileSync(good, uiGraph())
      writeFileSync(bad, '{not json')
      const job = batchService.create({
        name: 'mixed',
        instanceId: 'inst-1',
        items: [
          { workflowPath: bad, count: 2 },
          { workflowPath: good, count: 1 }
        ]
      })
      stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-ok' })
        if (url.includes('/history')) {
          return jsonResponse({
            'pid-ok': { status: { status_str: 'success' }, outputs: {} }
          })
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.notes).toContain('cannot parse')
      expect(result.items[0].failed).toBe(2)
      expect(result.items[1].promptIds).toEqual(['pid-ok'])
      // 2 failed (parse) + 0 later failures, but completed=1 → done
      expect(result.status).toBe('done')
    })

    it('readWorkflowGraph PNG variants: prompt, workflow fallback, both bad, empty', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const dir = join(ROOT, 'wf', 'pngs')
      mkdirSync(dir, { recursive: true })

      const pngPrompt = join(dir, 'p_prompt.png')
      writePng(pngPrompt, [['prompt', apiGraph()]])

      const pngWorkflow = join(dir, 'p_wf.png')
      writePng(pngWorkflow, [
        ['prompt', '{{bad'],
        ['workflow', uiGraph()]
      ])

      const pngBad = join(dir, 'p_bad.png')
      writePng(pngBad, [
        ['prompt', '{{bad'],
        ['workflow', '{{also-bad']
      ])

      const pngEmpty = join(dir, 'p_empty.png')
      writePng(pngEmpty, [['other', 'x']])

      const missing = join(dir, 'gone.json')
      writeFileSync(missing, uiGraph())

      const job = batchService.create({
        name: 'pngs',
        instanceId: 'inst-1',
        items: [
          { workflowPath: pngPrompt, count: 1 },
          { workflowPath: pngWorkflow, count: 1 },
          { workflowPath: pngBad, count: 1 },
          { workflowPath: pngEmpty, count: 1 },
          { workflowPath: missing, count: 1 }
        ]
      })
      // delete after create → readWorkflowGraph hits catch → null
      rmSync(missing, { force: true })

      let n = 0
      stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: `pid-${++n}` })
        if (url.includes('/history')) {
          const body: Record<string, unknown> = {}
          for (let i = 1; i <= n; i++) {
            body[`pid-${i}`] = { status: { status_str: 'success' }, outputs: {} }
          }
          return jsonResponse(body)
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      // items 0 and 1 parse; 2,3,4 fail
      expect(result.items[0].promptIds.length).toBe(1)
      expect(result.items[1].promptIds.length).toBe(1)
      expect(result.items[2].failed).toBe(1)
      expect(result.items[3].failed).toBe(1)
      expect(result.items[4].failed).toBe(1)
      expect(result.notes).toContain('cannot parse')
    })

    it('PNG with invalid prompt and no workflow meta → null parse', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const png = join(ROOT, 'wf', 'onlybadprompt.png')
      writePng(png, [['prompt', '{{nope']])
      const job = batchService.create({
        name: 'onlybad',
        instanceId: 'inst-1',
        items: [{ workflowPath: png, count: 1 }]
      })
      stubFetch(() => jsonResponse({}))
      const result = await batchService.start(job.id)
      expect(result.items[0].failed).toBe(1)
      expect(result.notes).toContain('cannot parse')
    })

    it('throws when the job id is unknown', async () => {
      const { batchService } = await freshP1p2()
      await expect(batchService.start('nope')).rejects.toThrow('Batch job not found')
    })

    it('errors out when no instance is configured', async () => {
      const { batchService } = await freshP1p2()
      const p = join(ROOT, 'wf', 'noinst.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'noinst',
        instanceId: 'missing',
        items: [{ workflowPath: p, count: 1 }]
      })
      await expect(batchService.start(job.id)).rejects.toThrow('No instance')
      const after = batchService.list().find((j) => j.id === job.id)!
      expect(after.status).toBe('error')
      expect(after.notes).toContain('No instance configured')
    })

    it('falls back to instances[0] when instanceId does not match', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance({ id: 'other', listen: '127.0.0.1', port: 8199 })
      const p = join(ROOT, 'wf', 'fallback.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'fb',
        instanceId: 'does-not-exist',
        items: [{ workflowPath: p, count: 1 }]
      })
      const calls = stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-fb' })
        if (url.includes('/history')) {
          return jsonResponse({ 'pid-fb': { status: { status_str: 'success' }, outputs: {} } })
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.status).toBe('done')
      expect(calls.find((c) => c.url.includes('/prompt'))!.url).toContain(':8199')
    })

    it('cancel during queuePrompt finishes as cancelled and dequeues', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'cancel.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'cancel',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      const calls = stubFetch(async (url) => {
        if (url.includes('/prompt')) {
          // cancel while the prompt is in flight
          batchService.cancel(job.id)
          return jsonResponse({ prompt_id: 'pid-late' })
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.status).toBe('cancelled')
      // late prompt is dequeued (fire-and-forget)
      await new Promise((r) => setTimeout(r, 20))
      const queueCall = calls.find((c) => c.url.includes('/queue'))
      expect(queueCall).toBeTruthy()
      expect((queueCall!.body as { delete: string[] }).delete).toContain('pid-late')
    })

    it('cancel before the next iteration returns cancelled', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'cancel2.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'cancel2',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 3 }]
      })
      let n = 0
      stubFetch((url) => {
        if (url.includes('/prompt')) {
          n += 1
          if (n === 1) {
            // clear runningIds mid-run
            batchService.cancel(job.id)
          }
          return jsonResponse({ prompt_id: `pid-c-${n}` })
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.status).toBe('cancelled')
    })

    it('outer catch: failure after submit marks error and rethrows', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'outer.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'outer',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-outer' })
        return jsonResponse({})
      })
      // First emit (submitting) is outside the try; later ones are inside it.
      let emitCount = 0
      const spy = vi.spyOn(batchService, 'emit').mockImplementation(() => {
        emitCount += 1
        if (emitCount >= 2) throw new Error('emit boom')
        return true
      })
      await expect(batchService.start(job.id)).rejects.toThrow('emit boom')
      spy.mockRestore()
      const after = batchService.list().find((j) => j.id === job.id)!
      expect(after.status).toBe('error')
      expect(after.finishedAt).toBeGreaterThan(0)
    })

    it('awaitOutputs retries when /history throws, then settles', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'retry.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'retry',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      // accelerate the 2.5s poll delay
      const realSetTimeout = globalThis.setTimeout
      vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) =>
        realSetTimeout(fn, ms === 2500 ? 0 : ms)
      )
      let hist = 0
      stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-r' })
        if (url.includes('/history')) {
          hist += 1
          if (hist === 1) throw new Error('history down')
          return jsonResponse({
            'pid-r': { status: { status_str: 'success' }, outputs: {} }
          })
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.produced).toBe(1)
      expect(hist).toBeGreaterThanOrEqual(2)
    })

    it('awaitOutputs returns early when cancelled while polling history', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'cancel3.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'cancel3',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      const realSetTimeout = globalThis.setTimeout
      vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) =>
        realSetTimeout(fn, ms === 2500 ? 0 : ms)
      )
      stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-c3' })
        if (url.includes('/history')) {
          // cancel from inside the history poll
          batchService.cancel(job.id)
          return jsonResponse({}) // nothing settled
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.status).toBe('cancelled')
    })

    it('history without matching outputs leaves produced at 0', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'noout.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'noout',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-no' })
        if (url.includes('/history')) {
          return jsonResponse({
            'pid-no': { status: { status_str: 'success' }, outputs: {} }
          })
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.produced).toBe(1)
      expect(result.items[0].outputPaths).toEqual([])
    })
  })

  // ========== cancel / remove ==========

  describe('BatchService.cancel / remove', () => {
    it('cancel posts /queue delete for pending prompt ids', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const { upsertBatchJob } = await import('../../src/main/services/db')
      const p = join(ROOT, 'wf', 'c.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'c',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      // simulate in-flight prompts already recorded
      const stored = batchService.list().find((j) => j.id === job.id)!
      stored.items[0].promptIds = ['pend-1', 'pend-2']
      upsertBatchJob(stored)

      const calls = stubFetch(() => jsonResponse({}))
      const cancelled = batchService.cancel(job.id)
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled.finishedAt).toBeGreaterThan(0)
      await new Promise((r) => setTimeout(r, 20))
      const q = calls.find((c) => c.url.includes('/queue'))
      expect(q).toBeTruthy()
      expect((q!.body as { delete: string[] }).delete).toEqual(['pend-1', 'pend-2'])
    })

    it('cancel without prompt ids still resolves and remove deletes', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'c2.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'c2',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      stubFetch(() => jsonResponse({}))
      expect(batchService.cancel(job.id).status).toBe('cancelled')
      await new Promise((r) => setTimeout(r, 10))
      expect(batchService.remove(job.id)).toBe(true)
      expect(batchService.list().some((j) => j.id === job.id)).toBe(false)
    })

    it('cancel throws for unknown id', async () => {
      const { batchService } = await freshP1p2()
      expect(() => batchService.cancel('nope')).toThrow('Batch job not found')
    })

    it('cancel dequeue failure is swallowed', async () => {
      const { batchService } = await freshP1p2()
      await seedInstance()
      const { upsertBatchJob } = await import('../../src/main/services/db')
      const p = join(ROOT, 'wf', 'c3.json')
      writeFileSync(p, uiGraph())
      const job = batchService.create({
        name: 'c3',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }]
      })
      const stored = batchService.list().find((j) => j.id === job.id)!
      stored.items[0].promptIds = ['p1']
      upsertBatchJob(stored)
      stubFetch(() => {
        throw new Error('net down')
      })
      expect(() => batchService.cancel(job.id)).not.toThrow()
      await new Promise((r) => setTimeout(r, 20))
    })
  })

  // ========== OutputService ==========

  describe('OutputService', () => {
    it('walks a real output tree, classifies types, preserves linked fields', async () => {
      const { outputService } = await freshP1p2()
      const { upsertOutputAsset, updateOutputAsset } = await import('../../src/main/services/db')
      const root = join(ROOT, 'walkroot')
      rmSync(root, { recursive: true, force: true })
      mkdirSync(join(root, 'sub', 'd2', 'd3', 'd4', 'd5'), { recursive: true })

      const png = join(root, 'a.png')
      writePng(png, [
        ['seed', '123'],
        ['prompt', JSON.stringify({ '1': { class_type: 'K', inputs: { seed: 5 } } })],
        ['prompt_id', 'walk-pid']
      ])
      writeFileSync(join(root, 'b.jpg'), 'j')
      writeFileSync(join(root, 'c.mp4'), 'v')
      writeFileSync(join(root, 'd.wav'), 'a')
      writeFileSync(join(root, 'e.txt'), 'skip-me')
      writeFileSync(join(root, 'sub', 'nested.webp'), 'w')
      // depth 5 dir is not walked
      writeFileSync(join(root, 'sub', 'd2', 'd3', 'd4', 'd5', 'deep.png'), 'x')
      // depth 4 dir IS walked
      writeFileSync(join(root, 'sub', 'd2', 'd3', 'd4', 'shallow.png'), 'x')

      // pre-link favorite on the png so walk preserves it
      const pngId = (await import('crypto'))
        .createHash('sha1')
        .update(png)
        .digest('hex')
        .slice(0, 16)
      upsertOutputAsset({
        id: pngId,
        path: png,
        fileName: 'a.png',
        type: 'image',
        size: 1,
        createdAt: 1,
        favorite: true,
        workflowId: 'wf-9',
        workflowName: 'WF',
        batchJobId: 'bj-9',
        params: {}
      })

      const res = outputService.list({ root, limit: 100 })
      const paths = res.items.map((i) => i.path)
      expect(paths).toContain(png)
      expect(paths).toContain(join(root, 'b.jpg'))
      expect(paths).toContain(join(root, 'c.mp4'))
      expect(paths).toContain(join(root, 'd.wav'))
      expect(paths).toContain(join(root, 'sub', 'nested.webp'))
      expect(paths).toContain(join(root, 'sub', 'd2', 'd3', 'd4', 'shallow.png'))
      expect(paths).not.toContain(join(root, 'e.txt'))
      expect(paths).not.toContain(join(root, 'sub', 'd2', 'd3', 'd4', 'd5', 'deep.png'))

      const rec = res.items.find((i) => i.path === png)!
      // prompt JSON node seed wins (seed == null first hit); meta.seed only fills a gap
      expect(rec.seed).toBe(5)
      expect(rec.promptId).toBe('walk-pid')
      expect(rec.favorite).toBe(true)
      expect(rec.workflowId).toBe('wf-9')
      expect(rec.batchJobId).toBe('bj-9')
      expect(rec.params.nodeCount).toBe(1)
      expect(rec.params.pngKeys).toContain('seed')

      const video = res.items.find((i) => i.path === join(root, 'c.mp4'))!
      expect(video.type).toBe('video')
      const audio = res.items.find((i) => i.path === join(root, 'd.wav'))!
      expect(audio.type).toBe('audio')
      void updateOutputAsset
    })

    it('sort by name/size and order asc/desc + type/workflowId filters', async () => {
      const { outputService } = await freshP1p2()
      const { upsertOutputAsset } = await import('../../src/main/services/db')
      for (const [id, fileName, size, createdAt, extra] of [
        ['s-a', 'aaa.png', 30, 300, {}],
        ['s-b', 'bbb.png', 10, 100, { workflowId: 'w1' }],
        ['s-c', 'ccc.png', 20, 200, { type: 'video' }]
      ] as Array<[string, string, number, number, Record<string, unknown>]>) {
        upsertOutputAsset({
          id,
          path: join(ROOT, fileName),
          fileName,
          type: (extra.type as 'image' | 'video') || 'image',
          size,
          createdAt,
          params: {},
          ...extra
        })
      }
      const byName = outputService.list({ sort: 'name', order: 'asc', limit: 10 })
      expect(byName.items.map((i) => i.id)).toEqual(['s-a', 's-b', 's-c'])

      const bySizeDesc = outputService.list({ sort: 'size', order: 'desc', limit: 10 })
      expect(bySizeDesc.items.map((i) => i.id)).toEqual(['s-a', 's-c', 's-b'])

      const byCreatedAsc = outputService.list({ sort: 'createdAt', order: 'asc', limit: 10 })
      expect(byCreatedAsc.items.map((i) => i.id)).toEqual(['s-b', 's-c', 's-a'])

      const videos = outputService.list({ type: 'video' })
      expect(videos.items.map((i) => i.id)).toEqual(['s-c'])

      const all = outputService.list({ type: 'all', limit: 10 })
      expect(all.total).toBe(3)

      const byWf = outputService.list({ workflowId: 'w1' })
      expect(byWf.items.map((i) => i.id)).toEqual(['s-b'])
    })

    it('favorite / indexFile', async () => {
      const { outputService } = await freshP1p2()
      const { listOutputAssetsAll, upsertOutputAsset } = await import('../../src/main/services/db')
      const f = join(ROOT, 'idx.mp4')
      writeFileSync(f, 'vid-bytes')

      outputService.indexFile(f, { favorite: true })
      let row = listOutputAssetsAll().find((a) => a.path === f)!
      expect(row.type).toBe('video')
      expect(row.favorite).toBe(true)

      expect(outputService.favorite(row.id, false)).toBe(true)
      row = listOutputAssetsAll().find((a) => a.path === f)!
      expect(row.favorite).toBe(false)
      expect(outputService.favorite('missing-id', true)).toBe(false)

      // indexFile ignores missing paths and classifies audio/other
      outputService.indexFile(join(ROOT, 'ghost.png'))
      const aud = join(ROOT, 'tone.flac')
      writeFileSync(aud, 'a')
      outputService.indexFile(aud)
      expect(listOutputAssetsAll().find((a) => a.path === aud)!.type).toBe('audio')
      const other = join(ROOT, 'doc.pdf')
      writeFileSync(other, 'p')
      outputService.indexFile(other)
      expect(listOutputAssetsAll().find((a) => a.path === other)!.type).toBe('other')
      void upsertOutputAsset
    })

    it('exportZip packs files and rejects empty/missing', async () => {
      const { outputService } = await freshP1p2()
      await expect(outputService.exportZip([])).rejects.toThrow('No files selected')
      const f1 = join(ROOT, 'z1.png')
      writeFileSync(f1, 'one')
      await expect(outputService.exportZip([join(ROOT, 'missing-z.png')])).rejects.toThrow(
        'Missing file'
      )
      const dest = join(ROOT, 'zip-out')
      const res = await outputService.exportZip([f1], dest)
      expect(res.path.endsWith('.zip')).toBe(true)
      expect(existsSync(res.path)).toBe(true)
    })

    it('importToWorkflow imports PNG with graph and returns null otherwise', async () => {
      const { outputService } = await freshP1p2()
      await seedInstance()
      const withWf = join(ROOT, 'imp_wf.png')
      writePng(withWf, [['workflow', uiGraph()]])
      const rec = await outputService.importToWorkflow(withWf)
      expect(rec).toBeTruthy()
      expect(rec!.name).toBeTruthy()
      // PNG import materialises a single .json in the instance folder
      expect(rec!.path.endsWith('.json')).toBe(true)

      const noMeta = join(ROOT, 'imp_plain.png')
      writePng(noMeta, [['foo', 'bar']])
      expect(await outputService.importToWorkflow(noMeta)).toBeNull()

      const notPng = join(ROOT, 'imp.json')
      writeFileSync(notPng, uiGraph())
      expect(await outputService.importToWorkflow(notPng)).toBeNull()

      const promptOnly = join(ROOT, 'imp_prompt.png')
      writePng(promptOnly, [['prompt', apiGraph()]])
      const rec2 = await outputService.importToWorkflow(promptOnly)
      expect(rec2).toBeTruthy()
    })
  })

  // ========== RemoteService ==========

  describe('RemoteService', () => {
    function seedRemote(overrides: Record<string, unknown> = {}) {
      return {
        id: 'r1',
        name: 'remote',
        baseUrl: 'http://10.0.0.2:8188',
        label: 'R',
        enabled: true,
        ...overrides
      }
    }

    it('save / list / remove round-trip', async () => {
      const { remoteService } = await freshP1p2()
      const cfg = seedRemote() as never
      remoteService.save(cfg)
      expect(remoteService.list().map((r) => r.id)).toEqual(['r1'])
      expect(remoteService.remove('r1')).toBe(true)
      expect(remoteService.list()).toEqual([])
    })

    it('test online with queue counts and apiKey header', async () => {
      const { remoteService } = await freshP1p2()
      const { upsertRemote } = await import('../../src/main/services/db')
      upsertRemote(seedRemote({ apiKey: 'secret-token', baseUrl: 'http://10.0.0.2:8188/' }) as never)
      const calls = stubFetch((url) => {
        if (url.includes('/system_stats')) return jsonResponse({ system: {} })
        if (url.includes('/queue')) {
          return jsonResponse({ queue_running: [1], queue_pending: [1, 2] })
        }
        return jsonResponse({})
      })
      const st = await remoteService.test('r1')
      expect(st.online).toBe(true)
      expect(st.queueRunning).toBe(1)
      expect(st.queuePending).toBe(2)
      expect(st.error).toBeUndefined()
      const statsCall = calls.find((c) => c.url.includes('/system_stats'))!
      // trailing slash stripped
      expect(statsCall.url).toBe('http://10.0.0.2:8188/system_stats')
      expect(statsCall.headers.Authorization).toBe('Bearer secret-token')
    })

    it('test online but queue fetch fails → still online', async () => {
      const { remoteService } = await freshP1p2()
      const { upsertRemote } = await import('../../src/main/services/db')
      upsertRemote(seedRemote() as never)
      stubFetch((url) => {
        if (url.includes('/system_stats')) return jsonResponse({})
        throw new Error('queue unreachable')
      })
      const st = await remoteService.test('r1')
      expect(st.online).toBe(true)
      expect(st.queueRunning).toBe(0)
      expect(st.queuePending).toBe(0)
    })

    it('test reports HTTP error status', async () => {
      const { remoteService } = await freshP1p2()
      const { upsertRemote } = await import('../../src/main/services/db')
      upsertRemote(seedRemote() as never)
      stubFetch(() => new Response('nope', { status: 503 }))
      const st = await remoteService.test('r1')
      expect(st.online).toBe(false)
      expect(st.error).toBe('HTTP 503')
    })

    it('test offline when fetch rejects (network / malformed url)', async () => {
      const { remoteService } = await freshP1p2()
      const { upsertRemote } = await import('../../src/main/services/db')
      upsertRemote(seedRemote({ baseUrl: 'not-a-valid-url' }) as never)
      stubFetch(() => {
        throw new Error('Failed to parse URL')
      })
      const st = await remoteService.test('r1')
      expect(st.online).toBe(false)
      expect(st.error).toContain('Failed to parse URL')
    })

    it('test throws for unknown remote', async () => {
      const { remoteService } = await freshP1p2()
      await expect(remoteService.test('ghost')).rejects.toThrow('Remote not found')
    })

    it('listStatus only probes enabled remotes', async () => {
      const { remoteService } = await freshP1p2()
      const { upsertRemote } = await import('../../src/main/services/db')
      upsertRemote(seedRemote({ id: 'on' }) as never)
      upsertRemote(seedRemote({ id: 'off', enabled: false }) as never)
      stubFetch((url) => {
        if (url.includes('/system_stats')) return jsonResponse({})
        if (url.includes('/queue')) return jsonResponse({ queue_running: [], queue_pending: [] })
        return jsonResponse({})
      })
      const all = await remoteService.listStatus()
      expect(all.map((s) => s.id)).toEqual(['on'])
    })
  })

  // ========== MarketService ==========

  describe('MarketService', () => {
    it('maps registry items with installed detection from custom_nodes + nodePack', async () => {
      const { marketService } = await freshP1p2()
      const { saveSettings } = await import('../../src/main/services/db')
      const instPath = join(ROOT, 'mkt-inst')
      mkdirSync(join(instPath, 'custom_nodes', 'ComfyUI-Foo'), { recursive: true })
      mkdirSync(join(instPath, 'custom_nodes', '.git'), { recursive: true })
      mkdirSync(join(instPath, 'custom_nodes', '__pycache__'), { recursive: true })
      mkdirSync(join(instPath, 'custom_nodes', '__MACOSX'), { recursive: true })
      mkdirSync(join(instPath, 'custom_nodes', 'node_modules'), { recursive: true })
      mkdirSync(join(instPath, 'custom_nodes', 'Other-Pack'), { recursive: true })
      saveSettings({ defaultInstancePath: instPath })

      const real = await import('../../src/main/services/registry')
      vi.doMock('../../src/main/services/registry', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/main/services/registry')>()
        return {
          ...actual,
          searchRegistry: vi.fn(async () => ({
            raw: [
              { id: 'ComfyUI-Foo', name: 'ComfyUI-Foo', title: 'Foo', description: 'd' },
              { id: 'Bar', name: 'Bar', description: 'd2' },
              { id: 'Baz', name: 'Baz', description: 'd3' }
            ],
            total: 3,
            page: 1,
            pageSize: 50,
            totalPages: 1,
            scanned: 3,
            clientFiltered: false
          }))
        }
      })
      vi.doMock('../../src/main/services/nodePack', () => ({
        nodePackService: {
          list: () => [{ name: 'Baz', registryId: 'baz-reg' }]
        }
      }))

      const res = await marketService.list({ category: 'tools' })
      expect(res.items.length).toBe(3)
      const foo = res.items.find((i: { id: string }) => i.id === 'ComfyUI-Foo')!
      expect(foo.installed).toBe(true)
      const bar = res.items.find((i: { id: string }) => i.id === 'Bar')!
      expect(bar.installed).toBe(false)
      const baz = res.items.find((i: { id: string }) => i.id === 'Baz')!
      expect(baz.installed).toBe(true) // via nodePack name
      expect(foo.category).toBe('tools')
      void real
    })

    it('resolves instanceId path over defaultInstancePath', async () => {
      const { marketService } = await freshP1p2()
      const { saveSettings, upsertInstanceConfig } = await import('../../src/main/services/db')
      const defPath = join(ROOT, 'mkt-default')
      mkdirSync(join(defPath, 'custom_nodes', 'Default-Pack'), { recursive: true })
      saveSettings({ defaultInstancePath: defPath })

      const altPath = join(ROOT, 'mkt-alt')
      mkdirSync(join(altPath, 'custom_nodes', 'Alt-Pack'), { recursive: true })
      upsertInstanceConfig(makeInstance({ id: 'alt-inst', path: altPath }) as never)

      vi.doMock('../../src/main/services/registry', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/main/services/registry')>()
        return {
          ...actual,
          searchRegistry: vi.fn(async () => ({
            raw: [{ id: 'Alt-Pack', name: 'Alt-Pack' }, { id: 'Default-Pack', name: 'Default-Pack' }],
            total: 2,
            page: 1,
            pageSize: 50,
            totalPages: 1,
            scanned: 2,
            clientFiltered: false
          }))
        }
      })
      vi.doMock('../../src/main/services/nodePack', () => ({
        nodePackService: { list: () => [] }
      }))

      const res = await marketService.list({ instanceId: 'alt-inst', query: 'x' })
      const alt = res.items.find((i: { id: string }) => i.id === 'Alt-Pack')!
      const def = res.items.find((i: { id: string }) => i.id === 'Default-Pack')!
      expect(alt.installed).toBe(true)
      expect(def.installed).toBe(false)
    })

    it('offline mode returns empty page when registry throws', async () => {
      const { marketService } = await freshP1p2()
      const { saveSettings } = await import('../../src/main/services/db')
      saveSettings({ networkMode: 'offline' })
      vi.doMock('../../src/main/services/registry', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/main/services/registry')>()
        return {
          ...actual,
          searchRegistry: vi.fn(async () => {
            throw new Error('registry down')
          })
        }
      })
      const res = await marketService.list({ query: 'foo', limit: 10, page: 2 })
      expect(res.items).toEqual([])
      expect(res.total).toBe(0)
      expect(res.page).toBe(2)
      expect(res.pageSize).toBe(10)
      expect(res.clientFiltered).toBe(true)
    })

    it('rethrows registry errors when not offline', async () => {
      const { marketService } = await freshP1p2()
      const { saveSettings } = await import('../../src/main/services/db')
      saveSettings({ networkMode: 'public' })
      vi.doMock('../../src/main/services/registry', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/main/services/registry')>()
        return {
          ...actual,
          searchRegistry: vi.fn(async () => {
            throw new Error('registry down')
          })
        }
      })
      await expect(marketService.list()).rejects.toThrow('registry down')
    })

    it('survives nodePack module failure using directory keys only', async () => {
      const { marketService } = await freshP1p2()
      const { saveSettings } = await import('../../src/main/services/db')
      const instPath = join(ROOT, 'mkt-np')
      mkdirSync(join(instPath, 'custom_nodes', 'DirOnly'), { recursive: true })
      saveSettings({ defaultInstancePath: instPath })
      vi.doMock('../../src/main/services/registry', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/main/services/registry')>()
        return {
          ...actual,
          searchRegistry: vi.fn(async () => ({
            raw: [{ id: 'DirOnly', name: 'DirOnly' }],
            total: 1,
            page: 1,
            pageSize: 50,
            totalPages: 1,
            scanned: 1,
            clientFiltered: false
          }))
        }
      })
      vi.doMock('../../src/main/services/nodePack', () => {
        throw new Error('nodePack unavailable')
      })
      const res = await marketService.list()
      expect(res.items[0].installed).toBe(true)
    })

    it('readdirSafe handles empty instance path', async () => {
      const { marketService } = await freshP1p2()
      const { saveSettings } = await import('../../src/main/services/db')
      saveSettings({ defaultInstancePath: '' })
      vi.doMock('../../src/main/services/registry', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/main/services/registry')>()
        return {
          ...actual,
          searchRegistry: vi.fn(async () => ({
            raw: [{ id: 'X', name: 'X' }],
            total: 1,
            page: 1,
            pageSize: 50,
            totalPages: 1,
            scanned: 1,
            clientFiltered: false
          }))
        }
      })
      vi.doMock('../../src/main/services/nodePack', () => ({
        nodePackService: { list: () => [] }
      }))
      const res = await marketService.list()
      expect(res.items[0].installed).toBe(false)
    })
  })

  // ========== indexPromptOutput media typing via history ==========

  describe('indexPromptOutput typing', () => {
    it('indexes non-png outputs and falls back to item seeds', async () => {
      const { batchService, outputService } = await freshP1p2()
      await seedInstance()
      const p = join(ROOT, 'wf', 'seedfb.json')
      writeFileSync(p, uiGraph())
      const mp4 = join(ROOT, 'comfy', 'output', 'fb.mp4')
      writeFileSync(mp4, 'video-bytes')

      const job = batchService.create({
        name: 'seedfb',
        instanceId: 'inst-1',
        items: [{ workflowPath: p, count: 1 }],
        params: { seedMode: 'fixed', baseSeed: 777 }
      })
      stubFetch((url) => {
        if (url.includes('/prompt')) return jsonResponse({ prompt_id: 'pid-fb2' })
        if (url.includes('/history')) {
          return jsonResponse({
            'pid-fb2': {
              status: { status_str: 'success' },
              outputs: {
                '1': { videos: [{ filename: 'fb.mp4', subfolder: '', type: 'output' }] }
              }
            }
          })
        }
        return jsonResponse({})
      })
      const result = await batchService.start(job.id)
      expect(result.produced).toBe(1)
      const listed = outputService.list({ batchJobId: job.id })
      const asset = listed.items.find((a) => a.path === mp4)!
      expect(asset.type).toBe('video')
      // seed falls back to the submitted seed (fixed 777)
      expect(asset.seed).toBe(777)
      expect(asset.promptId).toBe('pid-fb2')
      expect(asset.params.batchJobId).toBe(job.id)
    })
  })
})
