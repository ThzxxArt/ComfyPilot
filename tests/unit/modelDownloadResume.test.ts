/**
 * Resume integrity (0.1.18 WP1 / P0-2).
 *
 * The old downloader trusted any `206` answer and appended it. A proxy that
 * re-served the file from 0, or an upstream file that changed between attempts,
 * produced a file whose length matched and whose bytes were wrong. These tests
 * drive the real ModelService against a scripted fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  roots: [] as string[],
  downloads: [] as any[],
  fetchCalls: [] as Array<{ url: string; headers: Record<string, string> }>,
  handler: null as null | ((url: string, headers: Record<string, string>) => Response),
  abortReject: null as null | ((err: Error) => void)
}))

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      fetch: async (url: string, init?: { headers?: Record<string, string> }) => {
        const headers = init?.headers || {}
        h.fetchCalls.push({ url: String(url), headers })
        if (!h.handler) throw new Error('no handler')
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal
        if (signal) {
          signal.addEventListener('abort', () =>
            h.abortReject?.(new DOMException('Aborted', 'AbortError'))
          )
        }
        return h.handler(String(url), headers)
      }
    }
  }
}))

vi.mock('../../src/main/services/proxy', () => ({
  shouldBypass: () => true,
  buildBypassList: () => [],
  proxyFetch: async (
    url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal }
  ) => {
    const headers = init?.headers || {}
    h.fetchCalls.push({ url: String(url), headers })
    if (!h.handler) throw new Error('no handler')
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    init?.signal?.addEventListener('abort', () =>
      h.abortReject?.(new DOMException('Aborted', 'AbortError'))
    )
    return h.handler(String(url), headers)
  }
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => ({
    proxy: { enabled: false },
    useAria2: false,
    hfEndpoint: '',
    civitaiEndpoint: '',
    modelScanRoots: h.roots,
    githubEndpoint: ''
  }),
  loadInstanceConfigs: () => [],
  listModels: () => [],
  deleteModel: () => true,
  upsertModel: () => undefined,
  upsertModels: () => undefined,
  updateModel: () => undefined,
  upsertDownloadTask: (t: any) => {
    const i = h.downloads.findIndex((x) => x.id === t.id)
    if (i >= 0) h.downloads[i] = { ...t }
    else h.downloads.push({ ...t })
  },
  replaceDownloadTasks: (items: any[]) => {
    h.downloads = items
  },
  listDownloadTasks: () => h.downloads,
  stringifyJsonc: (v: unknown) => JSON.stringify(v),
  userDataDir: () => 'C:/fake/data'
}))

function streamResponse(
  body: Buffer,
  init: { status: number; headers?: Record<string, string> }
): Response {
  return new Response(new Blob([new Uint8Array(body)]).stream(), {
    status: init.status,
    headers: init.headers
  })
}

async function makeService(): Promise<any> {
  vi.resetModules()
  const mod = await import('../../src/main/services/model')
  return new mod.ModelService()
}

function seedTask(svc: any, destPath: string, totalBytes = 10): any {
  const task = {
    id: 't1',
    url: 'http://example.test/x.bin',
    destPath,
    fileName: 'x.bin',
    totalBytes,
    receivedBytes: 0,
    status: 'paused',
    startedAt: Date.now(),
    source: 'direct'
  }
  svc.downloads.set(task.id, task)
  return task
}

describe('ModelService resume integrity (0.1.18 P0-2)', () => {
  let root = ''
  let dest = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cp-resume-'))
    dest = join(root, 'x.bin')
    h.roots = [root]
    h.downloads = []
    h.fetchCalls = []
    h.handler = null
  })

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('appends a 206 only when Content-Range starts exactly at the local size', async () => {
    writeFileSync(dest, 'ABCD')
    h.handler = (url) => {
      if (url.endsWith('.sha256')) return new Response('nope', { status: 404 })
      return streamResponse(Buffer.from('EFGHIJ'), {
        status: 206,
        headers: {
          'content-range': 'bytes 4-9/10',
          'content-length': '6',
          etag: '"v1"'
        }
      })
    }
    const svc = await makeService()
    seedTask(svc, dest)
    const task = await svc.resumeDownload('t1')

    expect(task.status, task.error).toBe('done')
    expect(readFileSync(dest, 'utf-8')).toBe('ABCDEFGHIJ')
    expect(task.etag).toBe('"v1"')
    // The resume request must have carried the Range header.
    const main = h.fetchCalls.find((c) => c.url === 'http://example.test/x.bin')
    expect(main?.headers.Range).toBe('bytes=4-')
  })

  it('sends If-Range when the task remembered an ETag', async () => {
    writeFileSync(dest, 'ABCD')
    h.handler = (url) => {
      if (url.endsWith('.sha256')) return new Response('nope', { status: 404 })
      return streamResponse(Buffer.from('EFGHIJ'), {
        status: 206,
        headers: { 'content-range': 'bytes 4-9/10', 'content-length': '6' }
      })
    }
    const svc = await makeService()
    const task = seedTask(svc, dest)
    task.etag = '"v1"'
    await svc.resumeDownload('t1')
    const main = h.fetchCalls.find((c) => c.url === 'http://example.test/x.bin')
    expect(main?.headers['If-Range']).toBe('"v1"')
  })

  it('discards the partial and restarts cleanly when 206 starts at the wrong offset', async () => {
    writeFileSync(dest, 'ABCD')
    let call = 0
    h.handler = (url, headers) => {
      if (url.endsWith('.sha256')) return new Response('nope', { status: 404 })
      call += 1
      if (call === 1) {
        // A broken/misbehaving proxy: 206 that restarts at 0.
        return streamResponse(Buffer.from('ABCDEFGHIJ'), {
          status: 206,
          headers: { 'content-range': 'bytes 0-9/10', 'content-length': '10' }
        })
      }
      // The clean retry must NOT send a Range header.
      expect(headers.Range).toBeUndefined()
      return streamResponse(Buffer.from('ABCDEFGHIJ'), {
        status: 200,
        headers: { 'content-length': '10', etag: '"v2"' }
      })
    }
    const svc = await makeService()
    seedTask(svc, dest)
    const task = await svc.resumeDownload('t1')

    expect(task.status, task.error).toBe('done')
    expect(readFileSync(dest, 'utf-8')).toBe('ABCDEFGHIJ')
    expect(statSync(dest).size).toBe(10)
    expect(h.fetchCalls.filter((c) => c.url === 'http://example.test/x.bin')).toHaveLength(2)
  })

  it('discards the partial when the 206 omits Content-Range', async () => {
    writeFileSync(dest, 'ABCD')
    let call = 0
    h.handler = (url) => {
      if (url.endsWith('.sha256')) return new Response('nope', { status: 404 })
      call += 1
      if (call === 1) {
        return streamResponse(Buffer.from('XXXXXX'), {
          status: 206,
          headers: { 'content-length': '6' }
        })
      }
      return streamResponse(Buffer.from('ABCDEFGHIJ'), {
        status: 200,
        headers: { 'content-length': '10' }
      })
    }
    const svc = await makeService()
    seedTask(svc, dest)
    const task = await svc.resumeDownload('t1')
    expect(task.status, task.error).toBe('done')
    expect(readFileSync(dest, 'utf-8')).toBe('ABCDEFGHIJ')
  })

  it('restarts cleanly when the source file changed size between attempts', async () => {
    writeFileSync(dest, 'ABCD')
    let call = 0
    h.handler = (url) => {
      if (url.endsWith('.sha256')) return new Response('nope', { status: 404 })
      call += 1
      if (call === 1) {
        // Same start offset but a different total → different upstream file.
        return streamResponse(Buffer.from('EFGHIJ'), {
          status: 206,
          headers: { 'content-range': 'bytes 4-9/12', 'content-length': '6' }
        })
      }
      return streamResponse(Buffer.from('0123456789AB'), {
        status: 200,
        headers: { 'content-length': '12' }
      })
    }
    const svc = await makeService()
    seedTask(svc, dest)
    const task = await svc.resumeDownload('t1')
    expect(task.status, task.error).toBe('done')
    expect(readFileSync(dest, 'utf-8')).toBe('0123456789AB')
  })

  it('refuses a second active task writing the same destination', async () => {
    writeFileSync(dest, 'ABCD')
    h.handler = () =>
      // Never resolves; aborts when the controller fires (keeps t1 active
      // until the test cancels it, then lets the process exit).
      new Promise<Response>((_resolve, reject) => {
        h.abortReject = reject
      }) as unknown as Response
    const svc = await makeService()
    const first = seedTask(svc, dest)
    // Start t1 first so it owns the destination, then queue a second task
    // (different URL → different id, same file name).
    const running = svc.resumeDownload('t1').catch(() => undefined)
    await new Promise((r) => setTimeout(r, 10))
    svc.downloads.set('t2', {
      ...first,
      id: 't2',
      url: 'http://example.test/other.bin',
      status: 'paused'
    })
    await expect(svc.resumeDownload('t2')).rejects.toThrow(/already using/)

    // Cleanup: cancel the hanging first task so the process can exit.
    svc.cancelDownload('t1')
    await running
    // 0.2.5 WP9: the adopted partial is cleaned up on cancel and never left
    // behind as a final-looking model file.
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })
})

describe('Civitai download naming (0.2.5 WP9)', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cp-civitai-'))
    h.roots = [root]
    h.downloads = []
    h.fetchCalls = []
    h.handler = null
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('parses RFC 6266 filename and filename*', async () => {
    const { filenameFromContentDisposition } = await import('../../src/main/services/model')
    expect(filenameFromContentDisposition('attachment; filename="model.safetensors"')).toBe(
      'model.safetensors'
    )
    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8''civitai%20model.safetensors")
    ).toBe('civitai model.safetensors')
    expect(filenameFromContentDisposition('inline')).toBeUndefined()
  })

  it('uses Content-Disposition, writes a safe extension, then renames .part', async () => {
    h.handler = (url) => {
      if (url === 'https://civitai.com/api/download/models/123') {
        return streamResponse(Buffer.from('MODEL'), {
          status: 200,
          headers: {
            'content-length': '5',
            'content-disposition': 'attachment; filename="from-header.safetensors"'
          }
        })
      }
      if (url.includes('/api/v1/model-versions/123')) {
        return new Response(
          JSON.stringify({
            name: 'v1',
            baseModel: 'SDXL',
            trainedWords: ['trigger'],
            files: [{ name: 'from-api.safetensors', primary: true }],
            model: { id: 9, name: 'M' },
            images: [{ url: 'https://img/x.png' }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url.endsWith('.sha256')) return new Response('nope', { status: 404 })
      if (url.includes('from-header.safetensors')) {
        return streamResponse(Buffer.from('MODEL'), {
          status: 200,
          headers: { 'content-length': '5' }
        })
      }
      return new Response('missing', { status: 404 })
    }
    const svc = await makeService()
    const task = await svc.download({
      url: 'https://civitai.com/api/download/models/123',
      destDir: root
    })
    expect(task.fileName).toBe('from-header.safetensors')
    const deadline = Date.now() + 4000
    while (h.downloads[0]?.status !== 'done' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(h.downloads[0]?.status).toBe('done')
    expect(existsSync(join(root, 'from-header.safetensors'))).toBe(true)
    expect(existsSync(join(root, 'from-header.safetensors.part'))).toBe(false)
  })

  it('falls back to the API file name when HEAD has no Content-Disposition', async () => {
    h.handler = (url) => {
      if (url === 'https://civitai.com/api/download/models/456') {
        return new Response(null, { status: 200 })
      }
      if (url.includes('/api/v1/model-versions/456')) {
        return new Response(
          JSON.stringify({
            files: [{ name: 'api-name.safetensors', primary: true }],
            trainedWords: ['x'],
            model: { id: 1, name: 'M' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url.endsWith('.sha256')) return new Response('nope', { status: 404 })
      return streamResponse(Buffer.from('MODEL'), {
        status: 200,
        headers: { 'content-length': '5' }
      })
    }
    const svc = await makeService()
    const task = await svc.download({
      url: 'https://civitai.com/api/download/models/456',
      destDir: root
    })
    expect(task.fileName).toBe('api-name.safetensors')
    svc.cancelDownload(task.id)
    await new Promise((r) => setTimeout(r, 50))
  })
})
