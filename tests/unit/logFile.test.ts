import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readTextTail, rotateLogIfTooLarge } from '../../src/main/services/logFile'

const dir = mkdtempSync(join(tmpdir(), 'cp-logfile-'))
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('logFile (0.1.16)', () => {
  it('reads only the tail and drops a truncated first line', () => {
    const f = join(dir, 'a.log')
    writeFileSync(f, 'AAAA\nBBBB\nCCCC\n')
    expect(readTextTail(f, 9)).toBe('CCCC\n')
    expect(readTextTail(f, 1000)).toBe('AAAA\nBBBB\nCCCC\n')
  })

  it('returns empty for missing or empty files', () => {
    expect(readTextTail(join(dir, 'nope.log'), 100)).toBe('')
    const empty = join(dir, 'empty.log')
    writeFileSync(empty, '')
    expect(readTextTail(empty, 100)).toBe('')
  })

  it('rotates over the limit and keeps archives, no-ops under it', () => {
    const f = join(dir, 'rot.log')
    writeFileSync(f, 'x'.repeat(300))
    expect(rotateLogIfTooLarge(f, 100, 1)).toBe(true)
    expect(existsSync(`${f}.1`)).toBe(true)
    expect(existsSync(f)).toBe(false)
    writeFileSync(f, 'y')
    expect(rotateLogIfTooLarge(f, 100, 1)).toBe(false)
    expect(rotateLogIfTooLarge(join(dir, 'missing.log'), 10, 1)).toBe(false)
  })
})
