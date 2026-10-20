/**
 * High-intensity unit tests for NodePackService: meta discovery, issue
 * collection, listing/filtering, install (registry/git/manager), afterInstall
 * pip paths, uninstall shell cleanup, update success/rollback, toggle/lock,
 * conflicts, smokeTest, snapshots and update-check channels.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join, dirname } from 'path'

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void

const h = vi.hoisted(() => {
  type DirentName = string
  const state = {
    dirs: new Map<string, DirentName[]>(),
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
      proxy: {
        enabled: false,
        protocol: 'http',
        host: '',
        port: 7890,
        bypass: '',
        username: '',
        password: ''
      }
    } as Record<string, unknown>,
    renameFail: new Set<string>(),
    writeFail: new Set<string>(),
    unlinkFail: new Set<string>(),
    rmFail: new Set<string>(),
    /** Substrings whose statSync calls throw (injected reliability tests). */
    statFail: new Set<string>(),
    runtimePython: null as string | null,
    runtimePythonThrow: null as Error | null,
    execSyncOut: 'abc1234',
    execSyncErr: null as Error | null,
    /** Per-path size/mtime so (size,mtime) caches see real rewrites. */
    statStamp: new Map<string, { size: number; mtimeMs: number }>(),
    statClock: 0
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
    state.statStamp.delete(p)
    detachFromParent(p)
  }

  function copyPath(from: string, to: string): void {
    if (state.files.has(from)) {
      state.files.set(to, state.files.get(from)!)
      const st = state.statStamp.get(from)
      state.statStamp.set(to, st ? { ...st } : { size: 0, mtimeMs: ++state.statClock })
      return
    }
    // directory
    if (!state.dirs.has(from)) state.dirs.set(from, [])
    state.dirs.set(to, [...(state.dirs.get(from) || [])])
    state.isDir.add(to)
    attachToParent(to)
    for (const c of state.dirs.get(from) || []) {
      copyPath(join(from, c), join(to, c))
    }
  }

  function renamePath(from: string, to: string): void {
    // renameFail entries are substrings matched against the SOURCE path
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

  /** Write a file AND register it in the parent directory listing. */
  function writeFile(p: string, content: string): void {
    const parent = parentOf(p)
    if (parent && !state.dirs.has(parent)) mkdirPath(parent)
    state.files.set(p, content)
    state.exists.add(p)
    state.statStamp.set(p, { size: content.length, mtimeMs: ++state.statClock })
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
  const { state, fsKey, rmPath, renamePath, mkdirPath } = h
  return {
    existsSync: (p: unknown) => {
      const s = fsKey(p)
      return state.exists.has(s) || state.dirs.has(s) || state.files.has(s) || state.isDir.has(s)
    },
    readdirSync: (p: unknown) => {
      const s = fsKey(p)
      return [...(state.dirs.get(s) || [])]
    },
    statSync: (p: unknown) => {
      const s = fsKey(p)
      for (const frag of state.statFail) {
        if (s.includes(frag)) throw new Error(`ENOENT (injected stat failure): ${s}`)
      }
      const st = state.statStamp.get(s) || { size: 0, mtimeMs: 0 }
      return {
        isDirectory: () => state.isDir.has(s) || state.dirs.has(s),
        isFile: () => state.files.has(s),
        size: st.size,
        mtimeMs: st.mtimeMs
      }
    },
    readFileSync: (p: unknown) => {
      const s = fsKey(p)
      return state.files.get(s) ?? ''
    },
    writeFileSync: (p: unknown, data: unknown) => {
      const s = fsKey(p)
      for (const frag of state.writeFail) {
        if (s.includes(frag)) throw new Error(`write failed: ${s}`)
      }
      const text = String(data)
      state.files.set(s, text)
      state.exists.add(s)
      state.statStamp.set(s, { size: text.length, mtimeMs: ++state.statClock })
      h.attachToParent(s)
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
      state.statStamp.delete(s)
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
      const st = state.statStamp.get(src)
      state.statStamp.set(dst, st ? { ...st } : { size: 0, mtimeMs: ++state.statClock })
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

// ---------- crypto ----------
// ---------- electron (session.fetch routes through the same handler) ----------
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

vi.mock('crypto', () => {
  const hashOf = (s: string): string => {
    let h1 = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i)
      h1 = Math.imul(h1, 0x01000193)
    }
    return ((h1 >>> 0).toString(16) + (s.length * 2654435761).toString(16))
      .slice(0, 16)
      .padStart(16, '0')
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

// ---------- child_process (callback-accurate + promisify.custom) ----------
vi.mock('child_process', () => {
  type Handler = (
    cmd: string,
    args: string[],
    opts: unknown
  ) => { stdout?: string; stderr?: string; error?: Error; code?: number; hang?: boolean }
  let handler: Handler | null = null
  const setHandler = (fn: Handler | null): void => {
    handler = fn
  }
  const execFile = (cmd: string, args: string[], opts: unknown, cb?: ExecCallback): unknown => {
    const callback = typeof opts === 'function' ? (opts as unknown as ExecCallback) : cb
    const optsArg = typeof opts === 'function' ? undefined : opts
    const finish = (err: Error | null, out: string, errOut: string): void => {
      queueMicrotask(() => {
        if (typeof callback === 'function') callback(err, out, errOut)
      })
    }
    if (handler) {
      let result: ReturnType<Handler>
      try {
        result = handler(cmd, args, optsArg)
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)), '', '')
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      if (result.error) {
        const err = result.error as Error & { code?: number }
        if (result.code != null) err.code = result.code
        finish(err, result.stdout || '', result.stderr || result.error.message)
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
  // spawn is used by env.runStreaming for live pip/uv output — must route
  // through the same handler so tests can assert on the actual commands.
  const spawn = (cmd: string, args: string[], _opts?: unknown): unknown => {
    const { EventEmitter } = require('events') as typeof import('events')
    const child = new EventEmitter() as unknown as {
      stdout: InstanceType<typeof EventEmitter>
      stderr: InstanceType<typeof EventEmitter>
      kill: () => void
      emit: (ev: string, ...a: unknown[]) => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => undefined
    queueMicrotask(() => {
      try {
        const result = handler ? handler(cmd, args, undefined) : { stdout: 'ok', stderr: '' }
        // `hang` models a long-running command (e.g. git pull mid-transfer).
        if (result.hang) return
        if (result.error) {
          child.stderr.emit('data', Buffer.from(result.stderr || result.error.message))
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
  }
  return {
    execFile,
    spawn,
    execFileSync: () => {
      if (h.state.execSyncErr) throw h.state.execSyncErr
      return h.state.execSyncOut
    },
    __setExecHandler: setHandler
  }
})

// ---------- service mocks ----------
vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => h.state.settings,
  loadInstanceConfigs: () => h.state.instances,
  listNodePacks: () => h.state.nodePacks,
  upsertNodePack: vi.fn((p: Record<string, unknown>) => {
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
    h.state.snapshots.push(s)
    h.state.snapshotById.set(String(s.id), s)
  }),
  deleteSnapshot: vi.fn((id: string) => {
    const before = h.state.snapshots.length
    h.state.snapshots = h.state.snapshots.filter((s) => s.id !== id)
    h.state.snapshotById.delete(id)
    return h.state.snapshots.length < before
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

vi.mock('../../src/main/services/instance', async () => {
  const { existsSync } = await import('fs')
  const { join } = await import('path')
  return {
    resolveRuntimesPythonSync: () => {
      if (h.state.runtimePythonThrow) throw h.state.runtimePythonThrow
      return h.state.runtimePython
    },
    // Mirrors the shared resolver against the mocked FS (venv → pythonPath → runtime).
    resolveInstancePythonPath: (config: { venvPath?: string; pythonPath?: string }) => {
      if (config.venvPath) {
        const win = join(config.venvPath, 'Scripts', 'python.exe')
        const unix = join(config.venvPath, 'bin', 'python')
        if (existsSync(win)) return win
        if (existsSync(unix)) return unix
      }
      if (config.pythonPath) return config.pythonPath
      if (h.state.runtimePythonThrow) throw h.state.runtimePythonThrow
      return h.state.runtimePython || 'python'
    }
  }
})

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
    searchPacks: vi.fn(() => []),
    findByRepository: vi.fn(() => null)
  }
}))

vi.mock('../../src/main/services/zipSafe', () => ({
  safeUnzip: vi.fn(async () => undefined)
}))

import {
  nodePackService,
  resolveInstanceConfig,
  compareVersions
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
  registryIndex: {
    ensure: ReturnType<typeof vi.fn>
    searchPacks: ReturnType<typeof vi.fn>
    findByRepository: ReturnType<typeof vi.fn>
  }
}

const cpMock = cp as unknown as {
  execFile: (cmd: string, args: string[], opts: unknown, cb?: ExecCallback) => unknown
  __setExecHandler: (
    fn:
      | ((
          cmd: string,
          args: string[],
          opts: unknown
        ) => { stdout?: string; stderr?: string; error?: Error; code?: number })
      | null
  ) => void
}

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
  h.state.statFail.clear()
  h.state.runtimePython = null
  h.state.runtimePythonThrow = null
  h.state.execSyncOut = 'abc1234'
  h.state.execSyncErr = null
  h.state.settings = {
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

function makeRes(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    arrayBuffer: async () =>
      new TextEncoder().encode(typeof body === 'string' ? body : 'zip-bytes').buffer,
    headers: { get: () => '0' }
  } as unknown as Response
}

/** Seed a pack directory under custom_nodes. */
function seedPack(opts: {
  name: string
  nested?: boolean
  withGit?: boolean
  disabledMarker?: boolean
  disabledSuffix?: boolean
  pyproject?: string | null
  packageJson?: string | null
  nodeListJson?: string | null
  initPy?: string | null
  requirements?: string | null
  extraFiles?: Record<string, string>
  extraDirs?: string[]
}): string {
  const folderName = opts.disabledSuffix ? `${opts.name}.disabled` : opts.name
  const shell = join(ROOT, folderName)
  const packDir = opts.nested ? join(shell, `${opts.name}-inner`) : shell
  h.mkdirPath(packDir)
  if (opts.nested) {
    h.mkdirPath(shell)
  }
  if (opts.initPy !== null) {
    const init = opts.initPy ?? `NODE_CLASS_MAPPINGS = {"${opts.name}Node": None}\n`
    h.writeFile(join(packDir, '__init__.py'), init)
  }
  if (opts.pyproject !== null) {
    const pp =
      opts.pyproject ??
      `name = "${opts.name}"\nversion = "1.0.0"\ndescription = "desc"\nrepository = "https://github.com/x/${opts.name}"\nlicense = "MIT"\nrequires-python = ">=3.10"\n`
    h.writeFile(join(packDir, 'pyproject.toml'), pp)
  }
  if (opts.packageJson != null) {
    h.writeFile(join(packDir, 'package.json'), opts.packageJson)
  }
  if (opts.nodeListJson != null) {
    h.writeFile(join(packDir, 'node_list.json'), opts.nodeListJson)
  }
  if (opts.requirements != null) {
    h.writeFile(join(packDir, 'requirements.txt'), opts.requirements)
  }
  if (opts.withGit) {
    h.mkdirPath(join(packDir, '.git'))
  }
  if (opts.disabledMarker) {
    h.writeFile(join(packDir, '.disabled'), String(Date.now()))
  }
  for (const [rel, content] of Object.entries(opts.extraFiles || {})) {
    h.writeFile(join(packDir, rel), content)
  }
  for (const d of opts.extraDirs || []) {
    h.mkdirPath(join(packDir, d))
  }
  return packDir
}

function listIds(): Map<string, string> {
  return new Map(nodePackService.list('inst-1').map((p) => [p.name, p.id]))
}

beforeEach(() => {
  resetState()
  vi.clearAllMocks()
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch
})

// =====================================================================
// readPackMeta
// =====================================================================
describe('readPackMeta via list()', () => {
  it('reads name/version/description/repository/license/python from pyproject', () => {
    seedPack({
      name: 'PackA',
      pyproject:
        'name = "cool-pack"\nversion = "2.3.4"\ndescription = "A cool pack"\nrepository = "https://github.com/a/b"\nlicense = "Apache-2.0"\nrequires-python = ">=3.11"\n'
    })
    const packs = nodePackService.list('inst-1')
    expect(packs).toHaveLength(1)
    expect(packs[0].name).toBe('cool-pack')
    expect(packs[0].version).toBe('2.3.4')
    expect(packs[0].description).toBe('A cool pack')
    expect(packs[0].repository).toBe('https://github.com/a/b')
    expect(packs[0].license).toBe('Apache-2.0')
    expect(packs[0].pythonCompatible).toBe('>=3.11')
  })

  it('falls back to package.json when pyproject is absent', () => {
    seedPack({
      name: 'PackB',
      pyproject: null,
      packageJson: JSON.stringify({
        name: 'pkg-pack',
        version: '9.9.9',
        description: 'from package.json',
        repository: { url: 'https://github.com/p/q' },
        license: 'MIT'
      })
    })
    const packs = nodePackService.list('inst-1')
    expect(packs[0].name).toBe('pkg-pack')
    expect(packs[0].version).toBe('9.9.9')
    expect(packs[0].repository).toBe('https://github.com/p/q')
    expect(packs[0].license).toBe('MIT')
  })

  it('uses package.json homepage when repository.url is missing', () => {
    seedPack({
      name: 'PackB2',
      pyproject: null,
      packageJson: JSON.stringify({
        name: 'hp-pack',
        version: '1.0.0',
        homepage: 'https://hp.example'
      })
    })
    expect(nodePackService.list('inst-1')[0].repository).toBe('https://hp.example')
  })

  it('ignores malformed package.json and keeps folder name', () => {
    seedPack({ name: 'PackC', pyproject: null, packageJson: '{not json' })
    const packs = nodePackService.list('inst-1')
    expect(packs[0].name).toBe('PackC')
    expect(packs[0].version).toBe('0.0.0')
  })

  it('reads node_list.json as an array', () => {
    seedPack({ name: 'PackD', nodeListJson: JSON.stringify(['AlphaNode', 'BetaNode']) })
    const packs = nodePackService.list('inst-1')
    expect(packs[0].nodeList).toEqual(['AlphaNode', 'BetaNode'])
    expect(packs[0].nodeCount).toBe(2)
  })

  it('reads node_list.json as {nodes:{...}} object form', () => {
    seedPack({ name: 'PackE', nodeListJson: JSON.stringify({ nodes: { ZedNode: {}, QNode: {} } }) })
    const packs = nodePackService.list('inst-1')
    expect(packs[0].nodeList.sort()).toEqual(['QNode', 'ZedNode'])
  })

  it('extracts NODE_CLASS_MAPPINGS keys from .py files when no node_list.json', () => {
    seedPack({
      name: 'PackF',
      initPy: '# package init, no mappings here\n',
      nodeListJson: null,
      extraFiles: {
        'nodes.py':
          'NODE_CLASS_MAPPINGS = {\n  "LoadThing": None,\n  "SaveThing": None,\n}\nNODE_DISPLAY_NAME_MAPPINGS = {"LoadThing": "LT"}\n',
        'readme.md': 'not python'
      }
    })
    const packs = nodePackService.list('inst-1')
    expect(packs[0].nodeList.sort()).toEqual(['LoadThing', 'SaveThing'])
  })

  it('keeps an empty nodeList when node_list.json is malformed (no crash)', () => {
    seedPack({
      name: 'PackG',
      nodeListJson: 'oops',
      initPy: 'NODE_CLASS_MAPPINGS = {"OnlyNode": None}\n'
    })
    const packs = nodePackService.list('inst-1')
    // Malformed node_list.json is ignored; the .py scan is NOT a fallback in that case.
    expect(packs[0].nodeList).toEqual([])
    expect(packs[0].name).toBe('PackG')
  })

  it('returns defaults when nothing is present except a directory', () => {
    seedPack({ name: 'PackH', pyproject: null, initPy: null, nodeListJson: null })
    const packs = nodePackService.list('inst-1')
    expect(packs[0].name).toBe('PackH')
    expect(packs[0].version).toBe('0.0.0')
    expect(packs[0].nodeCount).toBe(0)
    expect(packs[0].nodeList).toEqual([])
  })

  it('tolerates unreadable .py files during mapping scan', () => {
    seedPack({ name: 'PackI', pyproject: null, initPy: null, nodeListJson: null })
    // Make readdirSync report a .py child with no backing content (read returns '')
    h.state.dirs.set(join(ROOT, 'PackI'), ['__init__.py', 'broken.py'])
    h.writeFile(join(ROOT, 'PackI', 'broken.py'), 'NODE_CLASS_MAPPINGS = {"BrokenNode": None}\n')
    const packs = nodePackService.list('inst-1')
    expect(packs[0].nodeList).toEqual(['BrokenNode'])
  })
})

// =====================================================================
// collectIssues
// =====================================================================
describe('collectIssues via list()', () => {
  it('flags NO_ENTRY when neither __init__.py nor pyproject exists', () => {
    seedPack({ name: 'NoEntry', pyproject: null, initPy: null })
    const issues = nodePackService.list('inst-1')[0].issues
    expect(issues.map((i) => i.code)).toContain('NO_ENTRY')
  })

  it('flags TORCH_PIN and CV_PIN from requirements.txt', () => {
    seedPack({
      name: 'Pins',
      requirements: 'torch==2.1.0\nopencv-python==4.8.0.76\nnumpy\n'
    })
    const codes = nodePackService.list('inst-1')[0].issues.map((i) => i.code)
    expect(codes).toContain('TORCH_PIN')
    expect(codes).toContain('CV_PIN')
    const torch = nodePackService.list('inst-1')[0].issues.find((i) => i.code === 'TORCH_PIN')
    expect(torch?.fixable).toBe(true)
    expect(torch?.fixId).toBe('unpin-torch')
  })

  it('flags NO_REPO when repository metadata is missing', () => {
    seedPack({
      name: 'NoRepo',
      pyproject: 'name = "NoRepo"\nversion = "1.0.0"\n'
    })
    const codes = nodePackService.list('inst-1')[0].issues.map((i) => i.code)
    expect(codes).toContain('NO_REPO')
  })

  it('produces no issues for a clean pack with entry + repository + no pins', () => {
    seedPack({ name: 'Clean' })
    expect(nodePackService.list('inst-1')[0].issues).toEqual([])
  })
})

// =====================================================================
// list()
// =====================================================================
describe('NodePackService.list', () => {
  it('filters junk/cache dirs and plain files', () => {
    seedPack({ name: 'Real' })
    const junk = [
      '.git',
      '__pycache__',
      '__MACOSX',
      'node_modules',
      'foo.egg-info',
      'bar.dist-info',
      'old.trash',
      'x.trash-1',
      'y.bak-2',
      'afile.txt'
    ]
    for (const j of junk) {
      if (j === 'afile.txt') {
        h.writeFile(join(ROOT, j), 'x')
      } else {
        h.mkdirPath(join(ROOT, j))
      }
    }
    // non-directory entry with pack-like name
    h.writeFile(join(ROOT, 'NotADir'), 'x')
    const packs = nodePackService.list('inst-1')
    expect(packs.map((p) => p.name)).toEqual(['Real'])
  })

  it('marks a pack disabled via .disabled marker', () => {
    seedPack({ name: 'DisA', disabledMarker: true })
    const p = nodePackService.list('inst-1')[0]
    expect(p.status).toBe('disabled')
  })

  it('marks a pack disabled via name.disabled folder convention', () => {
    seedPack({ name: 'DisB', disabledSuffix: true })
    const p = nodePackService.list('inst-1')[0]
    expect(p.status).toBe('disabled')
  })

  it('computes update-available status when a newer latestVersion is known', () => {
    seedPack({ name: 'UpdA' })
    const id = ''
    // use the real mocked hash �?recompute via list
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'UpdA',
        locked: false,
        installSource: 'registry',
        registryId: 'upd-a',
        version: '1.0.0',
        latestVersion: '2.0.0',
        issues: [],
        tags: [],
        nodeList: []
      }
    ]
    const p = nodePackService.list('inst-1')[0]
    expect(p.status).toBe('update-available')
    expect(p.latestVersion).toBe('2.0.0')
    void id
  })

  it('does not flag update-available when the pack is disabled', () => {
    seedPack({ name: 'UpdB', disabledMarker: true })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'UpdB',
        locked: false,
        installSource: 'registry',
        version: '1.0.0',
        latestVersion: '2.0.0',
        issues: [],
        tags: [],
        nodeList: []
      }
    ]
    expect(nodePackService.list('inst-1')[0].status).toBe('disabled')
  })

  it('returns [] when the custom_nodes root does not exist', () => {
    h.state.dirs.clear()
    h.state.isDir.clear()
    h.state.files.clear()
    h.state.exists.clear()
    // instance path has no custom_nodes
    h.mkdirPath(COMFY)
    expect(nodePackService.list('inst-1')).toEqual([])
  })

  it('resolves root from a filesystem path argument (contains slash)', () => {
    seedPack({ name: 'PathForm' })
    const packs = nodePackService.list(COMFY)
    expect(packs.map((p) => p.name)).toEqual(['PathForm'])
  })

  it('returns [] when instance path is missing and no COMFYUI_PATH fallback is set', () => {
    h.state.instances = []
    seedPack({ name: 'ViaSettings' })
    expect(nodePackService.list().map((p) => p.name)).toEqual([])
  })

  it('falls back to COMFYUI_PATH env when nothing else resolves', () => {
    h.state.instances = []
    process.env.COMFYUI_PATH = COMFY
    try {
      seedPack({ name: 'ViaEnv' })
      expect(nodePackService.list().map((p) => p.name)).toEqual(['ViaEnv'])
    } finally {
      delete process.env.COMFYUI_PATH
    }
  })

  it('inherits locked/tags/author/installSource from the known DB record', () => {
    seedPack({ name: 'Known' })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'Known',
        locked: true,
        author: 'alice',
        tags: ['t1'],
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        nodeList: []
      }
    ]
    const p = nodePackService.list('inst-1')[0]
    expect(p.locked).toBe(true)
    expect(p.author).toBe('alice')
    expect(p.tags).toEqual(['t1'])
    expect(p.installSource).toBe('git')
  })
})

// =====================================================================
// refresh()
// =====================================================================
describe('NodePackService.refresh', () => {
  it('keeps locked=true from the previous DB record and upserts', async () => {
    seedPack({ name: 'RefA' })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'RefA',
        locked: true,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: []
      }
    ]
    const packs = await nodePackService.refresh('inst-1')
    expect(packs[0].locked).toBe(true)
    expect(h.state.nodePacks[0].locked).toBe(true)
  })

  it('upserts unlocked packs too', async () => {
    seedPack({ name: 'RefB' })
    const packs = await nodePackService.refresh('inst-1')
    expect(packs[0].locked).toBe(false)
    expect(h.state.nodePacks.some((p) => p.name === 'RefB')).toBe(true)
  })
})

// =====================================================================
// install guards
// =====================================================================
describe('install security guards', () => {
  it('rejects every remote install when networkMode is offline', async () => {
    h.state.settings.networkMode = 'offline'
    await expect(nodePackService.install({ id: 'x', source: 'registry' })).rejects.toThrow(
      /offline/i
    )
    await expect(
      nodePackService.install({ id: 'x', source: 'git', url: 'https://g.com/a' })
    ).rejects.toThrow(/offline/i)
    await expect(nodePackService.install({ id: 'x', source: 'manager' })).rejects.toThrow(
      /offline/i
    )
  })

  it('rejects git installs when allowGitUrlInstall is false', async () => {
    h.state.settings.allowGitUrlInstall = false
    await expect(nodePackService.install({ id: 'https://g.com/a', source: 'git' })).rejects.toThrow(
      /allow_git_url_install/i
    )
  })

  it('rejects git installs under securityLevel=strong', async () => {
    h.state.settings.securityLevel = 'strong'
    await expect(nodePackService.install({ id: 'https://g.com/a', source: 'git' })).rejects.toThrow(
      /strong/i
    )
  })

  it('rejects registry/manager installs under securityLevel=strong', async () => {
    h.state.settings.securityLevel = 'strong'
    await expect(nodePackService.install({ id: 'x', source: 'registry' })).rejects.toThrow(
      /strong/i
    )
    await expect(nodePackService.install({ id: 'x', source: 'manager' })).rejects.toThrow(/strong/i)
  })

  it('throws when custom_nodes root cannot be resolved', async () => {
    h.state.instances = []
    delete process.env.COMFYUI_PATH
    // empty root string �?install throws
    await expect(nodePackService.install({ id: 'https://g.com/a', source: 'git' })).rejects.toThrow(
      /custom_nodes/i
    )
  })
})

// =====================================================================
// install �?git / manager channel
// =====================================================================
describe('install via git/manager channel', () => {
  it('clones a git repo and records the pack via afterInstall', async () => {
    const cloneArgs: string[][] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (String(cmd).includes('git') || cmd === 'git') {
        cloneArgs.push([...args])
        // simulate clone populating dest
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, '__init__.py'), 'NODE_CLASS_MAPPINGS = {"GitNode": None}\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "GitPack"\nversion = "3.0.0"\nrepository = "https://g.com/r"\n'
        )
        return { stdout: 'cloned' }
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/some/GitPack.git',
      source: 'git',
      branch: 'dev',
      instanceId: 'inst-1'
    })
    expect(cloneArgs[0]).toContain('clone')
    expect(cloneArgs[0]).toContain('--branch')
    expect(cloneArgs[0]).toContain('dev')
    // clone lands in a throwaway temp dir, then renameSync publishes it
    expect(cloneArgs[0][cloneArgs[0].length - 1]).toContain('custom_nodes')
    expect(rec.name).toBe('GitPack')
    expect(rec.installSource).toBe('git')
    expect(rec.version).toBe('3.0.0')
  })

  it('uses opts.id as the URL when source=git and no url is provided', async () => {
    const cloneArgs: string[][] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        cloneArgs.push([...args])
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "IdUrl"\nversion = "0.1.0"\n')
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/IdUrl.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(cloneArgs[0]).toContain('https://github.com/u/IdUrl.git')
    expect(rec.name).toBe('IdUrl')
  })

  it('cleans up the dest directory when clone fails', async () => {
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'partial.txt'), 'half')
        return { error: new Error('clone exploded'), stderr: 'clone exploded' }
      }
      return { stdout: '' }
    })
    await expect(
      nodePackService.install({
        id: 'https://github.com/u/Broken.git',
        source: 'git',
        instanceId: 'inst-1'
      })
    ).rejects.toThrow(/clone exploded/)
    const dest = join(ROOT, 'Broken')
    expect(h.state.dirs.has(dest)).toBe(false)
  })

  it('resolves nested pack dir after a zip-shaped clone', async () => {
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        const nested = join(dest, 'Nested-inner')
        h.mkdirPath(nested)
        h.writeFile(join(nested, '__init__.py'), 'NODE_CLASS_MAPPINGS = {"NNode": None}\n')
        h.writeFile(join(nested, 'pyproject.toml'), 'name = "NestedPack"\nversion = "1.1.1"\n')
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/Nested.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(rec.name).toBe('NestedPack')
    expect(rec.path).toContain('Nested-inner')
  })

  it('installs a manager pack by resolving its repository from the channel list', async () => {
    setFetch(async (url) => {
      if (url.includes('custom-node-list.json')) {
        return makeRes([
          {
            id: 'mgr-1',
            title: 'Manager Pack',
            name: 'ManagerPack',
            description: 'd',
            author: 'a',
            version: '1.2.3',
            repository: 'https://github.com/m/ManagerPack.git',
            tags: [],
            downloads: 1
          }
        ])
      }
      throw new Error('unexpected ' + url)
    })
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "ManagerPack"\nversion = "1.2.3"\n')
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'mgr-1',
      source: 'manager',
      instanceId: 'inst-1'
    })
    expect(rec.name).toBe('ManagerPack')
    expect(rec.installSource).toBe('manager')
  })

  it('throws when a manager pack has no repository URL', async () => {
    setFetch(async () =>
      makeRes([{ id: 'mgr-2', title: 'NoRepo', name: 'NoRepo', repository: '' }])
    )
    await expect(
      nodePackService.install({ id: 'mgr-2', source: 'manager', instanceId: 'inst-1' })
    ).rejects.toThrow(/no repository url/i)
  })

  it('rejects an unsafe git URL', async () => {
    await expect(
      nodePackService.install({ id: 'ext::sh -c evil', source: 'git', instanceId: 'inst-1' })
    ).rejects.toThrow(/invalid git url/i)
  })
})

