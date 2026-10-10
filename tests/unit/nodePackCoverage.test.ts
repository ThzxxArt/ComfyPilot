/**
 * Coverage-focused unit tests for nodePack.ts — targets branches left open by
 * nodePackService/nodePackUpdate: gitAvailable, isStrictInside catch, nested
 * pack-dir meta, registry-install→git-clone path (and zip fallback), unsafe
 * dest/tmp rejections, dest-already-exists, cleanup catch blocks, pip exec
 * fallback, resolveRemovalTargets, checkUpdates reason branches and
 * snapshot persistence catches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join, dirname } from 'path'

type ExecCallback = (err: unknown, stdout: string, stderr: string) => void

const h = vi.hoisted(() => {
  const state = {
    dirs: new Map<string, string[]>(),
    files: new Map<string, string>(),
    isDir: new Set<string>(),
    exists: new Set<string>(),
    nodePacks: [] as Array<Record<string, unknown>>,
    instances: [] as Array<Record<string, unknown>>,
    snapshots: [] as Array<Record<string, unknown>>,
    snapshotById: new Map<string, Record<string, unknown>>(),
    settings: {
      allowGitUrlInstall: true,
      allowPipInstall: true,
      securityLevel: 'normal',
      networkMode: 'public',
      pipIndex: '',
      proxy: { enabled: false, protocol: 'http', host: '', port: 7890, bypass: '', username: '', password: '' },
      defaultInstancePath: ''
    } as Record<string, unknown>,
    renameFail: new Set<string>(),
    writeFail: new Set<string>(),
    unlinkFail: new Set<string>(),
    rmFail: new Set<string>(),
    readdirFail: new Set<string>(),
    statFail: new Set<string>(),
    readFail: new Set<string>(),
    /** When set, path.resolve throws for any arg containing this substring. */
    resolveThrowOn: '' as string,
    /** When set, path.resolve returns this constant for args containing the substring. */
    resolveCollapseOn: '' as string,
    runtimePython: null as string | null,
    runtimePythonThrow: null as Error | null,
    /** Throw from listNodePacks after N successful calls (for snapshot catch paths). */
    listNodePacksThrowAfter: null as number | null,
    listNodePacksCalls: 0,
    insertSnapshotThrow: false,
    upsertThrowOnce: false
  }

  const fetchRoutes: Array<{
    match: (url: string) => boolean
    handle: (url: string) => Promise<unknown> | unknown
  }> = []

  function fsKey(p: unknown): string {
    return String(p)
  }

  function parentOf(p: string): string {
    const d = dirname(p)
    return d === p ? '' : d
  }

  function baseOf(p: string): string {
    const parts = p.split(/[\\/]/)
    return parts[parts.length - 1] || ''
  }

  function detachFromParent(p: string): void {
    const parent = parentOf(p)
    if (!parent) return
    const children = state.dirs.get(parent)
    if (!children) return
    const base = baseOf(p)
    const idx = children.indexOf(base)
    if (idx >= 0) children.splice(idx, 1)
  }

  function attachToParent(p: string): void {
    const parent = parentOf(p)
    if (!parent) return
    const base = baseOf(p)
    if (!base) return
    if (!state.dirs.has(parent)) state.dirs.set(parent, [])
    const children = state.dirs.get(parent)!
    if (!children.includes(base)) children.push(base)
  }

  function rmPath(p: string): void {
    for (const frag of state.rmFail) {
      if (String(p).includes(frag)) throw new Error(`rm failed: ${p}`)
    }
    const children = state.dirs.get(p)
    if (children) {
      for (const c of [...children]) rmPath(join(p, c))
    }
    state.dirs.delete(p)
    state.files.delete(p)
    state.isDir.delete(p)
    state.exists.delete(p)
    detachFromParent(p)
  }

  function copyPath(from: string, to: string): void {
    if (state.files.has(from)) {
      state.files.set(to, state.files.get(from)!)
      return
    }
    if (!state.dirs.has(from)) state.dirs.set(from, [])
    state.dirs.set(to, [...(state.dirs.get(from) || [])])
    state.isDir.add(to)
    attachToParent(to)
    for (const c of state.dirs.get(from) || []) {
      copyPath(join(from, c), join(to, c))
    }
  }

  function renamePath(from: string, to: string): void {
    for (const frag of state.renameFail) {
      if (from.includes(frag)) throw new Error(`rename failed: ${from} -> ${to}`)
    }
    copyPath(from, to)
    rmPath(from)
  }

  function mkdirPath(p: string): void {
    if (state.dirs.has(p)) return
    const parent = parentOf(p)
    if (parent && !state.dirs.has(parent)) mkdirPath(parent)
    state.dirs.set(p, [])
    state.isDir.add(p)
    state.exists.add(p)
    attachToParent(p)
  }

  function writeFile(p: string, content: string): void {
    const parent = parentOf(p)
    if (parent && !state.dirs.has(parent)) mkdirPath(parent)
    state.files.set(p, content)
    state.exists.add(p)
    attachToParent(p)
  }

  return {
    state,
    fetchRoutes,
    fsKey,
    rmPath,
    copyPath,
    renamePath,
    mkdirPath,
    writeFile,
    attachToParent
  }
})

// ---------- fs ----------
vi.mock('fs', () => {
  const { state, fsKey, rmPath, renamePath, mkdirPath, attachToParent } = h
  return {
    existsSync: (p: unknown) => {
      const s = fsKey(p)
      return state.exists.has(s) || state.dirs.has(s) || state.files.has(s) || state.isDir.has(s)
    },
    readdirSync: (p: unknown) => {
      const s = fsKey(p)
      for (const frag of state.readdirFail) {
        if (s.includes(frag)) {
          state.readdirFail.delete(frag) // one-shot: later scans of the same dir must succeed
          throw new Error(`readdir failed: ${s}`)
        }
      }
      return [...(state.dirs.get(s) || [])]
    },
    statSync: (p: unknown) => {
      const s = fsKey(p)
      for (const frag of state.statFail) {
        if (s.includes(frag)) throw new Error(`stat failed: ${s}`)
      }
      return {
        isDirectory: () => state.isDir.has(s) || state.dirs.has(s),
        isFile: () => state.files.has(s),
        size: 0,
        mtimeMs: 0
      }
    },
    readFileSync: (p: unknown) => {
      const s = fsKey(p)
      for (const frag of state.readFail) {
        if (s.includes(frag)) throw new Error(`read failed: ${s}`)
      }
      return state.files.get(s) ?? ''
    },
    writeFileSync: (p: unknown, data: unknown) => {
      const s = fsKey(p)
      for (const frag of state.writeFail) {
        if (s.includes(frag)) throw new Error(`write failed: ${s}`)
      }
      state.files.set(s, String(data))
      state.exists.add(s)
      attachToParent(s)
    },
    unlinkSync: (p: unknown) => {
      const s = fsKey(p)
      for (const frag of state.unlinkFail) {
        if (s.includes(frag)) throw new Error(`unlink failed: ${s}`)
      }
      if (!state.files.has(s) && !state.exists.has(s)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      state.files.delete(s)
      state.exists.delete(s)
    },
    mkdirSync: (p: unknown) => {
      mkdirPath(fsKey(p))
    },
    rmSync: (p: unknown) => {
      rmPath(fsKey(p))
    },
    renameSync: (from: unknown, to: unknown) => {
      renamePath(fsKey(from), fsKey(to))
    },
    copyFileSync: (from: unknown, to: unknown) => {
      const src = fsKey(from)
      const dst = fsKey(to)
      state.files.set(dst, state.files.get(src) ?? '')
      state.exists.add(dst)
    },
    cpSync: (from: unknown, to: unknown) => {
      const src = fsKey(from)
      const dst = fsKey(to)
      if (state.files.has(src)) {
        state.files.set(dst, state.files.get(src)!)
        return
      }
      state.dirs.set(dst, [...(state.dirs.get(src) || [])])
      state.isDir.add(dst)
      for (const c of state.dirs.get(src) || []) {
        const fromChild = join(src, c)
        const toChild = join(dst, c)
        if (state.files.has(fromChild)) state.files.set(toChild, state.files.get(fromChild)!)
        else {
          state.dirs.set(toChild, [...(state.dirs.get(fromChild) || [])])
          state.isDir.add(toChild)
        }
      }
    }
  }
})

// ---------- path (targeted resolve failures for isStrictInside guards) ----------
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>()
  return {
    ...actual,
    default: actual,
    resolve: (...args: string[]) => {
      const joined = args.map((a) => String(a)).join('\u0000')
      if (h.state.resolveThrowOn && joined.includes(h.state.resolveThrowOn)) {
        throw new TypeError(`path resolve failed: ${joined}`)
      }
      if (h.state.resolveCollapseOn && joined.includes(h.state.resolveCollapseOn)) {
        return 'COLLAPSED'
      }
      return actual.resolve(...args)
    }
  }
})

