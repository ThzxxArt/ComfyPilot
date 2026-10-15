/**
 * Bootstrap resumable download (0.1.13) — Range resume from the `${dest}.part`
 * file this module actually writes, and the HTTP 416 promote path.
 * Real temp filesystem; electron app/session mocked (network via h.fetchImpl).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  root: '',
  fetchImpl: null as null | ((url: string, init?: RequestInit) => Promise<Response>)
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.root, name: 't', isPackaged: false },
  session: {
    defaultSession: {
      fetch: (url: string, init?: RequestInit) => {
        if (!h.fetchImpl) throw new Error('no fetch impl')
        return h.fetchImpl(url, init)
      },
      setProxy: async () => undefined
    }
  }
}))

vi.mock('systeminformation', () => ({
  default: { graphics: async () => ({ controllers: [] }) }
}))

import { RUNTIME_SOURCES } from '../../src/shared/constants'

/** Same platform selection as bootstrap.platformKey(). */
function platformUvKey(): string {
  if (process.platform === 'win32') return 'uv-win-x64'
  if (process.platform === 'darwin') return 'uv-darwin-arm64'
  return 'uv-linux-x64'
}

function uvPaths(): { sizeHint: number; dest: string; part: string } {
  const src = RUNTIME_SOURCES[platformUvKey()]
  const fileName = basename(new URL(src.url).pathname) || 'uv.bin'
  const downloads = join(h.root, 'runtimes', 'downloads')
  mkdirSync(downloads, { recursive: true })
  const dest = join(downloads, fileName)
  return { sizeHint: src.sizeHint, dest, part: `${dest}.part` }
}

describe('bootstrap resumable download (0.1.13)', () => {
  beforeEach(() => {
    h.root = mkdtempSync(join(tmpdir(), 'cp-boot-dl-'))
    h.fetchImpl = null
    vi.resetModules()
  })

  async function freshService(): Promise<any> {
    return (await import('../../src/main/services/bootstrap')).bootstrapService
  }

  it('sends a Range request resuming from the .part bytes, then promotes it (0.1.13)', async () => {
    const { sizeHint, dest, part } = uvPaths()
    const already = 1024
    writeFileSync(part, Buffer.alloc(already, 7))
    let seenRange = ''
    const rest = Buffer.alloc(sizeHint - already, 2)
    h.fetchImpl = async (_url, init) => {
      const range = String((init?.headers as Record<string, string> | undefined)?.Range || '')
      if (!range) {
        // The post-download SHA256SUMS probe — 404 keeps the official hash
        // unset (pin-on-first-use path).
        return new Response('', { status: 404 })
      }
      seenRange = range
      // undici does not derive content-length for a Buffer body — real
      // servers always send it (the downloader's length gate relies on it).
      return new Response(rest, {
        status: 206,
        headers: { 'content-length': String(rest.length) }
      })
    }
    const svc = await freshService()
    // Extraction of the fake bytes fails — the point is what happened BEFORE
    // it: the resume offset came from `.part` (the old code read `dest`,
    // which never exists mid-download, so every retry restarted at 0).
    await expect(svc.download('uv')).rejects.toThrow()
    expect(seenRange).toBe(`bytes=${already}-`)
    expect(existsSync(dest)).toBe(true)
    expect(statSync(dest).size).toBe(sizeHint)
    expect(existsSync(part)).toBe(false)
  })

  it('promotes a complete .part to dest on HTTP 416 (0.1.13)', async () => {
    const { sizeHint, dest, part } = uvPaths()
    // A partial covering ≥ 90% of the hint is treated as the finished archive.
    const payload = Buffer.alloc(Math.ceil(sizeHint * 0.95), 1)
    writeFileSync(part, payload)
    h.fetchImpl = async () => new Response(null, { status: 416 })
    const svc = await freshService()
    await expect(svc.download('uv')).rejects.toThrow()
    expect(existsSync(dest)).toBe(true)
    expect(statSync(dest).size).toBe(payload.length)
    expect(existsSync(part)).toBe(false)
  })

  it('rejects a truncated .part on 416 instead of promoting it (0.1.13)', async () => {
    const { sizeHint, dest, part } = uvPaths()
    // Well below the plausibility floor — must be discarded, not promoted.
    writeFileSync(part, Buffer.alloc(Math.ceil(sizeHint * 0.5), 1))
    h.fetchImpl = async () => new Response(null, { status: 416 })
    const svc = await freshService()
    await expect(svc.download('uv')).rejects.toThrow(/truncated/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(part)).toBe(false)
  })
})
