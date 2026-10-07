/**
 * InstallerService internals: GPU detect, preflight matrix, suggest root,
 * starter models, mirror helpers, zip flatten, kill/cancel, pipArgs.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  graphicsImpl: async (): Promise<{ controllers: Array<Record<string, unknown>> }> => ({ controllers: [] }),
  execImpl: null as
    | null
    | ((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, out: string, errOut: string) => void) => unknown),
  getPathImpl: (): string => join(tmpdir(), 'cp-inst-svc'),
  fetchImpl: async (): Promise<Response> => new Response('zip-bytes', { status: 200 }),
  unzipImpl: async (): Promise<void> => undefined
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.getPathImpl() },
  session: {
    defaultSession: {
      fetch: (...args: unknown[]) => (h.fetchImpl as (...a: unknown[]) => Promise<Response>)(...args),
      setProxy: async () => undefined
    }
  }
}))

vi.mock('systeminformation', () => ({
  default: { graphics: () => h.graphicsImpl() }
}))

vi.mock('child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: unknown,
    cb: (err: Error | null, out: string, errOut: string) => void
  ) => {
    if (h.execImpl) return h.execImpl(cmd, args, opts, cb)
    queueMicrotask(() => cb(null, 'ok', ''))
    return { pid: 1, exitCode: null, kill: () => undefined }
  },
  spawn: () => ({ pid: 2, exitCode: null, kill: () => undefined })
}))

vi.mock('../../src/main/services/zipSafe', () => ({
  safeUnzip: (...args: unknown[]) => (h.unzipImpl as (...a: unknown[]) => Promise<void>)(...args)
}))

const realPlatform = process.platform
function stubPlatform(p: NodeJS.Platform | string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

const ROOT = join(tmpdir(), 'cp-inst-svc')

describe('installer service internals', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  beforeEach(() => {
    h.execImpl = null
    h.graphicsImpl = async () => ({ controllers: [] })
    h.getPathImpl = () => ROOT
    mkdirSync(ROOT, { recursive: true })
  })

  afterEach(() => {
    stubPlatform(realPlatform)
  })

  // ---------- applyGithubMirror ----------

  describe('applyGithubMirror', () => {
    it('returns raw when empty / no endpoint / non-github', async () => {
      const { applyGithubMirror } = await import('../../src/main/services/installer')
      const { saveSettings } = await import('../../src/main/services/db')
      saveSettings({ githubEndpoint: '' })
      expect(applyGithubMirror('')).toBe('')
      expect(applyGithubMirror('https://github.com/a/b')).toBe('https://github.com/a/b')

      saveSettings({ githubEndpoint: 'https://ghproxy.example/' })
      expect(applyGithubMirror('https://gitlab.com/a/b')).toBe('https://gitlab.com/a/b')
      expect(applyGithubMirror('not-a-url')).toBe('not-a-url')
    })

    it('prefixes github.com / git@github / ghcr.io URLs and strips trailing slash', async () => {
      const { applyGithubMirror } = await import('../../src/main/services/installer')
      const { saveSettings } = await import('../../src/main/services/db')
      saveSettings({ githubEndpoint: 'https://ghproxy.example///' })
      expect(applyGithubMirror('https://github.com/a/b.git')).toBe(
        'https://ghproxy.example/https://github.com/a/b.git'
      )
      expect(applyGithubMirror('git@github.com:a/b.git')).toContain('ghproxy.example')
      expect(applyGithubMirror('https://ghcr.io/v2/x')).toContain('ghproxy.example')
    })

    it('tolerates loadSettings throwing', async () => {
      const prev = h.getPathImpl
      h.getPathImpl = () => {
        throw new Error('no userData')
      }
      try {
        const { applyGithubMirror } = await import('../../src/main/services/installer')
        expect(applyGithubMirror('https://github.com/a/b')).toBe('https://github.com/a/b')
      } finally {
        h.getPathImpl = prev
      }
    })
  })

  // ---------- resolveTorchIndex mirrors ----------

  describe('resolveTorchIndex mirror shapes', () => {
    it('official-style mirror keeps /whl/<channel> suffix', async () => {
      const { resolveTorchIndex } = await import('../../src/main/services/installer')
      const { saveSettings } = await import('../../src/main/services/db')
      saveSettings({ torchIndexMirror: 'https://mirror.example/pytorch.org' })
      expect(resolveTorchIndex('cu126')).toContain('/whl/cu126')

      saveSettings({ torchIndexMirror: 'https://mirror.example/whl/' })
      expect(resolveTorchIndex('cpu')).toContain('/whl/cpu')

      saveSettings({ torchIndexMirror: 'https://mirror.example/whl/whl/' })
      expect(resolveTorchIndex('cpu')).not.toContain('/whl/whl/')

      saveSettings({ torchIndexMirror: '' })
    })

    it('unknown channel falls back to cpu index', async () => {
      const { resolveTorchIndex } = await import('../../src/main/services/installer')
      const { saveSettings } = await import('../../src/main/services/db')
      saveSettings({ torchIndexMirror: '' })
      const idx = resolveTorchIndex('nope' as never)
      expect(idx).toContain('/whl/cpu')
    })
  })

  it('listStarterModels returns the shared table', async () => {
    const { listStarterModels, STARTER_MODELS } = await import('../../src/main/services/installer')
    expect(listStarterModels()).toBe(STARTER_MODELS)
    expect(listStarterModels().length).toBeGreaterThan(0)
  })

  // ---------- detectGpu ----------

  describe('detectGpu', () => {
    it('nvidia old card → cu126, RTX 30/40 → cu130', async () => {
      h.graphicsImpl = async () => ({
        controllers: [
          { vendor: 'NVIDIA', model: 'GeForce GTX 1060' },
          { vendor: 'NVIDIA', model: 'RTX 4090' }
        ]
      })
      const { installerService } = await import('../../src/main/services/installer')
      const gpus = await installerService.detectGpu()
      expect(gpus[0].recommendedTorch).toBe('cu126')
      expect(gpus[1].recommendedTorch).toBe('cu130')
    })

    it('model-only regex matches geforce/gtx/quadro/tesla', async () => {
      h.graphicsImpl = async () => ({
        controllers: [{ vendor: 'other', model: 'Quadro P4000' }, { vendor: '', model: '' }]
      })
      const { installerService } = await import('../../src/main/services/installer')
      const gpus = await installerService.detectGpu()
      expect(gpus[0].recommendedTorch).toBe('cu126')
      expect(gpus[1].model).toBe('Unknown GPU')
    })

    it('AMD linux → rocm, AMD windows → cpu', async () => {
      stubPlatform('linux')
      h.graphicsImpl = async () => ({ controllers: [{ vendor: 'AMD', model: 'Radeon RX 6800' }] })
      let { installerService } = await import('../../src/main/services/installer')
      let gpus = await installerService.detectGpu()
      expect(gpus[0].recommendedTorch).toBe('rocm')

      stubPlatform('win32')
      vi.resetModules()
      h.graphicsImpl = async () => ({ controllers: [{ vendor: 'AMD', model: 'Radeon RX 6800' }] })
      ;({ installerService } = await import('../../src/main/services/installer'))
      gpus = await installerService.detectGpu()
      expect(gpus[0].recommendedTorch).toBe('cpu')
    })

    it('Intel win/linux → xpu, other platform → cpu', async () => {
      stubPlatform('win32')
      h.graphicsImpl = async () => ({ controllers: [{ vendor: 'Intel', model: 'Arc A770' }] })
      let { installerService } = await import('../../src/main/services/installer')
      let gpus = await installerService.detectGpu()
      expect(gpus[0].recommendedTorch).toBe('xpu')

      stubPlatform('darwin')
      vi.resetModules()
      h.graphicsImpl = async () => ({ controllers: [{ vendor: 'Intel', model: 'Iris Xe' }] })
      ;({ installerService } = await import('../../src/main/services/installer'))
      gpus = await installerService.detectGpu()
      expect(gpus[0].recommendedTorch).toBe('cpu')
    })

    it('unknown vendor on darwin → mps; empty controllers → none/cpu', async () => {
      stubPlatform('darwin')
      h.graphicsImpl = async () => ({ controllers: [{ vendor: 'Weird', model: 'Weird GPU' }] })
      let { installerService } = await import('../../src/main/services/installer')
      let gpus = await installerService.detectGpu()
      expect(gpus[0].recommendedTorch).toBe('mps')

      h.graphicsImpl = async () => ({ controllers: [] })
      gpus = await installerService.detectGpu()
      expect(gpus[0].vendor).toBe('none')
      expect(gpus[0].recommendedTorch).toBe('mps')

      stubPlatform('win32')
      gpus = await installerService.detectGpu()
      expect(gpus[0].recommendedTorch).toBe('cpu')
    })

    it('graphics() throw → detection failed (cpu)', async () => {
      h.graphicsImpl = async () => {
        throw new Error('probe fail')
      }
      const { installerService } = await import('../../src/main/services/installer')
      const gpus = await installerService.detectGpu()
      expect(gpus[0].model).toBe('GPU detection failed')
      expect(gpus[0].recommendedTorch).toBe('cpu')
    })
  })

  // ---------- preflight ----------

  describe('preflight matrix', () => {
    it('root ok, disk ok, git ok, python 3.12 ok', async () => {
      h.execImpl = (cmd, args, _o, cb) => {
        if (args[0] === '--version') {
          if (String(cmd).includes('git')) queueMicrotask(() => cb(null, 'git version 2.44.0', ''))
          else queueMicrotask(() => cb(null, 'Python 3.12.1', ''))
        }
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      const { installerService } = await import('../../src/main/services/installer')
      const root = join(ROOT, 'preflight-ok')
      mkdirSync(root, { recursive: true })
      const res = await installerService.preflight({ installRoot: root, useUv: true, pythonPath: 'python' })
      expect(res.ok).toBe(true)
      const byId = Object.fromEntries(res.checks.map((c) => [c.id, c]))
      expect(byId.root.ok).toBe(true)
      expect(byId.disk.ok).toBe(true)
      expect(byId.git.ok).toBe(true)
      expect(byId.python.ok).toBe(true)
      expect(byId.python.fixId).toBeUndefined()
      expect(byId.uv.ok).toBe(true)
    })

    it('empty / parent-hop root is not ok', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const res = await installerService.preflight({ installRoot: '', useUv: false })
      expect(res.checks.find((c) => c.id === 'root')?.ok).toBe(false)

      const res2 = await installerService.preflight({
        installRoot: join(ROOT, 'a', '..', 'b'),
        useUv: false
      })
      // `a/../b` is collapsed by join() — no raw hop remains
      expect(res2.checks.find((c) => c.id === 'root')?.ok).toBe(true)

      const res3 = await installerService.preflight({
        installRoot: ROOT + '/../escape',
        useUv: false
      })
      expect(res3.checks.find((c) => c.id === 'root')?.ok).toBe(false)
    })

    it('disk probe on missing parent → will-create branch', async () => {
      h.execImpl = (_c, _a, _o, cb) => {
        queueMicrotask(() => cb(null, 'Python 3.11.0', ''))
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      const { installerService } = await import('../../src/main/services/installer')
      const res = await installerService.preflight({
        installRoot: join(ROOT, 'no-such-parent-zzz', 'child'),
        useUv: false
      })
      expect(res.checks.find((c) => c.id === 'disk')?.detail).toContain('will be created')
    })

    it('git missing → soft fail with mingit fixId; uv missing → fixId', async () => {
      h.execImpl = (cmd, args, _o, cb) => {
        if (String(cmd).includes('git') || cmd === 'uv') {
          queueMicrotask(() => cb(new Error('ENOENT'), '', 'not found'))
        } else {
          queueMicrotask(() => cb(null, 'Python 3.12.0', ''))
        }
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      const { installerService } = await import('../../src/main/services/installer')
      const root = join(ROOT, 'preflight-fix')
      mkdirSync(root, { recursive: true })
      const res = await installerService.preflight({ installRoot: root, useUv: true, pythonPath: 'python' })
      expect(res.ok).toBe(true) // fixables are not hard fails
      const git = res.checks.find((c) => c.id === 'git')
      expect(git?.fixId).toBe('bootstrap-mingit')
      const uv = res.checks.find((c) => c.id === 'uv')
      expect(uv?.ok).toBe(false)
      expect(uv?.fixId).toBe('bootstrap-uv')
    })

    it('python 3.9 is too old (fixId); missing interpreter → fixId; unparseable → fixId', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const root = join(ROOT, 'preflight-py')
      mkdirSync(root, { recursive: true })

      h.execImpl = (_c, args, _o, cb) => {
        if (args[0] === '--version') queueMicrotask(() => cb(null, 'Python 3.9.13', ''))
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      let res = await installerService.preflight({ installRoot: root, useUv: false, pythonPath: 'python' })
      const py = res.checks.find((c) => c.id === 'python')
      expect(py?.ok).toBe(false)
      expect(py?.fixId).toBe('bootstrap-python')

      h.execImpl = (_c, _a, _o, cb) => {
        queueMicrotask(() => cb(new Error('ENOENT'), '', ''))
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      res = await installerService.preflight({ installRoot: root, useUv: false, pythonPath: 'missing-py' })
      const py2 = res.checks.find((c) => c.id === 'python')
      expect(py2?.ok).toBe(false)
      expect(py2?.detail).toContain('missing-py')

      h.execImpl = (_c, _a, _o, cb) => {
        queueMicrotask(() => cb(null, 'Jython 2.7', ''))
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      res = await installerService.preflight({ installRoot: root, useUv: false, pythonPath: 'python' })
      const py3 = res.checks.find((c) => c.id === 'python')
      expect(py3?.ok).toBe(false)
      expect(py3?.fixId).toBe('bootstrap-python')
    })

    it('empty python stdout falls back to interpreter name in detail', async () => {
      h.execImpl = (_c, _a, _o, cb) => {
        queueMicrotask(() => cb(null, '   ', ''))
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      const { installerService } = await import('../../src/main/services/installer')
      const root = join(ROOT, 'preflight-empty')
      mkdirSync(root, { recursive: true })
      const res = await installerService.preflight({ installRoot: root, useUv: false, pythonPath: 'python' })
      expect(res.checks.find((c) => c.id === 'python')?.detail).toBe('python')
    })

    it('useUv false skips uv check entirely', async () => {
      h.execImpl = (_c, args, _o, cb) => {
        queueMicrotask(() => cb(null, args[0] === '--version' ? 'Python 3.12.0' : 'git', ''))
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      const { installerService } = await import('../../src/main/services/installer')
      const root = join(ROOT, 'preflight-nouv')
      mkdirSync(root, { recursive: true })
      const res = await installerService.preflight({ installRoot: root, useUv: false, pythonPath: 'python' })
      expect(res.checks.find((c) => c.id === 'uv')).toBeUndefined()
    })
  })

  // ---------- suggestInstallRoot ----------

  describe('suggestInstallRoot', () => {
    it('returns a path with free space (or fallback)', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const res = await installerService.suggestInstallRoot()
      expect(typeof res.path).toBe('string')
      expect(res.path.length).toBeGreaterThan(0)
      expect(res.freeGb).toBeGreaterThanOrEqual(0)
    })
  })

  // ---------- pipArgs / setStep / cancel / killTree ----------

  describe('pipArgs mirrors', () => {
    it('appends -i and trusted-host for valid mirror; ignores malformed', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const { saveSettings } = await import('../../src/main/services/db')
      const anySvc = installerService as unknown as {
        pipArgs: (b: string[]) => string[]
        progress: unknown
        setStep: (id: string, s: string, d?: string, l?: string) => void
        log: (id: string, line: string) => void
        setBytes: (b?: unknown) => void
        killTree: (c: unknown) => Promise<void>
      }

      saveSettings({ pipIndex: '' })
      expect(anySvc.pipArgs(['-m', 'pip'])).toEqual(['-m', 'pip'])

      saveSettings({ pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple' })
      const args = anySvc.pipArgs(['-m', 'pip', 'install'])
      expect(args).toContain('-i')
      expect(args).toContain('https://pypi.tuna.tsinghua.edu.cn/simple')
      expect(args).toContain('--trusted-host')
      expect(args).toContain('pypi.tuna.tsinghua.edu.cn')

      saveSettings({ pipIndex: '::::not-a-url' })
      expect(anySvc.pipArgs(['x'])).toEqual(['x'])
      saveSettings({ pipIndex: '' })
    })

    it('setStep / log / setBytes no-op without progress; mutate with progress', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const anySvc = installerService as unknown as {
        progress: {
          steps: Array<{ id: string; status: string; detail: string; log: string[] }>
          step: string
          percent: number
          message: string
          bytes?: unknown
        } | null
        setStep: (id: string, s: string, d?: string, l?: string) => void
        log: (id: string, line: string) => void
        setBytes: (b?: unknown) => void
        emitProgress: (m?: string) => void
      }
      anySvc.progress = null
      anySvc.setStep('python', 'done')
      anySvc.log('python', 'x')
      anySvc.setBytes(undefined)
      anySvc.emitProgress('noop')

      anySvc.progress = {
        steps: [
          { id: 'python', status: 'pending', detail: '', log: [] },
          { id: 'done', status: 'done', detail: '', log: [] }
        ],
        step: 'bootstrap',
        percent: 0,
        message: ''
      }
      anySvc.setStep('python', 'done', 'detail', 'logline')
      expect(anySvc.progress.steps[0].status).toBe('done')
      expect(anySvc.progress.steps[0].log).toContain('logline')
      anySvc.setStep('missing', 'done') // unknown step ignored
      anySvc.log('python', 'extra')
      expect(anySvc.progress.steps[0].log).toContain('extra')
      anySvc.log('missing', 'orphan')
      anySvc.setBytes({ receivedBytes: 1, totalBytes: 2, speedBps: 0, label: 'L' })
      expect(anySvc.progress.bytes).toBeTruthy()
      anySvc.setBytes(undefined)
      expect(anySvc.progress.bytes).toBeUndefined()
    })

    it('getStatus exposes progress; cancel kills children and rejects runners', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      expect(installerService.getStatus()).toBeTruthy() // leftover from other tests or null
      const anySvc = installerService as unknown as {
        children: Set<unknown>
        runRejects: Set<(e: Error) => void>
        cancelled: boolean
        killTree: (c: unknown) => Promise<void>
      }
      let rejected: Error | null = null
      anySvc.runRejects.add((e) => {
        rejected = e
      })
      anySvc.runRejects.add(() => {
        throw new Error('bad reject handler')
      })
      const fakeChild = { pid: 999999, exitCode: null, kill: () => undefined }
      anySvc.children.add(fakeChild)
      const ok = installerService.cancel()
      expect(ok).toBe(true)
      expect(anySvc.cancelled).toBe(true)
      expect((rejected as unknown as Error).message).toMatch(/cancelled/i)
      expect(anySvc.runRejects.size).toBe(0)
    })
  })

  // ---------- flattenArchiveRoot / fetchComfyZip / installStarter ----------

  describe('flattenArchiveRoot', () => {
    it('flattens single nested GitHub archive dir with main.py', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const anySvc = installerService as unknown as {
        flattenArchiveRoot: (d: string) => Promise<void>
      }
      const dir = join(ROOT, 'flat1')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(join(dir, 'ComfyUI-master', 'comfy'), { recursive: true })
      writeFileSync(join(dir, 'ComfyUI-master', 'main.py'), 'print(1)')
      writeFileSync(join(dir, 'ComfyUI-master', 'comfy', 'x.py'), '')
      await anySvc.flattenArchiveRoot(dir)
      expect(existsSync(join(dir, 'main.py'))).toBe(true)
      expect(existsSync(join(dir, 'comfy', 'x.py'))).toBe(true)
      expect(existsSync(join(dir, 'ComfyUI-master'))).toBe(false)
    })

    it('leaves multi-entry dirs and non-main.py nests alone; early-returns when main.py exists', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const anySvc = installerService as unknown as {
        flattenArchiveRoot: (d: string) => Promise<void>
      }
      const dirA = join(ROOT, 'flat-a')
      rmSync(dirA, { recursive: true, force: true })
      mkdirSync(dirA, { recursive: true })
      writeFileSync(join(dirA, 'main.py'), '')
      await anySvc.flattenArchiveRoot(dirA) // early return

      const dirB = join(ROOT, 'flat-b')
      rmSync(dirB, { recursive: true, force: true })
      mkdirSync(join(dirB, 'one'), { recursive: true })
      mkdirSync(join(dirB, 'two'), { recursive: true })
      writeFileSync(join(dirB, 'one', 'main.py'), '')
      await anySvc.flattenArchiveRoot(dirB) // two entries — no flatten
      expect(existsSync(join(dirB, 'one', 'main.py'))).toBe(true)

      const dirC = join(ROOT, 'flat-c')
      rmSync(dirC, { recursive: true, force: true })
      mkdirSync(join(dirC, 'nest'), { recursive: true })
      writeFileSync(join(dirC, 'nest', 'other.py'), '')
      await anySvc.flattenArchiveRoot(dirC) // nest has no main.py
      expect(existsSync(join(dirC, 'nest', 'other.py'))).toBe(true)
    })

    it('swallows errors from unreadable dirs', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const anySvc = installerService as unknown as {
        flattenArchiveRoot: (d: string) => Promise<void>
      }
      await expect(anySvc.flattenArchiveRoot(join(ROOT, 'does-not-exist-flat'))).resolves.toBeUndefined()
    })
  })

  describe('fetchComfyZip', () => {
    it('downloads via session.fetch, unzips, flattens, sets bytes', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const anySvc = installerService as unknown as {
        fetchComfyZip: (d: string) => Promise<void>
        progress: { bytes?: unknown } | null
      }
      anySvc.progress = {
        steps: [],
        step: 'comfyui',
        status: 'running',
        message: '',
        percent: 0
      }
      const comfyDir = join(ROOT, 'zip-fetch', 'ComfyUI')
      mkdirSync(join(ROOT, 'zip-fetch'), { recursive: true })
      h.fetchImpl = async () =>
        new Response(Buffer.from('PK'), {
          status: 200,
          headers: { 'content-length': '2' }
        })
      h.unzipImpl = async (_zip: string, dest: string) => {
        mkdirSync(join(dest, 'ComfyUI-master'), { recursive: true })
        writeFileSync(join(dest, 'ComfyUI-master', 'main.py'), '')
      }
      await anySvc.fetchComfyZip(comfyDir)
      expect(existsSync(join(comfyDir, 'main.py'))).toBe(true)
    })

    it('throws on non-ok HTTP', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const anySvc = installerService as unknown as { fetchComfyZip: (d: string) => Promise<void> }
      h.fetchImpl = async () => new Response('nope', { status: 404 })
      await expect(anySvc.fetchComfyZip(join(ROOT, 'zip-fail', 'ComfyUI'))).rejects.toThrow(/HTTP 404/)
    })
  })

  describe('installStarter', () => {
    it('rejects unknown starter id', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      await expect(installerService.installStarter({ id: 'nope' })).rejects.toThrow(/Unknown starter/)
    })

    it('rejects when no instance registered / instance id not found', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const { loadInstanceConfigs, saveSettings } = await import('../../src/main/services/db')
      void saveSettings
      // ensure empty instance list by writing nothing — instances.jsonc may exist from other tests
      const cfgs = loadInstanceConfigs()
      if (cfgs.length === 0) {
        await expect(
          installerService.installStarter({ id: 'sd15-v1-5-pruned-emaonly' })
        ).rejects.toThrow(/No instance registered/)
      }
      await expect(
        installerService.installStarter({ id: 'sd15-v1-5-pruned-emaonly', instanceId: 'missing-id' })
      ).rejects.toThrow(/not found/)
    })

    it('downloads starter into instance models dir when instance exists', async () => {
      const { installerService } = await import('../../src/main/services/installer')
      const { upsertInstanceConfig } = await import('../../src/main/services/db')
      const instPath = join(ROOT, 'starter-inst')
      upsertInstanceConfig({
        id: 'starter-test-inst',
        name: 'S',
        path: instPath,
        pythonPath: '',
        venvPath: join(instPath, '.venv'),
        port: 8199,
        listen: '127.0.0.1',
        extraArgs: [],
        argTemplateId: 'default',
        enabled: true,
        notes: '',
        autoStart: false,
        frontendVersion: '',
        pinned: false
      })
      const modelMod = await import('../../src/main/services/model')
      const spy = vi.spyOn(modelMod.modelService, 'download').mockResolvedValue({ ok: true } as never)
      const res = await installerService.installStarter({
        id: 'sd15-v1-5-pruned-emaonly',
        instanceId: 'starter-test-inst'
      })
      expect(res).toEqual({ ok: true })
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })
  })
})
