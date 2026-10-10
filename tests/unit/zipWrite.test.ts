/**
 * zipWrite deep coverage: store vs deflate, inline content, path entries,
 * multi-entry archives, createWorkflowZip guards.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { inflateRawSync } from 'zlib'

const ROOT = join(tmpdir(), `cp-zipwrite-${process.pid}`)

function readZipEntries(buf: Buffer): Array<{ name: string; method: number; data: Buffer }> {
  const out: Array<{ name: string; method: number; data: Buffer }> = []
  let off = 0
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8)
    const compSize = buf.readUInt32LE(off + 18)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    const name = buf.toString('utf-8', off + 30, off + 30 + nameLen)
    const dataStart = off + 30 + nameLen + extraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    out.push({ name, method, data })
    off = dataStart + compSize
  }
  return out
}

describe('zipWrite', () => {
  beforeAll(() => mkdirSync(ROOT, { recursive: true }))

  it('packs a large highly-compressible file with deflate', async () => {
    const { writeZip } = await import('../../src/main/services/zipWrite')
    const big = join(ROOT, 'big.txt')
    writeFileSync(big, 'A'.repeat(50000))
    const out = join(ROOT, 'big.zip')
    writeZip(out, [{ path: big, name: 'big.txt' }])
    const entries = readZipEntries(readFileSync(out))
    expect(entries.length).toBe(1)
    expect(entries[0].method).toBe(8)
    expect(entries[0].data.length).toBe(50000)
  })

  it('uses store method when deflate does not shrink', async () => {
    const { writeZip } = await import('../../src/main/services/zipWrite')
    // Incompressible random-ish payload
    const rnd = join(ROOT, 'rnd.bin')
    const bytes = Buffer.alloc(200)
    for (let i = 0; i < 200; i++) bytes[i] = (i * 37 + 11) % 251
    writeFileSync(rnd, bytes)
    const out = join(ROOT, 'rnd.zip')
    writeZip(out, [{ path: rnd, name: 'rnd.bin' }])
    const entries = readZipEntries(readFileSync(out))
    expect(entries[0].method).toBe(0)
    expect(entries[0].data.equals(bytes)).toBe(true)
  })

  it('packs multiple entries including inline README', async () => {
    const { writeZip } = await import('../../src/main/services/zipWrite')
    const a = join(ROOT, 'a.json')
    writeFileSync(a, '{"a":1}')
    const out = join(ROOT, 'multi.zip')
    writeZip(out, [
      { path: a, name: 'a.json' },
      { name: 'README.txt', content: 'hello zip' }
    ])
    const entries = readZipEntries(readFileSync(out))
    expect(entries.map((e) => e.name).sort()).toEqual(['README.txt', 'a.json'])
    expect(entries.find((e) => e.name === 'README.txt')?.data.toString()).toBe('hello zip')
  })

  it('createWorkflowZip refuses missing files and empty lists', async () => {
    const { createWorkflowZip } = await import('../../src/main/services/zipWrite')
    await expect(createWorkflowZip(join(ROOT, 'x.zip'), [])).rejects.toThrow()
    await expect(
      createWorkflowZip(join(ROOT, 'x.zip'), [{ path: join(ROOT, 'missing.json'), name: 'm.json' }])
    ).rejects.toThrow()
    const ok = join(ROOT, 'ok.json')
    writeFileSync(ok, '{}')
    const out = join(ROOT, 'cw.zip')
    const p = await createWorkflowZip(out, [{ path: ok, name: 'ok.json' }])
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).size).toBeGreaterThan(30)
  })

  it('rejects entries with neither path nor content', async () => {
    const { writeZip } = await import('../../src/main/services/zipWrite')
    expect(() => writeZip(join(ROOT, 'bad.zip'), [{ name: 'x' } as never])).toThrow()
  })
})