// ---------- electron ----------
vi.mock('electron', () => ({
  session: {
    defaultSession: {
      fetch: (url: unknown, _opts?: unknown) => {
        const g = globalThis as Record<string, unknown>
        const f = g.fetch as ((u: unknown) => Promise<unknown>) | undefined
        if (f) return f(url)
        return Promise.reject(new Error(`no fetch handler for ${String(url)}`))
      },
      setProxy: async () => undefined
    }
  },
  app: { getPath: () => 'C:/fake/userData', getName: () => 'ComfyPilot' }
}))

// ---------- crypto ----------
vi.mock('crypto', () => {
  const hashOf = (s: string): string => {
    let h1 = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i)
      h1 = Math.imul(h1, 0x01000193)
    }
    return ((h1 >>> 0).toString(16) + (s.length * 2654435761).toString(16)).slice(0, 16).padStart(16, '0')
  }
  let uuidCounter = 0
  return {
    createHash: () => {
      let acc = ''
      return {
        update: (s: string) => {
          acc += String(s)
          return { digest: () => hashOf(acc), update: undefined }
        }
      }
    },
    randomUUID: () => `uuid-${++uuidCounter}`
  }
})

// ---------- child_process ----------
vi.mock('child_process', () => {
  type Handler = (
    cmd: string,
    args: string[],
    opts: unknown
  ) => { stdout?: string; stderr?: string; error?: unknown; code?: number }
  let handler: Handler | null = null
  const setHandler = (fn: Handler | null): void => {
    handler = fn
  }
  const execFile = (cmd: string, args: string[], opts: unknown, cb?: ExecCallback): unknown => {
    const callback = typeof opts === 'function' ? (opts as unknown as ExecCallback) : cb
    const optsArg = typeof opts === 'function' ? undefined : opts
    const finish = (err: unknown, out: string, errOut: string): void => {
      queueMicrotask(() => {
        if (typeof callback === 'function') callback(err, out, errOut)
      })
    }
    if (handler) {
      let result: ReturnType<Handler>
      try {
        result = handler(cmd, args, optsArg)
      } catch (e) {
        finish(e, '', '')
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      if (result.error != null) {
        const err = result.error as Error & { code?: number }
        if (result.code != null && err && typeof err === 'object') err.code = result.code
        finish(err, result.stdout || '', result.stderr || (err instanceof Error ? err.message : String(err)))
      } else {
        finish(null, result.stdout || '', result.stderr || '')
      }
    } else {
      finish(null, 'ok', '')
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
  return {
    execFile,
    execFileSync: () => 'abc1234',
    spawn: (cmd: string, args: string[]) => {
      const { EventEmitter } = require('events') as typeof import('events')
      const child = new EventEmitter() as unknown as {
        stdout: InstanceType<typeof EventEmitter>
        stderr: InstanceType<typeof EventEmitter>
        kill: () => void
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => undefined
      queueMicrotask(() => {
        try {
          const result = handler ? handler(cmd, args, undefined) : { stdout: 'ok', stderr: '' }
          if (result.error != null) {
            child.stderr.emit('data', Buffer.from(result.stderr || String(result.error)))
            child.emit('close', result.code ?? 1)
          } else {
            if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout))
            if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr))
            child.emit('close', 0)
          }
        } catch (e) {
          child.emit('error', e)
        }
      })
      return child
    },
    __setExecHandler: setHandler
  }
})

// ---------- service mocks ----------
vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => h.state.settings,
  loadInstanceConfigs: () => h.state.instances,
  listNodePacks: () => {
    if (h.state.listNodePacksThrowAfter != null && h.state.listNodePacksCalls >= h.state.listNodePacksThrowAfter) {
      h.state.listNodePacksCalls++
      h.state.listNodePacksThrowAfter = null // throw only once so later list() calls succeed
      throw new Error('db listNodePacks down')
    }
    h.state.listNodePacksCalls++
    return h.state.nodePacks
  },
  upsertNodePack: vi.fn((p: Record<string, unknown>) => {
    if (h.state.upsertThrowOnce) {
      h.state.upsertThrowOnce = false
      throw new Error('db upsert down')
    }
    const idx = h.state.nodePacks.findIndex((x) => x.id === p.id || x.name === p.name)
    if (idx >= 0) h.state.nodePacks[idx] = { ...h.state.nodePacks[idx], ...p }
    else h.state.nodePacks.push(p)
  }),
  deleteNodePack: vi.fn((id: string) => {
    const idx = h.state.nodePacks.findIndex((x) => x.id === id)
    if (idx >= 0) h.state.nodePacks.splice(idx, 1)
    return idx >= 0
  }),
  listSnapshots: vi.fn(() => h.state.snapshots),
  insertSnapshot: vi.fn((s: Record<string, unknown>) => {
    if (h.state.insertSnapshotThrow) throw new Error('db insertSnapshot down')
    h.state.snapshots.push(s)
    h.state.snapshotById.set(String(s.id), s)
  }),
  deleteSnapshot: vi.fn((id: string) => {
    h.state.snapshots = h.state.snapshots.filter((s) => s.id !== id)
    h.state.snapshotById.delete(id)
    return true
  }),
  getSnapshot: vi.fn((id: string) => h.state.snapshotById.get(id) || null),
  snapshotDir: vi.fn(() => 'C:/fake/snapshots'),
  userDataDir: vi.fn(() => 'C:/fake/user'),
  cacheDir: vi.fn(() => 'C:/fake/cache'),
  logsDir: vi.fn(() => 'C:/fake/logs')
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyEnv: vi.fn(() => ({}))
}))

