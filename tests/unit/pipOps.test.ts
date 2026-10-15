/**
 * PipOpsService (0.1.12) — spec validation, uv-first installs, busy guard,
 * cancellation, mirror retry, recipe steps and wheel hash verification.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import type { PipRecipe } from '../../src/shared/pipRecipes'

/* eslint-disable @typescript-eslint/no-explicit-any */

const CFG = {
  id: 'i1',
  name: 'Inst',
  path: 'C:/comfy',
  venvPath: 'C:/comfy/.venv',
  listen: '127.0.0.1',
  port: 8188,
  pythonPath: '',
  extraArgs: [],
  argTemplateId: 'default',
  enabled: true,
  notes: '',
  autoStart: false,
  frontendVersion: '',
  pinned: false
}

const h = vi.hoisted(() => ({
  execCalls: [] as Array<{ cmd: string; args: string[] }>,
  runImpl: null as null | ((cmd: string, args: string[], opts: any) => Promise<string> | string),
  showImpl: null as null | ((cmd: string, args: string[]) => string | Error),
  fetchImpl: null as null | (() => any),
  reqCalls: [] as string[],
  uvInstalled: true,
  settings: { pipIndex: '' },
  nodeOpStatus: null as null | string,
  nodeActive: false
}))

vi.mock('../../src/main/services/nodePack', () => ({
  nodePackService: {
    getOpProgress: () =>
      h.nodeOpStatus ? { status: h.nodeOpStatus, runId: 'r1', instanceId: 'i1' } : null,
    // Independent activity evidence (armed controller / batch): drives the
    // OP_BUSY lock even when no progress snapshot exists (0.1.13).
    isOpActive: () => h.nodeActive,
    installDeps: vi.fn()
  }
}))

vi.mock('../../src/main/services/env', async (importOriginal) => {
  // Keep the REAL outputIndicatesFailure — the happy-path assertions must
  // exercise the actual success/failure classification (0.1.13).
  const actual = await importOriginal<typeof import('../../src/main/services/env')>()
  return {
    outputIndicatesFailure: actual.outputIndicatesFailure,
    runStreaming: vi.fn(async (cmd: string, args: string[], opts: any) => {
      h.execCalls.push({ cmd, args })
      if (h.runImpl) return await h.runImpl(cmd, args, opts)
      return 'Successfully installed pkg'
    }),
    throwingExec: vi.fn(async (cmd: string, args: string[]) => {
      h.execCalls.push({ cmd, args })
      if (h.showImpl) {
        const r = h.showImpl(cmd, args)
        if (r instanceof Error) throw r
        return r
      }
      return 'Name: pkg\nVersion: 1.0'
    }),
    ensurePip: vi.fn(async () => undefined),
    installRequirements: vi.fn(async (_py: string, reqFile: string) => {
      h.reqCalls.push(reqFile)
    })
  }
})

vi.mock('../../src/main/services/bootstrap', () => ({
  bootstrapService: {
    ensure: vi.fn(async () => ({
      components: h.uvInstalled
        ? [{ kind: 'uv', installed: true, path: 'C:/uv/uv.exe' }]
        : [{ kind: 'uv', installed: false, path: '' }]
    }))
  }
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => [CFG],
  loadSettings: () => ({ pipIndex: h.settings.pipIndex })
}))

vi.mock('../../src/main/services/instance', () => ({
  resolveInstancePythonPath: () => 'C:/comfy/.venv/Scripts/python.exe'
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyFetch: vi.fn(async () => {
    if (!h.fetchImpl) throw new Error('no fetch impl')
    return h.fetchImpl()
  })
}))

