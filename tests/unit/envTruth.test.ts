/**
 * 0.2.5 WP0: repairEnv must never claim Python 3.13 for a non-3.13 venv, and
 * recreateVenv must archive the old venv before creating a new one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  instances: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
  handler: null as null | ((cmd: string, args: string[]) => { stdout: string } | Error)
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.root, name: 't', isPackaged: false }
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => ({ proxy: {}, pipIndex: '' }),
  loadInstanceConfigs: () => h.instances,
  upsertInstanceConfig: (c: Record<string, unknown>) => {
    h.upserts.push(c)
    const i = h.instances.findIndex((x) => x.id === c.id)
    if (i >= 0) h.instances[i] = c
    else h.instances.push(c)
  },
  userDataDir: () => h.root,
  uvPythonInstallDir: () => join(h.root, 'uv-python')
}))

vi.mock('../../src/main/services/bootstrap', () => ({
  bootstrapService: {
    ensure: async () => ({
      pythonPath: join(h.root, 'portable-python'),
      pythonOrigin: 'runtimes',
      components: [{ kind: 'uv', path: '', installed: false, origin: 'runtimes' }]
    })
  },
  findInRuntimes: () => join(h.root, 'portable-python')
}))

vi.mock('child_process', () => {
  const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')
  const run = (cmd: string, args: string[]): { stdout: string } | Error => {
    try {
      return h.handler ? h.handler(cmd, args) : { stdout: '' }
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }
  const execFile = ((cmd: string, args: string[], _o: unknown, cb?: unknown): { pid: number } => {
    const r = run(cmd, args)
    queueMicrotask(() => {
      if (typeof cb !== 'function') return
      if (r instanceof Error) (cb as (...a: unknown[]) => void)(r, '', '')
      else (cb as (...a: unknown[]) => void)(null, r.stdout, '')
    })
    return { pid: 1 }
  }) as ((...args: unknown[]) => { pid: number }) & Record<symbol, unknown>
  execFile[PROMISIFY_CUSTOM] = (cmd: string, args: string[]) =>
    new Promise((resolve, reject) => {
      const r = run(cmd, args)
      queueMicrotask(() => {
        if (r instanceof Error) reject(r)
        else resolve({ stdout: r.stdout, stderr: '' })
      })
    })
  return { execFile, execFileSync: () => '', spawn: () => ({ pid: 1, kill: () => undefined }) }
})

import { envService } from '../../src/main/services/env'
import { acquireEnvLock, resetEnvLocksForTest } from '../../src/main/services/envLock'

let comfy = ''
let venv = ''

beforeEach(() => {
  h.root = mkdtempSync(join(tmpdir(), 'cp-env-truth-'))
  comfy = join(h.root, 'ComfyUI')
  venv = join(comfy, '.venv')
  mkdirSync(join(comfy, 'comfy'), { recursive: true })
  writeFileSync(join(comfy, 'main.py'), 'print(1)')
  mkdirSync(join(venv, 'bin'), { recursive: true })
  writeFileSync(join(venv, 'bin', 'python'), 'old')
  h.instances = [
    {
      id: 'i1',
      name: 'T',
      path: comfy,
      venvPath: venv,
      pythonPath: '',
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default',
      enabled: true,
      notes: '',
      autoStart: false,
      frontendVersion: '',
      pinned: false
    }
  ]
  h.upserts = []
  h.handler = (cmd, args) => {
    if (args[0] === '--version') return { stdout: 'Python 3.12.9' }
    return { stdout: '' }
  }
  resetEnvLocksForTest()
})

afterEach(() => {
  resetEnvLocksForTest()
  rmSync(h.root, { recursive: true, force: true })
})

describe('repairEnv truth (0.2.5 WP0)', () => {
  it('keeps a 3.12 venv at 3.12 and requires migration instead of faking 3.13', async () => {
    await expect(envService.repairEnv({ instanceId: 'i1' })).rejects.toMatchObject({
      code: 'PYTHON_MIGRATION_REQUIRED'
    })
    const saved = h.upserts.at(-1)
    expect(saved?.pythonVersion).toBe('3.12.9')
    expect(saved?.migrationState).toBe('required')
    expect(String(saved?.migrationError)).toMatch(/migrate/i)
  })

  it('refuses an unparseable interpreter version', async () => {
    h.handler = () => ({ stdout: 'not a python' })
    await expect(envService.repairEnv({ instanceId: 'i1' })).rejects.toMatchObject({
      code: 'PYTHON_UNKNOWN'
    })
    expect(h.upserts.at(-1)?.pythonVersion).toBeUndefined()
  })

  it('archives the old venv before recreating it', async () => {
    h.handler = (cmd, args) => {
      if (args[0] === '--version') return { stdout: 'Python 3.13.5' }
      if (args.includes('venv')) {
        const p = args[args.indexOf('venv') + 1]
        mkdirSync(join(p, 'bin'), { recursive: true })
        writeFileSync(join(p, 'bin', 'python'), 'new')
        return { stdout: '' }
      }
      if (args[0] === '-c') return { stdout: '{"torch":"2.9.0","cuda":null}' }
      if (args.includes('--version') || args[0] === '-m') return { stdout: 'pip 25.0' }
      if (args.includes('list')) return { stdout: '[]' }
      if (args.includes('install')) return new Error('stop after archive check')
      return { stdout: '' }
    }
    await expect(
      envService.repairEnv({ instanceId: 'i1', recreateVenv: true, torchChannel: 'cpu' })
    ).rejects.toThrow()
    const archives = readdirSync(comfy).filter((n) => n.startsWith('.venv.pre-recreate-'))
    expect(archives).toHaveLength(1)
    expect(existsSync(join(comfy, archives[0], 'bin', 'python'))).toBe(true)
  })

  it('fails with ENV_BUSY when another environment operation holds the lock', async () => {
    const release = acquireEnvLock('i1', 'node-install')
    try {
      await expect(envService.repairEnv({ instanceId: 'i1' })).rejects.toMatchObject({
        code: 'ENV_BUSY'
      })
    } finally {
      release()
    }
  })
})

describe('repairEnv edge branches', () => {
  beforeEach(() => {
    ;(envService as unknown as { repairAbort: AbortController | null }).repairAbort = null
  })

  it('rejects unknown instances and non-ComfyUI directories', async () => {
    await expect(envService.repairEnv({ instanceId: 'nope' })).rejects.toThrow(/not found/i)
    const saved = h.instances
    h.instances = [{ ...saved[0], id: 'empty', path: join(h.root, 'no-main') }]
    try {
      await expect(envService.repairEnv({ instanceId: 'empty' })).rejects.toThrow(
        /Not a ComfyUI install/
      )
    } finally {
      h.instances = saved
    }
  })

  it('refuses Python 3.14 venvs with PYTHON_UNSUPPORTED and marks migration failed', async () => {
    h.handler = (cmd, args) => {
      if (args[0] === '--version') return { stdout: 'Python 3.14.0' }
      return { stdout: '' }
    }
    await expect(envService.repairEnv({ instanceId: 'i1' })).rejects.toMatchObject({
      code: 'PYTHON_UNSUPPORTED'
    })
    const saved = h.upserts.at(-1)
    expect(saved?.migrationState).toBe('failed')
    expect(String(saved?.migrationError)).toMatch(/Unsupported Python 3.14/)
  })

  it('reports a failed archive when the previous venv cannot be renamed', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(123456)
    mkdirSync(`${venv}.pre-recreate-123456`, { recursive: true })
    writeFileSync(join(`${venv}.pre-recreate-123456`, 'occupied'), 'x')
    try {
      await expect(envService.repairEnv({ instanceId: 'i1', recreateVenv: true })).rejects.toThrow(
        /Could not archive/
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('creates the sibling venv when none exists but refuses a non-3.13 result', async () => {
    rmSync(venv, { recursive: true, force: true })
    h.instances = [{ ...h.instances[0], venvPath: '' }]
    h.handler = (cmd, args) => {
      if (args.includes('venv')) {
        const p = args[args.indexOf('venv') + 1]
        mkdirSync(join(p, 'bin'), { recursive: true })
        writeFileSync(join(p, 'bin', 'python'), 'new')
        return { stdout: '' }
      }
      if (args[0] === '--version') return { stdout: 'Python 3.12.9' }
      return { stdout: '' }
    }
    await expect(envService.repairEnv({ instanceId: 'i1' })).rejects.toThrow(/PYTHON_UNSUPPORTED/)
  })

  it('rejects when no Python runtime can be downloaded', async () => {
    rmSync(venv, { recursive: true, force: true })
    h.instances = [{ ...h.instances[0], venvPath: '' }]
    const bootstrap = await import('../../src/main/services/bootstrap')
    vi.spyOn(bootstrap.bootstrapService, 'ensure').mockResolvedValueOnce({
      pythonPath: 'python',
      pythonOrigin: 'missing',
      components: []
    } as never)
    await expect(envService.repairEnv({ instanceId: 'i1' })).rejects.toThrow(
      /no Python 3.13 runtime/
    )
  })
})