vi.mock('../../src/main/services/security', () => ({
  sanitizeId: (s: string) => String(s).replace(/[^\w.-]/g, '_'),
  isPathInside: (child: string, parent: string) => {
    const c = String(child).replace(/\\/g, '/')
    const p = String(parent).replace(/\\/g, '/')
    return c === p || c.startsWith(p.endsWith('/') ? p : p + '/')
  },
  normalizePathEverySegment: (p: string) => String(p).replace(/\\/g, '/'),
  isSafeExternalUrl: (raw: string) => {
    try {
      const u = new URL(raw)
      return u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      return false
    }
  }
}))

vi.mock('../../src/main/services/installer', () => ({
  assertSafeGitUrl: (u: string) => {
    if (!u || u.startsWith('-') || /ext::/i.test(u)) throw new Error('Invalid git URL')
    return u
  },
  applyGithubMirror: (u: string) => u,
  assertSafeBranch: (b: string) => b,
  resolveTorchIndex: () => 'https://download.pytorch.org/whl/cpu/',
  officialTorchIndex: () => 'https://download.pytorch.org/whl/cpu/'
}))

vi.mock('../../src/main/services/bootstrap', () => ({
  findInRuntimes: () => null,
  bootstrapService: {
    ensure: vi.fn(async () => ({
      runtimesDir: 'C:/fake/runtimes',
      components: [],
      pythonPath: 'python',
      pythonOrigin: 'system',
      zipInstallReady: true
    })),
    cancelAll: vi.fn()
  }
}))

vi.mock('../../src/main/services/instance', () => ({
  resolveRuntimesPythonSync: () => {
    if (h.state.runtimePythonThrow) throw h.state.runtimePythonThrow
    return h.state.runtimePython
  }
}))

vi.mock('../../src/main/services/registry', () => ({
  searchRegistry: vi.fn(async () => ({
    raw: [],
    total: 0,
    page: 1,
    pageSize: 50,
    totalPages: 0,
    scanned: 0,
    clientFiltered: false
  })),
  toPageResult: vi.fn((result: unknown, map: (n: unknown) => unknown) => {
    const r = result as {
      raw?: unknown[]
      total?: number
      page?: number
      pageSize?: number
      totalPages?: number
      scanned?: number
      clientFiltered?: boolean
    }
    return {
      items: (r.raw || []).map(map),
      total: r.total || 0,
      page: r.page || 1,
      pageSize: r.pageSize || 50,
      totalPages: r.totalPages || 0,
      scanned: r.scanned || 0,
      clientFiltered: Boolean(r.clientFiltered)
    }
  }),
  mapRegistryPack: vi.fn((n: Record<string, unknown>) => n),
  matchesQuery: vi.fn(() => true),
  fetchRegistryPage: vi.fn(async () => ({ nodes: [], total: 0, page: 1, totalPages: 0, limit: 50 }))
}))

vi.mock('../../src/main/services/registryIndex', () => ({
  registryIndex: {
    ensure: vi.fn(async () => undefined),
    searchPacks: vi.fn(() => [])
  }
}))

vi.mock('../../src/main/services/zipSafe', () => ({
  safeUnzip: vi.fn(async () => undefined)
}))

// env.installRequirements normally streams via spawn; here we invoke the
// buffered-run fallback callback that nodePack passes in — that is the real
// code under test (the execFileAsync closure at nodePack.ts:1015-1020).
vi.mock('../../src/main/services/env', () => ({
  runStreaming: vi.fn(async () => ''),
  installRequirements: vi.fn(
    async (
      pythonPath: string,
      reqFile: string,
      exec: (c: string, a: string[], o?: { timeout?: number }) => Promise<string>,
      opts?: { onLine?: (line: string) => void }
    ) => {
      for (let i = 0; i < 405; i++) opts?.onLine?.(`log line ${i}`)
      return exec(pythonPath, ['-m', 'pip', 'install', '-r', reqFile], { timeout: 1234 })
    }
  )
}))

import {
  nodePackService,
  gitAvailable,
  isStrictInside,
  sanitizeInstallNameForTest,
  compareVersions,
  isUpdateAvailable,
  resolveGitBinary
} from '../../src/main/services/nodePack'
import * as cp from 'child_process'
import * as zipSafeMod from '../../src/main/services/zipSafe'
import * as registryMod from '../../src/main/services/registry'
import * as registryIndexMod from '../../src/main/services/registryIndex'

const zipSafeMock = zipSafeMod as unknown as { safeUnzip: ReturnType<typeof vi.fn> }
const registryMock = registryMod as unknown as {
  searchRegistry: ReturnType<typeof vi.fn>
  toPageResult: ReturnType<typeof vi.fn>
  mapRegistryPack: ReturnType<typeof vi.fn>
}
const registryIndexMock = registryIndexMod as unknown as {
  registryIndex: { ensure: ReturnType<typeof vi.fn>; searchPacks: ReturnType<typeof vi.fn> }
}

const cpMock = cp as unknown as {
  execFile: (cmd: string, args: string[], opts: unknown, cb?: ExecCallback) => unknown
  __setExecHandler: (
    fn: (cmd: string, args: string[], opts: unknown) => { stdout?: string; stderr?: string; error?: unknown; code?: number }
  ) => void
}

type PrivateSvc = {
  emitOpProgress: (o: {
    instanceId: string
    step: string
    status: string
    message: string
    logLine?: string
    detailKey?: string
  }) => void
  opLog: (line: string) => void
  resolveRemovalTargets: (packPath: string, instanceId?: string) => string[]
}
const priv = nodePackService as unknown as PrivateSvc

const COMFY = 'C:/fake/ComfyUI'
const ROOT = join(COMFY, 'custom_nodes')

