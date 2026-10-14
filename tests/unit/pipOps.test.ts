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
  nodeOpStatus: null as null | string
}))

vi.mock('../../src/main/services/nodePack', () => ({
  nodePackService: {
    getOpProgress: () =>
      h.nodeOpStatus ? { status: h.nodeOpStatus, runId: 'r1', instanceId: 'i1' } : null,
    installDeps: vi.fn()
  }
}))

vi.mock('../../src/main/services/env', () => ({
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
}))

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
