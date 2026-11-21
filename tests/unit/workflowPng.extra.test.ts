import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractPngTextMeta, readPngTextMetaFromFile } from '../../src/main/services/workflow'

const root = mkdtempSync(join(tmpdir(), 'cp-png-meta-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
}

describe('workflow PNG metadata helpers', () => {
  it('rejects non-PNG and malformed chunks', () => {
    expect(extractPngTextMeta(Buffer.alloc(0))).toEqual({})
    expect(extractPngTextMeta(Buffer.from('not a png'))).toEqual({})
    expect(extractPngTextMeta(Buffer.concat([SIG, Buffer.from([0, 0, 0])]))).toEqual({})
    const noNul = chunk('tEXt', Buffer.from('keyvalue'))
    expect(extractPngTextMeta(Buffer.concat([SIG, noNul]))).toEqual({})
    const nulAtStart = chunk('tEXt', Buffer.from('\0value'))
    expect(extractPngTextMeta(Buffer.concat([SIG, nulAtStart]))).toEqual({})
    const truncated = Buffer.concat([SIG, Buffer.from([0, 0, 0, 10, 0x74])])
    expect(extractPngTextMeta(truncated)).toEqual({})
  })

  it('extracts tEXt and iTXt metadata and stops at IEND', () => {
    const text = chunk('tEXt', Buffer.from('prompt\0{"a":1}'))
    const itxtBad = chunk('iTXt', Buffer.from('key\0\0\0no-lang-nul'))
    const itxtNoTrans = chunk('iTXt', Buffer.from('key\0\0\0en\0\0values'))
    const itxt = chunk('iTXt', Buffer.from('workflow\0\0\0en\0trans\0{"nodes":[]}'))
    const iend = chunk('IEND', Buffer.alloc(0))
    const after = chunk('tEXt', Buffer.from('ignored\0x'))
    const meta = extractPngTextMeta(
      Buffer.concat([SIG, text, itxtBad, itxtNoTrans, itxt, iend, after])
    )
    expect(meta.prompt).toBe('{"a":1}')
    expect(meta.key).toBe('values')
    expect(meta.workflow).toBe('{"nodes":[]}')
    expect(meta.ignored).toBeUndefined()
    const nulKey = chunk('iTXt', Buffer.from('\0x'))
    expect(extractPngTextMeta(Buffer.concat([SIG, nulKey]))).toEqual({})
  })

  it('reads metadata files defensively', () => {
    expect(readPngTextMetaFromFile(join(root, 'missing.png'))).toEqual({})
    const empty = join(root, 'empty.png')
    writeFileSync(empty, '')
    expect(readPngTextMetaFromFile(empty)).toEqual({})
    const good = join(root, 'good.png')
    writeFileSync(good, Buffer.concat([SIG, chunk('tEXt', Buffer.from('k\0v'))]))
    expect(readPngTextMetaFromFile(good)).toEqual({ k: 'v' })
  })
})