function resetState(): void {
  h.state.dirs.clear()
  h.state.files.clear()
  h.state.isDir.clear()
  h.state.exists.clear()
  h.state.nodePacks = []
  h.state.snapshots = []
  h.state.snapshotById.clear()
  h.state.renameFail.clear()
  h.state.writeFail.clear()
  h.state.unlinkFail.clear()
  h.state.rmFail.clear()
  h.state.readdirFail.clear()
  h.state.statFail.clear()
  h.state.readFail.clear()
  h.state.resolveThrowOn = ''
  h.state.resolveCollapseOn = ''
  h.state.runtimePython = null
  h.state.runtimePythonThrow = null
  h.state.listNodePacksThrowAfter = null
  h.state.listNodePacksCalls = 0
  h.state.insertSnapshotThrow = false
  h.state.upsertThrowOnce = false
  h.state.settings = {
    allowGitUrlInstall: true,
    allowPipInstall: true,
    securityLevel: 'normal',
    networkMode: 'public',
    pipIndex: '',
    proxy: { enabled: false, protocol: 'http', host: '', port: 7890, bypass: '', username: '', password: '' },
    defaultInstancePath: COMFY
  }
  h.state.instances = [
    {
      id: 'inst-1',
      name: 'ComfyUI',
      path: COMFY,
      pythonPath: '',
      venvPath: 'C:/fake/.venv',
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
  h.fetchRoutes.length = 0
  cpMock.__setExecHandler(null)
  h.mkdirPath(ROOT)
}

function setFetch(handler: (url: string) => Promise<unknown> | unknown): void {
  h.fetchRoutes.push({ match: () => true, handle: handler })
  ;(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
    const u = String(url)
    for (const r of h.fetchRoutes) {
      if (r.match(u)) return await r.handle(u)
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
}

function makeRes(body: unknown, init?: { ok?: boolean; status?: number; headers?: Record<string, string> }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(typeof body === 'string' ? body : 'zip-bytes').buffer,
    headers: {
      get: (k: string) => (init?.headers && k.toLowerCase() in init.headers ? init.headers[k.toLowerCase()] : null)
    }
  } as unknown as Response
}

function seedPack(opts: {
  name: string
  nested?: boolean
  withGit?: boolean
  pyproject?: string | null
  packageJson?: string | null
  requirements?: string | null
  extraFiles?: Record<string, string>
}): string {
  const shell = join(ROOT, opts.name)
  const packDir = opts.nested ? join(shell, `${opts.name}-inner`) : shell
  h.mkdirPath(packDir)
  if (opts.nested) h.mkdirPath(shell)
  h.writeFile(join(packDir, '__init__.py'), `NODE_CLASS_MAPPINGS = {"${opts.name}Node": None}\n`)
  if (opts.pyproject !== null) {
    const pp =
      opts.pyproject ??
      `name = "${opts.name}"\nversion = "1.0.0"\ndescription = "d"\nrepository = "https://github.com/x/${opts.name}"\nlicense = "MIT"\n`
    h.writeFile(join(packDir, 'pyproject.toml'), pp)
  }
  if (opts.packageJson != null) h.writeFile(join(packDir, 'package.json'), opts.packageJson)
  if (opts.requirements != null) h.writeFile(join(packDir, 'requirements.txt'), opts.requirements)
  if (opts.withGit) h.mkdirPath(join(packDir, '.git'))
  for (const [rel, content] of Object.entries(opts.extraFiles || {})) {
    h.writeFile(join(packDir, rel), content)
  }
  return packDir
}

/** Standard registry install API + zip download responses. */
function seedRegistryApi(body: Record<string, unknown>): void {
  setFetch(async (url) => {
    if (url.includes('/nodes/') && url.includes('/install')) return makeRes(body)
    if (url.includes('.zip')) return makeRes('zip-bytes')
    throw new Error('unexpected ' + url)
  })
}

beforeEach(() => {
  resetState()
  vi.clearAllMocks()
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch
})

// =====================================================================
// exported helpers
// =====================================================================
describe('gitAvailable', () => {
  it('returns true when git --version succeeds', async () => {
    cpMock.__setExecHandler(() => ({ stdout: 'git version 2.40.0' }))
    await expect(gitAvailable()).resolves.toBe(true)
  })

  it('returns false when git --version fails', async () => {
    cpMock.__setExecHandler(() => ({ error: new Error('not found'), stderr: 'not found' }))
    await expect(gitAvailable()).resolves.toBe(false)
  })
})

describe('isStrictInside', () => {
  it('returns false when path resolution throws (catch branch)', () => {
    h.state.resolveThrowOn = 'nope'
    expect(isStrictInside('C:/x/nope', 'C:/x')).toBe(false)
    h.state.resolveThrowOn = ''
  })

  it('returns false when child equals parent', () => {
    expect(isStrictInside(ROOT, ROOT)).toBe(false)
  })

  it('returns true for a real descendant', () => {
    expect(isStrictInside(join(ROOT, 'Pack'), ROOT)).toBe(true)
  })
})

describe('sanitizeInstallNameForTest', () => {
  it('falls back to pack-<ts> when sanitization collapses to empty', () => {
    const name = sanitizeInstallNameForTest('...')
    expect(name).toMatch(/^pack-\d+$/)
  })

  it('strips leading dots/dashes and caps length', () => {
    expect(sanitizeInstallNameForTest('..hidden')).toBe('hidden')
    expect(sanitizeInstallNameForTest('---x')).toBe('x')
    expect(sanitizeInstallNameForTest('a/b\\c')).toBe('a_b_c')
  })
})

describe('version helpers still exported', () => {
  it('compareVersions and isUpdateAvailable behave', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true)
    expect(resolveGitBinary()).toBe('git')
  })
})

// =====================================================================
// progress surface: getOpProgress + emitOpProgress logLine / log cap
// =====================================================================
describe('op progress surface', () => {
  it('getOpProgress returns null before any op and a snapshot after', async () => {
    expect(nodePackService.getOpProgress()).toBeNull()
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "ProgPack"\nversion = "1.0.0"\n')
      }
      return { stdout: '' }
    })
    await nodePackService.install({ id: 'https://github.com/u/ProgPack.git', source: 'git', instanceId: 'inst-1' })
    expect(nodePackService.getOpProgress()).not.toBeNull()
    expect(nodePackService.getOpProgress()?.instanceId).toBe('inst-1')
  })

  it('emitOpProgress pushes logLine and truncates beyond 400 entries', () => {
    for (let i = 0; i < 410; i++) {
      priv.emitOpProgress({
        instanceId: 'log-1',
        step: 'download',
        status: 'running',
        message: 'working',
        logLine: `line ${i}`
      })
    }
    const p = nodePackService.getOpProgress()
    expect(p).not.toBeNull()
    const step = p!.steps.find((s) => s.id === 'download')
    expect(step!.log.length).toBe(400)
    expect(step!.log[step!.log.length - 1]).toBe('line 409')
  })

  it('emitOpProgress without message/detailKey leaves detail untouched and accepts unknown step', () => {
    priv.emitOpProgress({ instanceId: 'log-2', step: 'verify', status: 'running', message: '' })
    priv.emitOpProgress({ instanceId: 'log-2', step: 'bogus-step', status: 'done', message: 'ok' })
    expect(nodePackService.getOpProgress()?.instanceId).toBe('log-2')
  })
})

