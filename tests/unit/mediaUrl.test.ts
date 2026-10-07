/**
 * Controlled media URL gate: thumbs/output only, round-trip safe.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', async () => {
  const path = await import('path')
  const root = path.join(tmpdir(), 'cp-media-url-test')
  return {
    app: { getPath: () => root },
    session: { defaultSession: { fetch: globalThis.fetch, setProxy: async () => undefined } }
  }
})

describe('media URL gate', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('thumbs round-trip through comfy-pilot-media', async () => {
    const { toMediaUrl, resolveMediaUrlToPath, thumbnailDisplayUrl } = await import(
      '../../src/main/services/media'
    )
    const { cacheDir } = await import('../../src/main/services/db')
    const thumbs = join(cacheDir(), 'thumbs')
    mkdirSync(thumbs, { recursive: true })
    const file = join(thumbs, 'abc123.png')
    writeFileSync(file, 'x')

    const url = toMediaUrl(file)
    expect(url).toBe('comfy-pilot-media:thumbs/abc123.png')
    expect(thumbnailDisplayUrl(file)).toBe(url)
    expect(thumbnailDisplayUrl(url)).toBe(url)
    expect(resolveMediaUrlToPath(url!)).toBe(file)
  })

  it('rejects paths outside allow-list and traversal', async () => {
    const { toMediaUrl, resolveMediaUrlToPath } = await import('../../src/main/services/media')
    expect(toMediaUrl('C:\\Windows\\System32\\evil.png')).toBeNull()
    expect(toMediaUrl(join(tmpdir(), 'not-allowed.png'))).toBeNull()
    expect(resolveMediaUrlToPath('comfy-pilot-media:thumbs/../../secret.png')).toBeNull()
    expect(resolveMediaUrlToPath('comfy-pilot-media:thumbs/a/b.png')).toBeNull()
    expect(resolveMediaUrlToPath('comfy-pilot-media:other/x.png')).toBeNull()
  })

  it('non-image extensions are refused', async () => {
    const { toMediaUrl, resolveMediaUrlToPath } = await import('../../src/main/services/media')
    const { cacheDir } = await import('../../src/main/services/db')
    const thumbs = join(cacheDir(), 'thumbs')
    const exe = join(thumbs, 'evil.exe')
    writeFileSync(exe, 'x')
    expect(toMediaUrl(exe)).toBeNull()
    expect(resolveMediaUrlToPath('comfy-pilot-media:thumbs/evil.exe')).toBeNull()
    void existsSync
  })
})
