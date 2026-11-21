/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  categorize,
  categoryHintForRoot,
  filenameFromContentDisposition,
  parseExtraModelPaths,
  parseExtraModelPathsDetailed,
  readSafetensorsMeta,
  sha256File
} from '../../src/main/services/model'

const root = mkdtempSync(join(tmpdir(), 'cp-model-helpers-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('model helper branches', () => {
  it('parses content-disposition filenames', () => {
    expect(filenameFromContentDisposition(null)).toBeUndefined()
    expect(filenameFromContentDisposition('')).toBeUndefined()
    expect(filenameFromContentDisposition('attachment; filename="a.safetensors"')).toBe(
      'a.safetensors'
    )
    expect(filenameFromContentDisposition('attachment; filename=a.safetensors')).toBe(
      'a.safetensors'
    )
    expect(filenameFromContentDisposition(`attachment; filename*=UTF-8''caf%C3%A9.bin`)).toBe(
      'café.bin'
    )
    expect(filenameFromContentDisposition(`attachment; filename*=UTF-8''%E0%A4%A.bin`)).toBeTruthy()
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeUndefined()
    expect(filenameFromContentDisposition('attachment; filename="dir/a.bin"')).toBe('a.bin')
  })

  it('categorises model paths and hints', () => {
    const cases: Array<[string, string | undefined, string]> = [
      ['/models/checkpoints/a.safetensors', undefined, 'checkpoints'],
      ['/models/loras/a.safetensors', undefined, 'loras'],
      ['/models/vae/a.safetensors', undefined, 'vae'],
      ['/models/controlnet/a.pth', undefined, 'controlnet'],
      ['/models/embeddings/a.pt', undefined, 'embeddings'],
      ['/models/clip_vision/a.bin', undefined, 'clip_vision'],
      ['/models/upscale_models/a.pth', undefined, 'upscale_models'],
      ['/models/diffusion_models/a.safetensors', undefined, 'diffusion_models'],
      ['/models/text_encoders/a.safetensors', undefined, 'text_encoders'],
      ['/models/unet/a.safetensors', undefined, 'diffusion_models'],
      ['/models/clip/a.safetensors', undefined, 'text_encoders'],
      ['/models/unknown/a.safetensors', undefined, 'other'],
      ['/models/a.safetensors', undefined, 'other'],
      ['/models/a.ckpt', undefined, 'other'],
      ['/models/a.pt', undefined, 'other'],
      ['/models/a.gguf', undefined, 'other'],
      ['/x/loras/a.bin', 'vae', 'vae'],
      ['/x/loras/a.bin', 'invalid' as any, 'invalid']
    ]
    for (const [path, hint, want] of cases) {
      expect(categorize(path, hint as any), path).toBe(want)
    }
    expect(categoryHintForRoot('/models/checkpoints')).toBe('checkpoints')
    expect(categoryHintForRoot('/models/loras/')).toBe('loras')
    expect(categoryHintForRoot('/models/unknown')).toBeUndefined()
    expect(categoryHintForRoot('')).toBeUndefined()
  })

  it('parses extra_model_paths yaml shapes', () => {
    const yaml = [
      'comfyui:',
      '  base_path: /models',
      '  checkpoints: |',
      '    checkpoints',
      '    extra/checkpoints',
      '  loras: loras',
      '  vae: vae',
      '  custom_nodes: nodes',
      'bad:',
      '  nested: value',
      'other:',
      '  text_encoders: clips'
    ].join('\n')
    const yamlFile = join(root, 'extra_model_paths.yaml')
    writeFileSync(yamlFile, yaml)
    const paths = parseExtraModelPaths(yamlFile).map((p) => p.replace(/\\/g, '/'))
    expect(paths).toContain('/models/checkpoints')
    expect(paths).toContain('/models/loras')
    expect(paths).toContain('/models/vae')
    const detailed = parseExtraModelPathsDetailed(yamlFile)
    expect(detailed.length).toBeGreaterThan(0)
    expect(detailed.some((r) => r.categoryHint === 'checkpoints')).toBe(true)
    expect(detailed.some((r) => r.categoryHint === 'text_encoders')).toBe(true)
    expect(parseExtraModelPathsDetailed(yamlFile, false).length).toBeLessThanOrEqual(
      detailed.length
    )
    expect(
      parseExtraModelPathsDetailed(yamlFile, true, { modelOnly: true }).some((r) =>
        r.path.replace(/\\/g, '/').endsWith('/nodes')
      )
    ).toBe(false)
    expect(parseExtraModelPathsDetailed(join(root, 'missing.yaml'))).toEqual([])
    const badFile = join(root, 'bad.yaml')
    writeFileSync(badFile, 'not: [valid')
    expect(parseExtraModelPaths(badFile)).toBeTruthy()
    const sectionBad = join(root, 'section.yaml')
    writeFileSync(sectionBad, 'x:\n  base_path: 1\n  checkpoints: ckpt\n')
    expect(
      parseExtraModelPathsDetailed(sectionBad).some((r) =>
        r.path.replace(/\\/g, '/').endsWith('/ckpt')
      )
    ).toBe(true)
    expect(parseExtraModelPathsDetailed()).toBeTruthy()
  })

  it('reads safetensors metadata safely and hashes files', async () => {
    expect(readSafetensorsMeta(join(root, 'missing.safetensors'))).toBeNull()
    const empty = join(root, 'empty.safetensors')
    writeFileSync(empty, '')
    expect(readSafetensorsMeta(empty)).toBeNull()
    const tiny = join(root, 'tiny.safetensors')
    writeFileSync(tiny, 'short')
    expect(readSafetensorsMeta(tiny)).toBeNull()
    const badLen = join(root, 'badlen.safetensors')
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(9999n)
    writeFileSync(badLen, Buffer.concat([len, Buffer.from('{}')]))
    expect(readSafetensorsMeta(badLen)).toMatchObject({ tensors: 0 })
    const good = join(root, 'good.safetensors')
    const header = Buffer.from(JSON.stringify({ __metadata__: { a: 1 } }))
    const hlen = Buffer.alloc(8)
    hlen.writeBigUInt64LE(BigInt(header.length))
    writeFileSync(good, Buffer.concat([hlen, header]))
    expect(readSafetensorsMeta(good)).toMatchObject({ a: 1, tensors: 0 })
    const noMeta = join(root, 'nometa.safetensors')
    const nheader = Buffer.from(JSON.stringify({ tensor: { dtype: 'F32' } }))
    const nlen = Buffer.alloc(8)
    nlen.writeBigUInt64LE(BigInt(nheader.length))
    writeFileSync(noMeta, Buffer.concat([nlen, nheader]))
    expect(readSafetensorsMeta(noMeta)).toMatchObject({ tensors: 1 })
    const corrupt = join(root, 'corrupt.safetensors')
    const chead = Buffer.from('{not json')
    const clen = Buffer.alloc(8)
    clen.writeBigUInt64LE(BigInt(chead.length))
    writeFileSync(corrupt, Buffer.concat([clen, chead]))
    expect(readSafetensorsMeta(corrupt)).toBeNull()
    expect(await sha256File(good)).toHaveLength(64)
  })
})
