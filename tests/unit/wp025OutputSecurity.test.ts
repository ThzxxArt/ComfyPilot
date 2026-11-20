import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ appDir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.appDir },
  shell: { showItemInFolder: vi.fn() }
}))

import { outputService } from '../../src/main/services/p1p2'
import { listOutputAssetsAll } from '../../src/main/services/db'

let root = ''
let outside = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cp-output-sec-'))
  h.appDir = join(root, 'app')
  outside = join(root, 'outside')
  mkdirSync(h.appDir, { recursive: true })
  mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('output containment (0.2.5 WP10 / S9)', () => {
  it('refuses to delete a DB-referenced file outside every output root', () => {
    const evil = join(outside, 'evil.png')
    writeFileSync(evil, 'png')
    outputService.indexFile(evil)
    const row = listOutputAssetsAll().find((a) => a.path === evil)
    expect(row).toBeTruthy()
    expect(() => outputService.remove(row!.id, true)).toThrow(/outside the output roots/i)
    expect(existsSync(evil)).toBe(true)
  })

  it('does not walk a symlinked output root', () => {
    const link = join(root, 'link-root')
    writeFileSync(join(outside, 'a.png'), 'png')
    symlinkSync(outside, link)
    expect(outputService.scan(link)).toBe(0)
  })
})