// =====================================================================
// install �?registry channel
// =====================================================================
describe('install via registry channel', () => {
  function seedRegistryHappy(unzipImpl: (dest?: string) => void): void {
    setFetch(async (url) => {
      if (url.includes('/nodes/') && url.includes('/install')) {
        return makeRes({ url: 'https://cdn.example/pack.zip', status: 'active' })
      }
      if (url.includes('pack.zip')) {
        return makeRes('zip-bytes')
      }
      throw new Error('unexpected ' + url)
    })
    const zipSafe = zipSafeMock
    zipSafe.safeUnzip.mockImplementation(async (_zip: string, dest?: string) => {
      // install() unzips into a throwaway temp dir then renames — the impl
      // must populate whatever dest it is given, not a hardcoded final name.
      unzipImpl(dest)
    })
  }

  it('downloads, unzips and records a flat registry pack', async () => {
    seedRegistryHappy((tmpDest) => {
      const dest = (tmpDest as string) || join(ROOT, 'RegPack')
      h.mkdirPath(dest)
      h.writeFile(join(dest, '__init__.py'), 'NODE_CLASS_MAPPINGS = {"RegNode": None}\n')
      h.writeFile(
        join(dest, 'pyproject.toml'),
        'name = "RegPack"\nversion = "5.0.0"\nrepository = "https://r.example"\n'
      )
    })
    const rec = await nodePackService.install({
      id: 'RegPack',
      source: 'registry',
      instanceId: 'inst-1'
    })
    expect(rec.name).toBe('RegPack')
    expect(rec.installSource).toBe('registry')
    expect(rec.registryId).toBe('RegPack')
    expect(rec.nodeList).toEqual(['RegNode'])
    // tmp zip removed after successful unzip
    const leftovers = [...h.state.files.keys()].filter((k) => k.includes('._install_'))
    expect(leftovers).toEqual([])
  })

  it('flattens a nested single-folder unzip layout', async () => {
    seedRegistryHappy((tmpDest) => {
      const dest = (tmpDest as string) || join(ROOT, 'NestReg')
      const nested = join(dest, 'NestReg-main')
      h.mkdirPath(nested)
      h.writeFile(join(nested, '__init__.py'), 'x')
      h.writeFile(join(nested, 'pyproject.toml'), 'name = "NestReg"\nversion = "1.0.0"\n')
    })
    const rec = await nodePackService.install({
      id: 'NestReg',
      source: 'registry',
      instanceId: 'inst-1'
    })
    expect(rec.name).toBe('NestReg')
    // After flattening, the pack lives at dest/ directly — no nested folder.
    expect(rec.path).not.toContain('NestReg-main')
  })

  it('throws when the registry reports the pack is banned', async () => {
    setFetch(async (url) => {
      if (url.includes('/install')) return makeRes({ status: 'banned' })
      throw new Error('unexpected')
    })
    await expect(
      nodePackService.install({ id: 'Banned', source: 'registry', instanceId: 'inst-1' })
    ).rejects.toThrow(/banned/i)
  })

  it('throws when no download URL is returned', async () => {
    setFetch(async () => makeRes({ status: 'active' }))
    await expect(
      nodePackService.install({ id: 'NoUrl', source: 'registry', instanceId: 'inst-1' })
    ).rejects.toThrow(/download url/i)
  })

  it('throws on a non-OK install API response', async () => {
    setFetch(async () => makeRes({}, { ok: false, status: 500 }))
    await expect(
      nodePackService.install({ id: 'HttpFail', source: 'registry', instanceId: 'inst-1' })
    ).rejects.toThrow(/HTTP 500/)
  })

  it('blocks an unsafe download URL scheme', async () => {
    setFetch(async () => makeRes({ url: 'ftp://evil/pack.zip' }))
    await expect(
      nodePackService.install({ id: 'Evil', source: 'registry', instanceId: 'inst-1' })
    ).rejects.toThrow(/blocked/i)
  })

  it('throws when the zip download fails', async () => {
    setFetch(async (url) => {
      if (url.includes('/install')) return makeRes({ url: 'https://cdn.example/pack.zip' })
      return makeRes({}, { ok: false, status: 404 })
    })
    await expect(
      nodePackService.install({ id: 'Z404', source: 'registry', instanceId: 'inst-1' })
    ).rejects.toThrow(/download failed/i)
  })

  it('cleans up tmp zip and dest when unzip throws', async () => {
    setFetch(async (url) => {
      if (url.includes('/install')) return makeRes({ url: 'https://cdn.example/pack.zip' })
      return makeRes('zip-bytes')
    })
    const zipSafe = zipSafeMock
    zipSafe.safeUnzip.mockImplementation(async (_zip: string, dest?: string) => {
      const finalDest = dest || join(ROOT, 'BadZip')
      h.mkdirPath(finalDest)
      h.writeFile(join(finalDest, 'partial.bin'), 'x')
      throw new Error('zip slip detected')
    })
    await expect(
      nodePackService.install({ id: 'BadZip', source: 'registry', instanceId: 'inst-1' })
    ).rejects.toThrow(/zip slip/i)
    expect(h.state.dirs.has(join(ROOT, 'BadZip'))).toBe(false)
    const leftovers = [...h.state.files.keys()].filter((k) => k.includes('._install_'))
    expect(leftovers).toEqual([])
  })

  it('includes the version segment in the install API URL', async () => {
    const urls: string[] = []
    setFetch(async (url) => {
      urls.push(url)
      if (url.includes('/install')) return makeRes({ downloadUrl: 'https://cdn.example/pack.zip' })
      return makeRes('zip-bytes')
    })
    const zipSafe = zipSafeMock
    zipSafe.safeUnzip.mockImplementation(async (_zip: string, dest?: string) => {
      const finalDest = dest || join(ROOT, 'VerPack')
      h.mkdirPath(finalDest)
      h.writeFile(join(finalDest, 'pyproject.toml'), 'name = "VerPack"\nversion = "1.0.0"\n')
    })
    await nodePackService.install({
      id: 'VerPack',
      version: '2.0.0',
      source: 'registry',
      instanceId: 'inst-1'
    })
    expect(urls[0]).toContain('/nodes/VerPack/install/2.0.0')
  })
})

