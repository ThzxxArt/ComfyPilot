/**
 * NodePackService.depsAudit (0.1.12 WP5) — requirements.txt vs installed list.
 * Real temp filesystem; db/instance/bootstrap/proxy/child_process mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  root: '',
  uvInstalled: true,
  execHandler: null as ((cmd: string, args: string[]) => { stdout: string } | Error) | null
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => [
    {
      id: 'i1',
      name: 'Inst',
      path: h.root,
      venvPath: join(h.root, '.venv'),
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
  ],
  loadSettings: () => ({
    allowGitUrlInstall: true,
    allowPipInstall: true,
    securityLevel: 'normal',
    networkMode: 'public',
    pipIndex: '',
    proxy: {
      enabled: false,
      protocol: 'http',
      host: '',
      port: 7890,
      bypass: '',
      username: '',
      password: ''
    }
  }),
  listNodePacks: () => [],
  listSnapshots: () => [],
  insertSnapshot: () => undefined,
  deleteSnapshot: () => undefined,
  getSnapshot: () => null,
  deleteNodePack: () => undefined,
  upsertNodePack: () => undefined,
  snapshotDir: () => h.root
}))

vi.mock('../../src/main/services/instance', () => ({
  instanceService: { getLogs: () => [] },
  resolveInstancePythonPath: () => 'C:/comfy/.venv/Scripts/python.exe',
  resolveRuntimesPythonSync: () => null
}))

vi.mock('../../src/main/services/bootstrap', () => ({
  findInRuntimes: () => null,
  bootstrapService: {
    ensure: vi.fn(async () => ({
      components: h.uvInstalled
        ? [{ kind: 'uv', installed: true, path: 'C:/uv/uv.exe' }]
        : [{ kind: 'uv', installed: false, path: '' }]
    }))
  }
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyEnv: () => ({})
}))

vi.mock('../../src/main/services/installer', () => ({
  assertSafeGitUrl: () => undefined,
  applyGithubMirror: (u: string) => u,
  assertSafeBranch: () => undefined
}))

const pipMock = vi.hoisted(() => ({
  installRequirementsFor: null as null | ((...args: unknown[]) => Promise<unknown>)
}))

vi.mock('../../src/main/services/pipOps', () => ({
  pipOpsService: {
    installRequirementsFor: (...args: unknown[]) =>
      pipMock.installRequirementsFor
        ? pipMock.installRequirementsFor(...args)
        : Promise.resolve({ ok: true, instanceId: 'i1', requested: [], installed: [] })
  },
  isPipOpActive: () => false
}))

vi.mock('child_process', () => {
  const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')
  const runHandler = (cmd: string, args: string[]): { stdout: string } | Error => {
    try {
      return h.execHandler ? h.execHandler(cmd, args) : { stdout: '' }
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }
  const execFile: any = (cmd: string, args: string[], _opts?: unknown, cb?: unknown) => {
    const result = runHandler(cmd, args)
    const done = typeof cb === 'function' ? (cb as (...a: unknown[]) => void) : null
    queueMicrotask(() => {
      if (!done) return
      if (result instanceof Error) done(result, '', '')
      else done(null, result.stdout, '')
    })
    return { pid: 1 }
  }
  execFile[PROMISIFY_CUSTOM] = (cmd: string, args: string[]) =>
    new Promise((resolve, reject) => {
      const result = runHandler(cmd, args)
      queueMicrotask(() => {
        if (result instanceof Error) reject(result)
        else resolve({ stdout: result.stdout, stderr: '' })
      })
    })
  return {
    execFile,
    execFileSync: () => '',
    spawn: () => ({ pid: 1, kill: () => undefined })
  }
})

function seedPack(folder: string, requirements: string): void {
  const dir = join(h.root, 'custom_nodes', folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '__init__.py'), '')
  writeFileSync(join(dir, 'requirements.txt'), requirements)
}

describe('NodePackService.depsAudit (0.1.12)', () => {
  beforeEach(() => {
    h.root = mkdtempSync(join(tmpdir(), 'cp-deps-'))
    mkdirSync(join(h.root, 'custom_nodes'), { recursive: true })
    h.uvInstalled = true
    h.execHandler = () => ({ stdout: '[]' })
  })

  async function fresh(): Promise<any> {
    vi.resetModules()
    return (await import('../../src/main/services/nodePack')).nodePackService
  }

  it('flags missing and satisfied declared dependencies', async () => {
    seedPack('Foo', 'onnx>=1.10\nflash-attn==2.6.0\n')
    h.execHandler = (_cmd, args) => {
      if (args[0] === 'pip' && args[1] === 'list') {
        return { stdout: JSON.stringify([{ name: 'onnx', version: '1.17.0' }]) }
      }
      return { stdout: '' }
    }
    const svc = await fresh()
    const audit = await svc.depsAudit('i1')
    expect(audit.ok).toBe(true)
    expect(audit.pipAvailable).toBe(true)
    expect(audit.checkedPacks).toBe(1)
    expect(audit.packs).toHaveLength(1)
    expect(audit.packs[0].missing).toEqual(['flash-attn==2.6.0'])
    expect(audit.packs[0].mismatched).toEqual([])
  })

  it('flags version mismatches with installed version detail', async () => {
    seedPack('Foo', 'onnx>=1.10\n')
    h.execHandler = (_cmd, args) => {
      if (args[0] === 'pip' && args[1] === 'list') {
        return { stdout: JSON.stringify([{ name: 'onnx', version: '1.9.0' }]) }
      }
      return { stdout: '' }
    }
    const svc = await fresh()
    const audit = await svc.depsAudit('i1')
    expect(audit.packs).toHaveLength(1)
    expect(audit.packs[0].missing).toEqual([])
    expect(audit.packs[0].mismatched).toEqual([
      { name: 'onnx', required: '>=1.10', installed: '1.9.0' }
    ])
  })

  it('returns ok:false + pipAvailable:false when no package manager works', async () => {
    seedPack('Foo', 'onnx\n')
    h.uvInstalled = false
    h.execHandler = () => new Error('boom')
    const svc = await fresh()
    const audit = await svc.depsAudit('i1')
    expect(audit.ok).toBe(false)
    expect(audit.pipAvailable).toBe(false)
    expect(String(audit.error)).toContain('package manager')
  })

  it('reports checkedPacks 0 when nothing declares requirements', async () => {
    const dir = join(h.root, 'custom_nodes', 'Bare')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '__init__.py'), '')
    const svc = await fresh()
    const audit = await svc.depsAudit('i1')
    expect(audit.ok).toBe(true)
    expect(audit.checkedPacks).toBe(0)
    expect(audit.packs).toEqual([])
  })

  it('falls back to python -m pip list when uv misses --format json', async () => {
    seedPack('Foo', 'onnx\n')
    h.execHandler = (cmd, args) => {
      if (cmd === 'C:/uv/uv.exe' && args[0] === 'pip' && args[1] === 'list') {
        return new Error('unexpected argument --format')
      }
      if (args[0] === '-m' && args[1] === 'pip' && args[2] === 'list') {
        return { stdout: JSON.stringify([{ name: 'onnx', version: '1.17.0' }]) }
      }
      return { stdout: '' }
    }
    const svc = await fresh()
    const audit = await svc.depsAudit('i1')
    expect(audit.ok).toBe(true)
    expect(audit.packs).toEqual([])
  })
})

describe('NodePackService.installDeps (0.1.13)', () => {
  beforeEach(() => {
    h.root = mkdtempSync(join(tmpdir(), 'cp-deps-'))
    mkdirSync(join(h.root, 'custom_nodes'), { recursive: true })
    h.uvInstalled = true
    h.execHandler = () => ({ stdout: '[]' })
    pipMock.installRequirementsFor = null
  })

  async function fresh(): Promise<any> {
    vi.resetModules()
    return (await import('../../src/main/services/nodePack')).nodePackService
  }

  it('delegates to the pip-op service with the pack requirements file (0.1.13)', async () => {
    seedPack('Foo', 'onnx>=1.10\n')
    let called: unknown[] | null = null
    pipMock.installRequirementsFor = async (...args) => {
      called = args
      return { ok: true, instanceId: 'i1', requested: [], installed: [] }
    }
    const svc = await fresh()
    const r = await svc.installDeps('Foo', 'i1')
    expect(r.ok).toBe(true)
    expect(called).toBeTruthy()
    const args = (called || []) as unknown[]
    const [instanceId, reqFile, label] = args
    expect(instanceId).toBe('i1')
    expect(String(reqFile)).toContain(join('custom_nodes', 'Foo', 'requirements.txt'))
    expect(label).toBe('Foo')
  })

  it('rejects unknown packs and packs without requirements.txt (0.1.13)', async () => {
    const dir = join(h.root, 'custom_nodes', 'Bar')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '__init__.py'), '')
    const svc = await fresh()
    await expect(svc.installDeps('Nope', 'i1')).rejects.toMatchObject({ code: 'PACK_NOT_FOUND' })
    await expect(svc.installDeps('Bar', 'i1')).rejects.toMatchObject({ code: 'NO_REQUIREMENTS' })
  })

  it('surfaces a failed pip-op result as-is (no swallowing, 0.1.13)', async () => {
    seedPack('Foo', 'onnx\n')
    pipMock.installRequirementsFor = async () => ({
      ok: false,
      instanceId: 'i1',
      requested: [],
      installed: [],
      error: 'requirements install failed: boom'
    })
    const svc = await fresh()
    const r = await svc.installDeps('Foo', 'i1')
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('boom')
  })
})
