import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash, randomBytes } from 'crypto'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return { app: { getPath: () => path.join(os.tmpdir(), 'cp-model-test') } }
})

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-model-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('sha256File', () => {
  it('hashes file contents', async () => {
    const { sha256File } = await import('../../src/main/services/model')
    const file = join(dir, 'a.bin')
    const data = 'hello-comfy-pilot'
    writeFileSync(file, data)
    const hash = await sha256File(file)
    expect(hash).toBe(createHash('sha256').update(data).digest('hex'))
    expect(hash).toHaveLength(64)
  })
})

describe('readSafetensorsMeta', () => {
  it('parses header JSON after 8-byte length', async () => {
    const { readSafetensorsMeta } = await import('../../src/main/services/model')
    const file = join(dir, 't.safetensors')
    const header = Buffer.from(
      JSON.stringify({
        __metadata__: { ss_base_model: 'sdxl', key: 'v' },
        weight: { dtype: 'F16', shape: [1], data_offsets: [0, 2] }
      }),
      'utf-8'
    )
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(header.length))
    const body = Buffer.alloc(2)
    writeFileSync(file, Buffer.concat([len, header, body]))

    const meta = readSafetensorsMeta(file)
    expect(meta).toBeTruthy()
    expect(meta?.ss_base_model).toBe('sdxl')
    expect(meta?.tensors).toBe(1)
  })

  it('returns null for garbage', async () => {
    const { readSafetensorsMeta } = await import('../../src/main/services/model')
    const file = join(dir, 'bad.safetensors')
    writeFileSync(file, randomBytes(32))
    expect(readSafetensorsMeta(file)).toBeNull()
    expect(readSafetensorsMeta(join(dir, 'missing.safetensors'))).toBeNull()
    expect(readSafetensorsMeta('')).toBeNull()
  })

  it('exists check false positive guard', () => {
    expect(existsSync(join(dir, 'nope'))).toBe(false)
  })
})

describe('categorize (ComfyUI folder_paths mapping)', () => {
  it('maps legacy unet/clip dirs to their canonical successors', async () => {
    const { categorize } = await import('../../src/main/services/model')
    expect(categorize('C:/m/models/unet/a.safetensors')).toBe('diffusion_models')
    expect(categorize('C:/m/models/clip/a.safetensors')).toBe('text_encoders')
    expect(categorize('C:/m/models/diffusion_models/a.safetensors')).toBe('diffusion_models')
    expect(categorize('C:/m/models/text_encoders/a.safetensors')).toBe('text_encoders')
  })

  it('keeps lookalike dirs apart (clip_vision vs clip, vae_approx vs vae)', async () => {
    const { categorize } = await import('../../src/main/services/model')
    expect(categorize('/m/models/clip_vision/a.safetensors')).toBe('clip_vision')
    expect(categorize('/m/models/vae_approx/a.safetensors')).toBe('vae_approx')
    expect(categorize('/m/models/vae/a.safetensors')).toBe('vae')
  })

  it('covers third-party registered folders and falls back to other', async () => {
    const { categorize } = await import('../../src/main/services/model')
    expect(categorize('/m/models/detection/a.pt')).toBe('detection')
    expect(categorize('/m/models/audio_encoders/a.safetensors')).toBe('audio_encoders')
    expect(categorize('/m/models/model_patches/a.safetensors')).toBe('model_patches')
    expect(categorize('/m/random/a.safetensors')).toBe('other')
  })
})

describe('parseExtraModelPaths (upstream key layout)', () => {
  // Windows `join` mixes separators with the yaml's forward slashes; compare
  // normalized forms instead of assuming POSIX.
  const slash = (p: string): string => p.replace(/\\/g, '/')
  it('parses block scalars, base_path and third-party keys', async () => {
    const { parseExtraModelPaths } = await import('../../src/main/services/model')
    const yamlFile = join(dir, 'extra_model_paths.yaml')
    writeFileSync(
      yamlFile,
      [
        'aki:',
        '  base_path: D:/AI',
        '  checkpoints: |',
        '    models/ckpt',
        '    D:/more/ckpt',
        '  audio_encoders: models/audio',
        '  diffusers:',
        '    - ignored-non-string'
      ].join('\n')
    )
    const roots = parseExtraModelPaths(yamlFile)
    expect(roots.map(slash)).toContain('D:/AI/models/ckpt')
    expect(roots.map(slash)).toContain('D:/more/ckpt')
    expect(roots.map(slash)).toContain('D:/AI/models/audio')
  })

  it('resolves relative values against the yaml directory when no base_path', async () => {
    const { parseExtraModelPaths } = await import('../../src/main/services/model')
    const yamlFile = join(dir, 'no-base.yaml')
    writeFileSync(yamlFile, ['comfy:', '  loras: extra/loras'].join('\n'))
    const roots = parseExtraModelPaths(yamlFile)
    expect(roots.map(slash)).toContain(slash(join(dir, 'extra/loras')))
  })

  it('accepts legacy clip/unet keys (aliases still mapped by categorize)', async () => {
    const { parseExtraModelPaths } = await import('../../src/main/services/model')
    const yamlFile = join(dir, 'legacy.yaml')
    writeFileSync(yamlFile, ['comfy:', '  clip: legacy/clip', '  unet: legacy/unet'].join('\n'))
    const roots = parseExtraModelPaths(yamlFile)
    expect(roots.map(slash)).toContain(slash(join(dir, 'legacy/clip')))
    expect(roots.map(slash)).toContain(slash(join(dir, 'legacy/unet')))
  })

  it('modelOnly skips custom_nodes/datasets (scan must not walk node packs)', async () => {
    const { parseExtraModelPaths } = await import('../../src/main/services/model')
    const yamlFile = join(dir, 'scan-safe.yaml')
    writeFileSync(
      yamlFile,
      ['comfy:', '  checkpoints: ckpt', '  custom_nodes: nodes', '  datasets: data'].join('\n')
    )
    const all = parseExtraModelPaths(yamlFile)
    expect(all.map(slash)).toContain(slash(join(dir, 'nodes')))
    const modelOnly = parseExtraModelPaths(yamlFile, true, { modelOnly: true })
    expect(modelOnly.map(slash)).toContain(slash(join(dir, 'ckpt')))
    expect(modelOnly.map(slash)).not.toContain(slash(join(dir, 'nodes')))
    expect(modelOnly.map(slash)).not.toContain(slash(join(dir, 'data')))
  })
})
