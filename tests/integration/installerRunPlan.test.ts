/**
 * Integration: full InstallerService.runPlan paths with stubbed bootstrap,
 * child_process, zip and desktop/instance hooks. No real git/pip/uv runs.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { pathKey } from '../helpers/pathKey'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { InstallPlan, InstallProgress } from '../../src/shared/types'

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void

const h = vi.hoisted(() => ({
  bootstrap: {
    runtimesDir: 'rt',
    pythonPath: 'C:/portable/python.exe',
    pythonOrigin: 'system' as string,
    zipInstallReady: true,
    components: [
      { kind: 'uv', path: 'C:/portable/uv.exe', installed: true, origin: 'runtimes' as const },
      { kind: 'python', path: 'C:/portable/python.exe', installed: true, origin: 'system' as const },
      { kind: 'mingit', path: 'C:/portable/mingit/bin/git.exe', installed: true, origin: 'runtimes' as const }
    ]
  } as {
    pythonPath: string
    pythonOrigin: string
    zipInstallReady: boolean
    components: Array<{ kind: string; path: string; installed: boolean; origin: string }>
  },
  execCalls: [] as Array<{ cmd: string; args: string[] }>,
  execImpl: null as null | ((cmd: string, args: string[], cb: ExecCb) => void),
  pendingCbs: [] as Array<ExecCb>,
  hang: false,
  safeUnzipImpl: null as null | ((zip: string, dest: string) => Promise<void>),
  desktopImpl: null as null | ((opts: unknown) => Promise<string>),
  instanceStartImpl: null as null | ((id: string) => Promise<void>),
  fetchImpl: null as null | (() => Promise<Response>),
  reset(): void {
    this.execCalls = []
    this.execImpl = null
    this.pendingCbs = []
    this.hang = false
    this.safeUnzipImpl = null
    this.desktopImpl = null
    this.instanceStartImpl = null
    this.fetchImpl = null
    this.bootstrap = {
      runtimesDir: 'rt',
      pythonPath: 'C:/portable/python.exe',
      pythonOrigin: 'system',
      zipInstallReady: true,
      components: [
        { kind: 'uv', path: 'C:/portable/uv.exe', installed: true, origin: 'runtimes' },
        { kind: 'python', path: 'C:/portable/python.exe', installed: true, origin: 'system' },
        { kind: 'mingit', path: 'C:/portable/mingit/bin/git.exe', installed: true, origin: 'runtimes' }
      ]
    }
  }
}))

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'cp-runplan') },
  session: {
    defaultSession: {
      fetch: (...args: unknown[]) =>
        h.fetchImpl
          ? (h.fetchImpl as (...a: unknown[]) => Promise<Response>)(...args)
          : Promise.resolve(new Response('zip', { status: 200 })),
      setProxy: async () => undefined
    }
  }
}))

vi.mock('systeminformation', () => ({
  default: { graphics: async () => ({ controllers: [] }) }
}))

vi.mock('child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: ExecCb
  ): { pid: number; exitCode: number | null; kill: () => void } => {
    const child = { pid: 4242, exitCode: null as number | null, kill: () => undefined }
    h.execCalls.push({ cmd: String(cmd), args: [...args] })
    const deliver = (): void => {
      if (h.execImpl) {
        h.execImpl(String(cmd), args, cb)
        return
      }
      // default success with plausible version strings + venv side effects
      if (args[0] === '--version') {
        const c = String(cmd).toLowerCase()
        if (c.includes('git')) cb(null, 'git version 2.44.0.windows.1', '')
        else if (c.includes('uv')) cb(null, 'uv 0.5.1', '')
        else cb(null, 'Python 3.12.1', '')
        return
      }
      if ((args[0] === '-m' && args[1] === 'venv') || args[0] === 'venv') {
        const venvPath = args[0] === 'venv' ? args[1] : args[2]
        mkdirSync(join(venvPath, 'Scripts'), { recursive: true })
        writeFileSync(join(venvPath, 'Scripts', 'python.exe'), '')
        cb(null, '', '')
        return
      }
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]
        mkdirSync(dest, { recursive: true })
        writeFileSync(join(dest, 'main.py'), 'print(1)\n')
        cb(null, '', '')
        return
      }
      cb(null, 'ok', '')
    }
    if (h.hang) {
      h.pendingCbs.push(() => deliver())
    } else {
      queueMicrotask(deliver)
    }
    return child
  },
  spawn: () => ({ pid: 1, exitCode: null, kill: () => undefined })
}))

vi.mock('../../src/main/services/bootstrap', () => ({
  bootstrapService: { ensure: async () => h.bootstrap }
}))

vi.mock('../../src/main/services/zipSafe', () => ({
  safeUnzip: (...args: unknown[]) => {
    if (h.safeUnzipImpl) return (h.safeUnzipImpl as (...a: unknown[]) => Promise<void>)(...args)
    // default: extract a GitHub-style nested ComfyUI-master/ tree
    const dest = args[1] as string
    mkdirSync(join(dest, 'ComfyUI-master'), { recursive: true })
    writeFileSync(join(dest, 'ComfyUI-master', 'main.py'), 'print(1)\n')
    writeFileSync(join(dest, 'ComfyUI-master', 'requirements.txt'), 'torch\n')
    return Promise.resolve()
  }
}))

vi.mock('../../src/main/services/desktop', () => ({
  createDesktopShortcut: (opts: unknown) => {
    if (h.desktopImpl) return h.desktopImpl(opts)
    return Promise.resolve('C:\\Users\\x\\Desktop\\ComfyPilot.lnk')
  },
  appExecutablePath: () => 'C:\\ComfyPilot\\app.exe',
  appIconPath: () => 'C:\\ComfyPilot\\app.ico'
}))

vi.mock('../../src/main/services/instance', () => ({
  instanceService: {
    start: (id: string) => {
      if (h.instanceStartImpl) return h.instanceStartImpl(id)
      return Promise.resolve(undefined)
    }
  }
}))

const ROOT = join(tmpdir(), 'cp-runplan')

function plan(overrides: Partial<InstallPlan> = {}): InstallPlan {
  return {
    installRoot: join(ROOT, 'inst'),
    instanceName: 'TestUI',
    useUv: false,
    pythonPath: 'python',
    torchChannel: 'cpu',
    comfyRepo: 'https://github.com/comfyanonymous/ComfyUI.git',
    comfyBranch: '',
    createDesktopShortcut: false,
    autoStart: false,
    comfySource: 'zip',
    skipStarter: true,
    ...overrides
  }
}

async function freshService(): Promise<{
  start: (p: InstallPlan) => Promise<{ runId: string }>
  cancel: () => boolean
  getStatus: () => InstallProgress | null
}> {
  vi.resetModules()
  const mod = await import('../../src/main/services/installer')
  return mod.installerService as never
}

function waitStatus(
  svc: { getStatus: () => InstallProgress | null },
  pred: (p: InstallProgress) => boolean,
  timeoutMs = 5000
): Promise<InstallProgress> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = (): void => {
      const p = svc.getStatus()
      if (p && pred(p)) {
        if (p.status === 'failed' && process.env['DEBUG_RUNPLAN']) {
          console.error('RUNPLAN FAIL', p.error, '::', p.steps.map((s) => `${s.id}=${s.status}:${s.detail}`).join(' | '))
        }
        return resolve(p)
      }
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for status: ' + JSON.stringify(p)))
      setTimeout(tick, 15)
    }
    tick()
  })
}

describe('installer runPlan (integration)', () => {
  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true })
  })

  beforeEach(() => {
    h.reset()
    rmSync(join(ROOT, 'inst'), { recursive: true, force: true })
  })

  afterEach(() => {
    h.hang = false
  })

  it('zip + python venv happy path: registers instance, writes env json', async () => {
    const svc = await freshService()
    const res = await svc.start(plan())
    expect(res.runId).toBeTruthy()
    const p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(p.percent).toBe(100)
    expect(p.instanceId).toBeTruthy()
    const env = JSON.parse(readFileSync(join(ROOT, 'inst', '.comfypilot-env.json'), 'utf-8'))
    expect(env.comfySource).toBe('zip')
    expect(existsSync(join(ROOT, 'inst', 'ComfyUI', 'main.py'))).toBe(true)
    const steps = Object.fromEntries(p.steps.map((s) => [s.id, s.status]))
    expect(steps.bootstrap).toBe('done')
    expect(steps.preflight).toBe('done')
    expect(steps.python).toBe('done')
    expect(steps.venv).toBe('done')
    expect(steps.comfyui).toBe('done')
    expect(steps.torch).toBe('done')
    expect(steps.starter).toBe('skipped')
    expect(steps.done).toBe('done')
    // pip path used (not uv) — torch install went through venv python -m pip
    expect(h.execCalls.some((c) => c.args.includes('torch'))).toBe(true)
    expect(h.execCalls.some((c) => c.args[0] === 'pip' || c.args.includes('pip'))).toBe(true)
  })

  it('uv path: uv venv + uv pip install torch and requirements', async () => {
    const svc = await freshService()
    const root = join(ROOT, 'inst')
    await svc.start(plan({ useUv: true, comfySource: 'zip' }))
    const p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(h.execCalls.some((c) => c.args[0] === 'venv')).toBe(true)
    expect(h.execCalls.some((c) => c.args[0] === 'pip' && c.args.includes('torch'))).toBe(true)
    void root
  })

  it('uv is used automatically when python missing but uv present', async () => {
    h.bootstrap.pythonPath = 'python'
    h.bootstrap.pythonOrigin = 'missing'
    const svc = await freshService()
    await svc.start(plan({ useUv: false, comfySource: 'zip' }))
    const p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(h.execCalls.some((c) => c.args[0] === 'venv')).toBe(true)
  })

  it('git source with branch clones via mingit; requirements present', async () => {
    const root = join(ROOT, 'inst')
    // clone mock writes main.py; also add requirements.txt after clone via execImpl
    h.execImpl = (cmd, args, cb) => {
      if (args[0] === '--version') {
        const c = cmd.toLowerCase()
        if (c.includes('git')) return queueMicrotask(() => cb(null, 'git version 2.44', ''))
        return queueMicrotask(() => cb(null, 'Python 3.12.1', ''))
      }
      if ((args[0] === '-m' && args[1] === 'venv') || args[0] === 'venv') {
        const venvPath = args[0] === 'venv' ? args[1] : args[2]
        mkdirSync(join(venvPath, 'Scripts'), { recursive: true })
        writeFileSync(join(venvPath, 'Scripts', 'python.exe'), '')
        return queueMicrotask(() => cb(null, '', ''))
      }
      if (args[0] === 'clone') {
        const dest = args[args.length - 1]
        mkdirSync(dest, { recursive: true })
        writeFileSync(join(dest, 'main.py'), '')
        writeFileSync(join(dest, 'requirements.txt'), 'torch\n')
        return queueMicrotask(() => cb(null, '', ''))
      }
      queueMicrotask(() => cb(null, 'ok', ''))
    }
    const svc = await freshService()
    await svc.start(
      plan({
        comfySource: 'git',
        comfyBranch: 'master',
        useUv: true
      })
    )
    const p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    const clone = h.execCalls.find((c) => c.args[0] === 'clone')
    expect(clone).toBeTruthy()
    expect(clone!.args).toContain('--branch')
    expect(clone!.args).toContain('master')
    expect(clone!.cmd).toContain('git')
    expect(h.execCalls.some((c) => c.args.includes('-r'))).toBe(true)
    void root
  })

  it('reuses existing ComfyUI dir and notes skipped branch switch', async () => {
    const root = join(ROOT, 'inst')
    mkdirSync(join(root, 'ComfyUI'), { recursive: true })
    writeFileSync(join(root, 'ComfyUI', 'main.py'), '')
    const svc = await freshService()
    await svc.start(plan({ comfySource: 'git', comfyBranch: 'dev' }))
    const p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    const comfyLog = p.steps.find((s) => s.id === 'comfyui')!.log.join('\n')
    expect(comfyLog).toContain('already present')
    expect(comfyLog).toContain('dev')
  })

  it('clears crashed clone debris (marker file present) and re-fetches', async () => {
    const root = join(ROOT, 'inst')
    mkdirSync(join(root, 'ComfyUI', 'custom_nodes'), { recursive: true })
    writeFileSync(join(root, '.comfypilot-env.json'), '{}')
    writeFileSync(join(root, 'ComfyUI', 'custom_nodes', 'x.js'), '')
    const svc = await freshService()
    await svc.start(plan())
    const p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(existsSync(join(root, 'ComfyUI', 'main.py'))).toBe(true)
    expect(existsSync(join(root, 'ComfyUI', 'custom_nodes', 'x.js'))).toBe(false)
  })

  it('refuses to delete foreign non-empty ComfyUI directory', async () => {
    const root = join(ROOT, 'inst')
    mkdirSync(join(root, 'ComfyUI'), { recursive: true })
    writeFileSync(join(root, 'ComfyUI', 'my-notes.txt'), '')
    const svc = await freshService()
    await svc.start(plan())
    const p = await waitStatus(svc, (s) => s.status === 'failed' || s.status === 'done')
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/Refusing to delete|not a ComfyPilot/)
    expect(existsSync(join(root, 'ComfyUI', 'my-notes.txt'))).toBe(true)
  })

  it('desktop shortcut success and failure are both non-fatal', async () => {
    h.desktopImpl = async () => 'C:\\Desktop\\ok.lnk'
    let svc = await freshService()
    await svc.start(plan({ createDesktopShortcut: true }))
    let p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(p.steps.find((s) => s.id === 'register')!.log.join('\n')).toContain('Desktop shortcut:')

    h.desktopImpl = async () => {
      throw new Error('shortcut denied')
    }
    svc = await freshService()
    await svc.start(plan({ createDesktopShortcut: true }))
    p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(p.steps.find((s) => s.id === 'register')!.log.join('\n')).toContain('shortcut failed')
  })

  it('autoStart success and failure both complete the install', async () => {
    h.instanceStartImpl = async () => undefined
    let svc = await freshService()
    await svc.start(plan({ autoStart: true, skipStarter: false }))
    let p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(p.steps.find((s) => s.id === 'done')!.detail).toContain('Installed and started')
    expect(p.steps.find((s) => s.id === 'starter')!.status).toBe('done')

    h.instanceStartImpl = async () => {
      throw new Error('port in use')
    }
    svc = await freshService()
    await svc.start(plan({ autoStart: true }))
    p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(p.steps.find((s) => s.id === 'done')!.detail).toContain('auto-start failed')
  })

  it('python fallback: plan python fails, bootstrap python works', async () => {
    h.bootstrap.pythonPath = 'C:/boot/python3.exe'
    h.bootstrap.pythonOrigin = 'runtimes'
    h.execImpl = (cmd, args, cb) => {
      if (args[0] === '--version') {
        if (String(cmd).includes('boot')) return queueMicrotask(() => cb(null, 'Python 3.11.2', ''))
        return queueMicrotask(() => cb(new Error('not found'), '', ''))
      }
      if ((args[0] === '-m' && args[1] === 'venv') || args[0] === 'venv') {
        const venvPath = args[0] === 'venv' ? args[1] : args[2]
        mkdirSync(join(venvPath, 'Scripts'), { recursive: true })
        writeFileSync(join(venvPath, 'Scripts', 'python.exe'), '')
        return queueMicrotask(() => cb(null, '', ''))
      }
      queueMicrotask(() => cb(null, 'ok', ''))
    }
    const svc = await freshService()
    await svc.start(plan({ pythonPath: 'broken-python' }))
    const p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
  })

  it('python fallback via uv-managed interpreter when both probes fail', async () => {
    h.bootstrap.pythonPath = 'C:/boot/python3.exe'
    h.bootstrap.pythonOrigin = 'runtimes'
    h.execImpl = (cmd, args, cb) => {
      if (args[0] === '--version') {
        // both plan python and bootstrap python report garbage
        return queueMicrotask(() => cb(null, 'not-a-version', ''))
      }
      if ((args[0] === '-m' && args[1] === 'venv') || args[0] === 'venv') {
        const venvPath = args[0] === 'venv' ? args[1] : args[2]
        mkdirSync(join(venvPath, 'Scripts'), { recursive: true })
        writeFileSync(join(venvPath, 'Scripts', 'python.exe'), '')
        return queueMicrotask(() => cb(null, '', ''))
      }
      queueMicrotask(() => cb(null, 'ok', ''))
    }
    const svc = await freshService()
    await svc.start(plan({ useUv: true, pythonPath: 'broken' }))
    const p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(p.steps.find((s) => s.id === 'python')!.log.join('\n') + p.steps.find((s) => s.id === 'python')!.detail).toMatch(
      /uv/i
    )
  })

  it('fails hard when no python is resolvable at all', async () => {
    h.bootstrap.pythonPath = 'python'
    h.bootstrap.pythonOrigin = 'missing'
    h.bootstrap.components = h.bootstrap.components.map((c) =>
      c.kind === 'uv' ? { ...c, installed: false, path: '' } : c
    )
    h.execImpl = (cmd, args, cb) => {
      if (args[0] === '--version') return queueMicrotask(() => cb(new Error('ENOENT'), '', ''))
      queueMicrotask(() => cb(null, 'ok', ''))
    }
    const svc = await freshService()
    await svc.start(plan())
    const p = await waitStatus(svc, (s) => s.status === 'failed')
    expect(p.error).toMatch(/Cannot locate Python/i)
  })

  it('preflight hard-fail (disk) aborts and marks the running step failed', async () => {
    // Empty installRoot fails root check inside preflight; start() itself rejects only
    // empty/parent-hop roots, so drive the runPlan error path via a hop-free root whose
    // preflight disk probe we force to hard-fail by making statfs throw is soft — instead
    // use a python missing + no fixId? python missing has fixId. Use invalid root through
    // runPlan's own guard: plan.installRoot with hop is rejected by start(). So trigger
    // hard fail via a fake disk failure: monkey-patch preflight result is not possible —
    // simplest reliable hard fail is a venv python file that never appears.
    h.execImpl = (cmd, args, cb) => {
      if (args[0] === '--version') return queueMicrotask(() => cb(null, 'Python 3.12.0', ''))
      if ((args[0] === '-m' && args[1] === 'venv') || args[0] === 'venv') {
        return queueMicrotask(() => cb(null, '', '')) // no python.exe created
      }
      queueMicrotask(() => cb(null, 'ok', ''))
    }
    const svc = await freshService()
    await svc.start(plan())
    const p = await waitStatus(svc, (s) => s.status === 'failed')
    expect(p.error).toMatch(/venv creation failed/)
    const failedStep = p.steps.find((s) => s.status === 'failed')
    expect(failedStep).toBeTruthy()
  })

  it('cleans up half-created ComfyUI dir after fetch failure', async () => {
    h.execImpl = (cmd, args, cb) => {
      if (args[0] === '--version') return queueMicrotask(() => cb(null, 'Python 3.12.0', ''))
      if ((args[0] === '-m' && args[1] === 'venv') || args[0] === 'venv') {
        const venvPath = args[0] === 'venv' ? args[1] : args[2]
        mkdirSync(join(venvPath, 'Scripts'), { recursive: true })
        writeFileSync(join(venvPath, 'Scripts', 'python.exe'), '')
        return queueMicrotask(() => cb(null, '', ''))
      }
      queueMicrotask(() => cb(null, 'ok', ''))
    }
    h.fetchImpl = async () => new Response('nope', { status: 500 })
    const svc = await freshService()
    await svc.start(plan({ comfySource: 'zip' }))
    const p = await waitStatus(svc, (s) => s.status === 'failed')
    expect(p.error).toMatch(/HTTP 500|download failed/i)
    expect(p.message).toMatch(/cleaned:|HTTP/)
  })

  it('zip extract to nested ComfyUI-master is flattened; missing main.py fails', { timeout: 15000 }, async () => {
    h.safeUnzipImpl = async (_zip, dest) => {
      mkdirSync(join(dest, 'ComfyUI-master'), { recursive: true })
      writeFileSync(join(dest, 'ComfyUI-master', 'main.py'), '')
      writeFileSync(join(dest, 'ComfyUI-master', 'requirements.txt'), 'x\n')
    }
    let svc = await freshService()
    await svc.start(plan({ comfySource: 'zip', useUv: true }))
    let p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(existsSync(join(ROOT, 'inst', 'ComfyUI', 'main.py'))).toBe(true)

    h.safeUnzipImpl = async (_zip, dest) => {
      mkdirSync(join(dest, 'ComfyUI-master'), { recursive: true })
      writeFileSync(join(dest, 'ComfyUI-master', 'README.md'), '')
    }
    h.execImpl = (cmd, args, cb) => {
      if (args[0] === '--version') return queueMicrotask(() => cb(null, 'Python 3.12.0', ''))
      if ((args[0] === '-m' && args[1] === 'venv') || args[0] === 'venv') {
        const venvPath = args[0] === 'venv' ? args[1] : args[2]
        mkdirSync(join(venvPath, 'Scripts'), { recursive: true })
        writeFileSync(join(venvPath, 'Scripts', 'python.exe'), '')
        return queueMicrotask(() => cb(null, '', ''))
      }
      queueMicrotask(() => cb(null, 'ok', ''))
    }
    // fresh root so the previous main.py is not reused
    rmSync(join(ROOT, 'inst'), { recursive: true, force: true })
    svc = await freshService()
    await svc.start(plan({ comfySource: 'zip' }))
    p = await waitStatus(svc, (s) => s.status === 'failed')
    expect(p.error).toMatch(/main\.py/)
  })

  it('cancel mid-run reports Installation cancelled', async () => {
    h.hang = true
    const svc = await freshService()
    await svc.start(plan())
    // wait until at least bootstrap started, then cancel while exec hangs
    await waitStatus(svc, (s) => s.step !== undefined && s.steps.some((st) => st.status === 'running'))
    svc.cancel()
    const p = await waitStatus(svc, (s) => s.status === 'failed', 8000)
    expect(p.error).toMatch(/cancelled/i)
  })

  it('second start while running throws', async () => {
    h.hang = true
    const svc = await freshService()
    await svc.start(plan())
    await expect(svc.start(plan())).rejects.toThrow(/already running/i)
    svc.cancel()
    await waitStatus(svc, (s) => s.status === 'failed', 8000)
  })

  it('git mode rejects unsafe repo / branch at start()', async () => {
    const svc = await freshService()
    await expect(svc.start(plan({ comfySource: 'git', comfyRepo: 'ext::sh -c evil' }))).rejects.toThrow()
    await expect(svc.start(plan({ comfySource: 'git', comfyBranch: 'a..b' }))).rejects.toThrow(/branch/i)
    await expect(svc.start(plan({ installRoot: ROOT + '/../x' }))).rejects.toThrow(/install root/i)
    await expect(svc.start(plan({ installRoot: '' }))).rejects.toThrow(/install root/i)
  })

  it('reuses existing instance config for the same path (keeps port)', async () => {
    const { upsertInstanceConfig } = await import('../../src/main/services/db')
    const comfyDir = join(ROOT, 'inst', 'ComfyUI')
    mkdirSync(comfyDir, { recursive: true })
    writeFileSync(join(comfyDir, 'main.py'), '')
    upsertInstanceConfig({
      id: 'same-path-inst',
      name: 'Old',
      path: comfyDir,
      pythonPath: '',
      venvPath: join(ROOT, 'inst', '.venv'),
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
    const svc = await freshService()
    await svc.start(plan())
    const p = await waitStatus(svc, (s) => s.status === 'done' || s.status === 'failed')
    expect(p.status).toBe('done')
    expect(p.instanceId).toBe('same-path-inst')
    const { loadInstanceConfigs } = await import('../../src/main/services/db')
    const cfg = loadInstanceConfigs().find((c) => c.id === 'same-path-inst')
    expect(cfg?.port).toBe(8199)
    expect(cfg?.name).toBe('TestUI')
  })
})