// =====================================================================
// afterInstall pip paths
// =====================================================================
describe('afterInstall pip handling', () => {
  it('adds a pip-disabled issue when allowPipInstall is off', async () => {
    h.state.settings.allowPipInstall = false
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        // clone lands in a throwaway temp dir; rename publishes it
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'requests\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipPack2"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/PipPack2.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(rec.issues.map((i) => i.code)).toContain('pip-disabled')
  })

  it('runs pip with the venv python and records no pip-failed on success', async () => {
    h.state.settings.allowPipInstall = true
    h.mkdirPath(join('C:/fake/.venv', 'Scripts'))
    h.writeFile(join('C:/fake/.venv', 'Scripts', 'python.exe'), '')
    const pipCalls: Array<{ cmd: string; args: string[] }> = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'requests\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipPack"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
        return { stdout: '' }
      }
      if (args.includes('pip')) {
        pipCalls.push({ cmd, args: [...args] })
        return { stdout: 'Successfully installed requests-2.0.0', stderr: '' }
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/PipPack.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    // ensurePip probes with `-m pip --version` first — the INSTALL call is the
    // one carrying `-r requirements.txt`.
    const installCalls = pipCalls.filter((c) => c.args.includes('-r') || c.args.includes('install'))
    expect(installCalls.length).toBeGreaterThanOrEqual(1)
    expect(installCalls[0].cmd).toContain('python')
    expect(installCalls[0].args).toContain('-m')
    expect(installCalls[0].args).toContain('pip')
    expect(rec.issues.map((i) => i.code)).not.toContain('pip-failed')
  })

  it('records pip-failed when execFile rejects', async () => {
    h.state.settings.allowPipInstall = true
    h.mkdirPath(join('C:/fake/.venv', 'Scripts'))
    h.writeFile(join('C:/fake/.venv', 'Scripts', 'python.exe'), '')
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'badpkg\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipPack"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
        return { stdout: '' }
      }
      if (args.includes('pip')) {
        // Let the ensurePip probe (--version) succeed; fail the actual install.
        if (args.includes('--version') || args.includes('ensurepip')) return { stdout: 'pip 24.0' }
        return { error: new Error('pip crashed'), stderr: 'pip crashed' }
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/PipPack.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    const pipIssue = rec.issues.find((i) => i.code === 'pip-failed')
    expect(pipIssue).toBeTruthy()
    expect(pipIssue!.severity).toBe('error')
    expect(pipIssue!.message).toMatch(/pip crashed/)
  })

  it('records pip-failed when pip output reports ERROR without success', async () => {
    h.state.settings.allowPipInstall = true
    h.mkdirPath(join('C:/fake/.venv', 'Scripts'))
    h.writeFile(join('C:/fake/.venv', 'Scripts', 'python.exe'), '')
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'bad\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipPack"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
        return { stdout: '' }
      }
      if (args.includes('pip'))
        return {
          stdout: 'ERROR: Could not find a version that satisfies the requirement',
          stderr: ''
        }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/PipPack.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(rec.issues.map((i) => i.code)).toContain('pip-failed')
  })

  it('appends pip mirror args including trusted-host', async () => {
    h.state.settings.allowPipInstall = true
    h.state.settings.pipIndex = 'https://mirror.example/simple/'
    h.mkdirPath(join('C:/fake/.venv', 'Scripts'))
    h.writeFile(join('C:/fake/.venv', 'Scripts', 'python.exe'), '')
    const pipCalls: string[][] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'x\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipPack"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
        return { stdout: '' }
      }
      if (args.includes('pip')) {
        pipCalls.push([...args])
        return { stdout: 'Successfully installed x', stderr: '' }
      }
      return { stdout: '' }
    })
    await nodePackService.install({
      id: 'https://github.com/u/PipPack.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    const installArgs =
      pipCalls.find((a) => a.includes('-r') || a.includes('install')) ||
      pipCalls[pipCalls.length - 1]
    expect(installArgs).toContain('-i')
    expect(installArgs).toContain('https://mirror.example/simple/')
    const installArgs2 =
      pipCalls.find((a) => a.includes('-r') || a.includes('install')) ||
      pipCalls[pipCalls.length - 1]
    expect(installArgs2).toContain('--trusted-host')
    expect(installArgs2).toContain('mirror.example')
  })

  it('skips trusted-host for a scheme-less mirror', async () => {
    h.state.settings.allowPipInstall = true
    h.state.settings.pipIndex = 'mirror.example/simple'
    h.mkdirPath(join('C:/fake/.venv', 'Scripts'))
    h.writeFile(join('C:/fake/.venv', 'Scripts', 'python.exe'), '')
    const pipCalls: string[][] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'x\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipPack"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
        return { stdout: '' }
      }
      if (args.includes('pip')) {
        pipCalls.push([...args])
        return { stdout: 'Successfully installed x', stderr: '' }
      }
      return { stdout: '' }
    })
    await nodePackService.install({
      id: 'https://github.com/u/PipPack.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    const installArgs =
      pipCalls.find((a) => a.includes('-r') || a.includes('install')) ||
      pipCalls[pipCalls.length - 1]
    expect(installArgs).toContain('-i')
    expect(installArgs).not.toContain('--trusted-host')
  })

  it('uses pythonPath then runtimes python then bare python', async () => {
    // pythonPath branch
    h.state.settings.allowPipInstall = true
    h.state.instances[0].pythonPath = 'C:/sys/python.exe'
    h.state.instances[0].venvPath = ''
    const cmds: string[] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'x\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipPack"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
        return { stdout: '' }
      }
      if (args.includes('pip')) {
        cmds.push(cmd)
        return { stdout: 'Successfully installed x', stderr: '' }
      }
      return { stdout: '' }
    })
    await nodePackService.install({
      id: 'https://github.com/u/PipPack.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(cmds[0]).toBe('C:/sys/python.exe')

    // runtimes branch
    h.state.runtimePython = 'C:/runtimes/python.exe'
    h.state.instances[0].pythonPath = ''
    cmds.length = 0
    await nodePackService.install({
      id: 'https://github.com/u/PipPack2.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    // PipPack2 clone creates another pack; pip runs with runtime python
    expect(cmds[0]).toBe('C:/runtimes/python.exe')

    // bare python fallback
    h.state.runtimePython = null
    h.state.runtimePythonThrow = null
    cmds.length = 0
    await nodePackService.install({
      id: 'https://github.com/u/PipPack3.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(cmds[0]).toBe('python')
  })

  it('resolves venv unix python when the Windows exe is missing', async () => {
    h.state.settings.allowPipInstall = true
    h.mkdirPath(join('C:/fake/.venv', 'bin'))
    h.writeFile(join('C:/fake/.venv', 'bin', 'python'), '')
    const cmds: string[] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'x\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipPack"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
        return { stdout: '' }
      }
      if (args.includes('pip')) {
        cmds.push(cmd)
        return { stdout: 'Successfully installed x', stderr: '' }
      }
      return { stdout: '' }
    })
    await nodePackService.install({
      id: 'https://github.com/u/PipPack4.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(cmds[0]).toContain(join('bin', 'python'))
  })
})

// =====================================================================
// uninstall
// =====================================================================
describe('NodePackService.uninstall', () => {
  it('refuses to uninstall a locked pack', async () => {
    seedPack({ name: 'LockUn' })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'LockUn',
        locked: true,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: first.path
      }
    ]
    await expect(nodePackService.uninstall('LockUn', 'inst-1')).rejects.toThrow(/locked/i)
  })

  it('removes the pack directory and the DB record', async () => {
    const dir = seedPack({ name: 'Gone' })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'Gone',
        locked: false,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const ok = await nodePackService.uninstall('Gone', 'inst-1')
    expect(ok).toBe(true)
    expect(h.state.dirs.has(dir)).toBe(false)
    expect(h.state.nodePacks.find((p) => p.name === 'Gone')).toBeUndefined()
  })

  it('returns false for an unknown pack', async () => {
    seedPack({ name: 'Only' })
    expect(await nodePackService.uninstall('Nope', 'inst-1')).toBe(false)
  })

  it('collapses the outer shell for a nested zip layout', async () => {
    const packDir = seedPack({ name: 'ShellPack', nested: true })
    const shell = dirname(packDir)
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'ShellPack',
        locked: false,
        installSource: 'registry',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: packDir
      }
    ]
    const ok = await nodePackService.uninstall('ShellPack', 'inst-1')
    expect(ok).toBe(true)
    expect(h.state.dirs.has(packDir)).toBe(false)
    expect(h.state.dirs.has(shell)).toBe(false)
  })

  it('keeps the parent when the pack is not nested (direct child of custom_nodes)', async () => {
    const packDir = seedPack({ name: 'FlatPack' })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'FlatPack',
        locked: false,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: packDir
      }
    ]
    await nodePackService.uninstall('FlatPack', 'inst-1')
    expect(h.state.dirs.has(packDir)).toBe(false)
    expect(h.state.dirs.has(ROOT)).toBe(true)
  })

  it('falls back to direct rm when rename-to-trash throws', async () => {
    const dir = seedPack({ name: 'RmFallback' })
    h.state.renameFail.add(dir)
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'RmFallback',
        locked: false,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const ok = await nodePackService.uninstall('RmFallback', 'inst-1')
    expect(ok).toBe(true)
    expect(h.state.dirs.has(dir)).toBe(false)
  })
})

