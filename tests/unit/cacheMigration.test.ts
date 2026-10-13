/**
 * 0.1.9 cache-directory migration: legacy `<userData>/cache` collides with
 * Chromium's `Cache` on case-insensitive filesystems and gets evicted with it.
 * `cacheDir()` must move our thumbs + registry index into `<userData>/app-cache`
 * on first access, without ever overwriting newer destination data.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ROOT = join(tmpdir(), `cp-cache-migrate-${process.pid}`)

/**
 * Symlink support probe (Windows without developer mode / hardened CI forbids
 * it). Probed eagerly so the affected case is reported as SKIPPED instead of
 * silently passing via an early `return`.
 */
const canSymlink = ((): boolean => {
  const target = join(tmpdir(), `cp-symlink-target-${process.pid}`)
  const probe = join(tmpdir(), `cp-symlink-probe-${process.pid}`)
  try {
    mkdirSync(target, { recursive: true })
    symlinkSync(target, probe, 'dir')
    return true
  } catch {
    return false
  } finally {
    try {
      rmSync(probe, { force: true })
      rmSync(target, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})()

vi.mock('electron', () => ({
  app: { getPath: () => ROOT }
}))

describe('legacy cache migration (0.1.9)', () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    vi.resetModules()
  })

  it('moves legacy thumbs + registry index into app-cache on first access', async () => {
    const legacy = join(ROOT, 'cache')
    mkdirSync(join(legacy, 'thumbs', 'output'), { recursive: true })
    writeFileSync(join(legacy, 'thumbs', 'output', 'a.png'), 'x')
    writeFileSync(join(legacy, 'registry-index.json'), '{}')
    writeFileSync(join(legacy, 'registry-index.json.tmp'), '{}')

    const { cacheDir } = await import('../../src/main/services/db')
    const dir = cacheDir()
    expect(dir).toBe(join(ROOT, 'app-cache'))
    expect(existsSync(join(dir, 'thumbs', 'output', 'a.png'))).toBe(true)
    expect(existsSync(join(dir, 'registry-index.json'))).toBe(true)
    expect(readFileSync(join(dir, 'registry-index.json'), 'utf-8')).toBe('{}')
    // MOVE semantics: the legacy copies are gone (a copy-only implementation
    // would leave duplicates behind and re-trigger migration forever).
    expect(existsSync(join(legacy, 'thumbs', 'output', 'a.png'))).toBe(false)
    expect(existsSync(join(legacy, 'registry-index.json'))).toBe(false)
  })

  it('is idempotent across module reloads (second run changes nothing)', async () => {
    const legacy = join(ROOT, 'cache')
    mkdirSync(join(legacy, 'thumbs'), { recursive: true })
    writeFileSync(join(legacy, 'thumbs', 'one.png'), 'one')
    const first = await import('../../src/main/services/db')
    first.cacheDir()
    const target = join(ROOT, 'app-cache', 'thumbs', 'one.png')
    expect(readFileSync(target, 'utf-8')).toBe('one')

    vi.resetModules()
    const second = await import('../../src/main/services/db')
    expect(() => second.cacheDir()).not.toThrow()
    expect(readFileSync(target, 'utf-8')).toBe('one')
  })

  it.skipIf(!canSymlink)('never descends into symlinked legacy entries', async () => {
    const legacy = join(ROOT, 'cache')
    const real = join(ROOT, 'real-thumbs')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'linked.png'), 'x')
    mkdirSync(legacy, { recursive: true })
    symlinkSync(real, join(legacy, 'thumbs'), 'dir')
    const { cacheDir } = await import('../../src/main/services/db')
    cacheDir()
    // The link target's contents must NOT be moved away.
    expect(existsSync(join(real, 'linked.png'))).toBe(true)
  })

  it('never overwrites newer destination data while merging', async () => {
    const legacy = join(ROOT, 'cache')
    const next = join(ROOT, 'app-cache')
    mkdirSync(join(legacy, 'thumbs'), { recursive: true })
    mkdirSync(join(next, 'thumbs'), { recursive: true })
    writeFileSync(join(legacy, 'thumbs', 'same.png'), 'old')
    writeFileSync(join(next, 'thumbs', 'same.png'), 'new')
    writeFileSync(join(legacy, 'thumbs', 'only-legacy.png'), 'old-only')

    const { cacheDir } = await import('../../src/main/services/db')
    cacheDir()
    expect(readFileSync(join(next, 'thumbs', 'same.png'), 'utf-8')).toBe('new')
    // Non-conflicting legacy files still make it across.
    expect(existsSync(join(next, 'thumbs', 'only-legacy.png'))).toBe(true)
  })

  it('does not throw when the legacy cache is absent', async () => {
    const { cacheDir } = await import('../../src/main/services/db')
    expect(() => cacheDir()).not.toThrow()
    expect(existsSync(join(ROOT, 'app-cache'))).toBe(true)
  })
})
