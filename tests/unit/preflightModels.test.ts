/**
 * 0.1.18 regression: model preflight must consult the TARGET instance's
 * models/ directory, otherwise a model that merely exists in another instance
 * is reported present (and the run fails later).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../src/main/services/target', () => ({
  resolveReadTarget: (id?: string) =>
    id === 'inst-1' ? { id, path: join(h.dir, 'ComfyUI'), name: 'inst' } : undefined
}))

vi.mock('../../src/main/services/model', () => ({
  modelService: { list: async () => [] }
}))

vi.mock('../../src/main/services/workflow', () => ({
  workflowService: {
    buildApiPrompt: async () => ({
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'present.safetensors' }
      },
      '2': { class_type: 'LoraLoader', inputs: { lora_name: 'missing.safetensors' } }
    })
  }
}))

describe('preflight models scoped to the target instance', () => {
  beforeAll(() => {
    h.dir = mkdtempSync(join(tmpdir(), 'cp-preflight-models-'))
    mkdirSync(join(h.dir, 'ComfyUI', 'models', 'checkpoints'), { recursive: true })
    writeFileSync(join(h.dir, 'ComfyUI', 'models', 'checkpoints', 'present.safetensors'), 'x')
  })
  afterAll(() => {
    rmSync(h.dir, { recursive: true, force: true })
  })

  it('finds a model on disk even when it is not in the global index', async () => {
    const { preflightService } = await import('../../src/main/services/preflight')
    const r = await preflightService.models('/wf/a.json', 'inst-1')
    expect(r.available).toBe(true)
    expect(r.required).toBe(2)
    expect(r.present).toBe(1)
    expect(r.missing.map((m) => m.name)).toEqual(['missing.safetensors'])
    expect(r.missing[0].present).toBe(false)
  })

  it('without a target keeps the global-index behaviour', async () => {
    const { preflightService } = await import('../../src/main/services/preflight')
    const r = await preflightService.models('/wf/a.json')
    expect(r.required).toBe(2)
    expect(r.present).toBe(0)
  })
})
