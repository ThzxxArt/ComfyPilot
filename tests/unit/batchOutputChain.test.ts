/**
 * Batch / output chain tests:
 *  - multi-workflow create + legacy shape migration
 *  - output list is newest-first and paginated (regression: slice dropped new items)
 *  - buildIterationPrompt seed modes + param overrides
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ROOT = join(tmpdir(), `cp-batch-output-test-${process.pid}`)

vi.mock('electron', async () => {
  return {
    app: { getPath: () => ROOT },
    shell: { showItemInFolder: () => undefined, openExternal: async () => undefined, openPath: async () => '' }
  }
})

describe('workflowConvert param matrix', () => {
  it('buildIterationPrompt increment seed + width/height/steps/cfg', async () => {
    const { buildIterationPrompt } = await import('../../src/main/services/workflowConvert')
    const graph = {
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
    }
    const a = buildIterationPrompt(graph, {
      iteration: 0,
      seedMode: 'increment',
      baseSeed: 1000,
      width: 768,
      height: 1024,
      steps: 30,
      cfg: 5
    })
    expect(a.seed).toBe(1000)
    expect(a.prompt['1'].inputs.seed).toBe(1000)
    expect(a.prompt['1'].inputs.steps).toBe(30)
    expect(a.prompt['1'].inputs.cfg).toBe(5)
    expect(a.prompt['2'].inputs.width).toBe(768)
    expect(a.prompt['2'].inputs.height).toBe(1024)

    const b = buildIterationPrompt(graph, {
      iteration: 3,
      seedMode: 'increment',
      baseSeed: 1000
    })
    expect(b.seed).toBe(1003)
  })

  it('fixed seed stays constant; random produces a number', async () => {
    const { buildIterationPrompt } = await import('../../src/main/services/workflowConvert')
    const graph = {
      nodes: [{ id: 1, type: 'KSampler', widgets_values: [1, 'fixed', 20, 7.5] }],
      links: []
    }
    const f0 = buildIterationPrompt(graph, { iteration: 0, seedMode: 'fixed', baseSeed: 77 })
    const f1 = buildIterationPrompt(graph, { iteration: 5, seedMode: 'fixed', baseSeed: 77 })
    expect(f0.seed).toBe(77)
    expect(f1.seed).toBe(77)

    const r = buildIterationPrompt(graph, { iteration: 1, seedMode: 'random' })
    expect(Number.isFinite(r.seed)).toBe(true)
  })
})

describe('BatchService multi-workflow', () => {
  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true })
  })
  beforeEach(() => {
    vi.resetModules()
  })

  it('creates a job with several legs and sums counts', async () => {
    const { batchService } = await import('../../src/main/services/p1p2')
    const dir = join(ROOT, 'wfs')
    mkdirSync(dir, { recursive: true })
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    writeFileSync(a, '{"nodes":[],"links":[]}')
    writeFileSync(b, '{"nodes":[],"links":[]}')

    const job = batchService.create({
      name: 'two-legs',
      instanceId: 'inst',
      items: [
        { workflowPath: a, workflowName: 'A', count: 2 },
        { workflowPath: b, workflowName: 'B', count: 3 }
      ],
      params: { seedMode: 'increment', baseSeed: 10 }
    })
    expect(job.items.length).toBe(2)
    expect(job.count).toBe(5)
    expect(job.params.seedMode).toBe('increment')
    expect(batchService.list().some((j) => j.id === job.id)).toBe(true)
  })

  it('rejects empty item list and missing files', async () => {
    const { batchService } = await import('../../src/main/services/p1p2')
    expect(() =>
      batchService.create({ name: 'x', instanceId: 'i', items: [] })
    ).toThrow()
    expect(() =>
      batchService.create({
        name: 'x',
        instanceId: 'i',
        items: [{ workflowPath: join(ROOT, 'nope.json'), count: 1 }]
      })
    ).toThrow()
  })

  it('migrates legacy single-path jobs into items[0]', async () => {
    const { batchService } = await import('../../src/main/services/p1p2')
    const { upsertBatchJob } = await import('../../src/main/services/db')
    const dir = join(ROOT, 'legacy')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'old.json')
    writeFileSync(p, '{}')
    upsertBatchJob({
      id: 'legacy-1',
      name: 'old',
      workflowPath: p,
      instanceId: 'i',
      count: 3,
      status: 'done',
      completed: 3,
      failed: 0,
      produced: 0,
      createdAt: 1,
      notes: '',
      params: {},
      items: [
        {
          workflowName: 'old',
          workflowPath: p,
          count: 3,
          submitted: 3,
          completed: 3,
          failed: 0,
          promptIds: ['p1'],
          seeds: [1],
          outputPaths: []
        }
      ]
    } as never)

    const listed = batchService.list()
    const job = listed.find((j) => j.id === 'legacy-1')
    expect(job?.items.length).toBe(1)
    expect(job?.items[0].workflowPath).toBe(p)
    expect(job?.count).toBe(3)
  })
})

describe('OutputService list ordering', () => {
  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true })
  })
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns newest first and paginates without dropping new items', async () => {
    // Fresh index — the JSONC store is shared across tests in this file.
    const dataDir = join(ROOT, 'data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'output_assets.jsonc'), '[]', 'utf-8')
    const { outputService } = await import('../../src/main/services/p1p2')
    const { upsertOutputAsset } = await import('../../src/main/services/db')

    // Simulate an index that already has 5 items with ascending createdAt.
    for (let i = 0; i < 5; i++) {
      upsertOutputAsset({
        id: `id-${i}`,
        path: join(ROOT, `f${i}.png`),
        fileName: `f${i}.png`,
        type: 'image',
        size: 100 + i,
        createdAt: 1000 + i,
        params: {}
      })
    }

    const page1 = outputService.list({ limit: 2, offset: 0, sort: 'createdAt', order: 'desc' })
    expect(page1.total).toBe(5)
    // Newest first: id-4, id-3
    expect(page1.items.map((a) => a.id)).toEqual(['id-4', 'id-3'])
    expect(page1.truncated).toBe(true)

    // The previous bug: slice(0, limit) of insertion order kept the OLDEST.
    const page2 = outputService.list({ limit: 2, offset: 4 })
    expect(page2.items.map((a) => a.id)).toEqual(['id-0'])
    expect(page2.truncated).toBe(false)
  })

  it('filters by favorite / type / batchJobId', async () => {
    const { outputService } = await import('../../src/main/services/p1p2')
    const { upsertOutputAsset } = await import('../../src/main/services/db')
    upsertOutputAsset({
      id: 'fav-1',
      path: join(ROOT, 'fav.png'),
      fileName: 'fav.png',
      type: 'image',
      size: 1,
      createdAt: 99999,
      favorite: true,
      batchJobId: 'job-9',
      params: {}
    })
    upsertOutputAsset({
      id: 'plain-1',
      path: join(ROOT, 'plain.png'),
      fileName: 'plain.png',
      type: 'image',
      size: 1,
      createdAt: 99998,
      params: {}
    })

    const favs = outputService.list({ favorite: true })
    expect(favs.items.every((a) => a.favorite)).toBe(true)
    expect(favs.items.some((a) => a.id === 'fav-1')).toBe(true)

    const byJob = outputService.list({ batchJobId: 'job-9' })
    expect(byJob.items.map((a) => a.id)).toEqual(['fav-1'])
  })
})
