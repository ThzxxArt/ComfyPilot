/**
 * modelService.scan behaviour (0.1.16): the scan used to call `upsertModel` per
 * discovered file — one full read-modify-write of models.jsonc each time
 * (O(N²)). It now reads the index once and writes all records in one batch.
 * This exercises the real scan on a temp models tree.
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir, isPackaged: false }
}))

const root = mkdtempSync(join(tmpdir(), 'cp-modelscan-'))
h.dir = root
const modelsDir = join(root, 'checkpoints')
mkdirSync(modelsDir, { recursive: true })
// safetensors with a zero-length header is enough to exercise the record path.
writeFileSync(join(modelsDir, 'sd15.safetensors'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]))
writeFileSync(join(modelsDir, 'notes.txt'), 'not a model')

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('modelService.scan (0.1.16 batch write)', () => {
  it('indexes model files under an explicit root and persists them', async () => {
    const { modelService } = await import('../../src/main/services/model')
    const list = await modelService.scan({ roots: [modelsDir], hash: false })
    expect(list.some((m) => m.fileName === 'sd15.safetensors')).toBe(true)
    // Non-model extensions are not indexed.
    expect(list.some((m) => m.fileName === 'notes.txt')).toBe(false)
    // Persisted through the single batch write.
    const { listModels } = await import('../../src/main/services/db')
    const rec = listModels().find((m) => m.fileName === 'sd15.safetensors')
    expect(rec).toBeTruthy()
    expect(rec?.category).toBe('checkpoints')
  })
})
