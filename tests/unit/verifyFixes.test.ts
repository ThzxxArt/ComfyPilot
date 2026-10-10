/**
 * Correctness locks for the review-verification fixes:
 *  - BatchJob.submitted is tracked and zero is preserved (not falsy-clobbered)
 *  - completed only counts settle successes
 *  - params.extractedFrom survives list() rescans
 *  - output root allow-list rejects parent-directory bypass
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seedTestInstance } from '../helpers/testInstance'

const ROOT = join(tmpdir(), `cp-verify-${process.pid}`)

vi.mock('electron', async () => {
  return {
    app: { getPath: () => ROOT },
    shell: {
      showItemInFolder: () => undefined,
      openExternal: async () => undefined,
      openPath: async () => ''
    }
  }
})

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

describe('BatchJob.submitted semantics', () => {
  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true })
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })
  beforeEach(async () => {
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })

  it('preserves submitted=0 on a mid-run job (no falsy clobber)', async () => {
    const { batchService } = await import('../../src/main/services/p1p2')
    const { upsertBatchJob } = await import('../../src/main/services/db')
    const dir = join(ROOT, 'wf-sub')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'a.json')
    writeFileSync(p, '{"nodes":[],"links":[]}')

    // A running job that has not submitted anything yet.
    upsertBatchJob({
      id: 'sub-zero',
      name: 'z',
      instanceId: 'i',
      items: [
        {
          workflowName: 'a',
          workflowPath: p,
          count: 2,
          submitted: 0,
          completed: 0,
          failed: 0,
          promptIds: [],
          seeds: [],
          outputPaths: []
        }
      ],
      status: 'submitting',
      count: 2,
      submitted: 0,
      completed: 0,
      failed: 0,
      produced: 0,
      createdAt: Date.now(),
      notes: '',
      params: {},
      workflowPath: p
    } as never)

    const job = batchService.list().find((j) => j.id === 'sub-zero')!
    expect(job.submitted).toBe(0)
    expect(job.completed).toBe(0)
  })

  it('derives submitted from items when the field is absent (legacy row)', async () => {
    const { batchService } = await import('../../src/main/services/p1p2')
    const { upsertBatchJob } = await import('../../src/main/services/db')
    const dir = join(ROOT, 'wf-leg')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'b.json')
    writeFileSync(p, '{}')

    upsertBatchJob({
      id: 'leg-sub',
      name: 'l',
      instanceId: 'i',
      items: [
        {
          workflowName: 'b',
          workflowPath: p,
          count: 3,
          submitted: 2,
          completed: 1,
          failed: 0,
          promptIds: ['x', 'y'],
          seeds: [1, 2],
          outputPaths: []
        }
      ],
      status: 'running',
      count: 3,
      completed: 1,
      failed: 0,
      produced: 1,
      createdAt: Date.now(),
      notes: '',
      params: {},
      workflowPath: p
    } as never)

    const job = batchService.list().find((j) => j.id === 'leg-sub')!
    expect(job.submitted).toBe(2)
    expect(job.completed).toBe(1)
  })
})

describe('workflow params survive rescan', () => {
  beforeAll(async () => {
    mkdirSync(ROOT, { recursive: true })
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })
  beforeEach(async () => {
    vi.resetModules()
    await seedTestInstance({ id: 'test-inst', path: join(ROOT, 'inst') })
  })

  it('extractedFrom is kept across list() and points at the original source', async () => {
    const { workflowService } = await import('../../src/main/services/workflow')
    const dir = join(ROOT, 'pair-keep')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'k.png')
    writePng(src, [
      ['workflow', JSON.stringify({ nodes: [{ id: 1, type: 'KSampler', widgets_values: [1] }], links: [] })]
    ])
    const rec = await workflowService.importFile(src)
    expect(rec.path.endsWith('.json')).toBe(true)
    expect(rec.params.extractedFrom).toBe(src)

    // Rescan — extractedFrom must not be wiped.
    const again = workflowService.list()
    const hit = again.find((w) => w.id === rec.id)
    expect(hit?.params.extractedFrom).toBe(src)

    // Delete removes only the library json; the original PNG stays.
    await workflowService.remove(rec.id)
    expect(existsSync(rec.path)).toBe(false)
    expect(existsSync(src)).toBe(true)
  })
})

describe('output root allow-list', () => {
  beforeAll(() => mkdirSync(ROOT, { recursive: true }))
  beforeEach(() => vi.resetModules())

  it('rejects a root that is a parent of an allowed area', async () => {
    const { isPathInside } = await import('../../src/main/services/security')
    // Simulates the handler check: root must be INSIDE an allowed area.
    const allowed = [join(ROOT, 'inst', 'output')]
    const evil = ROOT // parent of the allowed dir
    const ok = allowed.some((r) => evil === r || isPathInside(evil, r))
    expect(ok).toBe(false)
    const good = join(ROOT, 'inst', 'output', 'sub')
    expect(allowed.some((r) => good === r || isPathInside(good, r))).toBe(true)
  })
})
