/**
 * DoctorService behaviour (0.1.10): the whole checkup matrix + every fix.
 * Real filesystem via tmpdir; only db/model/instance/proxy/child_process mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => {
  const state = {
    root: '',
    instances: [] as Array<Record<string, unknown>>,
    settings: { networkMode: 'public', modelScanRoots: [] as string[] },
    execHandler: null as ((cmd: string, args: string[]) => { stdout: string } | Error) | null,
    proxyOk: true
  }
  return { state }
})

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => h.state.instances,
  loadSettings: () => h.state.settings
}))

vi.mock('../../src/main/services/model', () => ({
  parseExtraModelPaths: () => []
}))

vi.mock('../../src/main/services/instance', () => ({
  resolveInstancePythonPath: () => 'python'
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyFetch: async () => new Response('', { status: h.state.proxyOk ? 200 : 500 }),
  // env.ts (loaded by the ensure-pip fix) uses proxyEnv when spawning pip.
  proxyEnv: () => ({})
}))

vi.mock('child_process', () => {
  const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')
  const runHandler = (cmd: string, args: string[]): { stdout: string } | Error => {
    try {
      return h.state.execHandler ? h.state.execHandler(cmd, args) : { stdout: '' }
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
  // promisify resolves the callback's FIRST value only when util.promisify.custom
  // is absent — with a multi-value callback it yields an ARRAY, which silently
  // turned every `const { stdout } = await execFileAsync(...)` into undefined.
  // Register the custom form so the promise resolves {stdout, stderr} directly.
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

function defaultExec(cmd: string, args: string[]): { stdout: string } | Error {
  if (args[0] === '--version') {
    if (cmd === 'git') return { stdout: 'git version 2.47.1' }
    return { stdout: 'Python 3.13.0' }
  }
  if (args[0] === '-c' && String(args[1]).includes('torch')) {
    return { stdout: '2.9.0+cu130 13.0 True' }
  }
  if (args[0] === '-m' && args[1] === 'pip') {
    // 0.1.12: the doctor probes `pip --version` separately from `pip list`.
    if (args[2] === '--version')
      return { stdout: 'pip 24.0 from C:/venv/Lib/site-packages/pip (python 3.13)' }
    return { stdout: '[]' }
  }
  return { stdout: '' }
}

async function freshDoctor(): Promise<any> {
  vi.resetModules()
  return (await import('../../src/main/services/doctor')).doctorService
}

function seedMinimalInstall(name: string): string {
  const dir = join(h.state.root, name)
  mkdirSync(join(dir, 'models'), { recursive: true })
  mkdirSync(join(dir, 'custom_nodes'), { recursive: true })
  writeFileSync(join(dir, 'main.py'), 'x')
  writeFileSync(join(dir, 'requirements.txt'), 'torch\n')
  h.state.instances = [
    {
      id: 'inst-1',
      name: 'Inst',
      path: dir,
      port: 59999,
      listen: '127.0.0.1',
      extraArgs: [],
      venvPath: ''
    }
  ]
  return dir
}

describe('DoctorService (0.1.10 behaviour)', () => {
  beforeEach(() => {
    h.state.root = mkdtempSync(join(tmpdir(), 'cp-doctor-'))
    h.state.execHandler = defaultExec
    h.state.proxyOk = true
  })

  it('run() produces the full check matrix on a healthy install', async () => {
    seedMinimalInstall('healthy')
    const svc = await freshDoctor()
    const report = await svc.run('inst-1')
    const byId = new Map<string, { severity: string; detail: string }>(
      report.checks.map((c: any) => [c.id, c] as [string, { severity: string; detail: string }])
    )
    expect(byId.get('install-path')?.severity).toBe('pass')
    expect(byId.get('python')?.severity).toBe('pass')
    expect(byId.get('pip')?.severity).toBe('pass')
    expect(byId.get('torch')?.severity).toBe('pass')
    expect(byId.get('models-dir')?.severity).toBe('pass')
    expect(byId.get('custom-nodes')?.severity).toBe('pass')
    expect(byId.get('requirements')?.severity).toBe('pass')
    expect(byId.get('port')?.severity).toBeDefined()
    expect(byId.get('registry')?.severity).toBe('pass')
    expect(report.summary.pass).toBeGreaterThan(5)
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('emits honest progress events — checked count, no fabricated total (0.1.15)', async () => {
    seedMinimalInstall('progress')
    const svc = await freshDoctor()
    const events: Array<Record<string, unknown>> = []
    svc.on('progress', (p: Record<string, unknown>) => events.push(p))
    await svc.run('inst-1')
    expect(events.length).toBeGreaterThanOrEqual(3)
    // The conditional check set makes a percentage a lie — never claim one.
    expect(events.every((e) => !('total' in e))).toBe(true)
    expect(events.every((e) => typeof e.title === 'string' && e.title)).toBe(true)
    const dones = events.map((e) => Number(e.done) || 0)
    for (let i = 1; i < dones.length; i++) {
      expect(dones[i]).toBeGreaterThanOrEqual(dones[i - 1])
    }
  })

  it('run() checks the --disable-metadata flag (0.1.14)', async () => {
    seedMinimalInstall('metadata-default')
    let svc = await freshDoctor()
    let report = await svc.run('inst-1')
    let check = report.checks.find((c: any) => c.id === 'metadata')!
    expect(check.severity).toBe('pass')
    expect(check.detail).toContain('enabled')

    seedMinimalInstall('metadata-disabled')
    ;(h.state.instances[0] as { extraArgs: string[] }).extraArgs = ['--disable-metadata']
    svc = await freshDoctor()
    report = await svc.run('inst-1')
    check = report.checks.find((c: any) => c.id === 'metadata')!
    expect(check.severity).toBe('warn')
    expect(check.detail).toContain('--disable-metadata')
    expect(check.suggestion).toContain('attributed')
  })

  it('run() reports CPU-only torch as warn with a driver suggestion', async () => {
    seedMinimalInstall('cpu-torch')
    h.state.execHandler = (cmd, args) => {
      if (args[0] === '-c' && String(args[1]).includes('torch')) {
        return { stdout: '2.9.0+cpu none False' }
      }
      return defaultExec(cmd, args)
    }
    const svc = await freshDoctor()
    const report = await svc.run('inst-1')
    const torch = report.checks.find((c: any) => c.id === 'torch')!
    expect(torch.severity).toBe('warn')
    expect(torch.detail).toContain('cuda none')
  })

  it('run() fails install-path/python when the directory is broken', async () => {
    h.state.instances = [
      {
        id: 'inst-bad',
        name: 'Bad',
        path: join(h.state.root, 'missing'),
        port: 59998,
        listen: '127.0.0.1',
        extraArgs: []
      }
    ]
    h.state.execHandler = (cmd, args) => {
      if (args[0] === '--version') return new Error('python: command not found')
      return defaultExec(cmd, args)
    }
    const svc = await freshDoctor()
    const report = await svc.run('inst-bad')
    const byId = new Map<string, { severity: string }>(
      report.checks.map((c: any) => [c.id, c] as [string, { severity: string }])
    )
    expect(byId.get('install-path')?.severity).toBe('fail')
    expect(byId.get('python')?.severity).toBe('fail')
    expect(report.summary.fail).toBeGreaterThan(0)
  })

  it('run() rejects unknown instance ids loudly', async () => {
    const svc = await freshDoctor()
    await expect(svc.run('nope')).rejects.toThrow(/Instance not found/)
  })

  it('run() marks registry unreachable as warn (public mode)', async () => {
    seedMinimalInstall('no-registry')
    h.state.proxyOk = false
    const svc = await freshDoctor()
    const report = await svc.run('inst-1')
    const reg = report.checks.find((c: any) => c.id === 'registry')!
    expect(reg.severity).toBe('warn')
  })

  it('fix create-models-dir builds the standard tree', async () => {
    const dir = seedMinimalInstall('fix-models')
    rmSync(join(dir, 'models'), { recursive: true, force: true })
    const svc = await freshDoctor()
    const res = await svc.fix('inst-1', 'create-models-dir')
    expect(res.ok).toBe(true)
    for (const sub of ['checkpoints', 'loras', 'vae', 'diffusion_models']) {
      expect(existsSync(join(dir, 'models', sub))).toBe(true)
    }
  })

  it('fix create-custom-nodes creates the folder', async () => {
    const dir = seedMinimalInstall('fix-cn')
    rmSync(join(dir, 'custom_nodes'), { recursive: true, force: true })
    const svc = await freshDoctor()
    const res = await svc.fix('inst-1', 'create-custom-nodes')
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, 'custom_nodes'))).toBe(true)
  })

  it('fix unpin-torch rewrites exact torch pins in custom node requirements', async () => {
    const dir = seedMinimalInstall('fix-unpin')
    const pack = join(dir, 'custom_nodes', 'PinPack')
    mkdirSync(pack, { recursive: true })
    writeFileSync(join(pack, 'requirements.txt'), 'torch==2.1.0\ntorchvision>=0.16\n')
    const svc = await freshDoctor()
    const res = await svc.fix('inst-1', 'unpin-torch')
    expect(res.ok).toBe(true)
    const text = readFileSync(join(pack, 'requirements.txt'), 'utf-8')
    expect(text).toContain('torch>=2.0')
    expect(text).not.toContain('torch==2.1.0')
    expect(text).toContain('torchvision>=0.16')
  })

  it('fix write-extra-model-paths writes the full 0.1.10 template once', async () => {
    const dir = seedMinimalInstall('fix-yaml')
    const svc = await freshDoctor()
    const res = await svc.fix('inst-1', 'write-extra-model-paths')
    expect(res.ok).toBe(true)
    const yaml = readFileSync(join(dir, 'extra_model_paths.yaml'), 'utf-8')
    for (const key of [
      'checkpoints',
      'loras',
      'vae',
      'text_encoders',
      'diffusion_models',
      'controlnet',
      'detection'
    ]) {
      expect(yaml).toContain(`${key}:`)
    }
    expect(yaml).toContain('is_default: true')
    expect(yaml).toContain('models/clip')
    // Second call must not overwrite.
    const again = await svc.fix('inst-1', 'write-extra-model-paths')
    expect(again.message).toContain('already exists')
  })

  it('fix unknown ids fail cleanly; unknown instances fail cleanly', async () => {
    seedMinimalInstall('fix-unknown')
    const svc = await freshDoctor()
    expect((await svc.fix('inst-1', 'nope')).ok).toBe(false)
    expect((await svc.fix('missing', 'create-models-dir')).ok).toBe(false)
  })

  it('run() flags a missing pip as fail with the ensure-pip fix (0.1.12)', async () => {
    seedMinimalInstall('no-pip')
    h.state.execHandler = (cmd, args) => {
      if (args[0] === '-m' && args[1] === 'pip') {
        return new Error('No module named pip')
      }
      return defaultExec(cmd, args)
    }
    const svc = await freshDoctor()
    const report = await svc.run('inst-1')
    const pip = report.checks.find((c: any) => c.id === 'pip')!
    expect(pip.severity).toBe('fail')
    expect(pip.fixable).toBe(true)
    expect(pip.fixId).toBe('ensure-pip')
  })

  it('fix ensure-pip seeds pip via ensurepip and verifies afterwards (0.1.12)', async () => {
    seedMinimalInstall('fix-pip')
    let ensured = false
    h.state.execHandler = (cmd, args) => {
      if (args[0] === '-m' && args[1] === 'pip' && args[2] === '--version') {
        // pip missing until ensurepip ran.
        return ensured
          ? { stdout: 'pip 24.0 from x (python 3.13)' }
          : new Error('No module named pip')
      }
      if (args[0] === '-m' && args[1] === 'ensurepip') {
        ensured = true
        return { stdout: 'Successfully installed pip' }
      }
      return defaultExec(cmd, args)
    }
    const svc = await freshDoctor()
    const r = await svc.fix('inst-1', 'ensure-pip')
    expect(r.ok).toBe(true)
    expect(ensured).toBe(true)
    expect(r.message).toContain('pip is now available')
  })

  it('fix ensure-pip reports failure honestly when ensurepip cannot help (0.1.12)', async () => {
    seedMinimalInstall('fix-pip-fail')
    h.state.execHandler = (cmd, args) => {
      if (args[0] === '-m' && (args[1] === 'pip' || args[1] === 'ensurepip')) {
        return new Error('No module named pip')
      }
      return defaultExec(cmd, args)
    }
    const svc = await freshDoctor()
    const r = await svc.fix('inst-1', 'ensure-pip')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('pip is not available')
  })
})