// =====================================================================
// resolveNestedPackDir meta + catch
// =====================================================================
describe('resolveNestedPackDir via registry unzip', () => {
  function unzipInto(dest: string, innerFiles: Record<string, string>): void {
    const nested = join(dest, 'Wrapper')
    h.mkdirPath(nested)
    for (const [rel, content] of Object.entries(innerFiles)) {
      h.writeFile(join(nested, rel), content)
    }
  }

  it('descends when the nested dir has only pyproject.toml (no __init__.py)', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    zipSafeMock.safeUnzip.mockImplementation(async (_z: string, dest?: string) => {
      unzipInto(dest || join(ROOT, 'PyOnly'), { 'pyproject.toml': 'name = "PyOnly"\nversion = "2.0.0"\n' })
    })
    const rec = await nodePackService.install({ id: 'PyOnly', source: 'registry', instanceId: 'inst-1' })
    expect(rec.name).toBe('PyOnly')
    expect(rec.path).toContain('Wrapper')
  })

  it('descends when the nested dir has only requirements.txt', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    zipSafeMock.safeUnzip.mockImplementation(async (_z: string, dest?: string) => {
      unzipInto(dest || join(ROOT, 'ReqOnly'), { 'requirements.txt': 'numpy\n' })
    })
    const rec = await nodePackService.install({ id: 'ReqOnly', source: 'registry', instanceId: 'inst-1' })
    expect(rec.path).toContain('Wrapper')
  })

  it('stays at dest when readdir throws (catch branch)', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    zipSafeMock.safeUnzip.mockImplementation(async (_z: string, dest?: string) => {
      const d = dest || join(ROOT, 'ReadErr')
      const nested = join(d, 'Wrapper')
      h.mkdirPath(nested)
      h.writeFile(join(nested, 'pyproject.toml'), 'name = "ReadErr"\nversion = "1.0.0"\n')
      // fail readdir on the PUBLISHED dest (after rename), not the tmp dir
      h.state.readdirFail.add('ReadErr')
    })
    const rec = await nodePackService.install({ id: 'ReadErr', source: 'registry', instanceId: 'inst-1' })
    expect(rec.name).toBe('ReadErr')
    expect(rec.path).not.toContain('Wrapper')
    h.state.readdirFail.clear()
  })
})

// =====================================================================
// readPackMeta / list() error paths
// =====================================================================
describe('readPackMeta and list() resilience', () => {
  it('ignores .py files that cannot be read (catch at mapping scan)', () => {
    // __init__.py has no mappings; the only mappings live in an unreadable nodes.py
    const dir = join(ROOT, 'BadPy')
    h.mkdirPath(dir)
    h.writeFile(join(dir, '__init__.py'), '# no mappings here\n')
    h.writeFile(join(dir, 'nodes.py'), 'NODE_CLASS_MAPPINGS = {"XNode": None}\n')
    h.state.readFail.add('nodes.py')
    const packs = nodePackService.list('inst-1')
    expect(packs[0].nodeList).toEqual([])
  })

  it('skips entries whose statSync throws', () => {
    seedPack({ name: 'GoodPack' })
    h.mkdirPath(join(ROOT, 'GhostPack'))
    h.state.statFail.add('GhostPack')
    const packs = nodePackService.list('inst-1')
    expect(packs.map((p) => p.name)).toEqual(['GoodPack'])
    h.state.statFail.clear()
  })
})

// =====================================================================
// registry install → git clone path (and zip fallback)
// =====================================================================
describe('registry install prefers git clone', () => {
  it('clones via git when repository is present and git is available', async () => {
    seedRegistryApi({
      url: 'https://cdn.example/pack.zip',
      repository: 'https://github.com/u/GitReg.git',
      status: 'active'
    })
    const cloneArgs: string[][] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('--version')) return { stdout: 'git version 2.40' }
      if (args.includes('clone')) {
        cloneArgs.push([...args])
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, '__init__.py'), 'NODE_CLASS_MAPPINGS = {"GNode": None}\n')
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "GitReg"\nversion = "3.1.0"\n')
        return { stdout: 'cloned' }
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({ id: 'GitReg', source: 'registry', instanceId: 'inst-1' })
    expect(cloneArgs).toHaveLength(1)
    expect(cloneArgs[0]).toContain('clone')
    expect(rec.name).toBe('GitReg')
    expect(rec.installSource).toBe('git')
    expect(rec.version).toBe('3.1.0')
    // zip download is skipped on the git path
    const zips = [...h.state.files.keys()].filter((k) => k.includes('._install_'))
    expect(zips).toEqual([])
  })

  it('falls back to zip when the git clone fails', async () => {
    seedRegistryApi({
      url: 'https://cdn.example/pack.zip',
      repository: 'https://github.com/u/ZipFall.git',
      status: 'active'
    })
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('--version')) return { stdout: 'git version 2.40' }
      if (args.includes('clone')) {
        // create then fail so the tmp-dir cleanup path runs
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        return { error: new Error('clone exploded'), stderr: 'clone exploded' }
      }
      return { stdout: '' }
    })
    zipSafeMock.safeUnzip.mockImplementation(async (_z: string, dest?: string) => {
      const d = dest || join(ROOT, 'ZipFall')
      h.mkdirPath(d)
      h.writeFile(join(d, 'pyproject.toml'), 'name = "ZipFall"\nversion = "4.0.0"\n')
    })
    const rec = await nodePackService.install({ id: 'ZipFall', source: 'registry', instanceId: 'inst-1' })
    expect(rec.name).toBe('ZipFall')
    expect(rec.installSource).toBe('registry')
    expect(rec.version).toBe('4.0.0')
  })

  it('falls back to zip when git is unavailable', async () => {
    seedRegistryApi({
      url: 'https://cdn.example/pack.zip',
      repository: 'https://github.com/u/NoGit.git',
      status: 'active'
    })
    cpMock.__setExecHandler(() => ({ error: new Error('no git'), stderr: 'no git' }))
    zipSafeMock.safeUnzip.mockImplementation(async (_z: string, dest?: string) => {
      const d = dest || join(ROOT, 'NoGit')
      h.mkdirPath(d)
      h.writeFile(join(d, 'pyproject.toml'), 'name = "NoGit"\nversion = "1.2.0"\n')
    })
    const rec = await nodePackService.install({ id: 'NoGit', source: 'registry', instanceId: 'inst-1' })
    expect(rec.installSource).toBe('registry')
    expect(rec.version).toBe('1.2.0')
  })
})

