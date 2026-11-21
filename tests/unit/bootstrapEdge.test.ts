/**
 * Bootstrap branches: runtime source/platform mapping, detection, legacy
 * cleanup, checksum policies, resumable download edge cases and tar safety.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  fetchImpl: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
  execImpl: null as null | ((cmd: string, args: string[]) => { stdout?: string; error?: Error }),
  unzipImpl: null as null | ((zip: string, dest: string) => Promise<void> | void),
  insideImpl: null as null | ((dest: string) => void)
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

vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const run = (cmd: string, args: string[]): { stdout?: string; error?: Error } =>
    h.execImpl ? h.execImpl(cmd, args) : { stdout: '' }
  const execFile = ((
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ): unknown => {
    const res = run(cmd, args)
    queueMicrotask(() => {
      if (res.error) cb(res.error, res.stdout || '', '')
      else cb(null, res.stdout || '', '')
    })
    return { pid: 1, exitCode: null, kill: () => undefined }
  }) as unknown as { (cmd: string, args: string[], opts: unknown, cb: unknown): unknown } & {
    [promisify.custom]: (
      cmd: string,
      args: string[],
      opts?: unknown
    ) => Promise<{
      stdout: string
      stderr: string
    }>
  }
  execFile[promisify.custom] = (cmd, args) =>
    new Promise((resolve, reject) => {
      const res = run(cmd, args)
      queueMicrotask(() => {
        if (res.error) reject(res.error)
        else resolve({ stdout: res.stdout || '', stderr: '' })
      })
    })
  return { execFile }
})

vi.mock('../../src/main/services/zipSafe', () => ({
  safeUnzip: async (zip: string, dest: string) => {
    if (h.unzipImpl) await h.unzipImpl(zip, dest)
  },
  assertExtractedInside: (dest: string) => h.insideImpl?.(dest)
}))

import { RUNTIME_SOURCES } from '../../src/shared/constants'

const realPlatform = process.platform
const realArch = process.arch
function stubPlatform(p: string, arch = process.arch): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
}

function sha(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status })
}

async function freshService(): Promise<any> {
  return (await import('../../src/main/services/bootstrap')).bootstrapService
}

function uvKey(): keyof typeof RUNTIME_SOURCES {
  if (process.platform === 'win32') return 'uv-win-x64'
  if (process.platform === 'darwin') return 'uv-darwin-arm64'
  return 'uv-linux-x64'
}

describe('bootstrap edge branches', () => {
  beforeEach(() => {
    if (h.root) rmSync(h.root, { recursive: true, force: true })
    h.root = mkdtempSync(join(tmpdir(), 'cp-boot-edge-'))
    h.fetchImpl = null
    h.execImpl = null
    h.unzipImpl = null
    h.insideImpl = null
    vi.resetModules()
  })

  afterEach(() => {
    stubPlatform(realPlatform, realArch)
    rmSync(h.root, { recursive: true, force: true })
  })

  it('maps runtime sources for every platform and rejects unsupported ones', async () => {
    const svc = await freshService()
    stubPlatform('win32', 'x64')
    expect(svc.runtimeSource('uv').url).toBe(RUNTIME_SOURCES['uv-win-x64'].url)
    expect(svc.runtimeSource('mingit').url).toBe(RUNTIME_SOURCES['mingit-win-x64'].url)
    stubPlatform('darwin', 'arm64')
    expect(svc.runtimeSource('uv').url).toBe(RUNTIME_SOURCES['uv-darwin-arm64'].url)
    expect(svc.runtimeSource('python').url).toBe(RUNTIME_SOURCES['python-darwin-arm64'].url)
    stubPlatform('darwin', 'x64')
    expect(svc.runtimeSource('uv').url).toBe(RUNTIME_SOURCES['uv-darwin-x64'].url)
    stubPlatform('linux', 'arm64')
    expect(svc.runtimeSource('uv').url).toBe(RUNTIME_SOURCES['uv-linux-arm64'].url)
    expect(svc.runtimeSource('python').url).toBe(RUNTIME_SOURCES['python-linux-arm64'].url)
    stubPlatform('linux', 'x64')
    expect(() => svc.runtimeSource('mingit')).toThrow(/No runtime source/)
    expect(() => svc.runtimeSource('aria2')).toThrow(/No runtime source/)
  })

  it('removes legacy runtimes and tolerates missing directories', async () => {
    const { deleteLegacyPythonRuntimes, runtimesDir } =
      await import('../../src/main/services/bootstrap')
    const root = join(runtimesDir(), 'legacy')
    expect(deleteLegacyPythonRuntimes()).toEqual({ removed: [], failed: [] })
    mkdirSync(join(root, 'python'), { recursive: true })
    writeFileSync(join(root, 'legacy.json'), '{}')
    writeFileSync(join(root, 'loose.txt'), 'x')
    const res = deleteLegacyPythonRuntimes()
    expect(res.removed.sort()).toEqual(['loose.txt', 'python'])
    expect(res.failed).toEqual([])
    expect(existsSync(join(root, 'legacy.json'))).toBe(false)
  })

  it('walks runtimes with depth limits and finds system or local binaries', async () => {
    const { findInRuntimes, runtimesDir, isSupportedPythonVersion } =
      await import('../../src/main/services/bootstrap')
    const root = runtimesDir()
    mkdirSync(join(root, 'uv-0.13.6', 'a', 'b', 'c', 'd'), { recursive: true })
    writeFileSync(join(root, 'uv-0.13.6', 'a', 'b', 'c', 'd', 'uv'), '')
    expect(findInRuntimes('uv')).toBeNull()

    mkdirSync(join(root, 'python-3.13.18', 'python', 'python3.12'), { recursive: true })
    writeFileSync(join(root, 'python-3.13.18', 'python', 'python3'), '')
    expect(findInRuntimes('python')).toContain('python-3.13.18')

    expect(isSupportedPythonVersion('Python 3.13.2')).toBe(true)
    expect(isSupportedPythonVersion('Python 3.12.9')).toBe(false)
    expect(isSupportedPythonVersion(undefined)).toBe(false)
  })

  it('probes local, system and legacy Windows Python installs', async () => {
    const svc = await freshService()
    const { runtimesDir } = await import('../../src/main/services/bootstrap')
    h.execImpl = (cmd, args) => {
      if (args.includes('--version')) {
        if (cmd.includes('uv')) return { stdout: 'uv 0.13.6' }
        if (cmd.includes('git')) return { stdout: 'git version 2.44' }
        return { stdout: 'Python 3.12.9' }
      }
      return { stdout: '' }
    }
    mkdirSync(join(runtimesDir(), 'uv-0.13.6'), { recursive: true })
    writeFileSync(
      join(runtimesDir(), 'uv-0.13.6', process.platform === 'win32' ? 'uv.exe' : 'uv'),
      ''
    )
    const uv = await svc.probeKind('uv')
    expect(uv).toMatchObject({ installed: true, origin: 'runtimes' })

    mkdirSync(join(runtimesDir(), 'python-3.13.18', 'python'), { recursive: true })
    writeFileSync(
      join(
        runtimesDir(),
        'python-3.13.18',
        'python',
        process.platform === 'win32' ? 'python.exe' : 'python3'
      ),
      ''
    )
    const unsupported = await svc.probeKind('python')
    expect(unsupported.installed).toBe(false)
    expect(unsupported.version).toContain('3.12')

    rmSync(join(runtimesDir(), 'python-3.13.18'), { recursive: true, force: true })
    h.execImpl = (cmd, args) => {
      if (cmd === 'which' && args[0] === 'python') return { stdout: '/usr/bin/python\n' }
      if (args.includes('--version')) {
        if (cmd.includes('uv')) return { stdout: 'uv 0.13.6' }
        return { stdout: 'Python 3.13.2' }
      }
      return { stdout: '' }
    }
    const supported = await svc.probeKind('python')
    expect(supported).toMatchObject({ installed: true, origin: 'system' })

    stubPlatform('win32', 'x64')
    vi.resetModules()
    const winSvc = await freshService()
    const localAppData = join(h.root, 'localappdata')
    process.env.LOCALAPPDATA = localAppData
    const py313 = join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe')
    mkdirSync(dirname(py313), { recursive: true })
    writeFileSync(py313, '')
    h.execImpl = (_cmd, args) =>
      args.includes('--version') ? { stdout: 'Python 3.13.4' } : { stdout: '' }
    expect(await winSvc.probeKind('python')).toMatchObject({ path: py313, installed: true })

    rmSync(join(localAppData, 'Programs', 'Python', 'Python313'), { recursive: true, force: true })
    const py312 = join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe')
    mkdirSync(dirname(py312), { recursive: true })
    writeFileSync(py312, '')
    h.execImpl = (_cmd, args) =>
      args.includes('--version') ? { stdout: 'Python 3.12.9' } : { stdout: '' }
    const legacy = await winSvc.probeKind('python')
    expect(legacy).toMatchObject({ installed: false, legacyVersion: 'Python 3.12.9' })
  })

  it('reports status components and honours downloadIfMissing=false', async () => {
    const svc = await freshService()
    h.execImpl = (cmd, args) => {
      if (args.includes('--version')) return { stdout: cmd.includes('git') ? 'git version' : '' }
      return { stdout: '' }
    }
    const status = await svc.ensure({ downloadIfMissing: false, kinds: [] })
    expect(status.components.map((c: any) => c.kind).sort()).toEqual(
      ['aria2', 'mingit', 'python', 'uv'].sort()
    )
    expect(status.zipInstallReady).toBe(true)
  })

  it('continues after a non-abort runtime failure and rethrows aborts', async () => {
    const svc = await freshService()
    const progress: any[] = []
    svc.on('progress', (p: any) => progress.push(p))
    svc.probeKind = async (kind: string) => ({
      kind,
      installed: false,
      path: '',
      origin: 'missing'
    })
    svc.download = async (kind: string) => {
      throw new Error(`download ${kind} failed`)
    }
    svc.status = async () => ({ components: [], pythonPath: '', pythonOrigin: 'missing' })
    await expect(svc.ensure({ kinds: ['uv', 'python'] })).resolves.toBeTruthy()
    expect(progress.some((p) => p.phase === 'error' && p.kind === 'uv')).toBe(true)

    svc.download = async () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    await expect(svc.ensure({ kinds: ['uv'] })).rejects.toThrow(/aborted/)
  })

  it('applies checksum policy: sidecars, SHA256SUMS, pins and explicit opt-in', async () => {
    const constants = await import('../../src/shared/constants')
    const db = await import('../../src/main/services/db')
    const key = uvKey() as keyof typeof constants.RUNTIME_SOURCES
    const src = constants.RUNTIME_SOURCES[key] as any
    const saved = { ...src }
    const payload = 'runtime-payload'
    const digest = sha(payload)
    const url = 'https://example.test/uv-runtime.zip'
    Object.assign(src, { url, sizeHint: payload.length, sha256: undefined })
    try {
      const svc = await freshService()
      svc.downloadFile = async (_u: string, dest: string) => writeFileSync(dest, payload)
      svc.extractArchive = async () => undefined
      svc.probeKind = async (kind: string) => ({
        kind,
        installed: true,
        path: '/x',
        origin: 'runtimes'
      })

      h.fetchImpl = async (u) => {
        if (u.endsWith('.sha256')) return new Response(`${digest}\n`, { status: 200 })
        return new Response('', { status: 404 })
      }
      await expect(svc.downloadInner('uv')).resolves.toBeTruthy()
      const store = JSON.parse(readFileSync(join(h.root, 'runtimes', 'checksums.json'), 'utf-8'))
      expect(store[url]).toBe(digest)

      rmSync(join(h.root, 'runtimes', 'checksums.json'), { force: true })
      h.fetchImpl = async (u) => {
        if (u.endsWith('.sha256')) return new Response('nope', { status: 404 })
        if (u.endsWith('.sha256sum')) return new Response(digest, { status: 200 })
        return new Response('', { status: 404 })
      }
      await expect(svc.downloadInner('uv')).resolves.toBeTruthy()

      h.fetchImpl = async (u) => {
        if (u.endsWith('/SHA256SUMS')) {
          return new Response(`other ${'f'.repeat(64)}\n${digest}  uv-runtime.zip\n`, {
            status: 200
          })
        }
        return new Response('', { status: 404 })
      }
      await expect(svc.downloadInner('uv')).resolves.toBeTruthy()

      rmSync(join(h.root, 'runtimes', 'checksums.json'), { force: true })
      h.fetchImpl = async () => new Response('no hashes here', { status: 200 })
      db.saveSettings({ ...db.loadSettings(), allowUnverifiedRuntime: false })
      await expect(svc.downloadInner('uv')).rejects.toThrow(/No published checksum/)
      db.saveSettings({ ...db.loadSettings(), allowUnverifiedRuntime: true })
      await expect(svc.downloadInner('uv')).resolves.toBeTruthy()

      writeFileSync(join(h.root, 'runtimes', 'checksums.json'), '{bad json')
      h.fetchImpl = async () => new Response('', { status: 404 })
      await expect(svc.downloadInner('uv')).resolves.toBeTruthy()

      writeFileSync(
        join(h.root, 'runtimes', 'checksums.json'),
        JSON.stringify({ [url]: 'f'.repeat(64) })
      )
      await expect(svc.downloadInner('uv')).rejects.toThrow(/checksum mismatch/)
    } finally {
      Object.assign(src, saved)
    }
  })

  it('checks the canonical sidecar when a GitHub mirror is configured', async () => {
    const constants = await import('../../src/shared/constants')
    const db = await import('../../src/main/services/db')
    const key = uvKey() as keyof typeof constants.RUNTIME_SOURCES
    const src = constants.RUNTIME_SOURCES[key] as any
    const saved = { ...src }
    const payload = 'mirror-payload'
    const canonical = 'https://github.com/test/uv.zip'
    Object.assign(src, { url: canonical, sizeHint: payload.length, sha256: undefined })
    db.saveSettings({ ...db.loadSettings(), githubEndpoint: 'https://mirror.test/' })
    const fetched: string[] = []
    try {
      const svc = await freshService()
      svc.downloadFile = async (_u: string, dest: string) => writeFileSync(dest, payload)
      svc.extractArchive = async () => undefined
      svc.probeKind = async (kind: string) => ({
        kind,
        installed: true,
        path: '/x',
        origin: 'runtimes'
      })
      h.fetchImpl = async (u) => {
        fetched.push(u)
        if (u === 'https://mirror.test/https://github.com/test/uv.zip.sha256') {
          return new Response('', { status: 404 })
        }
        if (u === `${canonical}.sha256`) return new Response(sha(payload), { status: 200 })
        return new Response('', { status: 404 })
      }
      await expect(svc.downloadInner('uv')).resolves.toBeTruthy()
      expect(fetched).toContain(`${canonical}.sha256`)
    } finally {
      Object.assign(src, saved)
      db.saveSettings({ ...db.loadSettings(), githubEndpoint: '' })
    }
  })

  it('handles 416 candidates, truncation, append and missing bodies', async () => {
    const svc = await freshService()
    const cache = join(h.root, 'runtimes', 'downloads')
    mkdirSync(cache, { recursive: true })
    const dest = join(cache, 'uv.zip')
    const part = `${dest}.part`

    writeFileSync(part, 'x')
    h.fetchImpl = async () => new Response('', { status: 416 })
    await expect(svc.downloadFile('https://x/uv.zip', dest, 'uv', 1000, undefined)).rejects.toThrow(
      /truncated/
    )
    expect(existsSync(part)).toBe(false)

    writeFileSync(join(h.root, 'runtimes', 'checksums.json'), JSON.stringify({}))
    writeFileSync(part, 'y'.repeat(1000))
    h.fetchImpl = async () => new Response('', { status: 416 })
    await svc.downloadFile('https://x/uv.zip', dest, 'uv', 1000, undefined)
    expect(statSync(dest).size).toBe(1000)

    rmSync(dest, { force: true })
    rmSync(part, { force: true })
    writeFileSync(dest, 'z'.repeat(1000))
    await svc.downloadFile('https://x/uv.zip', dest, 'uv', 1000, undefined)
    expect(statSync(dest).size).toBe(1000)

    rmSync(dest, { force: true })
    h.fetchImpl = async () =>
      new Response('abc', { status: 200, headers: { 'content-length': '10' } })
    await expect(svc.downloadFile('https://x/uv.zip', dest, 'uv', 10, undefined)).rejects.toThrow(
      /truncated/
    )

    writeFileSync(part, 'abc')
    h.fetchImpl = async () =>
      new Response('de', { status: 206, headers: { 'content-length': '2' } })
    await svc.downloadFile('https://x/uv.zip', dest, 'uv', 5, undefined)
    expect(readFileSync(dest, 'utf-8')).toBe('abcde')

    rmSync(dest, { force: true })
    rmSync(part, { force: true })
    h.fetchImpl = async () =>
      ({ ok: true, status: 200, headers: { get: () => null } }) as unknown as Response
    await expect(svc.downloadFile('https://x/uv.zip', dest, 'uv', 5, undefined)).rejects.toThrow(
      /empty body/
    )
  })

  it('aborts before fetching when the epoch changed', async () => {
    const svc = await freshService()
    const cache = join(h.root, 'runtimes', 'downloads')
    mkdirSync(cache, { recursive: true })
    svc.cancelEpoch = 2
    let aborted = false
    h.fetchImpl = async (_u, init) => {
      aborted = Boolean(init?.signal?.aborted)
      throw new DOMException('Aborted', 'AbortError')
    }
    await expect(
      svc.downloadFile('https://x/uv.zip', join(cache, 'uv.zip'), 'uv', 5, 1)
    ).rejects.toThrow(/Abort/)
    expect(aborted).toBe(true)
  })

  it('validates tar listings and extracts archives safely', async () => {
    const svc = await freshService()
    const dest = join(h.root, 'extract')
    mkdirSync(dest, { recursive: true })
    let inside = false
    h.insideImpl = () => {
      inside = true
    }
    h.execImpl = (_cmd, args) => {
      if (args[0] === '-tzf') return { stdout: 'uv/bin/uv\n\nuv/README\n' }
      return { stdout: '' }
    }
    await svc.extractArchive('/tmp/uv.tar.gz', dest)
    expect(inside).toBe(true)

    h.execImpl = (_cmd, args) => {
      if (args[0] === '-tzf') return { stdout: '/etc/passwd\n' }
      return { stdout: '' }
    }
    await expect(svc.extractArchive('/tmp/uv2.tar.gz', dest)).rejects.toThrow(/Unsafe path/)
    h.execImpl = (_cmd, args) => (args[0] === '-tzf' ? { stdout: 'C:/evil\n' } : { stdout: '' })
    await expect(svc.extractArchive('/tmp/uv.tar.gz', dest)).rejects.toThrow(/Unsafe path/)
    h.execImpl = (_cmd, args) => (args[0] === '-tzf' ? { stdout: '../evil\n' } : { stdout: '' })
    await expect(svc.extractArchive('/tmp/uv.tar.gz', dest)).rejects.toThrow(/Unsafe path/)

    let unzipped = false
    h.unzipImpl = () => {
      unzipped = true
    }
    await svc.extractArchive('/tmp/uv.zip', dest)
    expect(unzipped).toBe(true)
  })

  it('cleans runtime directories only inside the runtimes root', async () => {
    const svc = await freshService()
    const { runtimesDir } = await import('../../src/main/services/bootstrap')
    const uvDir = join(runtimesDir(), 'uv-0.13.6')
    mkdirSync(uvDir, { recursive: true })
    writeFileSync(join(uvDir, 'uv'), '')
    svc.cleanupRuntime('uv')
    expect(existsSync(uvDir)).toBe(false)
    svc.cleanupRuntime('python')
  })

  it('deduplicates concurrent downloads of the same runtime', async () => {
    const svc = await freshService()
    let calls = 0
    svc.downloadInner = async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 20))
      return { kind: 'uv', installed: true, path: '/x', origin: 'runtimes' }
    }
    const [a, b] = await Promise.all([svc.download('uv'), svc.download('uv')])
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })
})
