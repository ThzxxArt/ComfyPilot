/**
 * Bootstrap resumable download (0.1.13) — Range resume from the `${dest}.part`
 * file this module actually writes, and the HTTP 416 promote path.
 * Real temp filesystem; electron app/session mocked (network via h.fetchImpl).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync } from 'fs'
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
  // tmpfs hygiene (0.1.15): un-cleaned 16MB download fixtures used to
  // accumulate under /tmp until the installer disk gate tripped.
  beforeEach(() => {
    if (h.root) rmSync(h.root, { recursive: true, force: true })
    h.root = mkdtempSync(join(tmpdir(), 'cp-boot-dl-'))
    h.fetchImpl = null
    vi.resetModules()
  })

  afterAll(() => {
    if (h.root) {
      try {
        rmSync(h.root, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
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

  // 0.1.17 (WP1): a cancel must end ensure(), not fall through to the next kind.
  it('ensure() propagates a cancel and never starts the next runtime', async () => {
    const svc = await freshService()
    const anySvc = svc as unknown as {
      probeKind: (k: string) => Promise<{ kind: string; installed: boolean; origin: string }>
      download: (k: string) => Promise<unknown>
    }
    const probed: string[] = []
    let failDownload: ((e: Error) => void) | null = null
    anySvc.probeKind = async (k: string) => {
      probed.push(k)
      return { kind: k, installed: false, origin: 'missing' }
    }
    anySvc.download = () =>
      new Promise((_resolve, reject) => {
        failDownload = reject
      })

    const pending = (svc.ensure as typeof svc.ensure)({
      kinds: ['uv', 'python'],
      downloadIfMissing: true
    })
    // Let the loop reach the download, then cancel it.
    await new Promise((r) => setTimeout(r, 10))
    svc.cancelAll()
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    // TS narrows the closure-assigned variable to null; the callback above sets it.
    ;(failDownload as ((e: Error) => void) | null)?.(abortErr)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(probed).toEqual(['uv'])
  })

  it('cancelAll aborts the real download and stops the next kind (review fix)', async () => {
    const svc = await freshService()
    const anySvc = svc as unknown as {
      probeKind: (k: string) => Promise<{ kind: string; installed: boolean; origin: string }>
    }
    const probed: string[] = []
    anySvc.probeKind = async (k: string) => {
      probed.push(k)
      return { kind: k, installed: false, origin: 'missing' }
    }
    // A transport that honours the abort signal, like the real session.fetch.
    h.fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        const fail = (): void => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }
        if (signal?.aborted) fail()
        else signal?.addEventListener('abort', fail)
      })

    const pending = (svc.ensure as typeof svc.ensure)({
      kinds: ['uv', 'python'],
      downloadIfMissing: true
    })
    await new Promise((r) => setTimeout(r, 20))
    svc.cancelAll()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    // The next kind must never be probed after a cancel.
    expect(probed).toEqual(['uv'])
  })

  it('a cancel that lands during the probe does not start a download', async () => {
    const svc = await freshService()
    const anySvc = svc as unknown as {
      probeKind: (k: string) => Promise<{ kind: string; installed: boolean; origin: string }>
    }
    const probed: string[] = []
    let fetchCalls = 0
    anySvc.probeKind = async (k: string) => {
      probed.push(k)
      // Slow probe: cancelAll() lands while ensure() is still waiting here.
      await new Promise((r) => setTimeout(r, 80))
      return { kind: k, installed: false, origin: 'missing' }
    }
    h.fetchImpl = () => {
      fetchCalls += 1
      return Promise.reject(new Error('fetch must not start after a cancel'))
    }
    const pending = (svc.ensure as typeof svc.ensure)({
      kinds: ['uv', 'python'],
      downloadIfMissing: true
    })
    await new Promise((r) => setTimeout(r, 10))
    svc.cancelAll()
    // 0.1.17 (review fix): the epoch check after the probe must end ensure()
    // instead of letting it start a fresh, un-aborted download that hangs.
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(probed).toEqual(['uv'])
    expect(fetchCalls).toBe(0)
  })

  it('a new ensure() after a cancel runs normally (no permanent latch)', async () => {
    const svc = await freshService()
    const anySvc = svc as unknown as {
      probeKind: (k: string) => Promise<{ kind: string; installed: boolean; origin: string }>
      download: (k: string) => Promise<unknown>
    }
    const probed: string[] = []
    anySvc.probeKind = async (k: string) => {
      probed.push(k)
      return { kind: k, installed: false, origin: 'missing' }
    }
    anySvc.download = async () => undefined

    svc.cancelAll()
    await svc.ensure({ kinds: ['uv'], downloadIfMissing: true })
    // status() probes every kind afterwards; the ensure() itself started at uv.
    expect(probed[0]).toBe('uv')
  })
})