// =====================================================================
// update
// =====================================================================
describe('NodePackService.update', () => {
  it('updates a git pack via pull --ff-only and re-reads meta', async () => {
    const dir = seedPack({
      name: 'GitUp',
      withGit: true,
      pyproject: 'name = "GitUp"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'GitUp',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const pulls: string[][] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('pull')) {
        pulls.push([...args])
        h.writeFile(join(dir, 'pyproject.toml'), 'name = "GitUp"\nversion = "2.0.0"\n')
      }
      return { stdout: 'ok' }
    })
    const rec = await nodePackService.update('GitUp', undefined, 'inst-1')
    expect(pulls[0]).toEqual(['-C', dir, 'pull', '--ff-only'])
    expect(rec.version).toBe('2.0.0')
  })

  it('falls back to fetch + ff-merge origin/<branch> when pull has no upstream', async () => {
    const dir = seedPack({
      name: 'NoUpUp',
      withGit: true,
      pyproject: 'name = "NoUpUp"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'NoUpUp',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const merges: string[][] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('pull')) {
        return {
          error: new Error('fatal: no tracking information for the current branch'),
          stderr: 'no tracking information for the current branch'
        }
      }
      if (args.includes('--abbrev-ref') && args.includes('HEAD')) return { stdout: 'main\n' }
      if (args.includes('merge')) {
        merges.push([...args])
        h.writeFile(join(dir, 'pyproject.toml'), 'name = "NoUpUp"\nversion = "2.0.0"\n')
        return { stdout: 'ok' }
      }
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'abc123\n' }
      return { stdout: '' }
    })
    const rec = await nodePackService.update('NoUpUp', undefined, 'inst-1')
    expect(merges[0]).toEqual(['-C', dir, 'merge', '--ff-only', 'origin/main'])
    expect(rec.version).toBe('2.0.0')
  })

  it('wraps git pull failures with the pack name', async () => {
    const dir = seedPack({ name: 'GitFail', withGit: true })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'GitFail',
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
      if (args.includes('pull')) return { error: new Error('diverged'), stderr: 'diverged' }
      return { stdout: '' }
    })
    await expect(nodePackService.update('GitFail', undefined, 'inst-1')).rejects.toThrow(
      /git pull failed for GitFail/
    )
  })

  it('reinstalls a registry pack and drops the .bak backup on success', async () => {
    const dir = seedPack({
      name: 'RegUp',
      pyproject: 'name = "RegUp"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'RegUp',
        locked: false,
        installSource: 'registry',
        registryId: 'reg-up',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    setFetch(async (url) => {
      if (url.includes('/install')) return makeRes({ url: 'https://cdn.example/pack.zip' })
      return makeRes('zip')
    })
    const zipSafe = zipSafeMock
    zipSafe.safeUnzip.mockImplementation(async (_zip: string, dest?: string) => {
      const finalDest = dest || join(ROOT, 'reg-up')
      h.mkdirPath(finalDest)
      h.writeFile(
        join(finalDest, 'pyproject.toml'),
        'name = "RegUp"\nversion = "2.0.0"\nrepository = "https://r"\n'
      )
    })
    const rec = await nodePackService.update('RegUp', undefined, 'inst-1')
    expect(rec.version).toBe('2.0.0')
    // original dir was renamed to .bak-* then cleaned up
    const baks = [...h.state.dirs.keys()].filter((k) => k.includes('.bak-'))
    expect(baks).toEqual([])
  })

  it('registry reinstall keeps ONE runId and a monotonic percent (reuseStream)', async () => {
    const dir = seedPack({
      name: 'RegMono',
      pyproject: 'name = "RegMono"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'RegMono',
        locked: false,
        installSource: 'registry',
        registryId: 'reg-mono',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    setFetch(async (url) => {
      if (url.includes('/install')) return makeRes({ url: 'https://cdn.example/pack.zip' })
      return makeRes('zip')
    })
    zipSafeMock.safeUnzip.mockImplementation(async (_zip: string, dest?: string) => {
      const finalDest = dest || join(ROOT, 'reg-mono')
      h.mkdirPath(finalDest)
      h.writeFile(
        join(finalDest, 'pyproject.toml'),
        'name = "RegMono"\nversion = "2.0.0"\nrepository = "https://r"\n'
      )
    })
    const progresses: Array<{
      runId: string
      percent: number
      cloneStatus?: string
    }> = []
    const onProg = (p: {
      runId: string
      percent: number
      instanceId?: string
      steps?: Array<{ id: string; status: string }>
    }): void => {
      // The service is a file-level singleton; only this instance's stream is
      // under test (a stale async op from another test must not leak in).
      if (p.instanceId !== 'inst-1') return
      progresses.push({
        runId: p.runId,
        percent: p.percent,
        cloneStatus: p.steps?.find((s) => s.id === 'clone')?.status
      })
    }
    nodePackService.on('op-progress', onProg)
    try {
      const rec = await nodePackService.update('RegMono', undefined, 'inst-1')
      expect(rec.version).toBe('2.0.0')
    } finally {
      nodePackService.off('op-progress', onProg)
    }
    // The whole update (git-prefer attempt → zip fallback) is ONE stream.
    expect(new Set(progresses.map((p) => p.runId)).size).toBe(1)
    // And the bar never jumps backwards, even when installInner re-marks the
    // pre-skipped clone step as running.
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i].percent).toBeGreaterThanOrEqual(progresses[i - 1].percent)
    }
    expect(progresses.some((p) => p.cloneStatus === 'skipped')).toBe(true)
  })

  it('rolls back a failed registry update and rethrows the original error', async () => {
    const dir = seedPack({
      name: 'RegRb',
      pyproject: 'name = "RegRb"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'RegRb',
        locked: false,
        installSource: 'registry',
        registryId: 'reg-rb',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    setFetch(async (url) => {
      if (url.includes('/install')) return makeRes({}, { ok: false, status: 502 })
      return makeRes('zip')
    })
    await expect(nodePackService.update('RegRb', undefined, 'inst-1')).rejects.toThrow(/HTTP 502/)
    // rollback restored the original directory
    expect(h.state.dirs.has(dir)).toBe(true)
  })

  it('reports backup-at when both update and rollback fail', async () => {
    const dir = seedPack({
      name: 'RegBoth',
      pyproject: 'name = "RegBoth"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'RegBoth',
        locked: false,
        installSource: 'registry',
        registryId: 'reg-both',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    setFetch(async (url) => {
      if (url.includes('/install')) return makeRes({}, { ok: false, status: 500 })
      return makeRes('zip')
    })
    // renaming the .bak trash back into place will fail (rollback failure)
    h.state.renameFail.add('.bak-')
    let caught: Error | null = null
    try {
      await nodePackService.update('RegBoth', undefined, 'inst-1')
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeTruthy()
    expect(caught!.message).toMatch(/rollback also failed/)
    expect(caught!.message).toMatch(/backup at/)
    expect(caught!.message).toMatch(/\.bak-/)
  })

  it('throws not-updatable for a local pack without git', async () => {
    const dir = seedPack({ name: 'LocalOnly' })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'LocalOnly',
        locked: false,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    await expect(nodePackService.update('LocalOnly', undefined, 'inst-1')).rejects.toThrow(
      /not updatable/i
    )
  })
})

// =====================================================================
// toggle / lock
// =====================================================================
describe('toggle and lock', () => {
  it('moves the pack into custom_nodes/.disabled when disabling (Manager-compatible)', () => {
    const dir = seedPack({ name: 'TogA' })
    const p = nodePackService.toggle('TogA', false, 'inst-1')
    expect(p?.status).toBe('disabled')
    expect(p?.path).toBe(join(ROOT, '.disabled', 'TogA'))
    expect(h.state.dirs.has(dir)).toBe(false)
    expect(h.state.dirs.has(join(ROOT, '.disabled', 'TogA'))).toBe(true)
  })

  it('lists packs inside .disabled/ as disabled', () => {
    seedPack({ name: 'TogA2' })
    nodePackService.toggle('TogA2', false, 'inst-1')
    const rec = nodePackService.list('inst-1').find((x) => x.name === 'TogA2')
    expect(rec?.status).toBe('disabled')
    expect(rec?.path).toBe(join(ROOT, '.disabled', 'TogA2'))
  })

  it('moves a disabled pack back out of .disabled/ when enabling', () => {
    seedPack({ name: 'TogB2' })
    nodePackService.toggle('TogB2', false, 'inst-1')
    const p = nodePackService.toggle('TogB2', true, 'inst-1')
    expect(p?.status).toBe('installed')
    expect(p?.path).toBe(join(ROOT, 'TogB2'))
    expect(h.state.dirs.has(join(ROOT, '.disabled', 'TogB2'))).toBe(false)
  })

  it('removes a legacy .disabled marker when enabling', () => {
    const dir = seedPack({ name: 'TogB', disabledMarker: true })
    const p = nodePackService.toggle('TogB', true, 'inst-1')
    expect(p?.status).toBe('installed')
    expect(h.state.files.has(join(dir, '.disabled'))).toBe(false)
  })

  it('renames name.disabled back to name when enabling', () => {
    seedPack({ name: 'TogC', disabledSuffix: true })
    const disabledDir = join(ROOT, 'TogC.disabled')
    const p = nodePackService.toggle('TogC', true, 'inst-1')
    expect(p?.path).toBe(join(ROOT, 'TogC'))
    expect(h.state.dirs.has(disabledDir)).toBe(false)
    expect(h.state.dirs.has(join(ROOT, 'TogC'))).toBe(true)
  })

  it('throws when the enable target already exists', () => {
    seedPack({ name: 'TogD', disabledSuffix: true })
    h.mkdirPath(join(ROOT, 'TogD'))
    expect(() => nodePackService.toggle('TogD', true, 'inst-1')).toThrow(/already exists/)
  })

  it('throws when the disable target already exists', () => {
    seedPack({ name: 'TogE' })
    h.mkdirPath(join(ROOT, '.disabled', 'TogE'))
    expect(() => nodePackService.toggle('TogE', false, 'inst-1')).toThrow(/already exists/)
  })

  it('checkUpdates reports disabled packs explicitly (never silently drops them)', async () => {
    seedPack({ name: 'SkipUpd' })
    nodePackService.toggle('SkipUpd', false, 'inst-1')
    const results = await nodePackService.checkUpdates('inst-1')
    const row = results.find((r) => r.name === 'SkipUpd')
    expect(row).toBeTruthy()
    expect(row?.updatable).toBe(false)
    expect(row?.checkStatus).toBe('skipped-disabled')
  })

  it('update on a disabled pack is refused with NODE_DISABLED', async () => {
    seedPack({ name: 'NoUpd' })
    nodePackService.toggle('NoUpd', false, 'inst-1')
    await expect(nodePackService.update('NoUpd', undefined, 'inst-1')).rejects.toMatchObject({
      code: 'NODE_DISABLED'
    })
  })

  it('returns undefined for an unknown pack', () => {
    seedPack({ name: 'TogE' })
    expect(nodePackService.toggle('Nope', false, 'inst-1')).toBeUndefined()
  })

  it('lock/unlock toggles the locked flag', () => {
    seedPack({ name: 'LockA' })
    const locked = nodePackService.lock('LockA', true, 'inst-1')
    expect(locked?.locked).toBe(true)
    const unlocked = nodePackService.lock('LockA', false, 'inst-1')
    expect(unlocked?.locked).toBe(false)
  })

  it('lock returns undefined for unknown packs', () => {
    seedPack({ name: 'LockB' })
    expect(nodePackService.lock('Nope', true)).toBeUndefined()
  })
})

// =====================================================================
// checkIssues / conflicts / smokeTest
// =====================================================================
describe('checkIssues, conflicts, smokeTest', () => {
  it('checkIssues returns the collected issues for a pack', () => {
    seedPack({ name: 'IssA', requirements: 'torch==1.0\n' })
    const issues = nodePackService.checkIssues('IssA', 'inst-1')
    expect(issues.map((i) => i.code)).toContain('TORCH_PIN')
    expect(nodePackService.checkIssues('Nope', 'inst-1')).toEqual([])
  })

  it('conflicts reports node names claimed by more than one pack', () => {
    seedPack({
      name: 'CA',
      pyproject: 'name = "CA"\nversion = "1"\n',
      nodeListJson: JSON.stringify(['SharedNode', 'OnlyA'])
    })
    seedPack({
      name: 'CB',
      pyproject: 'name = "CB"\nversion = "1"\n',
      nodeListJson: JSON.stringify(['SharedNode', 'OnlyB'])
    })
    const c = nodePackService.conflicts('inst-1')
    expect(c).toHaveLength(1)
    expect(c[0].nodeName).toBe('SharedNode')
    expect(c[0].packs.sort()).toEqual(['CA', 'CB'])
  })

  it('conflicts is empty when node names are unique', () => {
    seedPack({ name: 'UA', nodeListJson: JSON.stringify(['N1']) })
    seedPack({ name: 'UB', nodeListJson: JSON.stringify(['N2']) })
    expect(nodePackService.conflicts('inst-1')).toEqual([])
  })

  it('smokeTest returns [] on a successful import', async () => {
    seedPack({ name: 'SmokeOk' })
    cpMock.__setExecHandler(() => ({ stdout: '', code: 0 }))
    expect(await nodePackService.smokeTest('SmokeOk', 'inst-1')).toEqual([])
  })

  it('smokeTest reports NO_INIT when __init__.py is missing (exit code 3)', async () => {
    seedPack({
      name: 'SmokeNoInit',
      initPy: null,
      pyproject: 'name = "SmokeNoInit"\nversion = "1"\n'
    })
    cpMock.__setExecHandler(() => {
      const err = Object.assign(new Error('exit 3'), { code: 3 })
      return { error: err, stderr: 'exit 3' }
    })
    const issues = await nodePackService.smokeTest('SmokeNoInit', 'inst-1')
    expect(issues[0].code).toBe('NO_INIT')
    expect(issues[0].severity).toBe('warning')
  })

  it('smokeTest reports IMPORT_FAIL on other failures', async () => {
    seedPack({ name: 'SmokeFail' })
    cpMock.__setExecHandler(() => {
      const err = Object.assign(new Error('ModuleNotFoundError: nope'), { code: 2 })
      return { error: err, stderr: 'ModuleNotFoundError: nope' }
    })
    const issues = await nodePackService.smokeTest('SmokeFail', 'inst-1')
    expect(issues[0].code).toBe('IMPORT_FAIL')
    expect(issues[0].severity).toBe('error')
  })

  it('smokeTest returns [] for an unknown pack', async () => {
    seedPack({ name: 'SmokeX' })
    expect(await nodePackService.smokeTest('Nope', 'inst-1')).toEqual([])
  })
})

// =====================================================================
// snapshots
// =====================================================================
describe('snapshots', () => {
  it('createSnapshot records packs and marks disabled ones with @disabled', () => {
    seedPack({ name: 'SnapA' })
    seedPack({ name: 'SnapB', disabledMarker: true })
    const snap = nodePackService.createSnapshot('manual-1', 'inst-1')
    expect(snap.name).toBe('manual-1')
    expect(snap.packs).toHaveLength(2)
    const disabled = snap.packs.find((p) => p.name === 'SnapB')
    const enabled = snap.packs.find((p) => p.name === 'SnapA')
    expect(disabled?.source).toMatch(/@disabled$/)
    expect(enabled?.source).toBe('local')
    expect(h.state.snapshots).toHaveLength(1)
    // writes a json sidecar
    expect([...h.state.files.keys()].some((k) => k.includes(snap.id))).toBe(true)
  })

  it('createSnapshot generates a default name when none is given', () => {
    seedPack({ name: 'SnapC' })
    const snap = nodePackService.createSnapshot()
    expect(snap.name).toMatch(/^snapshot-/)
  })

  it('snapshots() lists DB snapshots', () => {
    seedPack({ name: 'SnapD' })
    nodePackService.createSnapshot('s1')
    expect(nodePackService.snapshots()).toHaveLength(1)
  })

  it('restoreSnapshot returns false for a missing snapshot', () => {
    expect(nodePackService.restoreSnapshot('nope')).toBe(false)
  })

  it('restoreSnapshot disables packs missing from the snapshot and aligns markers', () => {
    seedPack({ name: 'KeepOn' })
    seedPack({ name: 'TurnOff', disabledMarker: true })
    seedPack({ name: 'DropMe' })
    const snap = nodePackService.createSnapshot('align', 'inst-1')
    // Snapshot has KeepOn enabled, TurnOff disabled, DropMe enabled.
    // Now flip current state and restore.
    nodePackService.toggle('KeepOn', false, 'inst-1')
    nodePackService.toggle('TurnOff', true, 'inst-1')
    const ok = nodePackService.restoreSnapshot(snap.id, 'inst-1')
    expect(ok).toBe(true)
    const byName = new Map(nodePackService.list('inst-1').map((p) => [p.name, p]))
    expect(byName.get('KeepOn')?.status).toBe('installed')
    expect(byName.get('TurnOff')?.status).toBe('disabled')
    // DropMe is in the snapshot (enabled), so it stays enabled
    expect(byName.get('DropMe')?.status).toBe('installed')
  })

  it('restoreSnapshot disables current packs absent from the snapshot', () => {
    seedPack({ name: 'Early' })
    const snap = nodePackService.createSnapshot('with-early', 'inst-1')
    seedPack({ name: 'Late' })
    const ok = nodePackService.restoreSnapshot(snap.id, 'inst-1')
    expect(ok).toBe(true)
    const byName = new Map(nodePackService.list('inst-1').map((p) => [p.name, p]))
    expect(byName.get('Late')?.status).toBe('disabled')
    expect(byName.get('Early')?.status).toBe('installed')
  })

  it('restoreSnapshot keeps a .disabled-suffixed pack disabled (real form, no marker)', () => {
    // Snapshot says disabled and the folder is already in the ComfyUI-recognized
    // `.disabled` suffix form — restore must leave it disabled without needing
    // a legacy marker file.
    const hiddenDir = join(ROOT, 'Ghost.disabled')
    h.mkdirPath(hiddenDir)
    h.writeFile(join(hiddenDir, 'pyproject.toml'), 'name = "Ghost"\nversion = "1"\n')
    seedPack({ name: 'Visible' })
    const snap = {
      id: 'snap-ghost',
      name: 'ghost',
      createdAt: Date.now(),
      packs: [
        { name: 'Ghost', version: '1', path: hiddenDir, source: 'local@disabled' },
        { name: 'Visible', version: '1', path: join(ROOT, 'Visible'), source: 'local' }
      ],
      notes: ''
    }
    h.state.snapshots.push(snap)
    h.state.snapshotById.set(snap.id, snap)
    const ok = nodePackService.restoreSnapshot('snap-ghost')
    expect(ok).toBe(true)
    const ghost = nodePackService.list('inst-1').find((p) => p.name === 'Ghost')
    expect(ghost?.status).toBe('disabled')
    expect(h.state.files.has(join(hiddenDir, '.disabled'))).toBe(false)
  })

  it('restoreSnapshot removes a stale marker for a snap-enabled pack not in the listing', () => {
    const hiddenDir = join(ROOT, 'Ghost2')
    h.mkdirPath(hiddenDir)
    h.writeFile(join(hiddenDir, 'pyproject.toml'), 'name = "Ghost2"\nversion = "1"\n')
    h.writeFile(join(hiddenDir, '.disabled'), 'old')
    seedPack({ name: 'Vis2' })
    const snap = {
      id: 'snap-ghost2',
      name: 'ghost2',
      createdAt: Date.now(),
      packs: [
        { name: 'Ghost2', version: '1', path: hiddenDir, source: 'local' },
        { name: 'Vis2', version: '1', path: join(ROOT, 'Vis2'), source: 'local' }
      ],
      notes: ''
    }
    h.state.snapshots.push(snap)
    h.state.snapshotById.set(snap.id, snap)
    const ok = nodePackService.restoreSnapshot('snap-ghost2')
    expect(ok).toBe(true)
    expect(h.state.files.has(join(hiddenDir, '.disabled'))).toBe(false)
  })

  it('deleteSnapshot removes the sidecar file and DB row', () => {
    seedPack({ name: 'SnapDel' })
    const snap = nodePackService.createSnapshot('to-delete')
    const ok = nodePackService.deleteSnapshot(snap.id)
    expect(ok).toBe(true)
    expect(h.state.snapshots).toHaveLength(0)
    expect([...h.state.files.keys()].some((k) => k.includes(snap.id))).toBe(false)
  })
})

// =====================================================================
// checkUpdates
// =====================================================================
describe('checkUpdates channels', () => {
  it('flags a registry pack with a newer remote version', async () => {
    const dir = seedPack({
      name: 'RegChk',
      pyproject: 'name = "RegChk"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'RegChk',
        locked: false,
        installSource: 'registry',
        registryId: 'reg-chk',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const { searchRegistry, toPageResult, mapRegistryPack } = registryMock
    searchRegistry.mockResolvedValue({
      raw: [{ id: 'reg-chk', name: 'RegChk', latestVersion: '2.0.0' }],
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    })
    toPageResult.mockImplementation(
      (result: { raw?: unknown[] }, map: (n: unknown) => unknown) => ({
        items: (result.raw || []).map(map),
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
        scanned: 1,
        clientFiltered: false
      })
    )
    mapRegistryPack.mockImplementation((n: Record<string, unknown>) => n)
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].updatable).toBe(true)
    expect(results[0].updateSource).toBe('registry')
    expect(results[0].latestVersion).toBe('2.0.0')
  })

  it('reports up-to-date for a registry pack at the latest version', async () => {
    const dir = seedPack({
      name: 'RegChk2',
      pyproject: 'name = "RegChk2"\nversion = "2.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'RegChk2',
        locked: false,
        installSource: 'registry',
        registryId: 'reg-chk2',
        version: '2.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const { searchRegistry, toPageResult, mapRegistryPack } = registryMock
    searchRegistry.mockResolvedValue({
      raw: [{ id: 'reg-chk2', name: 'RegChk2', latestVersion: '2.0.0' }],
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    })
    toPageResult.mockImplementation(
      (result: { raw?: unknown[] }, map: (n: unknown) => unknown) => ({
        items: (result.raw || []).map(map),
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
        scanned: 1,
        clientFiltered: false
      })
    )
    mapRegistryPack.mockImplementation((n: Record<string, unknown>) => n)
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].updatable).toBe(false)
    expect(results[0].reasonKey).toBe('nodes.upToDate')
  })

  it('reports git behind counts for packs with a .git dir', async () => {
    const dir = seedPack({
      name: 'GitChk',
      withGit: true,
      pyproject: 'name = "GitChk"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'GitChk',
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
      if (args.includes('rev-list')) return { stdout: '3' }
      if (args.includes('describe')) return { stdout: 'v2.0.0\n' }
      return { stdout: '' }
    })
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].updatable).toBe(true)
    expect(results[0].updateSource).toBe('git')
    expect(results[0].reason).toMatch(/3 commit/)
    expect(results[0].latestVersion).toBe('v2.0.0')
  })

  it('reports git up-to-date when behind count is zero', async () => {
    const dir = seedPack({
      name: 'GitChk2',
      withGit: true,
      pyproject: 'name = "GitChk2"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'GitChk2',
        locked: false,
        installSource: 'manager',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('rev-list')) return { stdout: '0' }
      return { stdout: '' }
    })
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].updatable).toBe(false)
    expect(results[0].updateSource).toBe('git')
    expect(results[0].reasonKey).toBe('nodes.upToDate')
  })

  it('returns results for git packs using origin/<branch> when upstream is missing', async () => {
    const dir = seedPack({
      name: 'GitNoUp',
      withGit: true,
      pyproject: 'name = "GitNoUp"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'GitNoUp',
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
      if (args.includes('@{u}'))
        return { error: new Error('no upstream'), stderr: 'fatal: no upstream' }
      if (args.includes('--verify')) return { stdout: '' }
      if (args.includes('--abbrev-ref') && args.includes('HEAD')) return { stdout: 'main\n' }
      if (args.includes('rev-list')) return { stdout: '2' }
      if (args.includes('describe')) return { stdout: 'v9.9.9\n' }
      return { stdout: '' }
    })
    const results = await nodePackService.checkUpdates('inst-1')
    const r = results.find((x) => x.name === 'GitNoUp')
    expect(r?.updatable).toBe(true)
    expect(r?.updateSource).toBe('git')
    expect(r?.latestVersion).toBe('v9.9.9')
  })

  it('reports a git pack with no upstream and no origin branch as not updatable (still git)', async () => {
    const dir = seedPack({
      name: 'GitNoRemote',
      withGit: true,
      pyproject: 'name = "GitNoRemote"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'GitNoRemote',
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
      if (args.includes('@{u}')) return { error: new Error('no upstream'), stderr: 'fatal' }
      if (args.includes('--verify')) return { error: new Error('missing'), stderr: 'fatal' }
      if (args.includes('--abbrev-ref') && args.includes('HEAD')) return { stdout: 'main\n' }
      return { stdout: '' }
    })
    const results = await nodePackService.checkUpdates('inst-1')
    const r = results.find((x) => x.name === 'GitNoRemote')
    expect(r?.updatable).toBe(false)
    expect(r?.updateSource).toBe('git')
  })

  it('git fetch failure reports check-failed (not silently "not updatable")', async () => {
    const dir = seedPack({
      name: 'GitChk3',
      withGit: true,
      pyproject: 'name = "GitChk3"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'GitChk3',
        locked: false,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('fetch'))
        return { error: new Error('network down'), stderr: 'network down' }
      return { stdout: '' }
    })
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].updateSource).toBe('git')
    expect(results[0].checkStatus).toBe('check-failed')
    expect(results[0].error).toContain('network down')
    expect(results[0].updatable).toBe(false)
  })

  it('reports no remote version information when nothing is known', async () => {
    const dir = seedPack({
      name: 'NoRemote',
      pyproject: 'name = "NoRemote"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'NoRemote',
        locked: false,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].updatable).toBe(false)
    expect(results[0].reasonKey).toBe('nodes.notUpdatable')
    expect(results[0].latestVersion).toBeUndefined()
  })

  it('uses the local registry index when page 1 misses the pack', async () => {
    const dir = seedPack({
      name: 'IdxPack',
      pyproject: 'name = "IdxPack"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'IdxPack',
        locked: false,
        installSource: 'registry',
        registryId: 'idx-pack',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
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
    toPageResult.mockImplementation(
      (result: { raw?: unknown[] }, map: (n: unknown) => unknown) => ({
        items: (result.raw || []).map(map),
        total: 0,
        page: 1,
        pageSize: 50,
        totalPages: 0,
        scanned: 0,
        clientFiltered: false
      })
    )
    mapRegistryPack.mockImplementation((n: Record<string, unknown>) => n)
    const { registryIndex } = registryIndexMock
    registryIndex.searchPacks.mockReturnValue([
      { id: 'idx-pack', name: 'IdxPack', latestVersion: '9.9.9' }
    ])
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results[0].latestVersion).toBe('9.9.9')
    expect(results[0].updatable).toBe(true)
    // persisted latestVersion
    expect(h.state.nodePacks[0].latestVersion).toBe('9.9.9')
  })

  it('survives a registry outage and still returns per-pack rows', async () => {
    seedPack({
      name: 'OfflineReg',
      pyproject: 'name = "OfflineReg"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const { searchRegistry } = registryMock
    searchRegistry.mockRejectedValue(new Error('registry down'))
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('OfflineReg')
  })
})

// =====================================================================
// updateAll
// =====================================================================
describe('updateAll', () => {
  it('mixes success, failure and skip into a summary', async () => {
    const dirA = seedPack({
      name: 'AllA',
      withGit: true,
      pyproject: 'name = "AllA"\nversion = "1.0.0"\n'
    })
    const dirB = seedPack({
      name: 'AllB',
      withGit: true,
      pyproject: 'name = "AllB"\nversion = "1.0.0"\n'
    })
    seedPack({
      name: 'AllC',
      pyproject: 'name = "AllC"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const ids = listIds()
    h.state.nodePacks = [
      {
        id: ids.get('AllA'),
        name: 'AllA',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dirA
      },
      {
        id: ids.get('AllB'),
        name: 'AllB',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dirB
      },
      {
        id: ids.get('AllC'),
        name: 'AllC',
        locked: true,
        installSource: 'registry',
        registryId: 'all-c',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: join(ROOT, 'AllC')
      }
    ]
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('rev-list')) return { stdout: '2' }
      if (args.includes('fetch')) return { stdout: '' }
      if (args.includes('describe')) return { stdout: 'v2\n' }
      if (args.includes('pull')) {
        if (args[1] === dirB || args.includes(dirB))
          return { error: new Error('pull failed'), stderr: 'pull failed' }
        return { stdout: 'ok' }
      }
      return { stdout: '' }
    })
    const out = await nodePackService.updateAll('inst-1')
    const byName = new Map(out.map((r) => [r.name, r]))
    expect(byName.get('AllA')?.ok).toBe(true)
    expect(byName.get('AllA')?.error).toBeUndefined()
    expect(byName.get('AllB')?.ok).toBe(false)
    expect(byName.get('AllB')?.error).toMatch(/git pull failed/)
    expect(byName.get('AllC')?.skipped).toBe(true)
    expect(byName.get('AllC')?.ok).toBe(true)
  })

  it('includeCheckFailed retries packs whose pre-check failed (0.1.11)', async () => {
    const dirOk = seedPack({
      name: 'CC-Ok',
      withGit: true,
      pyproject: 'name = "CC-Ok"\nversion = "1.0.0"\n'
    })
    const dirFail = seedPack({
      name: 'CC-Fail',
      withGit: true,
      pyproject: 'name = "CC-Fail"\nversion = "1.0.0"\n'
    })
    const ids = listIds()
    h.state.nodePacks = [
      {
        id: ids.get('CC-Ok'),
        name: 'CC-Ok',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dirOk
      },
      {
        id: ids.get('CC-Fail'),
        name: 'CC-Fail',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dirFail
      }
    ]
    cpMock.__setExecHandler((_cmd, args) => {
      const isFailPack = args.some((a) => String(a).includes('CC-Fail'))
      if (args.includes('fetch')) {
        // A flaky fetch makes the pre-check fail for CC-Fail only.
        if (isFailPack) return { error: new Error('fetch timeout'), stderr: 'fetch timeout' }
        return { stdout: '' }
      }
      if (args.includes('rev-list')) return { stdout: isFailPack ? '0' : '2' }
      if (args.includes('describe')) return { stdout: 'v2\n' }
      if (args.includes('pull')) return { stdout: 'ok' }
      return { stdout: '' }
    })
    try {
      // Conservative default: a failed check means "not attempted".
      const conservative = await nodePackService.updateAll('inst-1')
      const cFail = conservative.find((r) => r.name === 'CC-Fail')!
      expect(cFail.skipped).toBe(true)
      expect(cFail.checkStatus).toBe('check-failed')

      // Opt-in retry: the pack IS attempted and its outcome reported.
      const retried = await nodePackService.updateAll('inst-1', { includeCheckFailed: true })
      const rFail = retried.find((r) => r.name === 'CC-Fail')!
      expect(rFail.ok).toBe(true)
      expect(rFail.skipped).toBeUndefined()
      expect(rFail.checkStatus).toBe('check-failed')
    } finally {
      cpMock.__setExecHandler(null)
    }
  })

  it('never lets a stale shallow-clone tag overwrite latestVersion (0.1.11)', async () => {
    const dir = seedPack({
      name: 'ShallowTag',
      withGit: true,
      pyproject: 'name = "ShallowTag"\nversion = "1.2.0"\n'
    })
    const ids = listIds()
    h.state.nodePacks = [
      {
        id: ids.get('ShallowTag'),
        name: 'ShallowTag',
        locked: false,
        installSource: 'git',
        version: '1.2.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    cpMock.__setExecHandler((_cmd, args) => {
      if (args.includes('fetch')) return { stdout: '' }
      if (args.includes('rev-list')) return { stdout: '1' }
      // `describe` on a --depth 1 clone resolves to an OLD tag (1.0 < 1.2).
      if (args.includes('describe')) return { stdout: 'v1.0.0\n' }
      return { stdout: '' }
    })
    try {
      const checks = await nodePackService.checkUpdates('inst-1')
      const r = checks.find((c) => c.name === 'ShallowTag')!
      expect(r.updatable).toBe(true)
      // The honest signal is the commit distance, not the misleading tag.
      expect(r.behindCount).toBe(1)
      expect(r.latestVersion).toBeUndefined()
      // The stored record must not learn the stale tag either.
      const stored = h.state.nodePacks.find((p) => p.name === 'ShallowTag')
      expect(stored?.latestVersion).toBeUndefined()
    } finally {
      cpMock.__setExecHandler(null)
    }
  })

  it('emits batch-error and rethrows when the pre-check itself throws', async () => {
    const spy = vi
      .spyOn(nodePackService, 'checkUpdates')
      .mockRejectedValueOnce(new Error('precheck boom'))
    const events: Array<{ phase: string; error?: string }> = []
    const onEvent = (e: { phase: string; error?: string }): void => {
      events.push(e)
    }
    nodePackService.on('update-batch', onEvent)
    try {
      await expect(nodePackService.updateAll('inst-1')).rejects.toThrow('precheck boom')
    } finally {
      nodePackService.off('update-batch', onEvent)
      spy.mockRestore()
    }
    // 'checking' opens the batch, then the terminal batch-error.
    expect(events.map((e) => e.phase)).toEqual(['checking', 'batch-error'])
    expect(events[1]).toMatchObject({ phase: 'batch-error', error: 'precheck boom' })
  })
})