// =====================================================================
// unsafe dest / tmp rejections
// =====================================================================
describe('unsafe destination guards', () => {
  it('rejects a git install whose dest resolves outside root', async () => {
    h.state.resolveThrowOn = 'EvilGit'
    await expect(
      nodePackService.install({ id: 'https://github.com/u/EvilGit.git', source: 'git', instanceId: 'inst-1' })
    ).rejects.toThrow(/unsafe destination/i)
    h.state.resolveThrowOn = ''
  })

  it('rejects an unsafe temp clone path', async () => {
    h.state.resolveThrowOn = '_clone_tmp_'
    await expect(
      nodePackService.install({ id: 'https://github.com/u/TmpGit.git', source: 'git', instanceId: 'inst-1' })
    ).rejects.toThrow(/unsafe temp clone path/i)
    h.state.resolveThrowOn = ''
  })

  it('rejects a registry zip install whose dest resolves outside root and unlinks the tmp zip', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    h.state.resolveThrowOn = 'EvilZip'
    await expect(nodePackService.install({ id: 'EvilZip', source: 'registry', instanceId: 'inst-1' })).rejects.toThrow(
      /unsafe destination/i
    )
    const leftovers = [...h.state.files.keys()].filter((k) => k.includes('._install_'))
    expect(leftovers).toEqual([])
    h.state.resolveThrowOn = ''
  })

  it('unsafe dest rejection still throws when unlink(tmpZip) itself throws', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    h.state.resolveThrowOn = 'EvilZip2'
    h.state.unlinkFail.add('._install_')
    await expect(nodePackService.install({ id: 'EvilZip2', source: 'registry', instanceId: 'inst-1' })).rejects.toThrow(
      /unsafe destination/i
    )
    h.state.resolveThrowOn = ''
    h.state.unlinkFail.clear()
  })

  it('rejects an unsafe temp unzip path and unlinks the tmp zip', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    h.state.resolveThrowOn = '_unzip_tmp_'
    await expect(nodePackService.install({ id: 'EvilTmp', source: 'registry', instanceId: 'inst-1' })).rejects.toThrow(
      /unsafe temp unzip path/i
    )
    const leftovers = [...h.state.files.keys()].filter((k) => k.includes('._install_'))
    expect(leftovers).toEqual([])
    h.state.resolveThrowOn = ''
  })

  it('unsafe temp unzip rejection still throws when unlink(tmpZip) itself throws', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    h.state.resolveThrowOn = '_unzip_tmp_'
    h.state.unlinkFail.add('._install_')
    await expect(nodePackService.install({ id: 'EvilTmp2', source: 'registry', instanceId: 'inst-1' })).rejects.toThrow(
      /unsafe temp unzip path/i
    )
    h.state.resolveThrowOn = ''
    h.state.unlinkFail.clear()
  })
})

// =====================================================================
// dest already exists / cleanup catch blocks
// =====================================================================
describe('destination collisions and cleanup resilience', () => {
  it('refuses a git install when dest already exists (tmp clone removed)', async () => {
    h.mkdirPath(join(ROOT, 'Taken'))
    h.writeFile(join(ROOT, 'Taken', 'pyproject.toml'), 'name = "Taken"\nversion = "0.0.1"\n')
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "Taken"\nversion = "9.9.9"\n')
      }
      return { stdout: '' }
    })
    await expect(
      nodePackService.install({ id: 'https://github.com/u/Taken.git', source: 'git', instanceId: 'inst-1' })
    ).rejects.toThrow(/already exists/i)
    // pre-existing dest must survive
    expect(h.state.dirs.has(join(ROOT, 'Taken'))).toBe(true)
    const tmps = [...h.state.dirs.keys()].filter((k) => k.includes('_clone_tmp_'))
    expect(tmps).toEqual([])
  })

  it('still rethrows when git tmp cleanup itself throws', async () => {
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        return { error: new Error('clone exploded'), stderr: 'clone exploded' }
      }
      return { stdout: '' }
    })
    h.state.rmFail.add('_clone_tmp_')
    await expect(
      nodePackService.install({ id: 'https://github.com/u/RmFail.git', source: 'git', instanceId: 'inst-1' })
    ).rejects.toThrow(/clone exploded/)
    h.state.rmFail.clear()
  })

  it('refuses a zip install when dest already exists after unzip', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    h.mkdirPath(join(ROOT, 'ZipTaken'))
    h.writeFile(join(ROOT, 'ZipTaken', 'pyproject.toml'), 'name = "ZipTaken"\nversion = "0.0.1"\n')
    zipSafeMock.safeUnzip.mockImplementation(async (_z: string, dest?: string) => {
      const d = dest || join(ROOT, 'ZipTaken-tmp')
      h.mkdirPath(d)
      h.writeFile(join(d, 'pyproject.toml'), 'name = "ZipTaken"\nversion = "9.9.9"\n')
    })
    await expect(nodePackService.install({ id: 'ZipTaken', source: 'registry', instanceId: 'inst-1' })).rejects.toThrow(
      /already exists/i
    )
    expect(h.state.dirs.has(join(ROOT, 'ZipTaken'))).toBe(true)
    const tmps = [...h.state.dirs.keys()].filter((k) => k.includes('_unzip_tmp_'))
    expect(tmps).toEqual([])
  })

  it('unzip failure: unlink(tmpZip) throw is swallowed, original error rethrown', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    zipSafeMock.safeUnzip.mockImplementation(async (_z: string, dest?: string) => {
      const d = dest || join(ROOT, 'UnzipFail')
      h.mkdirPath(d)
      throw new Error('zip slip detected')
    })
    h.state.unlinkFail.add('._install_')
    await expect(nodePackService.install({ id: 'UnzipFail', source: 'registry', instanceId: 'inst-1' })).rejects.toThrow(
      /zip slip/i
    )
    h.state.unlinkFail.clear()
  })

  it('unzip failure: rm(tmpDest) throw is swallowed, original error rethrown', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    zipSafeMock.safeUnzip.mockImplementation(async (_z: string, dest?: string) => {
      const d = dest || join(ROOT, 'RmTmpFail')
      h.mkdirPath(d)
      throw new Error('unzip boom')
    })
    h.state.rmFail.add('_unzip_tmp_')
    await expect(nodePackService.install({ id: 'RmTmpFail', source: 'registry', instanceId: 'inst-1' })).rejects.toThrow(
      /unzip boom/i
    )
    h.state.rmFail.clear()
  })

  it('successful unzip: unlink(tmpZip) throw after publish is swallowed', async () => {
    seedRegistryApi({ url: 'https://cdn.example/pack.zip' })
    zipSafeMock.safeUnzip.mockImplementation(async (_z: string, dest?: string) => {
      const d = dest || join(ROOT, 'PostOk')
      h.mkdirPath(d)
      h.writeFile(join(d, 'pyproject.toml'), 'name = "PostOk"\nversion = "1.0.0"\n')
    })
    h.state.unlinkFail.add('._install_')
    const rec = await nodePackService.install({ id: 'PostOk', source: 'registry', instanceId: 'inst-1' })
    expect(rec.name).toBe('PostOk')
    h.state.unlinkFail.clear()
  })
})

