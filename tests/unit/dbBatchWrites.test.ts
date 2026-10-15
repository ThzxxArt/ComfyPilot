import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ModelRecord, DownloadTask } from '../../src/shared/types'

const h = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir }
}))

const root = mkdtempSync(join(tmpdir(), 'cp-dbw-'))
h.dir = root

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
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

describe('db batch + debounced writes (0.1.16)', () => {
  it('upsertModels writes every record in a single pass', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    db.upsertModels([model('a'), model('b')])
    db.upsertModel(model('c'))
    expect(db.listModels().map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('download upsert is read-after-write consistent and flushes to disk', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    db.upsertDownloadTask({ id: 'd1', status: 'running' } as DownloadTask)
    db.upsertDownloadTask({ id: 'd2', status: 'queued' } as DownloadTask)
    expect(db.listDownloadTasks().map((t) => t.id)).toEqual(['d1', 'd2'])
    db.flushPendingWrites()
    expect(existsSync(join(root, 'data', 'downloads.jsonc'))).toBe(true)
    const onDisk = JSON.parse(
      readFileSync(join(root, 'data', 'downloads.jsonc'), 'utf-8')
    ) as DownloadTask[]
    expect(onDisk.map((t) => t.id).sort()).toEqual(['d1', 'd2'])
  })

  it('install-run save is debounced but immediately readable', async () => {
    vi.resetModules()
    const db = await import('../../src/main/services/db')
    db.saveInstallRun({ runId: 'r1', status: 'running' })
    expect(db.loadInstallRuns().some((r) => r.runId === 'r1')).toBe(true)
    db.flushPendingWrites()
    const onDisk = db.parseJsonc<{ runs: Array<{ runId: string }> }>(
      readFileSync(join(root, 'data', 'install-runs.jsonc'), 'utf-8')
    )
    expect(onDisk.runs[0].runId).toBe('r1')
  })
})