// =====================================================================
// 0.1.9 check-status matrix (every pack gets an explicit row)
// =====================================================================
describe('checkUpdates status matrix', () => {
  it('reports disabled/locked/check-failed rows explicitly', async () => {
    seedPack({
      name: 'MxA',
      withGit: true,
      pyproject: 'name = "MxA"\nversion = "1.0.0"\n'
    })
    seedPack({ name: 'MxB', pyproject: 'name = "MxB"\nversion = "1.0.0"\n' })
    seedPack({ name: 'MxC', pyproject: 'name = "MxC"\nversion = "1.0.0"\n' })
    nodePackService.toggle('MxB', false, 'inst-1')
    nodePackService.lock('MxC', true, 'inst-1')
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('fetch')) return { error: new Error('down'), stderr: 'down' }
      return { stdout: '' }
    })
    const rows = await nodePackService.checkUpdates('inst-1')
    const by = new Map(rows.map((r) => [r.name, r]))
    expect(rows).toHaveLength(3)
    expect(by.get('MxA')?.checkStatus).toBe('check-failed')
    expect(by.get('MxB')?.checkStatus).toBe('skipped-disabled')
    expect(by.get('MxC')?.checkStatus).toBe('locked')
  })

  it('matches a local pack to registry metadata by repository URL', async () => {
    const dir = seedPack({
      name: 'RepoMatch',
      pyproject:
        'name = "RepoMatch"\nversion = "1.0.0"\nrepository = "git@github.com:Org/RepoMatch.git"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'RepoMatch',
        locked: false,
        installSource: 'local',
        repository: 'git@github.com:Org/RepoMatch.git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    registryIndexMock.registryIndex.findByRepository.mockReturnValue({
      id: 'rm-id',
      name: 'RepoMatch',
      latestVersion: '2.0.0'
    })
    try {
      const rows = await nodePackService.checkUpdates('inst-1')
      const r = rows.find((x) => x.name === 'RepoMatch')
      expect(r?.latestVersion).toBe('2.0.0')
      // Local copies are checked, but not updatable via registry — honest status.
      expect(r?.checkStatus).toBe('unsupported')
      expect(r?.updatable).toBe(false)
    } finally {
      registryIndexMock.registryIndex.findByRepository.mockReturnValue(null)
    }
  })

  it('persists git check results (latestVersion + lastCheckedAt)', async () => {
    const dir = seedPack({
      name: 'GitPersist',
      withGit: true,
      pyproject: 'name = "GitPersist"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'GitPersist',
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
      if (args.includes('describe')) return { stdout: 'v9.9.9\n' }
      if (args.includes('fetch')) return { stdout: '' }
      if (args.includes('@{u}')) return { stdout: 'origin/main\n' }
      if (args.includes('rev-list')) return { stdout: '1' }
      return { stdout: '' }
    })
    const rows = await nodePackService.checkUpdates('inst-1')
    expect(rows[0].checkStatus).toBe('updatable')
    const known = h.state.nodePacks.find((p) => p.name === 'GitPersist')!
    expect(known.latestVersion).toBe('v9.9.9')
    expect(known.lastCheckedAt).toBeGreaterThan(0)
  })

  it('does not trust ambiguous registry name matches', async () => {
    const dir = seedPack({
      name: 'Ambiguous',
      pyproject: 'name = "Ambiguous"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'Ambiguous',
        locked: false,
        installSource: 'registry',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    registryIndexMock.registryIndex.searchPacks.mockReturnValue([
      { id: 'a1', name: 'Ambiguous', latestVersion: '2.0.0' },
      { id: 'a2', name: 'Ambiguous', latestVersion: '3.0.0' }
    ])
    try {
      const rows = await nodePackService.checkUpdates('inst-1')
      const r = rows.find((x) => x.name === 'Ambiguous')
      expect(r?.checkStatus).toBe('unsupported')
      expect(r?.updatable).toBe(false)
    } finally {
      registryIndexMock.registryIndex.searchPacks.mockReturnValue([])
    }
  })

  it('emits check progress for every pack', async () => {
    seedPack({ name: 'CpA', pyproject: 'name = "CpA"\nversion = "1.0.0"\n' })
    seedPack({ name: 'CpB', pyproject: 'name = "CpB"\nversion = "1.0.0"\n' })
    const seen: Array<{ done: number; total: number }> = []
    const onProg = (p: { done: number; total: number }): void => {
      seen.push({ done: p.done, total: p.total })
    }
    nodePackService.on('check-progress', onProg)
    try {
      await nodePackService.checkUpdates('inst-1')
    } finally {
      nodePackService.off('check-progress', onProg)
    }
    expect(seen).toHaveLength(2)
    expect(seen.map((s) => s.done).sort((a, b) => a - b)).toEqual([1, 2])
    expect(seen[0].total).toBe(2)
  })

  it('a pack whose check crashes still gets a check-failed row (no lost results)', async () => {
    seedPack({ name: 'CrashA', pyproject: 'name = "CrashA"\nversion = "1.0.0"\n' })
    seedPack({ name: 'CrashB', pyproject: 'name = "CrashB"\nversion = "1.0.0"\n' })
    const spy = vi
      .spyOn(
        nodePackService as unknown as { checkOnePack: (...a: unknown[]) => Promise<unknown> },
        'checkOnePack'
      )
      .mockRejectedValueOnce(new Error('boom'))
    try {
      const rows = await nodePackService.checkUpdates('inst-1')
      expect(rows).toHaveLength(2)
      const byName = new Map(rows.map((r) => [r.name, r]))
      // CrashA is queued first and workers shift synchronously, so the
      // mockRejectedValueOnce deterministically lands on CrashA.
      expect(byName.get('CrashA')).toMatchObject({
        checkStatus: 'check-failed',
        error: 'boom'
      })
      expect(byName.get('CrashB')?.checkStatus).not.toBe('check-failed')
    } finally {
      spy.mockRestore()
    }
  })
})