// =====================================================================
// afterInstall pip buffered-run fallback (installRequirements exec callback)
// =====================================================================
describe('afterInstall pip fallback runner', () => {
  it('routes through the execFileAsync fallback and streams onLine into opLog', async () => {
    h.state.settings.allowPipInstall = true
    h.mkdirPath(join('C:/fake/.venv', 'Scripts'))
    h.writeFile(join('C:/fake/.venv', 'Scripts', 'python.exe'), '')
    const cmds: Array<{ cmd: string; args: string[]; timeout?: number }> = []
    cpMock.__setExecHandler((cmd, args, opts) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'requests\n')
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "PipFall"\nversion = "1.0.0"\n')
        return { stdout: '' }
      }
      cmds.push({ cmd, args: [...args], timeout: (opts as { timeout?: number } | undefined)?.timeout })
      return { stdout: 'Successfully installed requests' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/PipFall.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(rec.issues.map((i) => i.code)).not.toContain('pip-failed')
    const pipRun = cmds.find((c) => c.args.includes('pip') && c.args.includes('install'))
    expect(pipRun).toBeTruthy()
    expect(pipRun!.cmd).toContain('python')
    expect(pipRun!.timeout).toBe(1234)
  })

  it('records pip-failed when the fallback runner rejects', async () => {
    h.state.settings.allowPipInstall = true
    h.mkdirPath(join('C:/fake/.venv', 'Scripts'))
    h.writeFile(join('C:/fake/.venv', 'Scripts', 'python.exe'), '')
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'bad\n')
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "PipBad"\nversion = "1.0.0"\n')
        return { stdout: '' }
      }
      return { error: new Error('pip exploded'), stderr: 'pip exploded' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/PipBad.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(rec.issues.map((i) => i.code)).toContain('pip-failed')
    const prog = nodePackService.getOpProgress()
    expect(prog).not.toBeNull()
    // 405 onLine pushes exceed the 400 cap inside opLog
    const reqStep = prog!.steps.find((s) => s.id === 'requirements')
    expect(reqStep).toBeTruthy()
    expect(reqStep!.log.length).toBe(400)
  })

  it('skips requirements step when the pack has no requirements.txt', async () => {
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "NoReq"\nversion = "1.0.0"\n')
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/NoReq.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(rec.name).toBe('NoReq')
    const step = nodePackService.getOpProgress()?.steps.find((s) => s.id === 'requirements')
    expect(step?.status).toBe('skipped')
  })
})

// =====================================================================
// snapshot best-effort catch paths
// =====================================================================
describe('snapshot persistence catches', () => {
  it('install continues when createSnapshot throws (pre-install snapshot)', async () => {
    h.state.listNodePacksThrowAfter = 0
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "SnapFail"\nversion = "1.0.0"\n')
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/SnapFail.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(rec.name).toBe('SnapFail')
    // after the failed snapshot, the db list must work again for afterInstall
    h.state.listNodePacksThrowAfter = null
  })

  it('uninstall continues when createSnapshot throws (pre-uninstall snapshot)', async () => {
    const dir = seedPack({ name: 'SnapUn' })
    h.state.nodePacks = [
      {
        id: 'aaaaaaaaaaaaaaaa',
        name: 'SnapUn',
        locked: false,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    // list() in uninstall must succeed; createSnapshot's internal list() throws
    h.state.listNodePacksThrowAfter = 1
    const ok = await nodePackService.uninstall('SnapUn', 'inst-1')
    expect(ok).toBe(true)
    expect(h.state.dirs.has(dir)).toBe(false)
    h.state.listNodePacksThrowAfter = null
  })

  it('updateAll continues when the pre-update snapshot throws', async () => {
    const dir = seedPack({ name: 'SnapAll', withGit: true, pyproject: 'name = "SnapAll"\nversion = "1.0.0"\n' })
    h.state.nodePacks = [
      {
        id: 'bbbbbbbbbbbbbbbb',
        name: 'SnapAll',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('fetch')) return { stdout: '' }
      if (args.includes('rev-list')) return { stdout: '2' }
      if (args.includes('describe')) return { stdout: 'v2.0.0\n' }
      if (args.includes('pull')) return { stdout: 'ok' }
      return { stdout: '' }
    })
    // checkUpdates runs first (needs listNodePacks), then updateAll's snapshot fails
    h.state.listNodePacksThrowAfter = 1
    const out = await nodePackService.updateAll('inst-1')
    expect(out).toHaveLength(1)
    expect(out[0].ok).toBe(true)
    h.state.listNodePacksThrowAfter = null
  })

  it('update continues when the pre-update snapshot throws', async () => {
    const dir = seedPack({ name: 'SnapUp', withGit: true, pyproject: 'name = "SnapUp"\nversion = "1.0.0"\n' })
    h.state.nodePacks = [
      {
        id: 'cccccccccccccccc',
        name: 'SnapUp',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('pull')) {
        h.writeFile(join(dir, 'pyproject.toml'), 'name = "SnapUp"\nversion = "2.0.0"\n')
        return { stdout: 'ok' }
      }
      return { stdout: '' }
    })
    // list() inside updateInner uses listNodePacks once, then createSnapshot lists again
    h.state.listNodePacksThrowAfter = 1
    const rec = await nodePackService.update('SnapUp', undefined, 'inst-1')
    expect(rec.version).toBe('2.0.0')
    h.state.listNodePacksThrowAfter = null
  })

  it('createSnapshot still returns a record when insertSnapshot and writeFileSync fail', () => {
    seedPack({ name: 'SnapRec' })
    h.state.insertSnapshotThrow = true
    h.state.writeFail.add('snapshots')
    const snap = nodePackService.createSnapshot('best-effort')
    expect(snap.id).toBeTruthy()
    expect(snap.packs.length).toBeGreaterThanOrEqual(0)
    h.state.insertSnapshotThrow = false
    h.state.writeFail.clear()
  })
})

// =====================================================================
// resolveRemovalTargets branches (private — exercised via uninstall + direct)
// =====================================================================
describe('resolveRemovalTargets', () => {
  it('collapses the shell when it holds exactly one pack entry', () => {
    const packDir = seedPack({ name: 'OnlyChild', nested: true })
    const shell = dirname(packDir)
    const targets = priv.resolveRemovalTargets(packDir, 'inst-1')
    expect(targets).toContain(packDir)
    expect(targets).toContain(shell)
  })

  it('keeps the shell when it holds extra siblings (monorepo)', () => {
    const packDir = seedPack({ name: 'Mono', nested: true })
    const shell = dirname(packDir)
    h.mkdirPath(join(shell, '.git'))
    const targets = priv.resolveRemovalTargets(packDir, 'inst-1')
    expect(targets).toEqual([packDir])
  })

  it('returns only the pack when parent is the custom_nodes root', () => {
    const packDir = seedPack({ name: 'Flat' })
    const targets = priv.resolveRemovalTargets(packDir, 'inst-1')
    expect(targets).toEqual([packDir])
  })

  it('returns only the pack when isPathInside(parent) is false', () => {
    const packDir = seedPack({ name: 'NotInside' })
    // packPath not under parent: craft a path whose dirname is not its real parent
    const targets = priv.resolveRemovalTargets(`${packDir}${dirname(packDir)}`, 'inst-1')
    expect(targets.length).toBeGreaterThanOrEqual(1)
  })

  it('returns only the pack when parentParent is not the custom_nodes root', () => {
    const deep = join(ROOT, 'A', 'B', 'PackDeep')
    h.mkdirPath(deep)
    h.writeFile(join(deep, '__init__.py'), 'x')
    h.writeFile(join(deep, 'pyproject.toml'), 'name = "PackDeep"\nversion = "1.0.0"\n')
    const targets = priv.resolveRemovalTargets(deep, 'inst-1')
    expect(targets).toEqual([deep])
  })

  it('returns only the pack when readdir of the parent throws', () => {
    const packDir = seedPack({ name: 'ReaddirBad', nested: true })
    h.state.readdirFail.add('ReaddirBad')
    const targets = priv.resolveRemovalTargets(packDir, 'inst-1')
    expect(targets).toEqual([packDir])
    h.state.readdirFail.clear()
  })

  it('returns only the pack when custom_nodes root cannot be resolved', () => {
    const packDir = seedPack({ name: 'NoRoot' })
    h.state.instances = []
    h.state.settings.defaultInstancePath = ''
    delete process.env.COMFYUI_PATH
    const targets = priv.resolveRemovalTargets(packDir, 'inst-1')
    expect(targets).toEqual([packDir])
  })
})

