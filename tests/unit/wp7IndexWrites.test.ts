/**
 * 0.1.17 (WP7): index-write governance.
 *  - hot collections keep an in-memory snapshot and coalesce disk writes
 *  - an external (hand) edit invalidates the snapshot
 *  - the output index is only touched by an explicit scan, not by listing
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  utimesSync,
  statSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ModelRecord, OutputAsset } from '../../src/shared/types'

const h = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir }
}))

let root = ''

/** Fresh userData per test — one test pre-seeding models must not leak on. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cp-wp7-'))
  h.dir = root
})

// 0.1.17 (WP7): hot collections flush on a 400 ms timer. Drain it before the
// next test swaps `root`, otherwise a late write lands in the NEW data dir and
// makes row counts non-deterministic.
afterEach(async () => {
  try {
    const db = await import('../../src/main/services/db')
    db.flushPendingWrites()
  } catch {
    /* module not loaded in this test */
  }
})

afterAll(() => {
  try {
    if (root) rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function model(id: string): ModelRecord {
  return {
    id,
    name: id,
    fileName: `${id}.safetensors`,
    category: 'checkpoints',
    path: `/models/${id}.safetensors`,
    size: 1,
    modifiedAt: 1,
    tags: [],
    metadata: {},
    source: 'local',
    trainedWords: [],
    pathRoot: '/models'
  } as unknown as ModelRecord
}

function asset(id: string, path: string): OutputAsset {
  return {
    id,
    path,
    fileName: `${id}.png`,
    type: 'image',
    size: 1,
    createdAt: Date.now(),
    favorite: false,
    params: {}
  } as unknown as OutputAsset
}

describe('hot collection write coalescing (0.1.17 WP7)', () => {
  it('keeps reads consistent while coalescing disk writes', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    const file = join(root, 'data', 'models.jsonc')

    db.upsertModels([model('a')])
    db.upsertModels([model('b')])
    db.upsertModels([model('c')])
    // Read-after-write is immediate even though nothing has hit the disk yet.
    expect(db.listModels().map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(existsSync(file)).toBe(false)

    db.flushPendingWrites()
    expect(existsSync(file)).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as ModelRecord[]
    expect(onDisk.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('invalidates the snapshot after an external edit (hand-edited jsonc)', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    const file = join(root, 'data', 'models.jsonc')
    db.upsertModels([model('original')])
    db.flushPendingWrites()
    expect(db.listModels().map((m) => m.id)).toEqual(['original'])

    // User edits the file by hand (bump mtime so the change is detectable).
    writeFileSync(file, JSON.stringify([model('edited')]), 'utf-8')
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)

    expect(db.listModels().map((m) => m.id)).toEqual(['edited'])
  })

  it('clears many dead thumbnails in one write', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    db.mergeUpsertOutputAssets([
      { ...asset('t1', '/out/t1.png'), thumbnail: '/thumbs/t1.png' },
      { ...asset('t2', '/out/t2.png'), thumbnail: '/thumbs/t2.png' },
      { ...asset('t3', '/out/t3.png'), thumbnail: '/thumbs/t3.png' }
    ])
    const cleared = db.clearOutputAssetThumbnails(['t1', 't3'])
    expect(cleared).toBe(2)
    db.flushPendingWrites()
    const rows = JSON.parse(
      readFileSync(join(root, 'data', 'output_assets.jsonc'), 'utf-8')
    ) as OutputAsset[]
    const byId = new Map(rows.map((r) => [r.id, r.thumbnail]))
    expect(byId.get('t1')).toBeUndefined()
    expect(byId.get('t3')).toBeUndefined()
    expect(byId.get('t2')).toBe('/thumbs/t2.png')
  })
})

describe('output list vs scan (0.1.17 WP7)', () => {
  it('list() does not index a new file until scan() runs', async () => {
    vi.resetModules()
    const p1p2 = await import('../../src/main/services/p1p2')
    const outDir = join(root, 'wp7-out')
    mkdirSync(outDir, { recursive: true })
    p1p2.outputService.scan(outDir)
    expect(p1p2.outputService.list({ root: outDir }).items).toHaveLength(0)

    writeFileSync(join(outDir, 'new.png'), 'png')
    // Listing stays index-only: the file is invisible until an explicit scan.
    expect(p1p2.outputService.list({ root: outDir }).items).toHaveLength(0)
    expect(p1p2.outputService.scan(outDir)).toBe(1)
    expect(p1p2.outputService.list({ root: outDir }).items).toHaveLength(1)
  })
})

describe('output list bounds (0.1.17 WP7)', () => {
  it('clamps an oversized limit and never returns more than 200 rows', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    const p1p2 = await import('../../src/main/services/p1p2')
    const rows = Array.from({ length: 250 }, (_, i) => asset(`bulk-${i}`, `/out/bulk-${i}.png`))
    db.mergeUpsertOutputAssets(rows)
    const res = p1p2.outputService.list({ limit: 5000 })
    expect(res.items).toHaveLength(200)
    expect(res.total).toBe(250)
    expect(res.truncated).toBe(true)
    // A zero/NaN limit still returns a usable page instead of everything.
    expect(p1p2.outputService.list({ limit: 0 }).items.length).toBeLessThanOrEqual(200)
  })

  it('a flush with no pending writes does not touch the file', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    const file = join(root, 'data', 'models.jsonc')
    db.upsertModels([model('stable')])
    db.flushPendingWrites()
    const before = statSync(file).mtimeMs
    // Debounce window with nothing scheduled → no rewrite at all.
    db.flushPendingWrites()
    expect(statSync(file).mtimeMs).toBe(before)
    expect(db.listModels().map((m) => m.id)).toEqual(['stable'])
  })
})

describe('persistence failures are not swallowed (review fix)', () => {
  it('keeps a failed write queued for the next flush instead of dropping it', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    db.upsertModels([model('lost')])
    // Make the data directory unwritable by replacing it with a file.
    rmSync(join(root, 'data'), { recursive: true, force: true })
    writeFileSync(join(root, 'data'), 'not a directory')
    const first = db.flushPendingWrites()
    expect(first.failed).toContain('models')
    // The value is still queued and reads still see it.
    expect(db.listModels().map((m) => m.id)).toEqual(['lost'])
    // Restore the directory: the next flush persists the same value.
    rmSync(join(root, 'data'), { force: true })
    mkdirSync(join(root, 'data'), { recursive: true })
    const second = db.flushPendingWrites()
    expect(second.failed).toEqual([])
    const onDisk = JSON.parse(readFileSync(join(root, 'data', 'models.jsonc'), 'utf-8'))
    expect(onDisk.map((m: { id: string }) => m.id)).toEqual(['lost'])
  })
})

describe('node pack deletion vs queued writes (review fix)', () => {
  it('cannot be resurrected by a pending upsert flush', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    const pack = (id: string) =>
      ({
        id,
        name: id,
        path: `/custom_nodes/${id}`,
        enabled: true,
        version: '1.0.0',
        description: '',
        tags: [],
        installedAt: 1
      }) as unknown as Parameters<typeof db.upsertNodePack>[0]
    db.upsertNodePack(pack('keep'))
    db.upsertNodePack(pack('drop'))
    // Delete inside the 400 ms debounce window: the earlier upsert is still queued.
    expect(db.deleteNodePack('drop')).toBe(true)
    db.flushPendingWrites()
    const rows = JSON.parse(
      readFileSync(join(root, 'data', 'node_packs.jsonc'), 'utf-8')
    ) as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['keep'])
  })
})