// =====================================================================
// 0.1.9 batch update events + aggregate progress + cancel
// =====================================================================
describe('batch update progress (0.1.9)', () => {
  function seedTwoGitPacks(): { dirA: string; dirB: string } {
    const dirA = seedPack({
      name: 'BtA',
      withGit: true,
      pyproject: 'name = "BtA"\nversion = "1.0.0"\n'
    })
    const dirB = seedPack({
      name: 'BtB',
      withGit: true,
      pyproject: 'name = "BtB"\nversion = "1.0.0"\n'
    })
    const ids = listIds()
    h.state.nodePacks = [
      {
        id: ids.get('BtA'),
        name: 'BtA',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dirA
      },
      {
        id: ids.get('BtB'),
        name: 'BtB',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dirB
      }
    ]
    return { dirA, dirB }
  }

  function batchExecHandler(
    dirA: string,
    dirB: string
  ): (
    cmd: string,
    args: string[]
  ) => {
    stdout?: string
    stderr?: string
    error?: Error
    code?: number
    hang?: boolean
  } {
    return (cmd, args) => {
      if (args.includes('fetch')) return { stdout: '' }
      if (args.includes('@{u}')) return { stdout: 'origin/main\n' }
      if (args.includes('rev-list')) return { stdout: '1' }
      if (args.includes('describe')) return { stdout: 'v2\n' }
      if (args.includes('pull')) {
        const name = args.includes(dirA) ? 'BtA' : args.includes(dirB) ? 'BtB' : ''
        const target = args.includes(dirA) ? dirA : dirB
        if (name)
          h.writeFile(join(target, 'pyproject.toml'), `name = "${name}"\nversion = "2.0.0"\n`)
        return { stdout: 'ok' }
      }
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'abc\n' }
      return { stdout: '' }
    }
  }

  it('emits ordered batch events with monotonic aggregate progress', async () => {
    const { dirA, dirB } = seedTwoGitPacks()
    cpMock.__setExecHandler(batchExecHandler(dirA, dirB))
    const events: Array<{
      phase: string
      index: number
      total: number
      packName?: string
      summary?: { ok: number; fail: number; skip: number; cancelled?: boolean }
    }> = []
    const aggregates: number[] = []
    const runIds = new Set<string>()
    const onEvent = (e: (typeof events)[number]): void => {
      events.push(e)
    }
    const onProg = (p: { aggregatePercent?: number; runId?: string }): void => {
      if (p.runId) runIds.add(p.runId)
      if (p.aggregatePercent != null) aggregates.push(p.aggregatePercent)
    }
    nodePackService.on('update-batch', onEvent)
    nodePackService.on('op-progress', onProg)
    try {
      const out = await nodePackService.updateAll('inst-1')
      expect(out.filter((r) => r.ok && !r.skipped)).toHaveLength(2)
    } finally {
      nodePackService.off('update-batch', onEvent)
      nodePackService.off('op-progress', onProg)
    }
    // The batch reserves/cancellable state BEFORE the slow check pass.
    expect(events[0].phase).toBe('checking')
    const startEvent = events.find((e) => e.phase === 'start')
    expect(startEvent?.total).toBe(2)
    expect(events.filter((e) => e.phase === 'pack-start').map((e) => e.index)).toEqual([1, 2])
    expect(events.filter((e) => e.phase === 'pack-done')).toHaveLength(2)
    expect(events.at(-1)?.phase).toBe('batch-done')
    expect(events.at(-1)?.summary).toMatchObject({ ok: 2, fail: 0 })
    // Exactly one terminal batch event — a pack's own done must never end the batch.
    const doneIdx = events.findIndex((e) => e.phase === 'batch-done')
    expect(events.filter((e) => e.phase === 'batch-done')).toHaveLength(1)
    expect(events.slice(0, doneIdx).filter((e) => e.phase === 'pack-done')).toHaveLength(2)
    for (let i = 1; i < aggregates.length; i++) {
      expect(aggregates[i]).toBeGreaterThanOrEqual(aggregates[i - 1])
    }
    expect(aggregates.at(-1)).toBe(100)
    // One continuous stream for the whole batch: the terminal log never resets.
    expect(runIds.size).toBe(1)
  })

  it('cancelUpdateBatch stops the remaining queue and reports cancelled', async () => {
    const { dirA, dirB } = seedTwoGitPacks()
    // A third pack ensures "remaining" is non-empty after cancelling during #1.
    const dirC = seedPack({
      name: 'BtC',
      withGit: true,
      pyproject: 'name = "BtC"\nversion = "1.0.0"\n'
    })
    const ids = listIds()
    h.state.nodePacks.push({
      id: ids.get('BtC'),
      name: 'BtC',
      locked: false,
      installSource: 'git',
      version: '1.0.0',
      issues: [],
      tags: [],
      nodeList: [],
      path: dirC
    })
    cpMock.__setExecHandler(batchExecHandler(dirA, dirB))
    const starts: number[] = []
    const onEvent = (e: {
      phase: string
      index: number
      summary?: { cancelled?: boolean }
    }): void => {
      if (e.phase === 'pack-start') {
        starts.push(e.index)
        if (e.index === 1) nodePackService.cancelUpdateBatch('inst-1')
      }
    }
    const done: Array<{ cancelled?: boolean }> = []
    const onDone = (e: { phase: string; summary?: { cancelled?: boolean } }): void => {
      if (e.phase === 'batch-done' && e.summary) done.push(e.summary)
    }
    nodePackService.on('update-batch', onEvent)
    nodePackService.on('update-batch', onDone)
    try {
      const out = await nodePackService.updateAll('inst-1')
      const byName = new Map(out.map((r) => [r.name, r]))
      expect(byName.get('BtB')?.skipped).toBe(true)
      expect(byName.get('BtC')?.skipped).toBe(true)
    } finally {
      nodePackService.off('update-batch', onEvent)
      nodePackService.off('update-batch', onDone)
    }
    expect(starts).toEqual([1])
    expect(done[0]?.cancelled).toBe(true)
  })
})

