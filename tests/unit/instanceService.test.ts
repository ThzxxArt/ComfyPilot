/**
 * High-intensity unit tests for InstanceService:
 * pure escaping helpers, config persistence, launch preview/script export,
 * discovery scoring, version cache, env probe, diagnostics, port helpers,
 * and the full start/waitReady/stop/restart/forceKill lifecycle including
 * generation fencing and the ready-probe extend window.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join, dirname } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import type { ComfyInstanceConfig, ComfyInstanceInfo, LaunchOptions } from '@shared/types'

// ---------------------------------------------------------------------------
// hoisted mutable state shared with module mocks
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  type Cb = (...args: unknown[]) => void

  function miniEmitter(): {
    on: (ev: string, cb: Cb) => unknown
    once: (ev: string, cb: Cb) => unknown
    emit: (ev: string, ...args: unknown[]) => boolean
    listeners: (ev: string) => Cb[]
  } {
    const map = new Map<string, Cb[]>()
    const api = {
      on(ev: string, cb: Cb) {
        if (!map.has(ev)) map.set(ev, [])
        map.get(ev)!.push(cb)
        return api
      },
      once(ev: string, cb: Cb) {
        const wrapped: Cb = (...args) => {
          const arr = map.get(ev) || []
          const i = arr.indexOf(wrapped)
          if (i >= 0) arr.splice(i, 1)
          cb(...args)
        }
        return api.on(ev, wrapped)
      },
      emit(ev: string, ...args: unknown[]) {
        const arr = map.get(ev) || []
        for (const cb of [...arr]) cb(...args)
        return arr.length > 0
      },
      listeners(ev: string) {
        return map.get(ev) || []
      }
    }
    return api
  }

  const state = {
    homeDir: '',
    userData: '',
    logs: '',
    instances: [] as Array<Record<string, unknown>>,
    settings: {
      theme: 'light',
      locale: 'zh-CN',
      defaultInstancePath: '',
      modelScanRoots: [] as string[],
      proxy: {
        enabled: false,
        protocol: 'http',
        host: '',
        port: 7890,
        username: '',
        password: '',
        bypass: ''
      }
    } as Record<string, unknown>,
    upsertCalls: [] as Array<Record<string, unknown>>,
    deleteCalls: [] as string[],
    portsInUse: new Set<number>(),
    portErrors: new Map<number, string>(),
    fetchImpl: null as null | ((url: string) => Promise<unknown>),
    execHandler: null as
      | null
      | ((cmd: string, args: string[], opts: unknown) => {
          stdout?: string
          stderr?: string
          error?: Error
          hang?: boolean
        }),
    findInRuntimes: null as string | null,
    findInRuntimesThrow: null as Error | null,
    lastChild: null as null | Record<string, unknown>,
    spawnCount: 0,
    spawnFail: null as Error | null,
    spawnExitImmediate: null as null | { code: number | null; signal: string | null },
    saveDialogResult: { canceled: true, filePath: undefined } as {
      canceled: boolean
      filePath?: string
    },
    // direct process.kill spy storage (forceKill pid fallback)
    processKillCalls: [] as Array<string | number>
  }

  type Child = {
    stdout: ReturnType<typeof miniEmitter>
    stderr: ReturnType<typeof miniEmitter>
    pid: number
    exitCode: number | null
    signalCode: string | null
    killed: boolean
    killSignals: string[]
    kill: (signal?: string) => boolean
    on: (ev: string, cb: Cb) => unknown
    emit: (ev: string, ...args: unknown[]) => boolean
  }

  function makeChild(): Child {
    const em = miniEmitter()
    let nextPid = 4000 + state.spawnCount
    const child: Child = {
      stdout: miniEmitter(),
      stderr: miniEmitter(),
      pid: nextPid,
      exitCode: null,
      signalCode: null,
      killed: false,
      killSignals: [],
      kill(signal?: string) {
        child.killSignals.push(signal || 'SIGTERM')
        child.killed = true
        return true
      },
      on: em.on,
      emit: em.emit
    }
    return child
  }

  function fetchDefault(url: string): Promise<unknown> {
    if (state.fetchImpl) return state.fetchImpl(url)
    return Promise.resolve({ ok: false, json: async () => ({}) })
  }

  return { state, miniEmitter, makeChild, fetchDefault }
})

// ---------------------------------------------------------------------------
// module mocks
// ---------------------------------------------------------------------------
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal()
  const patched = {
    ...actual,
    homedir: () => h.state.homeDir
  }
  return { ...patched, default: patched }
})

vi.mock('net', () => {
  const createServer = (): unknown => {
    const em = h.miniEmitter()
    const server = {
      once: em.once,
      on: em.on,
      listen(port: number) {
        queueMicrotask(() => {
          const custom = h.state.portErrors.get(port)
          if (custom) {
            em.emit('error', Object.assign(new Error(custom), { code: 'EACCES' }))
          } else if (h.state.portsInUse.has(port)) {
            em.emit(
              'error',
              Object.assign(new Error(`EADDRINUSE: ${port}`), { code: 'EADDRINUSE' })
            )
          } else {
            em.emit('listening')
          }
        })
        return server
      },
      close(cb?: () => void) {
        queueMicrotask(() => cb?.())
        return server
      }
    }
    return server
  }
  return { createServer, default: { createServer } }
})

vi.mock('child_process', () => {
  type ExecCb = (err: Error | null, stdout: string, stderr: string) => void
  const execFile = (cmd: string, args: string[], opts: unknown, cb?: ExecCb): unknown => {
    const callback = typeof opts === 'function' ? (opts as unknown as ExecCb) : cb
    const optsArg = typeof opts === 'function' ? undefined : opts
    const finish = (err: Error | null, out: string, errOut: string): void => {
      queueMicrotask(() => {
        if (typeof callback === 'function') callback(err, out, errOut)
      })
    }
    const handler = h.state.execHandler
    if (handler) {
      let result: ReturnType<typeof handler>
      try {
        result = handler(cmd, args as string[], optsArg)
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)), '', '')
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      if (result.hang) return { pid: 1, exitCode: null, kill: () => undefined }
      if (result.error) finish(result.error, result.stdout || '', result.stderr || '')
      else finish(null, result.stdout || '', result.stderr || '')
    } else {
      finish(null, '', '')
    }
    return { pid: 1, exitCode: null, kill: () => undefined }
  }
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (cmd: string, args: string[], opts?: unknown) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(cmd, args, opts, (err, stdout, stderr) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      })
  })

  const spawn = (cmd: string, args: string[], opts: unknown): unknown => {
    h.state.spawnCount += 1
    if (h.state.spawnFail) throw h.state.spawnFail
    const child = h.makeChild()
    h.state.lastChild = child as unknown as Record<string, unknown>
    if (h.state.spawnExitImmediate) {
      const spec = h.state.spawnExitImmediate
      setTimeout(() => child.emit('exit', spec.code, spec.signal), 0)
    }
    return child
  }

  return { execFile, spawn }
})

vi.mock('electron', () => ({
  app: { getPath: () => h.state.userData },
  dialog: {
    showSaveDialog: async () => h.state.saveDialogResult
  }
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => h.state.settings,
  loadInstanceConfigs: () => h.state.instances as unknown[],
  upsertInstanceConfig: (c: Record<string, unknown>) => {
    h.state.upsertCalls.push({ ...c })
    const idx = h.state.instances.findIndex((x) => x.id === c.id)
    if (idx >= 0) h.state.instances[idx] = { ...c }
    else h.state.instances.push({ ...c })
  },
  deleteInstanceConfig: (id: string) => {
    h.state.deleteCalls.push(id)
    const idx = h.state.instances.findIndex((x) => x.id === id)
    if (idx >= 0) {
      h.state.instances.splice(idx, 1)
      return true
    }
    return false
  },
  logsDir: () => h.state.logs,
  userDataDir: () => h.state.userData
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyEnv: vi.fn(() => ({ HTTP_PROXY: 'http://proxy.test:7890' }))
}))

vi.mock('../../src/main/services/bootstrap', () => ({
  findInRuntimes: () => {
    if (h.state.findInRuntimesThrow) throw h.state.findInRuntimesThrow
    return h.state.findInRuntimes
  }
}))

// ---------------------------------------------------------------------------
// imports under test (after mocks)
// ---------------------------------------------------------------------------
import {
  InstanceService,
  quoteCommandLineArg,
  escapeForBat,
  escapeForSh,
  resolveRuntimesPythonSync,
  hashId
} from '../../src/main/services/instance'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const ROOT = join(tmpdir(), 'cp-instance-svc')
const HOME = join(ROOT, 'home')
const USER = join(ROOT, 'user')
const LOGS = join(ROOT, 'logs')
const COMFY = join(ROOT, 'comfy')

function resetDirs(): void {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  mkdirSync(USER, { recursive: true })
  mkdirSync(LOGS, { recursive: true })
  mkdirSync(COMFY, { recursive: true })
}

function cfg(over: Partial<ComfyInstanceConfig> = {}): ComfyInstanceConfig {
  return {
    id: 'inst-1',
    name: 'Alpha',
    path: COMFY,
    pythonPath: '',
    venvPath: '',
    port: 8188,
    listen: '127.0.0.1',
    extraArgs: [],
    argTemplateId: 'default',
    enabled: true,
    notes: '',
    autoStart: false,
    frontendVersion: '',
    pinned: false,
    ...over
  }
}

function register(...list: Array<Record<string, unknown>>): void {
  h.state.instances.length = 0
  for (const c of list) h.state.instances.push({ ...c })
}

function okStats(url: string): Promise<unknown> {
  if (String(url).includes('/system_stats')) {
    return Promise.resolve({ ok: true, json: async () => ({ system: { os: 'x' } }) })
  }
  return Promise.resolve({ ok: false, json: async () => ({}) })
}

function failFetch(url: string): Promise<unknown> {
  if (String(url).includes('/system_stats')) {
    return Promise.reject(new Error('ECONNREFUSED'))
  }
  return Promise.resolve({ ok: false, json: async () => ({}) })
}

function childOf(svc: InstanceService, id: string): ReturnType<typeof h.makeChild> {
  const rt = (
    svc as unknown as {
      runtimes: Map<string, { process?: ReturnType<typeof h.makeChild> }>
    }
  ).runtimes.get(id)
  return rt!.process!
}

function pokeRuntime(
  svc: InstanceService,
  id: string,
  patch: Record<string, unknown>
): void {
  const rt = (
    svc as unknown as {
      runtimes: Map<string, Record<string, unknown>>
    }
  ).runtimes.get(id)
  Object.assign(rt!, patch)
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

let svc: InstanceService

beforeEach(() => {
  resetDirs()
  h.state.homeDir = HOME
  h.state.userData = USER
  h.state.logs = LOGS
  h.state.instances = []
  h.state.upsertCalls = []
  h.state.deleteCalls = []
  h.state.portsInUse = new Set()
  h.state.portErrors = new Map()
  h.state.fetchImpl = okStats
  h.state.execHandler = null
  h.state.findInRuntimes = null
  h.state.findInRuntimesThrow = null
  h.state.lastChild = null
  h.state.spawnCount = 0
  h.state.spawnFail = null
  h.state.spawnExitImmediate = null
  h.state.saveDialogResult = { canceled: true, filePath: undefined }
  h.state.processKillCalls = []
  h.state.settings = {
    theme: 'light',
    locale: 'zh-CN',
    defaultInstancePath: '',
    modelScanRoots: [],
    proxy: {
      enabled: false,
      protocol: 'http',
      host: '',
      port: 7890,
      username: '',
      password: '',
      bypass: ''
    }
  }
  process.env.COMFYUI_PATH = ''
  process.env.USERPROFILE = HOME
  process.env.LOCALAPPDATA = join(HOME, 'AppData', 'Local')
  globalThis.fetch = vi.fn((input: unknown) =>
    h.fetchDefault(String(input))
  ) as unknown as typeof fetch
  svc = new InstanceService()
})

afterEach(() => {
  try {
    svc.killAllNow()
  } catch {
    /* ignore */
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ===========================================================================
// pure helpers
// ===========================================================================
describe('quoteCommandLineArg', () => {
  it('passes through tokens without special characters', () => {
    expect(quoteCommandLineArg('python')).toBe('python')
    expect(quoteCommandLineArg('--port')).toBe('--port')
    expect(quoteCommandLineArg('C:\\ComfyUI\\main.py')).toBe('C:\\ComfyUI\\main.py')
  })

  it('quotes tokens containing whitespace', () => {
    expect(quoteCommandLineArg('C:\\Program Files\\python.exe')).toBe(
      '"C:\\Program Files\\python.exe"'
    )
  })

  it('escapes embedded double quotes inside the wrapped form', () => {
    expect(quoteCommandLineArg('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('quotes cmd metacharacters', () => {
    expect(quoteCommandLineArg('a&b')).toBe('"a&b"')
    expect(quoteCommandLineArg('100%')).toBe('"100%"')
  })
})

describe('escapeForBat', () => {
  it('doubles percent signs', () => {
    expect(escapeForBat('50%')).toBe('"50%%"')
  })

  it('doubles double quotes (cmd style, not backslash)', () => {
    expect(escapeForBat('a"b')).toBe('"a""b"')
  })

  it('caret-escapes metacharacters', () => {
    expect(escapeForBat('a&b|c<d>e^f!g')).toBe('"a^&b^|c^<d^>e^^f^!g"')
  })

  it('wraps plain values in quotes too', () => {
    expect(escapeForBat('plain')).toBe('"plain"')
  })
})

describe('escapeForSh', () => {
  it('wraps in single quotes', () => {
    expect(escapeForSh('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes using backslash-quote', () => {
    expect(escapeForSh("it's")).toBe("'it'\\''s'")
  })
})

describe('resolveRuntimesPythonSync', () => {
  it('returns the portable python when present', () => {
    h.state.findInRuntimes = 'C:/runtimes/python.exe'
    expect(resolveRuntimesPythonSync()).toBe('C:/runtimes/python.exe')
  })

  it('returns null when bootstrap has nothing', () => {
    h.state.findInRuntimes = null
    expect(resolveRuntimesPythonSync()).toBeNull()
  })

  it('returns null when bootstrap throws', () => {
    h.state.findInRuntimesThrow = new Error('runtimes exploded')
    expect(resolveRuntimesPythonSync()).toBeNull()
  })
})

describe('hashId', () => {
  it('is a stable 12-char hex digest', () => {
    const a = hashId('comfy://a')
    const b = hashId('comfy://a')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
  })

  it('differs for different inputs', () => {
    expect(hashId('one')).not.toBe(hashId('two'))
  })
})

// ===========================================================================
// list / save / remove
// ===========================================================================
describe('list()', () => {
  it('sorts pinned first, then running, then by name', () => {
    register(
      cfg({ id: 'a', name: 'aaa', pinned: false }),
      cfg({ id: 'b', name: 'bbb', pinned: false }),
      cfg({ id: 'p', name: 'zzz', pinned: true }),
      cfg({ id: 'c', name: 'ccc', pinned: false })
    )
    // make 'b' running by adopting
    h.state.fetchImpl = okStats
    h.state.portsInUse.add(8188)
    // only one instance shares port 8188 — adopt sets that runtime to running
    const ids = svc.list().map((i) => i.id)
    // pinned first
    expect(ids[0]).toBe('p')
  })

  it('normalizes legacy fields omitted from old JSONC records', () => {
    register({
      id: 'old',
      name: 'Old',
      path: COMFY,
      port: 8199,
      listen: '127.0.0.1'
      // pinned / autoStart / extraArgs intentionally missing
    } as unknown as Record<string, unknown>)
    const [info] = svc.list()
    expect(info.pinned).toBe(false)
    expect(info.autoStart).toBe(false)
    expect(info.extraArgs).toEqual([])
    expect(info.managerEnabled).toBeUndefined()
    expect(info.port).toBe(8199)
    expect(info.url).toBe('http://127.0.0.1:8199')
  })

  it('maps 0.0.0.0 listen to loopback URL and flags manager', () => {
    register(
      cfg({ id: 'm', name: 'Mgr', listen: '0.0.0.0', extraArgs: ['--enable-manager'] })
    )
    const [info] = svc.list()
    expect(info.url).toBe('http://127.0.0.1:8188')
    expect(info.managerEnabled).toBe(true)
  })

  it('keeps running entries ahead of stopped siblings', async () => {
    register(
      cfg({ id: 'run', name: 'zz-run' }),
      cfg({ id: 'stop', name: 'aa-stop' })
    )
    // adopt 'run' so its status becomes running
    h.state.fetchImpl = okStats
    h.state.portsInUse.add(8188)
    await svc.start('run')
    const infos = svc.list()
    expect(infos[0].id).toBe('run')
    expect(infos[0].status).toBe('running')
  })
})

describe('save()', () => {
  it('assigns a uuid when id is empty', () => {
    const info = svc.save(cfg({ id: '' }))
    expect(info.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].id).toBe(info.id)
  })

  it('persists only configuration fields (strips runtime junk)', () => {
    const dirty = {
      ...cfg({ id: 'keep' }),
      status: 'running',
      pid: 999,
      url: 'http://x',
      startedAt: 1,
      uptimeMs: 2,
      lastError: 'nope',
      version: '1.2.3',
      managerEnabled: true
    }
    const info = svc.save(dirty as unknown as ComfyInstanceConfig)
    const persisted = h.state.upsertCalls[0]
    expect(persisted).not.toHaveProperty('status')
    expect(persisted).not.toHaveProperty('pid')
    expect(persisted).not.toHaveProperty('url')
    expect(persisted).not.toHaveProperty('uptimeMs')
    expect(persisted).not.toHaveProperty('lastError')
    expect(persisted).not.toHaveProperty('version')
    expect(persisted.id).toBe('keep')
    expect(info.id).toBe('keep')
  })

  it('fills defaults for missing optional fields', () => {
    const bare = {
      id: 'bare',
      name: 'Bare',
      path: COMFY
    } as unknown as ComfyInstanceConfig
    const info = svc.save(bare)
    expect(info.pythonPath).toBe('')
    expect(info.venvPath).toBe('')
    expect(info.port).toBe(8188)
    expect(info.listen).toBe('127.0.0.1')
    expect(info.extraArgs).toEqual([])
    expect(info.argTemplateId).toBe('default')
    expect(info.enabled).toBe(true)
    expect(info.notes).toBe('')
    expect(info.frontendVersion).toBe('')
    expect(info.pinned).toBe(false)
    expect(info.autoStart).toBe(false)
  })

  it('coerces non-array extraArgs to empty array on save', () => {
    const bad = {
      ...cfg({ id: 'bad' }),
      extraArgs: '--cpu --highvram'
    } as unknown as ComfyInstanceConfig
    const info = svc.save(bad)
    expect(info.extraArgs).toEqual([])
  })
})

describe('remove()', () => {
  it('kills a live process, bumps generation and deletes the DB row', () => {
    register(cfg({ id: 'gone' }))
    h.state.fetchImpl = okStats
    h.state.portsInUse.add(8188)
    // adopt gives us a runtime without a child; force a child in place
    void svc.list()
    const child = h.makeChild()
    pokeRuntime(svc, 'gone', {
      process: child,
      pid: child.pid,
      managed: true,
      generation: 1,
      status: 'running'
    })
    const removed = svc.remove('gone')
    expect(removed).toBe(true)
    expect(child.killSignals.length).toBeGreaterThan(0)
    expect(h.state.deleteCalls).toContain('gone')
  })

  it('still deletes when no runtime exists', () => {
    register(cfg({ id: 'nope' }))
    expect(svc.remove('nope')).toBe(true)
    expect(h.state.deleteCalls).toContain('nope')
    expect(svc.remove('nope')).toBe(false)
  })
})

// ===========================================================================
// previewLaunch / resolvePython / buildArgs
// ===========================================================================
describe('previewLaunch()', () => {
  it('throws for unknown instance', () => {
    register()
    expect(() => svc.previewLaunch('missing')).toThrow(/not found/)
  })

  it('prefers venv Scripts/python.exe on Windows layout', () => {
    const venv = join(ROOT, 'venv-win')
    write(join(venv, 'Scripts', 'python.exe'), 'exe')
    register(cfg({ id: 'v1', venvPath: venv, pythonPath: 'should-not-win' }))
    const preview = svc.previewLaunch('v1')
    expect(preview.python).toBe(join(venv, 'Scripts', 'python.exe'))
  })

  it('falls back to venv bin/python on unix layout', () => {
    const venv = join(ROOT, 'venv-unix')
    write(join(venv, 'bin', 'python'), 'exe')
    register(cfg({ id: 'v2', venvPath: venv, pythonPath: 'should-not-win' }))
    expect(svc.previewLaunch('v2').python).toBe(join(venv, 'bin', 'python'))
  })

  it('falls through empty venv to pythonPath', () => {
    const venv = join(ROOT, 'venv-empty')
    mkdirSync(venv, { recursive: true })
    register(cfg({ id: 'v3', venvPath: venv, pythonPath: 'D:/py/python.exe' }))
    expect(svc.previewLaunch('v3').python).toBe('D:/py/python.exe')
  })

  it('uses pythonPath when no venv is configured', () => {
    register(cfg({ id: 'v4', pythonPath: 'C:/custom/python.exe' }))
    expect(svc.previewLaunch('v4').python).toBe('C:/custom/python.exe')
  })

  it('prefers portable python_embeded next to the install', () => {
    write(join(COMFY, 'python_embeded', 'python.exe'), 'exe')
    register(cfg({ id: 'v5' })) // no venvPath / pythonPath — embed wins
    expect(svc.previewLaunch('v5').python).toBe(join(COMFY, 'python_embeded', 'python.exe'))
  })

  it('pythonPath still wins over embeds (documented priority)', () => {
    write(join(COMFY, 'python_embeded', 'python.exe'), 'exe')
    register(cfg({ id: 'v5b', pythonPath: 'explicit-python' }))
    expect(svc.previewLaunch('v5b').python).toBe('explicit-python')
  })

  it('accepts the python_embedded spelling too', () => {
    write(join(COMFY, 'python_embedded', 'python.exe'), 'exe')
    register(cfg({ id: 'v6' }))
    expect(svc.previewLaunch('v6').python).toBe(join(COMFY, 'python_embedded', 'python.exe'))
  })

  it('falls back to ComfyPilot runtimes python', () => {
    h.state.findInRuntimes = join(USER, 'runtimes', 'python', 'python.exe')
    register(cfg({ id: 'v7' }))
    expect(svc.previewLaunch('v7').python).toBe(join(USER, 'runtimes', 'python', 'python.exe'))
  })

  it('last-resorts to bare python', () => {
    register(cfg({ id: 'v8' }))
    expect(svc.previewLaunch('v8').python).toBe('python')
  })

  it('merges template args and extraArgs into the command line', () => {
    register(
      cfg({
        id: 'args',
        argTemplateId: 'preview-taesd',
        extraArgs: ['--highvram']
      })
    )
    const preview = svc.previewLaunch('args')
    expect(preview.args[0]).toBe(join(COMFY, 'main.py'))
    expect(preview.args).toContain('--preview-method')
    expect(preview.args).toContain('taesd')
    expect(preview.args).toContain('--highvram')
    expect(preview.args).toContain('--port')
    expect(preview.args).toContain('8188')
    expect(preview.commandLine).toContain('--preview-method')
    expect(preview.cwd).toBe(COMFY)
  })

  it('splits legacy string extraArgs on whitespace', () => {
    register({
      ...cfg({ id: 'legacy' }),
      extraArgs: '--cpu  --lowvram'
    } as unknown as Record<string, unknown>)
    const preview = svc.previewLaunch('legacy')
    expect(preview.args).toContain('--cpu')
    expect(preview.args).toContain('--lowvram')
  })

  it('uses default port/listen fallbacks when they are zero/empty', () => {
    register(cfg({ id: 'dflt', port: 0, listen: '' }))
    const preview = svc.previewLaunch('dflt')
    expect(preview.args).toContain('8188')
    expect(preview.args).toContain('127.0.0.1')
  })
})

// ===========================================================================
// exportLaunchScript
// ===========================================================================
describe('exportLaunchScript()', () => {
  it('writes a .bat with cmd-safe escaping (opts.dir skips dialog)', async () => {
    const dir = join(ROOT, 'export-bat')
    const instPath = join(ROOT, 'path with space', 'Comfy & UI')
    mkdirSync(instPath, { recursive: true })
    register(cfg({ id: 'bat', name: 'My Instance!', path: instPath }))
    const { path: out } = await svc.exportLaunchScript('bat', { dir, kind: 'bat' })
    expect(out.endsWith('.bat')).toBe(true)
    expect(existsSync(out)).toBe(true)
    const body = readFileSync(out, 'utf-8')
    expect(body.startsWith('@echo off')).toBe(true)
    expect(body).toContain('REM Generated by ComfyPilot')
    // percent signs doubled, ampersand caret-escaped, wrapped in quotes
    expect(body).toContain('cd /d "')
    expect(body).toMatch(/Comfy \^& UI/)
    // filename sanitizer replaced "!" and spaces
    expect(out).toContain('launch-My_Instance')
  })

  it('writes a .sh with single-quote escaping', async () => {
    const dir = join(ROOT, 'export-sh')
    register(cfg({ id: 'sh', name: "it's", path: COMFY, extraArgs: ["--prompt", "it's"] }))
    const { path: out } = await svc.exportLaunchScript('sh', { dir, kind: 'sh' })
    const body = readFileSync(out, 'utf-8')
    expect(body.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(body).toContain("it'\\''s")
    expect(body).toContain('cd ')
  })

  it('uses the save dialog when no dir is provided', async () => {
    register(cfg({ id: 'dlg', name: 'Dlg' }))
    const target = join(ROOT, 'from-dialog.bat')
    h.state.saveDialogResult = { canceled: false, filePath: target }
    const { path: out } = await svc.exportLaunchScript('dlg', { kind: 'bat' })
    expect(out).toBe(target)
    expect(existsSync(target)).toBe(true)
  })

  it('throws when the dialog is cancelled', async () => {
    register(cfg({ id: 'cancel', name: 'C' }))
    h.state.saveDialogResult = { canceled: true, filePath: undefined }
    await expect(svc.exportLaunchScript('cancel')).rejects.toThrow(/Cancelled/)
  })
})

// ===========================================================================
// discover
// ===========================================================================
describe('discover()', () => {
  it('scores main.py / requirements.txt / venv and demotes registered paths', () => {
    // allow-listed root via settings
    const scan = join(HOME, 'scan')
    const full = join(scan, 'full')
    const reqOnly = join(scan, 'reqonly')
    const venved = join(scan, 'venved')
    const registered = join(scan, 'registered')
    write(join(full, 'main.py'), 'print(1)')
    write(join(full, 'requirements.txt'), 'torch')
    write(join(full, 'venv', 'pyvenv.cfg'), 'home = x')
    write(join(reqOnly, 'requirements.txt'), 'torch')
    write(join(venved, 'main.py'), 'print(1)')
    write(join(venved, '.venv', 'pyvenv.cfg'), 'home = x')
    write(join(registered, 'main.py'), 'print(1)')
    h.state.settings.defaultInstancePath = scan
    register(cfg({ id: 'r', path: registered }))

    const found = svc.discover()
    const byPath = new Map(found.map((c) => [c.path, c]))
    expect(byPath.get(full)?.score).toBe(100) // 50 + 20 + 30
    expect(byPath.get(full)?.reason).toBe('Found main.py')
    expect(byPath.get(reqOnly)?.score).toBe(20)
    expect(byPath.get(reqOnly)?.reason).toBe('Found requirements.txt')
    expect(byPath.get(venved)?.score).toBe(80) // 50 + 30
    expect(byPath.get(registered)?.score).toBe(-50) // 50 - 100
    expect(byPath.get(registered)?.registered).toBe(true)
    expect(byPath.get(registered)?.reason).toBe('Already registered')
    // sorted by score desc
    expect(found[0].path).toBe(full)
  })

  it('rejects a renderer root outside the allow-list', () => {
    const scan = join(HOME, 'scan')
    const inside = join(scan, 'ok')
    const outside = join(ROOT, 'elsewhere', 'sneaky')
    write(join(inside, 'main.py'), 'print(1)')
    write(join(outside, 'main.py'), 'print(1)')
    h.state.settings.defaultInstancePath = scan
    const found = svc.discover(outside)
    expect(found.every((c) => !c.path.startsWith(outside))).toBe(true)
  })

  it('accepts a root nested under an allow-listed tree and scores the root itself', () => {
    const scan = join(HOME, 'scan')
    const nested = join(scan, 'nested', 'deep')
    write(join(nested, 'main.py'), 'print(1)')
    write(join(nested, 'requirements.txt'), 'x')
    h.state.settings.defaultInstancePath = scan
    const found = svc.discover(nested)
    const hit = found.find((c) => c.path === nested)
    expect(hit).toBeTruthy()
    expect(hit!.score).toBe(70)
  })

  it('ignores directories without main.py or requirements.txt', () => {
    const scan = join(HOME, 'scan')
    mkdirSync(join(scan, 'not-comfy'), { recursive: true })
    write(join(scan, 'not-comfy', 'readme.md'), 'hi')
    h.state.settings.defaultInstancePath = scan
    const found = svc.discover()
    expect(found.every((c) => !c.path.endsWith('not-comfy'))).toBe(true)
  })
})

// ===========================================================================
// probeVersion (through toInfo) + invalidateVersionCache
// ===========================================================================
describe('version probe + cache', () => {
  it('prefers comfyVersion from .comfypilot-env.json', () => {
    write(join(COMFY, '.comfypilot-env.json'), JSON.stringify({ comfyVersion: '0.3.1' }))
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBe('0.3.1')
  })

  it('falls back to short commit sha', () => {
    write(
      join(COMFY, '.comfypilot-env.json'),
      JSON.stringify({ comfyCommit: 'abcdef0123456789' })
    )
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBe('abcdef012345')
  })

  it('falls back to fetch date', () => {
    write(
      join(COMFY, '.comfypilot-env.json'),
      JSON.stringify({ comfyFetchedAt: Date.UTC(2024, 4, 6) })
    )
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBe('2024-05-06')
  })

  it('reads the stamp from the parent directory', () => {
    const install = join(ROOT, 'parent-install', 'ComfyUI')
    mkdirSync(install, { recursive: true })
    write(
      join(ROOT, 'parent-install', '.comfypilot-env.json'),
      JSON.stringify({ comfyVersion: 'parent-stamp' })
    )
    register(cfg({ id: 'ver', path: install }))
    expect(svc.list()[0].version).toBe('parent-stamp')
  })

  it('falls back to pyproject version= line', () => {
    write(join(COMFY, 'pyproject.toml'), '[project]\nname = "x"\nversion = "0.0.9"\n')
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBe('0.0.9')
  })

  it('does not match version= that is not at line start', () => {
    write(join(COMFY, 'pyproject.toml'), 'name = "version = \\"1.0.0\\""\n')
    write(join(COMFY, 'main.py'), 'print(1)')
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBe('detected')
  })

  it('reports detected when main.py exists', () => {
    write(join(COMFY, 'main.py'), 'print(1)')
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBe('detected')
  })

  it('reports detected when only requirements.txt exists', () => {
    write(join(COMFY, 'requirements.txt'), 'torch')
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBe('detected')
  })

  it('returns undefined when nothing identifies the install', () => {
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBeUndefined()
  })

  it('serves cached version until invalidateVersionCache is called', () => {
    write(join(COMFY, 'main.py'), 'print(1)')
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBe('detected')
    // mutate the install — cached value must win
    write(
      join(COMFY, '.comfypilot-env.json'),
      JSON.stringify({ comfyVersion: 'fresh' })
    )
    expect(svc.list()[0].version).toBe('detected')
    svc.invalidateVersionCache(COMFY)
    expect(svc.list()[0].version).toBe('fresh')
  })

  it('invalidateVersionCache() with no args clears everything', () => {
    write(join(COMFY, 'main.py'), 'print(1)')
    register(cfg({ id: 'ver' }))
    expect(svc.list()[0].version).toBe('detected')
    write(
      join(COMFY, '.comfypilot-env.json'),
      JSON.stringify({ comfyVersion: 'fresh' })
    )
    svc.invalidateVersionCache()
    expect(svc.list()[0].version).toBe('fresh')
  })
})

// ===========================================================================
// probeEnv
// ===========================================================================
describe('probeEnv()', () => {
  it('collects python version, torch JSON and pip list', async () => {
    register(cfg({ id: 'env', venvPath: '', pythonPath: 'C:/py/python.exe' }))
    h.state.execHandler = (_cmd, args) => {
      if (args[0] === '--version') return { stdout: 'Python 3.12.1' }
      if (args[0] === '-c') {
        return {
          stdout: JSON.stringify({
            torch: '2.3.0',
            cuda: '12.1',
            mps: true,
            npu: false
          })
        }
      }
      if (args[0] === '-m') {
        return {
          stdout: JSON.stringify([
            { name: 'torch', version: '2.3.0' },
            { name: 'numpy', version: '1.26' }
          ])
        }
      }
      return { stdout: '' }
    }
    const probe = await svc.probeEnv('env')
    expect(probe.ok).toBe(true)
    expect(probe.pythonVersion).toBe('Python 3.12.1')
    expect(probe.pythonPath).toBe('C:/py/python.exe')
    expect(probe.torchVersion).toBe('2.3.0')
    expect(probe.cudaVersion).toBe('12.1')
    expect(probe.mpsAvailable).toBe(true)
    expect(probe.npuAvailable).toBe(false)
    expect(probe.packages.length).toBeGreaterThanOrEqual(2)
    expect(probe.errors).toEqual([])
  })

  it('reports partial failure but still returns', async () => {
    register(cfg({ id: 'env', pythonPath: 'C:/py/python.exe' }))
    h.state.execHandler = (_cmd, args) => {
      if (args[0] === '--version') return { stdout: 'Python 3.11.0' }
      if (args[0] === '-c') throw new Error('no torch')
      return { error: new Error('pip missing') }
    }
    const probe = await svc.probeEnv('env')
    expect(probe.pythonVersion).toBe('Python 3.11.0')
    expect(probe.errors.length).toBeGreaterThan(0)
    expect(probe.errors.some((e) => e.startsWith('torch:'))).toBe(true)
    expect(probe.ok).toBe(false)
  })

  it('falls back to sys.version when --version is empty', async () => {
    register(cfg({ id: 'env', pythonPath: 'C:/py/python.exe' }))
    h.state.execHandler = (_cmd, args) => {
      if (args[0] === '--version') return { stdout: '' }
      if (args[0] === '-c' && String(args[1]).includes('sys.version')) {
        return { stdout: '3.10.0 (tags/v3.10.0:0f11a82, Oct 2023)' }
      }
      return { error: new Error('nope') }
    }
    const probe = await svc.probeEnv('env')
    expect(probe.pythonVersion).toContain('3.10.0')
  })

  it('records python failure and leaves ok=false', async () => {
    register(cfg({ id: 'env', pythonPath: 'C:/py/python.exe' }))
    h.state.execHandler = () => ({ error: new Error('ENOENT python') })
    const probe = await svc.probeEnv('env')
    expect(probe.ok).toBe(false)
    expect(probe.pythonVersion).toBe('')
    expect(probe.errors.length).toBeGreaterThan(0)
  })

  it('uses bare python when the instance id is unknown', async () => {
    h.state.execHandler = (_cmd, args) => {
      if (args[0] === '--version') return { stdout: 'Python 3.9' }
      return { error: new Error('skip') }
    }
    const probe = await svc.probeEnv('ghost')
    expect(probe.pythonPath).toBe('python')
  })
})

// ===========================================================================
// exportDiagnostics / copyDiagnostics
// ===========================================================================
describe('exportDiagnostics()', () => {
  it('writes instance.json, console.log, env.json and optional extras', async () => {
    write(join(COMFY, 'extra_model_paths.yaml'), 'paths:\n  x: y\n')
    mkdirSync(join(COMFY, 'custom_nodes'), { recursive: true })
    write(join(COMFY, 'custom_nodes', 'a.py'), 'x')
    register(cfg({ id: 'diag', venvPath: join(ROOT, 'v') }))
    h.state.execHandler = (_cmd, args) => {
      if (args[0] === '--version') return { stdout: 'Python 3.12' }
      if (args[0] === '-c') {
        return { stdout: JSON.stringify({ torch: '2.0', cuda: null, mps: false, npu: false }) }
      }
      return { stdout: JSON.stringify([]) }
    }
    const pkg = await svc.exportDiagnostics('diag')
    expect(pkg.contents).toEqual(
      expect.arrayContaining([
        'instance.json',
        'console.log',
        'env.json',
        'extra_model_paths.yaml',
        'custom_nodes.txt'
      ])
    )
    expect(existsSync(join(pkg.path, 'instance.json'))).toBe(true)
    expect(existsSync(join(pkg.path, 'custom_nodes.txt'))).toBe(true)
    expect(readFileSync(join(pkg.path, 'custom_nodes.txt'), 'utf-8')).toContain('a.py')
    expect(pkg.size).toBeGreaterThanOrEqual(0)
    expect(pkg.createdAt).toBeGreaterThan(0)
  })

  it('falls back to the on-disk log file when no runtime logs exist', async () => {
    write(
      join(LOGS, 'diag.log'),
      '[2024-01-01T00:00:00.000Z] INFO hello\nnot-a-match\n'
    )
    register(cfg({ id: 'diag' }))
    h.state.execHandler = () => ({ error: new Error('no python') })
    const pkg = await svc.exportDiagnostics('diag')
    const consoleLog = readFileSync(join(pkg.path, 'console.log'), 'utf-8')
    expect(consoleLog).toContain('hello')
  })

  it('copyDiagnostics returns the package directory', async () => {
    register(cfg({ id: 'diag' }))
    h.state.execHandler = () => ({ error: new Error('no python') })
    const p = await svc.copyDiagnostics('diag')
    expect(existsSync(p)).toBe(true)
  })
})

// ===========================================================================
// checkPort / suggestPort
// ===========================================================================
describe('checkPort / suggestPort', () => {
  it('reports available when the port binds', async () => {
    const r = await svc.checkPort(18188)
    expect(r).toEqual({ port: 18188, available: true })
  })

  it('reports in-use for EADDRINUSE', async () => {
    h.state.portsInUse.add(18189)
    const r = await svc.checkPort(18189)
    expect(r.available).toBe(false)
    expect(r.owner).toBe('port in use')
  })

  it('surfaces the raw message for non-EADDRINUSE errors', async () => {
    h.state.portErrors.set(18190, 'permission denied')
    const r = await svc.checkPort(18190)
    expect(r.available).toBe(false)
    expect(r.owner).toBe('permission denied')
  })

  it('suggestPort returns the first free default port', async () => {
    h.state.portsInUse.add(8188)
    expect(await svc.suggestPort()).toBe(8189)
  })

  it('suggestPort falls back to a random high port when all defaults are busy', async () => {
    for (const p of [8188, 8189, 8190, 8191, 8192, 8288, 8388]) h.state.portsInUse.add(p)
    const p = await svc.suggestPort()
    expect(p).toBeGreaterThanOrEqual(9000)
    expect(p).toBeLessThan(9500)
  })
})

// ===========================================================================
// start()
// ===========================================================================
describe('start()', () => {
  it('rejects concurrent starts for the same id', async () => {
    register(cfg({ id: 'race' }))
    h.state.fetchImpl = failFetch // keep it not-ready so start blocks ~200ms
    const first = svc.start('race')
    await expect(svc.start('race')).rejects.toThrow(/already in progress/)
    await first
  })

  it('adopts an already-running ComfyUI when /system_stats answers', async () => {
    register(cfg({ id: 'adopt' }))
    h.state.portsInUse.add(8188)
    h.state.fetchImpl = okStats
    const info = await svc.start('adopt')
    expect(info.status).toBe('running')
    expect(info.managed).toBeUndefined() // managed is not on ComfyInstanceInfo
    expect(h.state.spawnCount).toBe(0)
    const logs = svc.getLogs('adopt').map((l) => l.message)
    expect(logs.some((m) => m.includes('Adopted already-running'))).toBe(true)
  })

  it('relocates to a free port when requested and persists the change', async () => {
    register(cfg({ id: 'move', port: 8188 }))
    h.state.portsInUse.add(8188) // configured port busy
    h.state.fetchImpl = failFetch // not ComfyUI on the busy port
    const info = await svc.start('move', { relocatePort: true } as LaunchOptions)
    expect(info.port).toBe(8189)
    expect(h.state.upsertCalls.some((c) => c.id === 'move' && c.port === 8189)).toBe(true)
    expect(h.state.spawnCount).toBe(1)
  })

  it('throws PORT_IN_USE with a suggestion when relocate is not requested', async () => {
    register(cfg({ id: 'busy', port: 8188 }))
    h.state.portsInUse.add(8188)
    h.state.fetchImpl = failFetch
    const err = (await svc.start('busy').catch((e) => e)) as Error & {
      code?: string
      suggestedPort?: number
    }
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('PORT_IN_USE')
    expect(err.suggestedPort).toBe(8189)
    const [info] = svc.list()
    expect(info.status).toBe('error')
    expect(info.lastError).toMatch(/already in use/)
  })

  it('spawns and becomes ready when /system_stats returns system keys', async () => {
    register(cfg({ id: 'ok' }))
    h.state.fetchImpl = okStats
    const info = await svc.start('ok')
    expect(info.status).toBe('running')
    expect(info.pid).toBeGreaterThan(0)
    expect(h.state.spawnCount).toBe(1)
    const child = childOf(svc, 'ok')
    expect(child).toBeTruthy()
    // ready log was emitted
    expect(svc.getLogs('ok').some((l) => l.message.includes('ComfyUI ready'))).toBe(true)
  })

  it('accepts /system_stats that only has devices', async () => {
    register(cfg({ id: 'dev' }))
    h.state.fetchImpl = (url) =>
      String(url).includes('/system_stats')
        ? Promise.resolve({ ok: true, json: async () => ({ devices: [] }) })
        : Promise.resolve({ ok: false, json: async () => ({}) })
    const info = await svc.start('dev')
    expect(info.status).toBe('running')
  })

  it('ignores /system_stats JSON without system/devices keys', async () => {
    register(cfg({ id: 'junk' }))
    h.state.fetchImpl = (url) =>
      String(url).includes('/system_stats')
        ? Promise.resolve({ ok: true, json: async () => ({ hello: 1 }) })
        : Promise.resolve({ ok: false, json: async () => ({}) })
    const info = await svc.start('junk')
    // not ready yet — still starting after the 200ms fast-fail window
    expect(info.status).toBe('starting')
  })

  it('ignores /system_stats JSON parse failures', async () => {
    register(cfg({ id: 'badjson' }))
    h.state.fetchImpl = (url) =>
      String(url).includes('/system_stats')
        ? Promise.resolve({
            ok: true,
            json: async () => {
              throw new Error('bad json')
            }
          })
        : Promise.resolve({ ok: false, json: async () => ({}) })
    const info = await svc.start('badjson')
    expect(info.status).toBe('starting')
  })

  it('fails fast when the process exits within the first 200ms', async () => {
    register(cfg({ id: 'crash' }))
    h.state.spawnExitImmediate = { code: 1, signal: null }
    h.state.fetchImpl = failFetch
    await expect(svc.start('crash')).rejects.toThrow(/Exited with code 1/)
  })

  it('treats exit code 0 as stopped without throwing', async () => {
    register(cfg({ id: 'clean' }))
    h.state.spawnExitImmediate = { code: 0, signal: null }
    h.state.fetchImpl = failFetch
    const info = await svc.start('clean')
    expect(info.status).toBe('stopped')
  })

  it('surfaces spawn exceptions as error status', async () => {
    register(cfg({ id: 'spawnfail' }))
    h.state.spawnFail = new Error('spawn ENOENT')
    await expect(svc.start('spawnfail')).rejects.toThrow(/spawn ENOENT/)
    expect(svc.list()[0].status).toBe('error')
    expect(svc.list()[0].lastError).toBe('spawn ENOENT')
  })

  it('classifies stdout/stderr lines by severity', async () => {
    register(cfg({ id: 'logs' }))
    h.state.fetchImpl = failFetch
    await svc.start('logs')
    const child = childOf(svc, 'logs')
    child.stdout.emit('data', Buffer.from('Traceback (most recent call last):\nWARN careful\nplain info\n'))
    child.stderr.emit('data', Buffer.from('error happened\nsoft warning\n'))
    const levels = svc.getLogs('logs', 200).map((l) => l.level)
    expect(levels).toContain('error')
    expect(levels).toContain('warn')
    expect(levels).toContain('info')
  })

  it('records child process errors and clears the probe', async () => {
    register(cfg({ id: 'cerr' }))
    h.state.fetchImpl = failFetch
    await svc.start('cerr')
    const child = childOf(svc, 'cerr')
    child.emit('error', new Error('aborted'))
    const info = svc.list()[0]
    expect(info.status).toBe('error')
    expect(info.lastError).toBe('aborted')
  })

  it('returns immediately when already running and ready', async () => {
    register(cfg({ id: 're' }))
    h.state.fetchImpl = okStats
    await svc.start('re')
    expect(h.state.spawnCount).toBe(1)
    const info = await svc.start('re')
    expect(info.status).toBe('running')
    expect(h.state.spawnCount).toBe(1) // no second spawn
  })

  it('waits for an existing non-ready process instead of double-spawning', async () => {
    register(cfg({ id: 'wait-in-start' }))
    h.state.fetchImpl = failFetch
    await svc.start('wait-in-start')
    expect(h.state.spawnCount).toBe(1)
    // now make the probe succeed and call start again
    h.state.fetchImpl = okStats
    const info = await svc.start('wait-in-start')
    expect(info.status).toBe('running')
    expect(h.state.spawnCount).toBe(1)
  })

  it('ignores a stale child exit after a newer generation is live', async () => {
    register(cfg({ id: 'gen' }))
    h.state.fetchImpl = okStats
    await svc.start('gen')
    const oldChild = childOf(svc, 'gen')
    await svc.stop('gen')
    await svc.start('gen')
    const newChild = childOf(svc, 'gen')
    expect(newChild).not.toBe(oldChild)
    // stale exit must not clobber the new process state
    oldChild.emit('exit', 1, null)
    const info = svc.list()[0]
    expect(info.status).toBe('running')
    expect(info.pid).toBe(newChild.pid)
  })

  it('startAll starts enabled instances and records failures', async () => {
    register(
      cfg({ id: 'a1', enabled: true }),
      cfg({ id: 'a2', enabled: true, port: 8188 }),
      cfg({ id: 'a3', enabled: false })
    )
    // second instance on same port after first adopted/started → busy conflict
    h.state.portsInUse.add(8188)
    h.state.fetchImpl = okStats
    // both enabled share port 8188; first adopts, second also adopts (same URL)
    const out = await svc.startAll()
    expect(out.length).toBe(2)
    expect(out.every((i) => i.status === 'running')).toBe(true)
  })

  it('startAll logs errors from failing instances', async () => {
    register(cfg({ id: 'f1' }))
    h.state.spawnFail = new Error('nope')
    const out = await svc.startAll()
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('error')
  })
})

// ===========================================================================
// waitReady()
// ===========================================================================
describe('waitReady()', () => {
  it('throws when the instance id is unknown', async () => {
    register()
    await expect(svc.waitReady('ghost')).rejects.toThrow(/not found/)
  })

  it('returns immediately when already ready', async () => {
    register(cfg({ id: 'ready' }))
    h.state.fetchImpl = okStats
    await svc.start('ready')
    const r = await svc.waitReady('ready')
    expect(r.ready).toBe(true)
    expect(r.elapsedMs).toBe(0)
  })

  it('returns the error state without hanging', async () => {
    register(cfg({ id: 'err' }))
    h.state.spawnExitImmediate = { code: 3, signal: null }
    h.state.fetchImpl = failFetch
    await svc.start('err').catch(() => undefined)
    // runtime is in error after the fast-fail
    const r = await svc.waitReady('err')
    expect(r.ready).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('reports not-running when a config exists but no runtime is live', async () => {
    register(cfg({ id: 'cold' }))
    const r = await svc.waitReady('cold')
    expect(r.ready).toBe(false)
    expect(r.error).toBe('Instance is not running')
  })

  it('resolves with a timeout error when readiness never arrives', async () => {
    register(cfg({ id: 'slow' }))
    h.state.fetchImpl = failFetch
    await svc.start('slow')
    const r = await svc.waitReady('slow', 80)
    expect(r.ready).toBe(false)
    expect(r.error).toMatch(/did not become ready within/)
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('settles multiple waiters independently of each other', async () => {
    register(cfg({ id: 'multi' }))
    h.state.fetchImpl = failFetch
    await svc.start('multi')
    const a = svc.waitReady('multi', 50)
    const b = svc.waitReady('multi', 5000)
    // short waiter times out first
    const ra = await a
    expect(ra.ready).toBe(false)
    expect(ra.error).toMatch(/did not become ready/)
    // long waiter is still pending until stop settles it
    h.state.fetchImpl = okStats
    await svc.stop('multi')
    const rb = await b
    expect(rb.ready).toBe(false)
  })

  it('launch() throws when the instance never becomes ready', async () => {
    register(cfg({ id: 'noready' }))
    h.state.fetchImpl = failFetch
    const p = svc.launch('noready')
    // after start() returns (200ms), launch parks in waitReady — then the
    // process dies with a non-zero code and the waiter is settled with error.
    setTimeout(() => {
      childOf(svc, 'noready').emit('exit', 1, null)
    }, 250)
    await expect(p).rejects.toThrow(/Exited with code 1/)
  }, 3000)

  it('launch() returns the info once ready', async () => {
    register(cfg({ id: 'go' }))
    h.state.fetchImpl = okStats
    const info = await svc.launch('go')
    expect(info.status).toBe('running')
  })

  it('launch() returns early when start already produced a ready instance', async () => {
    register(cfg({ id: 'instant' }))
    h.state.fetchImpl = okStats
    // start() path: adopt
    h.state.portsInUse.add(8188)
    const info = await svc.launch('instant')
    expect(info.status).toBe('running')
    expect(h.state.spawnCount).toBe(0)
  })
})

// ===========================================================================
// stop / restart / forceKill / killAllNow
// ===========================================================================
describe('stop()', () => {
  it('sends SIGTERM then escalates to SIGKILL after 3s if still alive', async () => {
    vi.useFakeTimers()
    register(cfg({ id: 'stop' }))
    h.state.fetchImpl = okStats
    const startP = svc.start('stop')
    await vi.advanceTimersByTimeAsync(250)
    await startP
    const child = childOf(svc, 'stop')
    const stopP = svc.stop('stop')
    await vi.advanceTimersByTimeAsync(0)
    await stopP
    expect(child.killSignals).toContain('SIGTERM')
    // process never exits on its own — advance past the escalation window
    expect(child.exitCode).toBeNull()
    await vi.advanceTimersByTimeAsync(3001)
    expect(child.killSignals).toContain('SIGKILL')
  })

  it('does not SIGKILL when the child already exited', async () => {
    vi.useFakeTimers()
    register(cfg({ id: 'dead' }))
    h.state.fetchImpl = okStats
    const startP = svc.start('dead')
    await vi.advanceTimersByTimeAsync(250)
    await startP
    const child = childOf(svc, 'dead')
    const stopP = svc.stop('dead')
    await vi.advanceTimersByTimeAsync(0)
    await stopP
    child.exitCode = 0
    await vi.advanceTimersByTimeAsync(3001)
    expect(child.killSignals).not.toContain('SIGKILL')
  })

  it('warns instead of killing when stopping an adopted external process', async () => {
    register(cfg({ id: 'ext' }))
    h.state.portsInUse.add(8188)
    h.state.fetchImpl = okStats
    await svc.start('ext')
    const info = await svc.stop('ext')
    expect(info.status).toBe('stopped')
    const messages = svc.getLogs('ext').map((l) => l.message)
    expect(messages.some((m) => m.includes('adopted external'))).toBe(true)
  })

  it('throws for unknown ids', async () => {
    await expect(svc.stop('ghost')).rejects.toThrow(/not found/)
  })

  it('stopAll stops every live managed process', async () => {
    register(cfg({ id: 's1' }), cfg({ id: 's2', port: 8189 }))
    h.state.fetchImpl = okStats
    await svc.start('s1')
    await svc.start('s2')
    const out = await svc.stopAll()
    expect(out).toHaveLength(2)
    expect(out.every((i) => i.status === 'stopped')).toBe(true)
  })
})

describe('restart()', () => {
  it('stops, waits for the port to free, then launches again', async () => {
    register(cfg({ id: 're' }))
    h.state.fetchImpl = okStats
    await svc.start('re')
    // after stop the port stays "busy" for two polls, then frees
    let polls = 0
    const realCheck = svc.checkPort.bind(svc)
    const spy = vi.spyOn(svc, 'checkPort').mockImplementation(async (port: number) => {
      polls += 1
      if (polls <= 2) return { port, available: false }
      return realCheck(port)
    })
    const info = await svc.restart('re')
    expect(info.status).toBe('running')
    expect(polls).toBeGreaterThan(2)
    spy.mockRestore()
  })
})

describe('forceKill()', () => {
  it('SIGKILLs a managed child', async () => {
    register(cfg({ id: 'fk' }))
    h.state.fetchImpl = okStats
    await svc.start('fk')
    const child = childOf(svc, 'fk')
    await svc.forceKill('fk')
    expect(child.killSignals).toContain('SIGKILL')
    expect(svc.list()[0].status).toBe('stopped')
  })

  it('falls back to process.kill(pid) when the child handle is gone', async () => {
    register(cfg({ id: 'fk-pid' }))
    h.state.fetchImpl = okStats
    await svc.start('fk-pid')
    const child = childOf(svc, 'fk-pid')
    pokeRuntime(svc, 'fk-pid', { process: undefined, pid: child.pid, managed: true })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    await svc.forceKill('fk-pid')
    expect(killSpy).toHaveBeenCalledWith(child.pid, 'SIGKILL')
    killSpy.mockRestore()
  })

  it('refuses to kill an adopted external process', async () => {
    register(cfg({ id: 'ext' }))
    h.state.portsInUse.add(8188)
    h.state.fetchImpl = okStats
    await svc.start('ext')
    await svc.forceKill('ext')
    const messages = svc.getLogs('ext').map((l) => l.message)
    expect(messages.some((m) => m.includes('refusing to kill'))).toBe(true)
  })

  it('throws for unknown ids', async () => {
    await expect(svc.forceKill('ghost')).rejects.toThrow(/not found/)
  })
})

describe('killAllNow()', () => {
  it('synchronously kills every live child', () => {
    register(cfg({ id: 'k1' }), cfg({ id: 'k2', port: 8189 }))
    // materialize runtime entries, then attach live children
    svc.list()
    const c1 = h.makeChild()
    const c2 = h.makeChild()
    pokeRuntime(svc, 'k1', { process: c1, pid: c1.pid, managed: true, status: 'running' })
    pokeRuntime(svc, 'k2', { process: c2, pid: c2.pid, managed: true, status: 'running' })
    svc.killAllNow()
    expect(c1.killSignals.length).toBeGreaterThan(0)
    expect(c2.killSignals.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// logs ring buffer
// ===========================================================================
describe('getLogs / clearLogs', () => {
  it('caps the in-memory log ring at 5000 lines', async () => {
    register(cfg({ id: 'cap' }))
    h.state.fetchImpl = failFetch
    await svc.start('cap')
    const child = childOf(svc, 'cap')
    for (let i = 0; i < 5001; i++) {
      child.stdout.emit('data', Buffer.from(`line ${i}\n`))
    }
    const logs = svc.getLogs('cap', 10000)
    expect(logs.length).toBe(5000)
    // oldest lines were dropped
    expect(logs[0].message).toContain('line 1')
    expect(logs[logs.length - 1].message).toContain('line 5000')
  })

  it('getLogs honours the limit and unknown ids return empty', async () => {
    register(cfg({ id: 'cap' }))
    h.state.fetchImpl = failFetch
    await svc.start('cap')
    const child = childOf(svc, 'cap')
    child.stdout.emit('data', Buffer.from('a\nb\nc\n'))
    expect(svc.getLogs('cap', 2)).toHaveLength(2)
    expect(svc.getLogs('ghost')).toEqual([])
  })

  it('clearLogs wipes the buffer and reports status', async () => {
    register(cfg({ id: 'clr' }))
    h.state.fetchImpl = failFetch
    await svc.start('clr')
    const child = childOf(svc, 'clr')
    child.stdout.emit('data', Buffer.from('hello\n'))
    expect(svc.getLogs('clr').length).toBeGreaterThan(0)
    expect(svc.clearLogs('clr')).toBe(true)
    expect(svc.getLogs('clr')).toEqual([])
    expect(svc.clearLogs('ghost')).toBe(false)
  })
})

// ===========================================================================
// ready probe deadline + extend window (fake timers)
// ===========================================================================
describe('ready probe timeout', () => {
  it('extends once while the process is alive, then errors', async () => {
    vi.useFakeTimers()
    register(cfg({ id: 'hang' }))
    h.state.fetchImpl = failFetch
    const startP = svc.start('hang')
    await vi.advanceTimersByTimeAsync(250)
    await startP

    const waitP = svc.waitReady('hang', 400_000)
    // first deadline is READY_TIMEOUT_MS (180s)
    await vi.advanceTimersByTimeAsync(181_000)
    const interim = svc.getLogs('hang', 50).map((l) => l.message)
    expect(interim.some((m) => m.includes('extending'))).toBe(true)

    // second deadline is READY_EXTEND_MS (120s) after the extension
    await vi.advanceTimersByTimeAsync(121_000)
    const result = await waitP
    expect(result.ready).toBe(false)
    expect(result.error).toMatch(/did not answer/)
    const finalLogs = svc.getLogs('hang', 200).map((l) => l.message)
    expect(finalLogs.some((m) => m.includes('did not answer'))).toBe(true)
  })

  it('stops polling when the generation moves on', async () => {
    vi.useFakeTimers()
    register(cfg({ id: 'stale-probe' }))
    h.state.fetchImpl = failFetch
    const startP = svc.start('stale-probe')
    await vi.advanceTimersByTimeAsync(250)
    await startP
    // bump generation behind the probe's back
    pokeRuntime(svc, 'stale-probe', { generation: 99 })
    await vi.advanceTimersByTimeAsync(1000)
    // no error was recorded by the stale probe
    expect(svc.list()[0].status).toBe('starting')
  })

  it('stops polling when the process handle vanishes mid-wait', async () => {
    vi.useFakeTimers()
    register(cfg({ id: 'vanish' }))
    h.state.fetchImpl = failFetch
    const startP = svc.start('vanish')
    await vi.advanceTimersByTimeAsync(250)
    await startP
    pokeRuntime(svc, 'vanish', { process: undefined })
    await vi.advanceTimersByTimeAsync(1000)
    expect(svc.list()[0].status).toBe('starting')
  })
})

// ===========================================================================
// branch-fill cases
// ===========================================================================
describe('branch coverage extras', () => {
  it('toInfo falls back to default port/listen when they are empty', () => {
    register(cfg({ id: 'zero', port: 0, listen: '' }))
    const [info] = svc.list()
    expect(info.url).toBe('http://127.0.0.1:8188')
  })

  it('baseUrlOf maps IPv6 wildcards to loopback during adopt', async () => {
    register(cfg({ id: 'v6', listen: '::', port: 8188 }))
    h.state.portsInUse.add(8188)
    const seen: string[] = []
    h.state.fetchImpl = (url) => {
      seen.push(String(url))
      return okStats(url)
    }
    const info = await svc.start('v6')
    expect(info.status).toBe('running')
    // adopt/ready probes must hit loopback, not the raw "::" wildcard
    expect(seen.some((u) => u.startsWith('http://127.0.0.1:8188/'))).toBe(true)
  })

  it('also maps the bracketed IPv6 wildcard', async () => {
    register(cfg({ id: 'v6b', listen: '[::]', port: 8188 }))
    h.state.portsInUse.add(8188)
    const seen: string[] = []
    h.state.fetchImpl = (url) => {
      seen.push(String(url))
      return okStats(url)
    }
    const info = await svc.start('v6b')
    expect(info.status).toBe('running')
    expect(seen.some((u) => u.startsWith('http://127.0.0.1:8188/'))).toBe(true)
  })

  it('exportLaunchScript picks the platform default kind when omitted', async () => {
    register(cfg({ id: 'defkind', name: '' }))
    const dir = join(ROOT, 'export-default')
    const { path: out } = await svc.exportLaunchScript('defkind', { dir })
    // win32 → .bat in this environment
    expect(out.endsWith('.bat') || out.endsWith('.sh')).toBe(true)
    expect(out).toContain('launch-comfyui') // empty name falls back
  })

  it('list() comparator handles unpinned-vs-pinned both ways', () => {
    register(
      cfg({ id: 'u1', name: 'aaa', pinned: false }),
      cfg({ id: 'p1', name: 'mmm', pinned: true }),
      cfg({ id: 'u2', name: 'zzz', pinned: false }),
      cfg({ id: 'p2', name: 'bbb', pinned: true })
    )
    const ids = svc.list().map((i) => i.id)
    expect(ids).toEqual(['p2', 'p1', 'u1', 'u2'])
  })

  it('ensureRuntime refreshes config when the entry already exists', () => {
    register(cfg({ id: 'upd', name: 'First', notes: 'a' }))
    expect(svc.list()[0].name).toBe('First')
    h.state.instances[0] = { ...cfg({ id: 'upd', name: 'Second', notes: 'b' }) }
    expect(svc.list()[0].name).toBe('Second')
  })

  it('skips USERPROFILE/LOCALAPPDATA roots when those env vars are unset', () => {
    delete process.env.USERPROFILE
    delete process.env.LOCALAPPDATA
    delete process.env.COMFYUI_PATH
    h.state.settings.defaultInstancePath = ''
    const found = svc.discover()
    expect(Array.isArray(found)).toBe(true)
  })

  it('dedupes a path scored both as a root and as a child', () => {
    const scan = join(HOME, 'scan')
    write(join(scan, 'main.py'), 'print(1)')
    // scan is both settings.defaultInstancePath AND a child of HOME
    h.state.settings.defaultInstancePath = scan
    const found = svc.discover()
    const hits = found.filter((c) => c.path === scan)
    expect(hits.length).toBeLessThanOrEqual(1)
  })

  it('probeEnv records non-Error exceptions thrown by execFile', async () => {
    register(cfg({ id: 'str-err', pythonPath: 'x' }))
    h.state.execHandler = () => {
      throw 'plain string failure'
    }
    const probe = await svc.probeEnv('str-err')
    expect(probe.errors.some((e) => e.includes('plain string failure'))).toBe(true)
  })

  it('probeEnv tolerates empty torch JSON stdout', async () => {
    register(cfg({ id: 'empty-torch', pythonPath: 'x' }))
    h.state.execHandler = (_c, args) => {
      if (args[0] === '--version') return { stdout: 'Python 3.12' }
      if (args[0] === '-c') return { stdout: '\n' } // last line empty → '{}'
      return { stdout: '[]' }
    }
    const probe = await svc.probeEnv('empty-torch')
    expect(probe.pythonVersion).toBe('Python 3.12')
    expect(probe.packages.some((p) => p.name === 'torch')).toBe(true)
  })

  it('probeEnv handles torch JSON missing the torch key', async () => {
    register(cfg({ id: 'no-torch-ver', pythonPath: 'x' }))
    h.state.execHandler = (_c, args) => {
      if (args[0] === '--version') return { stdout: 'Python 3.12' }
      if (args[0] === '-c') return { stdout: JSON.stringify({ cuda: '11.8' }) }
      return { stdout: '[]' }
    }
    const probe = await svc.probeEnv('no-torch-ver')
    expect(probe.cudaVersion).toBe('11.8')
    expect(probe.packages.find((p) => p.name === 'torch')?.version).toBe('')
  })

  it('exportDiagnostics uses in-memory logs once a runtime exists', async () => {
    register(cfg({ id: 'live-diag' }))
    h.state.fetchImpl = failFetch
    await svc.start('live-diag')
    const child = childOf(svc, 'live-diag')
    child.stdout.emit('data', Buffer.from('from-memory\n'))
    h.state.execHandler = () => ({ error: new Error('skip') })
    const pkg = await svc.exportDiagnostics('live-diag')
    const text = readFileSync(join(pkg.path, 'console.log'), 'utf-8')
    expect(text).toContain('from-memory')
  })

  it('buildArgs treats a falsy string extraArgs as empty', () => {
    register({
      ...cfg({ id: 'empty-extra' }),
      extraArgs: ''
    } as unknown as Record<string, unknown>)
    const preview = svc.previewLaunch('empty-extra')
    expect(preview.args).toEqual([join(COMFY, 'main.py'), '--port', '8188', '--listen', '127.0.0.1'])
  })
})
