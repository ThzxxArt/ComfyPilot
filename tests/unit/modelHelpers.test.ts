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
        'weight': { dtype: 'F16', shape: [1], data_offsets: [0, 2] }
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