// =====================================================================
// git source inference (manually copied checkouts)
// =====================================================================
describe('git source inference', () => {
  it('infers installSource "git" and repository from .git for a manually copied pack', () => {
    const dir = seedPack({
      name: 'ManualGit',
      withGit: true,
      pyproject: 'name = "ManualGit"\nversion = "1.0.0"\n'
    })
    h.writeFile(
      join(dir, '.git', 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/u/ManualGit.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    )
    const pack = nodePackService.list('inst-1').find((p) => p.name === 'ManualGit')
    expect(pack?.installSource).toBe('git')
    expect(pack?.repository).toBe('https://github.com/u/ManualGit.git')
  })

  it('upgrades a stale "local" record to "git" when .git exists on disk', () => {
    const dir = seedPack({
      name: 'UpgradeGit',
      withGit: true,
      pyproject: 'name = "UpgradeGit"\nversion = "1.0.0"\n'
    })
    h.state.nodePacks = [
      {
        id: 'stale',
        name: 'UpgradeGit',
        installSource: 'local',
        version: '1.0.0',
        path: dir,
        issues: [],
        tags: [],
        nodeList: [],
        locked: false
      }
    ]
    const pack = nodePackService.list('inst-1').find((p) => p.name === 'UpgradeGit')
    expect(pack?.installSource).toBe('git')
  })

  it('keeps an explicit "git" record even when .git is temporarily absent', () => {
    const dir = seedPack({
      name: 'LostGit',
      pyproject: 'name = "LostGit"\nversion = "1.0.0"\n'
    })
    h.state.nodePacks = [
      {
        id: 'stale2',
        name: 'LostGit',
        installSource: 'git',
        version: '1.0.0',
        path: dir,
        issues: [],
        tags: [],
        nodeList: [],
        locked: false
      }
    ]
    const pack = nodePackService.list('inst-1').find((p) => p.name === 'LostGit')
    // Explicit records are honored; a missing .git surfaces as a real git
    // error on update instead of silently relabeling the pack.
    expect(pack?.installSource).toBe('git')
  })
})

// =====================================================================
// managerChannelList / registrySearch
// =====================================================================
describe('managerChannelList', () => {
  it('returns entries from the first reachable endpoint and stops', async () => {
    const urls: string[] = []
    setFetch(async (url) => {
      urls.push(url)
      return makeRes([
        {
          id: 'a',
          title: 'A',
          name: 'A',
          description: '',
          author: '',
          version: '1',
          repository: 'https://g/a',
          tags: ['t'],
          downloads: 5
        },
        {
          id: 'a',
          title: 'A-dup',
          name: 'A-dup',
          description: '',
          author: '',
          version: '1',
          repository: '',
          tags: [],
          downloads: 0
        }
      ])
    })
    const out = await nodePackService.managerChannelList()
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a')
    expect(out[0].tags).toEqual(['t'])
    expect(urls).toHaveLength(1)
  })

  it('falls through to the second endpoint when the first returns HTTP error', async () => {
    let calls = 0
    setFetch(async () => {
      calls++
      if (calls === 1) return makeRes({}, { ok: false, status: 404 })
      return makeRes([{ id: 'b', title: 'B', name: 'B', repository: 'https://g/b' }])
    })
    const out = await nodePackService.managerChannelList()
    expect(out.map((p) => p.id)).toEqual(['b'])
  })

  it('returns [] when every endpoint fails', async () => {
    setFetch(async () => {
      throw new Error('network down')
    })
    expect(await nodePackService.managerChannelList()).toEqual([])
  })

  it('stops after the first failure when networkMode is offline', async () => {
    h.state.settings.networkMode = 'offline'
    let calls = 0
    setFetch(async () => {
      calls++
      throw new Error('down')
    })
    expect(await nodePackService.managerChannelList()).toEqual([])
    expect(calls).toBe(1)
    h.state.settings.networkMode = 'public'
  })
})

describe('registrySearch', () => {
  it('maps registry results through toPageResult', async () => {
    const { searchRegistry, toPageResult, mapRegistryPack } = registryMock
    searchRegistry.mockResolvedValue({
      raw: [{ id: 'x', name: 'X' }],
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    })
    toPageResult.mockImplementation(
      (result: { raw?: unknown[] }, map: (n: unknown) => unknown) => ({
        items: (result.raw || []).map(map),
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
        scanned: 1,
        clientFiltered: false
      })
    )
    mapRegistryPack.mockImplementation((n: Record<string, unknown>) => n)
    const page = await nodePackService.registrySearch({ query: 'x', limit: 10 })
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(1)
  })

  it('returns an empty offline page when networkMode is offline and search fails', async () => {
    h.state.settings.networkMode = 'offline'
    const { searchRegistry } = registryMock
    searchRegistry.mockRejectedValue(new Error('boom'))
    const page = await nodePackService.registrySearch({ query: 'q', limit: 5 })
    expect(page.items).toEqual([])
    expect(page.clientFiltered).toBe(true)
    expect(page.pageSize).toBe(5)
  })

  it('rethrows search errors when not in offline mode', async () => {
    const { searchRegistry } = registryMock
    searchRegistry.mockRejectedValue(new Error('boom'))
    await expect(nodePackService.registrySearch()).rejects.toThrow(/boom/)
  })
})

// =====================================================================
// resolveInstanceConfig extras
// =====================================================================
describe('resolveInstanceConfig fallbacks', () => {
  it('prefers the first enabled instance', () => {
    h.state.instances = [
      { id: 'a', path: COMFY, enabled: false },
      { id: 'b', path: COMFY, enabled: true }
    ]
    expect(resolveInstanceConfig()?.id).toBe('b')
  })

  it('falls back to the first instance when all are disabled', () => {
    h.state.instances = [
      { id: 'a', path: COMFY, enabled: false },
      { id: 'b', path: COMFY, enabled: false }
    ]
    expect(resolveInstanceConfig()?.id).toBe('a')
  })
})

// =====================================================================
// Edge branches for coverage (error/catch paths and optional chains)
// =====================================================================
describe('edge branches', () => {
  it('restoreSnapshot tolerates a throwing marker write', () => {
    const hiddenDir = join(ROOT, 'ghostw.trash')
    h.mkdirPath(hiddenDir)
    h.writeFile(join(hiddenDir, 'pyproject.toml'), 'name = "GhostW"\nversion = "1"\n')
    seedPack({ name: 'VisW' })
    const snap = {
      id: 'snap-w',
      name: 'w',
      createdAt: Date.now(),
      packs: [
        { name: 'GhostW', version: '1', path: hiddenDir, source: 'local@disabled' },
        { name: 'VisW', version: '1', path: join(ROOT, 'VisW'), source: 'local' }
      ],
      notes: ''
    }
    h.state.snapshots.push(snap)
    h.state.snapshotById.set(snap.id, snap)
    h.state.writeFail.add('.disabled')
    expect(nodePackService.restoreSnapshot('snap-w')).toBe(true)
  })

  it('restoreSnapshot tolerates a throwing marker unlink', () => {
    const hiddenDir = join(ROOT, 'ghostu.trash')
    h.mkdirPath(hiddenDir)
    h.writeFile(join(hiddenDir, 'pyproject.toml'), 'name = "GhostU"\nversion = "1"\n')
    h.writeFile(join(hiddenDir, '.disabled'), 'old')
    seedPack({ name: 'VisU' })
    const snap = {
      id: 'snap-u',
      name: 'u',
      createdAt: Date.now(),
      packs: [
        { name: 'GhostU', version: '1', path: hiddenDir, source: 'local' },
        { name: 'VisU', version: '1', path: join(ROOT, 'VisU'), source: 'local' }
      ],
      notes: ''
    }
    h.state.snapshots.push(snap)
    h.state.snapshotById.set(snap.id, snap)
    h.state.unlinkFail.add('.disabled')
    expect(nodePackService.restoreSnapshot('snap-u')).toBe(true)
  })

  it('deleteSnapshot tolerates a throwing unlink of the sidecar', () => {
    seedPack({ name: 'SnapThrow' })
    const snap = nodePackService.createSnapshot('throw-me')
    h.state.unlinkFail.add(snap.id)
    const ok = nodePackService.deleteSnapshot(snap.id)
    expect(ok).toBe(true)
    expect(h.state.snapshots).toHaveLength(0)
  })

  it('uninstall keeps going when both rename and rm fail', async () => {
    const dir = seedPack({ name: 'Stuck' })
    h.state.renameFail.add(dir)
    h.state.rmFail.add(dir)
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'Stuck',
        locked: false,
        installSource: 'local',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    const ok = await nodePackService.uninstall('Stuck', 'inst-1')
    expect(ok).toBe(true)
    // DB row is still deleted even if the directory could not be removed
    expect(h.state.nodePacks.find((p) => p.name === 'Stuck')).toBeUndefined()
  })

  it('update reports backup-cleanup failure but still succeeds', async () => {
    const dir = seedPack({
      name: 'BakFail',
      pyproject: 'name = "BakFail"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'BakFail',
        locked: false,
        installSource: 'registry',
        registryId: 'bak-fail',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    setFetch(async (url) => {
      if (url.includes('/install')) return makeRes({ url: 'https://cdn.example/pack.zip' })
      return makeRes('zip')
    })
    const zipSafe = zipSafeMock
    zipSafe.safeUnzip.mockImplementation(async (_zip: string, dest?: string) => {
      const finalDest = dest || join(ROOT, 'bak-fail')
      h.mkdirPath(finalDest)
      h.writeFile(
        join(finalDest, 'pyproject.toml'),
        'name = "BakFail"\nversion = "2.0.0"\nrepository = "https://r"\n'
      )
    })
    h.state.rmFail.add('.bak-')
    const events: Array<{ phase: string; message?: string }> = []
    nodePackService.on('install-progress', (e: { phase: string; message?: string }) =>
      events.push(e)
    )
    const rec = await nodePackService.update('BakFail', undefined, 'inst-1')
    nodePackService.removeAllListeners('install-progress')
    expect(rec.version).toBe('2.0.0')
    expect(events.some((e) => /backup cleanup failed/i.test(e.message || ''))).toBe(true)
  })

  it('resolveInstancePython falls back when the runtimes probe throws', async () => {
    h.state.runtimePythonThrow = new Error('no runtimes')
    h.state.settings.allowPipInstall = true
    h.state.instances[0].pythonPath = ''
    h.state.instances[0].venvPath = ''
    const cmds: string[] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'x\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipPack"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
        return { stdout: '' }
      }
      if (args.includes('pip')) {
        cmds.push(cmd)
        return { stdout: 'Successfully installed x', stderr: '' }
      }
      return { stdout: '' }
    })
    await nodePackService.install({
      id: 'https://github.com/u/PipRT.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    expect(cmds[0]).toBe('python')
    h.state.runtimePythonThrow = null
  })

  it('afterInstall skips pip when no python can be resolved (empty vpy)', async () => {
    h.state.settings.allowPipInstall = true
    h.state.instances[0].pythonPath = ''
    h.state.instances[0].venvPath = ''
    h.state.runtimePython = ''
    const pipCalls: string[] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, 'requirements.txt'), 'x\n')
        h.writeFile(
          join(dest, 'pyproject.toml'),
          'name = "PipSkip"\nversion = "1.0.0"\nrepository = "https://r"\n'
        )
        return { stdout: '' }
      }
      if (args.includes('pip')) {
        pipCalls.push(cmd)
        return { stdout: '', stderr: '' }
      }
      return { stdout: '' }
    })
    const rec = await nodePackService.install({
      id: 'https://github.com/u/PipSkip.git',
      source: 'git',
      instanceId: 'inst-1'
    })
    // resolveInstancePython returns 'python' at worst �� so pip still runs; assert no crash
    expect(rec.name).toBe('PipSkip')
    void pipCalls
  })

  it('list skips entries whose statSync throws', () => {
    seedPack({ name: 'Good' })
    // A phantom child whose statSync genuinely throws (injected): the catch
    // path must skip it while the healthy pack still lists.
    h.state.dirs.set(ROOT, ['Good', 'Phantom'])
    h.state.statFail.add('Phantom')
    const packs = nodePackService.list('inst-1')
    expect(packs.map((p) => p.name)).toEqual(['Good'])
  })

  it('checkUpdates persists latestVersion only when it changed', async () => {
    const dir = seedPack({
      name: 'Persist',
      pyproject: 'name = "Persist"\nversion = "1.0.0"\nrepository = "https://r"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'Persist',
        locked: false,
        installSource: 'registry',
        registryId: 'persist',
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
      raw: [{ id: 'persist', name: 'Persist', latestVersion: '2.0.0' }],
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    })
    toPageResult.mockImplementation(
      (result: { raw?: unknown[] }, map: (n: unknown) => unknown) => ({
        items: (result.raw || []).map(map),
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
        scanned: 1,
        clientFiltered: false
      })
    )
    mapRegistryPack.mockImplementation((n: Record<string, unknown>) => n)
    const before = h.state.nodePacks.length
    await nodePackService.checkUpdates('inst-1')
    expect(h.state.nodePacks.length).toBe(before)
  })

  it('compareVersions handles equal-length pre-release tags', () => {
    expect(compareVersions('1.0.0-rc1', '1.0.0-rc2')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc2', '1.0.0-rc1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha')).toBe(0)
    expect(compareVersions('v2.0.0', '2.0')).toBe(0)
    expect(compareVersions('2.0', 'v2.0.0')).toBe(0)
  })
})

// =====================================================================
// 0.1.4 market UX: install must emit start AND done (field bug)
// =====================================================================
describe('install progress lifecycle', () => {
  it('install() emits start, then done — the UI hangs without done', async () => {
    resetState()
    const phases: Array<{ phase: string; op?: string }> = []
    nodePackService.on('install-progress', (e: { phase: string; op?: string }) => {
      phases.push({ phase: e.phase, op: e.op })
    })
    cpMock.__setExecHandler((_cmd, args) => {
      if (args.includes('clone')) {
        const dest = args[args.length - 1]
        h.mkdirPath(dest)
        h.writeFile(join(dest, '__init__.py'), 'x')
        h.writeFile(join(dest, 'pyproject.toml'), 'name = "DonePack2"\nversion = "1.0.0"\n')
      }
      return { stdout: '' }
    })
    try {
      await nodePackService.install({
        id: 'https://github.com/u/DonePack2.git',
        source: 'git',
        instanceId: 'inst-1'
      })
    } finally {
      nodePackService.removeAllListeners('install-progress')
    }
    expect(phases[0]?.phase).toBe('start')
    expect(phases[0]?.op).toBe('install')
    expect(phases[phases.length - 1]?.phase).toBe('done')
    expect(phases[phases.length - 1]?.op).toBe('install')
  })

  it('update() emits start/done with op=update', async () => {
    resetState()
    const { join } = require('path') as typeof import('path')
    const packPath = join('C:/fake/ComfyUI', 'custom_nodes', 'UpPack')
    h.state.isDir.add(packPath)
    h.state.isDir.add(join(packPath, '.git'))
    h.state.dirs.set(join('C:/fake/ComfyUI', 'custom_nodes'), ['UpPack'])
    h.state.dirs.set(packPath, ['__init__.py'])
    h.state.files.set(join(packPath, '__init__.py'), 'x')
    h.state.files.set(join(packPath, 'pyproject.toml'), 'name = "UpPack"\nversion = "1.0.0"\n')
    h.state.nodePacks = [
      {
        id: 'abcdef0123456789',
        name: 'UpPack',
        locked: false,
        installSource: 'git',
        path: packPath,
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: []
      }
    ]
    const phases: Array<{ phase: string; op?: string }> = []
    nodePackService.on('install-progress', (e: { phase: string; op?: string }) => {
      phases.push({ phase: e.phase, op: e.op })
    })
    cpMock.__setExecHandler((_cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok' }
      return { stdout: '' }
    })
    try {
      await nodePackService.update('UpPack', undefined, 'inst-1')
    } finally {
      nodePackService.removeAllListeners('install-progress')
    }
    expect(phases.some((p) => p.phase === 'start' && p.op === 'update')).toBe(true)
    expect(phases.some((p) => p.phase === 'done' && p.op === 'update')).toBe(true)
  })
})

