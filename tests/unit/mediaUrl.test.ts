/**
 * Controlled media URL gate: thumbs/output only, round-trip safe.
 * 0.1.9 root cause: output thumbs live at `thumbs/output/<key>.png` but the
 * URL flattened the directory and the resolver rejected `/` — every output
 * thumbnail 403'd. These tests pin the nested round-trip.
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

  it('thumbs round-trip through comfy-pilot-media (flat legacy layout)', async () => {
    const { toMediaUrl, resolveMediaUrlToPath, thumbnailDisplayUrl } =
      await import('../../src/main/services/media')
    const { cacheDir } = await import('../../src/main/services/db')
    const thumbs = join(cacheDir(), 'thumbs')
    mkdirSync(thumbs, { recursive: true })
    const file = join(thumbs, 'abc123.png')
    writeFileSync(file, 'x')

    const url = toMediaUrl(file)
    expect(url).toBe('comfy-pilot-media:thumbs/abc123.png')
    expect(thumbnailDisplayUrl(file)).toBe(url)
    expect(thumbnailDisplayUrl(url!)).toBe(url)
    expect(resolveMediaUrlToPath(url!)).toBe(file)
  })

  it('nested output thumbs round-trip (regression: every thumb 403d)', async () => {
    const { toMediaUrl, resolveMediaUrlToPath, thumbnailDisplayUrl } =
      await import('../../src/main/services/media')
    const { cacheDir } = await import('../../src/main/services/db')
    const nested = join(cacheDir(), 'thumbs', 'output')
    mkdirSync(nested, { recursive: true })
    const file = join(nested, 'ae081c1595287491.png')
    writeFileSync(file, 'x')

    const url = toMediaUrl(file)
    expect(url).toBe('comfy-pilot-media:thumbs/output/ae081c1595287491.png')
    expect(thumbnailDisplayUrl(file)).toBe(url)
    expect(resolveMediaUrlToPath(url!)).toBe(file)
  })

  it('serves videos only under allowed output roots', async () => {
    const { toMediaUrl, resolveMediaUrlToPath } = await import('../../src/main/services/media')
    const { upsertInstanceConfig } = await import('../../src/main/services/db')
    const instRoot = join(tmpdir(), 'cp-media-url-test', 'vid-inst')
    const out = join(instRoot, 'output')
    mkdirSync(out, { recursive: true })
    const mp4 = join(out, 'clip.mp4')
    writeFileSync(mp4, 'v')
    upsertInstanceConfig({
      id: 'vid-inst',
      name: 'V',
      path: instRoot,
      pythonPath: '',
      venvPath: '',
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true,
      notes: '',
      autoStart: false,
      frontendVersion: '',
      pinned: false
    })
    const url = toMediaUrl(mp4)
    expect(url).toBe('comfy-pilot-media:output/clip.mp4')
    expect(resolveMediaUrlToPath(url!)).toBe(mp4)
    // Videos outside the allow-list are still refused.
    expect(toMediaUrl(join(tmpdir(), 'cp-media-url-test', 'not-allowed.mp4'))).toBeNull()
  })

  it('serves names containing `..` (ordinary filenames, not hops)', async () => {
    const { toMediaUrl, resolveMediaUrlToPath } = await import('../../src/main/services/media')
    const { cacheDir } = await import('../../src/main/services/db')
    const nested = join(cacheDir(), 'thumbs', 'output')
    mkdirSync(nested, { recursive: true })
    const file = join(nested, 'my..image.png')
    writeFileSync(file, 'x')
    const url = toMediaUrl(file)
    expect(url).toBe('comfy-pilot-media:thumbs/output/my..image.png')
    expect(resolveMediaUrlToPath(url!)).toBe(file)
  })

  it('rejects paths outside allow-list and traversal', async () => {
    const { toMediaUrl, resolveMediaUrlToPath } = await import('../../src/main/services/media')
    expect(toMediaUrl('C:\\Windows\\System32\\evil.png')).toBeNull()
    expect(toMediaUrl(join(tmpdir(), 'not-allowed.png'))).toBeNull()
    expect(resolveMediaUrlToPath('comfy-pilot-media:thumbs/../../secret.png')).toBeNull()
    expect(resolveMediaUrlToPath('comfy-pilot-media:thumbs/output/../../../secret.png')).toBeNull()
    // Missing nested file → null (existence check), not a path escape.
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

  it('serves audio and refuses raw images / 3D files (0.1.14 catalogue)', async () => {
    const { toMediaUrl, resolveMediaUrlToPath } = await import('../../src/main/services/media')
    const { cacheDir } = await import('../../src/main/services/db')
    const thumbs = join(cacheDir(), 'thumbs')
    // Audio plays inline in the lightbox — the protocol must serve it.
    const mp3 = join(thumbs, 'voice.mp3')
    writeFileSync(mp3, 'a')
    expect(toMediaUrl(mp3)).toBe('comfy-pilot-media:thumbs/voice.mp3')
    expect(resolveMediaUrlToPath('comfy-pilot-media:thumbs/voice.mp3')).toBe(mp3)
    // Raw images and 3D outputs open with the OS default app — never the protocol.
    const exr = join(thumbs, 'render.exr')
    writeFileSync(exr, 'x')
    expect(toMediaUrl(exr)).toBeNull()
    expect(resolveMediaUrlToPath('comfy-pilot-media:thumbs/render.exr')).toBeNull()
    const glb = join(thumbs, 'mesh.glb')
    writeFileSync(glb, 'x')
    expect(toMediaUrl(glb)).toBeNull()
    expect(resolveMediaUrlToPath('comfy-pilot-media:thumbs/mesh.glb')).toBeNull()
  })
})