describe('PipOpsService (0.1.12)', () => {
  beforeEach(() => {
    vi.resetModules()
    h.execCalls = []
    h.runImpl = null
    h.showImpl = null
    h.fetchImpl = null
    h.reqCalls = []
    h.uvInstalled = true
    h.settings.pipIndex = ''
    h.nodeOpStatus = null
    h.nodeActive = false
  })

  async function fresh(): Promise<any> {
    return (await import('../../src/main/services/pipOps')).pipOpsService
  }

  it('rejects invalid package specs before any command runs', async () => {
    const svc = await fresh()
    await expect(svc.installSpec('i1', 'https://evil.example/x.whl')).rejects.toMatchObject({
      code: 'INVALID_SPEC'
    })
    await expect(svc.installSpec('i1', 'pkg; rm -rf /')).rejects.toMatchObject({
      code: 'INVALID_SPEC'
    })
    expect(h.execCalls).toHaveLength(0)
  })

  it('installs via uv first (uv pip install --python …) and verifies with pip show', async () => {
    const svc = await fresh()
    const r = await svc.installSpec('i1', 'onnx')
    expect(r.ok).toBe(true)
    expect(r.installed).toEqual(['onnx'])
    const installCall = h.execCalls.find((c) => c.cmd === 'C:/uv/uv.exe')
    expect(installCall).toBeTruthy()
    expect(installCall!.args.slice(0, 3)).toEqual(['pip', 'install', '--python'])
    expect(installCall!.args).toContain('onnx')
    // verify used `uv pip show`
    expect(h.execCalls.some((c) => c.cmd === 'C:/uv/uv.exe' && c.args[1] === 'show')).toBe(true)
  })

  it('falls back to python -m pip when uv is unavailable (with ensurePip)', async () => {
    h.uvInstalled = false
    const svc = await fresh()
    const r = await svc.installSpec('i1', 'onnx')
    expect(r.ok).toBe(true)
    const installCall = h.execCalls.find((c) => c.cmd === 'C:/comfy/.venv/Scripts/python.exe')
    expect(installCall).toBeTruthy()
    expect(installCall!.args.slice(0, 3)).toEqual(['-m', 'pip', 'install'])
    const { ensurePip } = (await import('../../src/main/services/env')) as any
    expect(ensurePip).toHaveBeenCalled()
  })

  it('retries against official PyPI when the configured mirror fails', async () => {
    h.settings.pipIndex = 'https://mirror.example/simple'
    let calls = 0
    h.runImpl = async (_cmd, _args) => {
      calls += 1
      if (calls === 1) throw new Error('mirror broken')
      return 'Successfully installed pkg'
    }
    const svc = await fresh()
    const r = await svc.installSpec('i1', 'onnx')
    expect(r.ok).toBe(true)
    const uvCalls = h.execCalls.filter((c) => c.cmd === 'C:/uv/uv.exe' && c.args[1] === 'install')
    expect(uvCalls).toHaveLength(2)
    expect(uvCalls[0].args).toContain('--index-url')
    expect(uvCalls[0].args).toContain('https://mirror.example/simple')
    expect(uvCalls[1].args).toContain('https://pypi.org/simple')
  })

  it('busy guard: a second op is rejected with OP_BUSY; cancelling frees the slot', async () => {
    // First op hangs until aborted — the abort must surface as cancelled.
    // Mirrors the REAL runStreaming contract: a signal aborted before the run
    // starts is rejected immediately (the real code checks signal.aborted).
    h.runImpl = (_cmd, _args, opts) =>
      new Promise<string>((_resolve, reject) => {
        const fail = (): void => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        }
        if (opts.signal?.aborted) {
          fail()
          return
        }
        opts.signal?.addEventListener('abort', fail)
      })
    const svc = await fresh()
    const p1 = svc.installSpec('i1', 'onnx')
    await expect(svc.installSpec('i1', 'triton-windows')).rejects.toMatchObject({
      code: 'OP_BUSY'
    })
    expect(svc.busy('i1')).toBe(true)
    expect(svc.cancel('i1')).toBe(true)
    const r1 = await p1
    expect(r1.ok).toBe(false)
    expect(r1.cancelled).toBe(true)
    expect(svc.busy('i1')).toBe(false)

    // Slot released — a fresh op succeeds.
    h.runImpl = null
    const r2 = await svc.installSpec('i1', 'onnx')
    expect(r2.ok).toBe(true)
  })

  it('cancel returns false when nothing is running', async () => {
    const svc = await fresh()
    expect(svc.cancel('i1')).toBe(false)
  })

  it('walks preflight→requirements→verify→done at 100% with unused steps closed (0.1.13)', async () => {
    const svc = await fresh()
    const events: any[] = []
    svc.on('progress', (p: any) => events.push(p))
    const r = await svc.installSpec('i1', 'onnx')
    expect(r.ok).toBe(true)
    const last = events[events.length - 1]
    expect(last.status).toBe('done')
    expect(last.percent).toBe(100)
    const byId = Object.fromEntries(last.steps.map((s: any) => [s.id, s.status]))
    expect(byId.preflight).toBe('done')
    // A spec install has no wheel download — the step must be closed, not
    // left pending forever (the old 60% + spinning-step bug).
    expect(byId.download).toBe('skipped')
    expect(byId.requirements).toBe('done')
    expect(byId.verify).toBe('done')
    expect(byId.done).toBe('done')
  })

  it('keeps the finished progress snapshot for status hydration (0.1.13)', async () => {
    const svc = await fresh()
    await svc.installSpec('i1', 'onnx')
    // The op has settled — busy is false, but the snapshot still answers.
    expect(svc.busy('i1')).toBe(false)
    const snap = svc.getProgress('i1')
    expect(snap?.status).toBe('done')
    expect(snap?.percent).toBe(100)
    // A new op supersedes the snapshot when it starts.
    let release: (() => void) | null = null
    h.runImpl = () =>
      new Promise<string>((resolve) => {
        release = () => resolve('Successfully installed pkg')
      })
    const p = svc.installSpec('i1', 'pkg2')
    await vi.waitFor(() => expect(svc.busy('i1')).toBe(true))
    expect(svc.getProgress('i1')?.runId).not.toBe(snap?.runId)
    await vi.waitFor(() => expect(typeof release).toBe('function'))
    ;(release as unknown as () => void)()
    await p
  })

  it('advances the bar during the requirements phase (line heuristic, 0.1.13)', async () => {
    const svc = await fresh()
    const events: any[] = []
    svc.on('progress', (p: any) => events.push(p))
    h.runImpl = async (_cmd, _args, opts) => {
      for (let i = 0; i < 10; i++) opts?.onLine?.(`Collecting dep-${i}`)
      opts?.onLine?.('Installing collected packages: a, b')
      return 'Successfully installed a b'
    }
    await svc.installSpec('i1', 'a')
    // preflight done + download skipped settle the bar at 40%; the running
    // requirements fraction must push intermediate frames above it.
    const mid = events.filter((e) => e.status === 'running' && e.percent > 40)
    expect(mid.length).toBeGreaterThan(0)
  })

  it('records a failed status + error on the snapshot (0.1.13)', async () => {
    const svc = await fresh()
    h.runImpl = () => {
      throw new Error('boom: no matching distribution')
    }
    const r = await svc.installSpec('i1', 'pkg')
    expect(r.ok).toBe(false)
    const snap = svc.getProgress('i1')
    expect(snap?.status).toBe('failed')
    expect(String(snap?.error)).toContain('boom')
    const byId = Object.fromEntries((snap?.steps || []).map((s: any) => [s.id, s.status]))
    expect(byId.preflight).toBe('done')
    expect(byId.download).toBe('skipped')
  })

  it('marks cancellation on the snapshot (0.1.13)', async () => {
    h.runImpl = (_cmd, _args, opts) =>
      new Promise<string>((_resolve, reject) => {
        const fail = (): void => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        }
        if (opts.signal?.aborted) {
          fail()
          return
        }
        opts.signal?.addEventListener('abort', fail)
      })
    const svc = await fresh()
    const p = svc.installSpec('i1', 'onnx')
    await vi.waitFor(() => expect(svc.busy('i1')).toBe(true))
    expect(svc.cancel('i1')).toBe(true)
    const r = await p
    expect(r.cancelled).toBe(true)
    expect(svc.getProgress('i1')?.status).toBe('cancelled')
  })

  it('installRequirementsFor finishes at 100% with download skipped (0.1.13)', async () => {
    const svc = await fresh()
    const r = await svc.installRequirementsFor(
      'i1',
      'C:/comfy/custom_nodes/x/requirements.txt',
      'x'
    )
    expect(r.ok).toBe(true)
    expect(h.reqCalls).toContain('C:/comfy/custom_nodes/x/requirements.txt')
    const snap = svc.getProgress('i1')
    expect(snap?.status).toBe('done')
    expect(snap?.percent).toBe(100)
    const byId = Object.fromEntries((snap?.steps || []).map((s: any) => [s.id, s.status]))
    expect(byId.download).toBe('skipped')
    expect(byId.preflight).toBe('done')
  })

  it('rejects while a node-pack operation is running (cross-guard, 0.1.12)', async () => {
    h.nodeOpStatus = 'running'
    const svc = await fresh()
    await expect(svc.installSpec('i1', 'onnx')).rejects.toMatchObject({ code: 'OP_BUSY' })
    expect(h.execCalls).toHaveLength(0)

    // Once the node op settles, installs proceed again.
    h.nodeOpStatus = null
    const r = await svc.installSpec('i1', 'onnx')
    expect(r.ok).toBe(true)
  })

  it('rejects on INDEPENDENT activity evidence even without a progress snapshot (0.1.13)', async () => {
    // An armed controller/batch blocks installs even if the snapshot is gone
    // (the 0.1.13 guard's new isOpActive arm).
    h.nodeActive = true
    h.nodeOpStatus = null
    const svc = await fresh()
    await expect(svc.installSpec('i1', 'onnx')).rejects.toMatchObject({ code: 'OP_BUSY' })
    expect(h.execCalls).toHaveLength(0)

    // Activity cleared → the stale-free guard lets installs through.
    h.nodeActive = false
    const r = await svc.installSpec('i1', 'onnx')
    expect(r.ok).toBe(true)
  })

  it('applies the triton recipe as a single pip step', async () => {
    const svc = await fresh()
    const r = await svc.installRecipe('i1', 'triton')
    expect(r.ok).toBe(true)
    const installCall = h.execCalls.find((c) => c.cmd === 'C:/uv/uv.exe' && c.args[1] === 'install')
    expect(installCall!.args).toContain('triton-windows')
  })

  it('rejects recipes whose platform was not verified here', async () => {
    const svc = await fresh()
    if (process.platform === 'win32') return // sageattention is valid on Windows
    await expect(svc.installRecipe('i1', 'sageattention')).rejects.toMatchObject({
      code: 'RECIPE_PLATFORM'
    })
  })

  it('rejects unknown recipes', async () => {
    const svc = await fresh()
    await expect(svc.installRecipe('i1', 'nope')).rejects.toMatchObject({
      code: 'RECIPE_NOT_FOUND'
    })
  })

  it('downloads recipe wheels through the proxy, verifies sha256, installs the local file', async () => {
    const bytes = Buffer.from('fake-wheel-bytes-123')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const recipe: PipRecipe = {
      id: 'test-wheel-recipe',
      titleKey: 'deps.recipe.onnx.title',
      descKey: 'deps.recipe.onnx.desc',
      matchModules: [],
      steps: [
        {
          kind: 'wheel',
          url: 'https://example.com/testpkg-1.0-py3-none-any.whl',
          sha256: sha,
          sizeBytes: bytes.length
        }
      ],
      sourceUrl: 'https://example.com',
      experimental: true
    }
    // Same module registry as the freshly imported pipOps (vi.resetModules).
    const { PIP_RECIPES } = await import('../../src/shared/pipRecipes')
    PIP_RECIPES.push(recipe)
    try {
      h.fetchImpl = () => ({
        ok: true,
        status: 200,
        headers: {
          get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null)
        },
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      })
      // Wheel filename → package name `testpkg` for verification.
      h.showImpl = (_cmd, args) =>
        args.includes('testpkg') ? 'Name: testpkg\nVersion: 1.0' : new Error('no')
      const svc = await fresh()
      const r = await svc.installRecipe('i1', 'test-wheel-recipe')
      expect(r.ok).toBe(true)
      const installCall = h.execCalls.find(
        (c) => c.cmd === 'C:/uv/uv.exe' && c.args[1] === 'install'
      )
      expect(installCall).toBeTruthy()
      expect(installCall!.args.some((a) => a.endsWith('.whl'))).toBe(true)
    } finally {
      PIP_RECIPES.splice(PIP_RECIPES.indexOf(recipe), 1)
    }
  })

  it('rejects a wheel whose hash does not match — and never installs it', async () => {
    const bytes = Buffer.from('tampered')
    const recipe: PipRecipe = {
      id: 'test-bad-wheel',
      titleKey: 'deps.recipe.onnx.title',
      descKey: 'deps.recipe.onnx.desc',
      matchModules: [],
      steps: [
        {
          kind: 'wheel',
          url: 'https://example.com/evil-1.0-py3-none-any.whl',
          sha256: 'a'.repeat(64),
          sizeBytes: bytes.length
        }
      ],
      sourceUrl: 'https://example.com',
      experimental: true
    }
    const { PIP_RECIPES } = await import('../../src/shared/pipRecipes')
    PIP_RECIPES.push(recipe)
    try {
      h.fetchImpl = () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      })
      const svc = await fresh()
      const r = await svc.installRecipe('i1', 'test-bad-wheel')
      expect(r.ok).toBe(false)
      expect(String(r.error)).toContain('sha256 mismatch')
      expect(
        h.execCalls.filter((c) => c.cmd === 'C:/uv/uv.exe' && c.args[1] === 'install')
      ).toHaveLength(0)
    } finally {
      PIP_RECIPES.splice(PIP_RECIPES.indexOf(recipe), 1)
    }
  })

  it('rejects wheel size mismatch before hashing', async () => {
    const bytes = Buffer.from('abc')
    const recipe: PipRecipe = {
      id: 'test-size-wheel',
      titleKey: 'deps.recipe.onnx.title',
      descKey: 'deps.recipe.onnx.desc',
      matchModules: [],
      steps: [
        {
          kind: 'wheel',
          url: 'https://example.com/size-1.0-py3-none-any.whl',
          sha256: 'b'.repeat(64),
          sizeBytes: 999
        }
      ],
      sourceUrl: 'https://example.com',
      experimental: true
    }
    const { PIP_RECIPES } = await import('../../src/shared/pipRecipes')
    PIP_RECIPES.push(recipe)
    try {
      h.fetchImpl = () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      })
      const svc = await fresh()
      const r = await svc.installRecipe('i1', 'test-size-wheel')
      expect(r.ok).toBe(false)
      expect(String(r.error)).toContain('size mismatch')
    } finally {
      PIP_RECIPES.splice(PIP_RECIPES.indexOf(recipe), 1)
    }
  })

  it("installRequirementsFor runs installRequirements for the pack's file", async () => {
    const svc = await fresh()
    const r = await svc.installRequirementsFor(
      'i1',
      'C:/comfy/custom_nodes/Foo/requirements.txt',
      'Foo'
    )
    expect(r.ok).toBe(true)
    expect(h.reqCalls).toEqual(['C:/comfy/custom_nodes/Foo/requirements.txt'])
  })

  it('parses package names from wheel filenames (URL and path forms)', async () => {
    const { wheelPackageName } = await import('../../src/main/services/pipOps')
    expect(
      wheelPackageName(
        'https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0/sageattention-2.2.0+cu130torch2.9.0andhigher.post4-cp39-abi3-win_amd64.whl'
      )
    ).toBe('sageattention')
    expect(wheelPackageName('C:\\tmp\\Flash_Attn-2.6.0-cp312.whl')).toBe('flash-attn')
    expect(wheelPackageName('')).toBe('')
  })
})