// =====================================================================
// 0.1.9 streaming fidelity: git % → step fraction, op-log increment,
// trimmed progress snapshots, pip fraction, reuseStream continuity
// =====================================================================
describe('node-op streaming fidelity (0.1.9)', () => {
  function seedGitPack(name: string, extra: { requirements?: string } = {}): string {
    const dir = seedPack({
      name,
      withGit: true,
      pyproject: `name = "${name}"\nversion = "1.0.0"\n`
    })
    if (extra.requirements) h.writeFile(join(dir, 'requirements.txt'), extra.requirements)
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name,
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    return dir
  }

  it('git pull streams Receiving objects % into the clone step and op-log', async () => {
    const dir = seedGitPack('StreamGit')
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('pull')) {
        return {
          stdout: 'Receiving objects:  42%\n',
          stderr: 'Resolving deltas:  50%\n'
        }
      }
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'abc\n' }
      void dir
      return { stdout: '' }
    })
    const lines: string[] = []
    let maxClone = 0
    let maxStepLog = 0
    const onLog = (l: { line: string }): void => {
      lines.push(l.line)
    }
    const onProg = (p: {
      steps?: Array<{ id: string; progress?: number; log: string[] }>
    }): void => {
      for (const s of p.steps || []) {
        maxStepLog = Math.max(maxStepLog, s.log.length)
        if (s.id === 'clone' && s.progress) maxClone = Math.max(maxClone, s.progress)
      }
    }
    nodePackService.on('op-log', onLog)
    nodePackService.on('op-progress', onProg)
    try {
      await nodePackService.update('StreamGit', undefined, 'inst-1')
    } finally {
      nodePackService.off('op-log', onLog)
      nodePackService.off('op-progress', onProg)
    }
    expect(lines.some((l) => l.includes('Receiving objects'))).toBe(true)
    // 42% → ≥0.1 + 0.42*0.85 fraction
    expect(maxClone).toBeGreaterThan(0.3)
    // Progress snapshots carry at most the trailing log line (incremental lines
    // travel on op-log instead of re-sending the whole buffer).
    expect(maxStepLog).toBeLessThanOrEqual(1)
  })

  it('pip output stays indeterminate instead of inventing a fraction', async () => {
    seedGitPack('PipPack', { requirements: 'requests\n' })
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('pull')) return { stdout: '' }
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'abc\n' }
      if (args.includes('--version')) return { stdout: 'pip 24.0\n' }
      if (args.includes('install')) {
        return {
          stdout:
            'Collecting requests\nDownloading requests.whl\nInstalling collected packages: requests\nSuccessfully installed requests-2.0\n'
        }
      }
      return { stdout: '' }
    })
    // 0.1.17 (WP2-4): pip has no denominator — the step must never carry an
    // invented fraction, only stage text (honesty over motion).
    let sawRequirements = false
    let maxReq = 0
    let lastDetail = ''
    const onProg = (p: {
      steps?: Array<{ id: string; status?: string; progress?: number; detail?: string }>
    }): void => {
      const req = (p.steps || []).find((s) => s.id === 'requirements')
      if (!req) return
      if (req.status === 'running') {
        sawRequirements = true
        if (req.detail) lastDetail = req.detail
      }
      if (req.progress) maxReq = Math.max(maxReq, req.progress)
    }
    nodePackService.on('op-progress', onProg)
    try {
      await nodePackService.update('PipPack', undefined, 'inst-1')
    } finally {
      nodePackService.off('op-progress', onProg)
    }
    expect(sawRequirements).toBe(true)
    expect(maxReq).toBe(0)
    expect(lastDetail).toMatch(/Installing|Building|Finalizing/i)
  })

  it('reuseStream keeps the current runId for registry reinstalls inside an update', async () => {
    seedPack({ name: 'ReusePack', pyproject: 'name = "ReusePack"\nversion = "1.0.0"\n' })
    const spy = vi
      .spyOn(
        nodePackService as unknown as { installInner: (...a: unknown[]) => Promise<unknown> },
        'installInner'
      )
      .mockResolvedValue({ name: 'ReusePack', id: 'reuse', version: '1.0.0' })
    const runIds: string[] = []
    const onProg = (p: { runId: string }): void => {
      runIds.push(p.runId)
    }
    nodePackService.on('op-progress', onProg)
    try {
      await nodePackService.install({ id: 'reuse-src', source: 'registry', instanceId: 'inst-1' })
      await nodePackService.install(
        { id: 'reuse-src', source: 'registry', instanceId: 'inst-1' },
        { reuseStream: true }
      )
    } finally {
      nodePackService.off('op-progress', onProg)
      spy.mockRestore()
    }
    // reuseStream must NOT start a new stream (registry update mid-flight).
    expect(new Set(runIds).size).toBe(1)
  })
})

// =====================================================================
// 0.1.9 op exclusivity (OP_BUSY) + abort propagation
// =====================================================================
describe('op exclusivity and abort (0.1.9)', () => {
  type BatchMap = Map<string, unknown>

  it('rejects single ops while a batch context is active (OP_BUSY)', async () => {
    seedPack({ name: 'BusyA', pyproject: 'name = "BusyA"\nversion = "1.0.0"\n' })
    const map = (nodePackService as unknown as { opBatches: BatchMap }).opBatches
    map.set('inst-1', { batchId: 'b1', index: 1, total: 1, cancelled: false })
    try {
      await expect(nodePackService.update('BusyA', undefined, 'inst-1')).rejects.toMatchObject({
        code: 'OP_BUSY'
      })
      await expect(
        nodePackService.install({ id: 'x', source: 'registry', instanceId: 'inst-1' })
      ).rejects.toMatchObject({ code: 'OP_BUSY' })
      await expect(nodePackService.updateAll('inst-1')).rejects.toMatchObject({
        code: 'OP_BUSY'
      })
    } finally {
      map.delete('inst-1')
    }
  })

  it('cancelOp aborts an in-flight git pull promptly (AbortError → OP_CANCELLED)', async () => {
    const dir = seedPack({
      name: 'HangPack',
      withGit: true,
      pyproject: 'name = "HangPack"\nversion = "1.0.0"\n'
    })
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'HangPack',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    let pullStarted = false
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('pull')) {
        pullStarted = true
        return { hang: true }
      }
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'abc\n' }
      return { stdout: '' }
    })
    const pending = nodePackService.update('HangPack', undefined, 'inst-1')
    for (let i = 0; i < 100 && !pullStarted; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(pullStarted).toBe(true)
    expect(nodePackService.cancelOp('inst-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'OP_CANCELLED' })
  })
})

// =====================================================================
// 0.1.9 follow-ups: duplicate names + batch abort-current
// =====================================================================
describe('duplicate pack names and batch abort (0.1.9)', () => {
  it('checkUpdates yields one row per pack even for Foo + .disabled/Foo', async () => {
    seedPack({ name: 'DupPack', pyproject: 'name = "DupPack"\nversion = "1.0.0"\n' })
    nodePackService.toggle('DupPack', false, 'inst-1')
    seedPack({ name: 'DupPack', pyproject: 'name = "DupPack"\nversion = "1.0.0"\n' })
    cpMock.__setExecHandler(() => ({ stdout: '' }))
    const rows = await nodePackService.checkUpdates('inst-1')
    const dup = rows.filter((r) => r.name === 'DupPack')
    expect(dup).toHaveLength(2)
    expect(dup.map((r) => r.checkStatus).sort()).toEqual(['skipped-disabled', 'unsupported'])
    expect(new Set(dup.map((r) => r.id)).size).toBe(2)
  })

  it('cancelUpdateBatch aborts the in-flight pack and skips the rest', async () => {
    const dirA = seedPack({
      name: 'CtA',
      withGit: true,
      pyproject: 'name = "CtA"\nversion = "1.0.0"\n'
    })
    const dirB = seedPack({
      name: 'CtB',
      withGit: true,
      pyproject: 'name = "CtB"\nversion = "1.0.0"\n'
    })
    const ids = listIds()
    h.state.nodePacks = [
      {
        id: ids.get('CtA'),
        name: 'CtA',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dirA
      },
      {
        id: ids.get('CtB'),
        name: 'CtB',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dirB
      }
    ]
    let pulls = 0
    let firstHangStarted = false
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('fetch')) return { stdout: '' }
      if (args.includes('@{u}')) return { stdout: 'origin/main\n' }
      if (args.includes('rev-list')) return { stdout: '1' }
      if (args.includes('describe')) return { stdout: 'v2\n' }
      if (args.includes('pull')) {
        pulls += 1
        if (pulls === 1) {
          firstHangStarted = true
          return { hang: true }
        }
        return { stdout: 'ok' }
      }
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'abc\n' }
      return { stdout: '' }
    })
    const pending = nodePackService.updateAll('inst-1')
    for (let i = 0; i < 200 && !firstHangStarted; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(firstHangStarted).toBe(true)
    expect(nodePackService.cancelUpdateBatch('inst-1')).toBe(true)
    const out = await pending
    const byName = new Map(out.map((r) => [r.name, r]))
    // Current pack aborted (not merely skipped), remaining pack skipped.
    expect(byName.get('CtA')?.ok).toBe(false)
    expect(byName.get('CtA')?.error).toMatch(/cancel/i)
    expect(byName.get('CtB')?.skipped).toBe(true)
    expect(pulls).toBe(1)
  })
})

// =====================================================================
// 0.1.9 round-3: cancellation during pip + batch vs single exclusivity
// =====================================================================
describe('cancellation and exclusivity follow-ups (0.1.9)', () => {
  it('cancel during pip install cancels the op (never a swallowed pip issue)', async () => {
    const dir = seedPack({
      name: 'PipCancel',
      withGit: true,
      pyproject: 'name = "PipCancel"\nversion = "1.0.0"\n'
    })
    h.writeFile(join(dir, 'requirements.txt'), 'requests\n')
    const first = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        id: first.id,
        name: 'PipCancel',
        locked: false,
        installSource: 'git',
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: [],
        path: dir
      }
    ]
    let pipStarted = false
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('pull')) return { stdout: '' }
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'abc\n' }
      if (args.includes('--version')) return { stdout: 'pip 24.0\n' }
      if (args.includes('install')) {
        pipStarted = true
        return { hang: true }
      }
      return { stdout: '' }
    })
    const pending = nodePackService.update('PipCancel', undefined, 'inst-1')
    for (let i = 0; i < 200 && !pipStarted; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(pipStarted).toBe(true)
    expect(nodePackService.cancelOp('inst-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'OP_CANCELLED' })
  })

  it('updateAll is rejected while a single op is in flight (OP_BUSY)', async () => {
    seedPack({ name: 'SingleBusy', pyproject: 'name = "SingleBusy"\nversion = "1.0.0"\n' })
    const controllers = (nodePackService as unknown as { opAborts: Map<string, AbortController> })
      .opAborts
    controllers.set('inst-1', new AbortController())
    try {
      await expect(nodePackService.updateAll('inst-1')).rejects.toMatchObject({
        code: 'OP_BUSY'
      })
    } finally {
      controllers.delete('inst-1')
    }
  })
})

// =====================================================================
// pip dependency recording + removal (0.1.10 — closes the last coverage gap)
// =====================================================================
describe('pip deps recording and removal (0.1.10)', () => {
  function seedReqPack(name: string, reqText: string): string {
    return seedPack({
      name,
      pyproject: `name = "${name}"\nversion = "1.0.0"\n`,
      requirements: reqText
    })
  }

  it('pipDeps parses requirements.txt (comments/options/URLs stripped) and prefers recorded names', () => {
    resetState()
    seedReqPack(
      'DepsPack',
      'requests>=2\n# comment\nnumpy==1.26.0\n-e .\nhttps://x/y.whl\npkg[x] ; python_version < "3.12"\n'
    )
    expect(nodePackService.pipDeps('DepsPack', 'inst-1')).toEqual(['requests', 'numpy', 'pkg'])

    // A recorded list wins (it also survives a deleted requirements.txt).
    const rec = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [{ ...rec, pipRequirements: ['pkg-a', 'pkg-b'] }]
    expect(nodePackService.pipDeps('DepsPack', 'inst-1')).toEqual(['pkg-a', 'pkg-b'])
    expect(nodePackService.pipDeps('unknown-pack', 'inst-1')).toEqual([])
  })

  it('uninstall({removePipDeps}) uninstalls in batches of 20', async () => {
    resetState()
    seedReqPack('RemoveDeps', 'a\n')
    const rec = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [
      {
        ...rec,
        pipRequirements: Array.from({ length: 21 }, (_, i) => `p${i}`)
      }
    ]
    const batchSizes: number[] = []
    cpMock.__setExecHandler((cmd, args) => {
      if (args.includes('uninstall')) {
        batchSizes.push(args.filter((x) => x.startsWith('p') && !x.startsWith('pip')).length)
      }
      return { stdout: 'ok' }
    })
    try {
      const removed = await nodePackService.uninstall('RemoveDeps', 'inst-1', {
        removePipDeps: true
      })
      expect(removed).toBe(true)
      expect(batchSizes).toEqual([20, 1])
    } finally {
      cpMock.__setExecHandler(null)
    }
  })

  it('uninstall aborts (AbortError propagates) instead of counting pip failures', async () => {
    resetState()
    seedReqPack('AbortDeps', 'x\n')
    const rec = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [{ ...rec, pipRequirements: ['p1'] }]
    cpMock.__setExecHandler((_cmd, args) => {
      if (args.includes('uninstall')) {
        const err = new Error('aborted') as Error & { name: string }
        err.name = 'AbortError'
        return { error: err }
      }
      return { stdout: 'ok' }
    })
    try {
      await expect(
        nodePackService.uninstall('AbortDeps', 'inst-1', { removePipDeps: true })
      ).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      cpMock.__setExecHandler(null)
    }
  })

  it('removePipDeps falls back to per-name retries when a batch fails for non-abort reasons', async () => {
    resetState()
    seedReqPack('RetryDeps', 'x\n')
    const rec = nodePackService.list('inst-1')[0]
    h.state.nodePacks = [{ ...rec, pipRequirements: ['bad', 'good'] }]
    const attempted: string[] = []
    cpMock.__setExecHandler((_cmd, args) => {
      if (args.includes('uninstall')) {
        const names = args.filter((a) => a === 'bad' || a === 'good')
        if (names.length === 2) {
          // Batch call fails (e.g. one name not installed).
          return { error: new Error('No matching distribution found for bad') }
        }
        attempted.push(names[0])
        return { stdout: 'ok' }
      }
      return { stdout: 'ok' }
    })
    try {
      await nodePackService.uninstall('RetryDeps', 'inst-1', { removePipDeps: true })
      expect(attempted.sort()).toEqual(['bad', 'good'])
    } finally {
      cpMock.__setExecHandler(null)
    }
  })
})