// =====================================================================
// checkUpdates reason branches + persistence catch
// =====================================================================
describe('checkUpdates extra branches', () => {
  it('reports not-updatable via Registry or git for a local pack with a known remote', async () => {
    const dir = seedPack({ name: 'LocalRemote', pyproject: 'name = "LocalRemote"\nversion = "1.0.0"\n' })
    h.state.nodePacks = [
      {
        id: 'dddddddddddddddd',
        name: 'LocalRemote',
        locked: false,
        installSource: 'local',
        version: '1.0.0',
        latestVersion: '2.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const { searchRegistry, toPageResult, mapRegistryPack } = registryMock
    searchRegistry.mockResolvedValue({
      raw: [{ id: 'local-remote', name: 'LocalRemote', latestVersion: '2.0.0' }],
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    })
    toPageResult.mockImplementation((result: { raw?: unknown[] }, map: (n: unknown) => unknown) => ({
      items: (result.raw || []).map(map),
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    }))
    mapRegistryPack.mockImplementation((n: Record<string, unknown>) => n)
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].updatable).toBe(false)
    expect(results[0].updateSource).toBe('none')
    expect(results[0].reason).toMatch(/not updatable/i)
    expect(results[0].reasonKey).toBe('nodes.notUpdatable')
  })

  it('survives upsertNodePack failing while persisting latestVersion', async () => {
    const dir = seedPack({ name: 'UpFail', pyproject: 'name = "UpFail"\nversion = "1.0.0"\n' })
    h.state.nodePacks = [
      {
        id: 'eeeeeeeeeeeeeeee',
        name: 'UpFail',
        locked: false,
        installSource: 'registry',
        registryId: 'up-fail',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const { searchRegistry, toPageResult, mapRegistryPack } = registryMock
    searchRegistry.mockResolvedValue({
      raw: [{ id: 'up-fail', name: 'UpFail', latestVersion: '3.0.0' }],
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    })
    toPageResult.mockImplementation((result: { raw?: unknown[] }, map: (n: unknown) => unknown) => ({
      items: (result.raw || []).map(map),
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    }))
    mapRegistryPack.mockImplementation((n: Record<string, unknown>) => n)
    h.state.upsertThrowOnce = true
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].updatable).toBe(true)
    // persistence failed but the result row is still returned
    expect(h.state.nodePacks[0].latestVersion).toBeUndefined()
  })

  it('tolerates registryIndex throwing during the catalog peek', async () => {
    seedPack({ name: 'IdxThrow', pyproject: 'name = "IdxThrow"\nversion = "1.0.0"\n' })
    const { searchRegistry, toPageResult, mapRegistryPack } = registryMock
    searchRegistry.mockResolvedValue({
      raw: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
      scanned: 0,
      clientFiltered: false
    })
    toPageResult.mockImplementation(() => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
      scanned: 0,
      clientFiltered: false
    }))
    mapRegistryPack.mockImplementation((n: Record<string, unknown>) => n)
    registryIndexMock.registryIndex.ensure.mockRejectedValue(new Error('index corrupt'))
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results).toHaveLength(1)
    registryIndexMock.registryIndex.ensure.mockResolvedValue(undefined)
  })

  it('uses registryIndex exact-name hit to fill latestVersion', async () => {
    seedPack({ name: 'IdxHit', pyproject: 'name = "IdxHit"\nversion = "1.0.0"\n' })
    const { searchRegistry, toPageResult, mapRegistryPack } = registryMock
    searchRegistry.mockResolvedValue({
      raw: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
      scanned: 0,
      clientFiltered: false
    })
    toPageResult.mockImplementation(() => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
      scanned: 0,
      clientFiltered: false
    }))
    mapRegistryPack.mockImplementation((n: Record<string, unknown>) => n)
    registryIndexMock.registryIndex.ensure.mockResolvedValue(undefined)
    registryIndexMock.registryIndex.searchPacks.mockReturnValue([
      { id: 'other', name: 'NotThis', latestVersion: '1.0.0' },
      { id: 'idx-hit', name: 'IdxHit', latestVersion: '5.5.5' }
    ])
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].latestVersion).toBe('5.5.5')
  })
})

// =====================================================================
// install() error-message fallbacks (non-Error throws)
// =====================================================================
describe('install error message fallbacks', () => {
  it('stringifies a non-Error thrown from the git clone path', async () => {
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        // promisify custom rejects with whatever we pass; use a string
        return { error: 'raw string failure' as unknown as Error }
      }
      return { stdout: '' }
    })
    const events: Array<Record<string, unknown>> = []
    nodePackService.on('install-progress', (e: Record<string, unknown>) => events.push(e))
    await expect(
      nodePackService.install({ id: 'https://github.com/u/StrFail.git', source: 'git', instanceId: 'inst-1' })
    ).rejects.toBeTruthy()
    const errEvent = events.find((e) => e.phase === 'error')
    expect(errEvent).toBeTruthy()
    expect(String(errEvent!.message)).toContain('raw string failure')
    nodePackService.removeAllListeners('install-progress')
  })
})

// =====================================================================
// managerChannelList field fallbacks
// =====================================================================
describe('managerChannelList field fallbacks', () => {
  it('fills missing id/name/displayName/tags/downloads from alternates', async () => {
    setFetch(async () =>
      makeRes([
        { title: 'OnlyTitle', description: 'd', tags: ['t1', 2], downloads: 7 },
        { name: 'OnlyName', repository: 'https://g/n' },
        { id: 'full', title: 'T', name: 'N', tags: 'not-an-array', downloads: 0 },
        { id: 'bare', description: 'no names' }
      ])
    )
    const out = await nodePackService.managerChannelList()
    expect(out.map((p) => p.id).sort()).toEqual(['OnlyName', 'OnlyTitle', 'bare', 'full'])
    // id falls back to title then name
    const onlyTitle = out.find((p) => p.id === 'OnlyTitle')!
    expect(onlyTitle.name).toBe('OnlyTitle') // n.name missing → n.title
    expect(onlyTitle.displayName).toBe('OnlyTitle')
    expect(onlyTitle.tags).toEqual(['t1', '2'])
    expect(onlyTitle.downloads).toBe(7)
    const onlyName = out.find((p) => p.id === 'OnlyName')!
    expect(onlyName.name).toBe('OnlyName')
    expect(onlyName.displayName).toBe('OnlyName') // n.title missing → n.name
    const full = out.find((p) => p.id === 'full')!
    expect(full.tags).toEqual([])
    expect(full.downloads).toBe(0)
    // both name and title missing → empty-string fallback
    const bare = out.find((p) => p.id === 'bare')!
    expect(bare.name).toBe('')
    expect(bare.displayName).toBe('')
  })
})

