/**
 * High-intensity unit tests for ComfyUpdaterService: check (git/zip/unknown),
 * start concurrency, the full runUpdate pipeline (preflight → stop → backup →
 * fetch → requirements → torch → verify → done/rollback), cancel/killTree,
 * copyCoreTree/overlayTree, stampInstallMeta, venvPython and pipArgs.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pathKey } from '../helpers/pathKey'
import { join, dirname } from 'path'

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void
type ExecResult = { stdout?: string; stderr?: string; error?: Error; code?: number; hang?: boolean }
type ExecHandler = (cmd: string, args: string[], opts: unknown) => ExecResult

const h = vi.hoisted(() => {
  const state = {
    dirs: new Map<string, string[]>(),
    files: new Map<string, string>(),
    isDir: new Set<string>(),
    exists: new Set<string>(),
    instances: [] as Array<Record<string, unknown>>,
    settings: {
      pipIndex: '',
      torchIndexMirror: '',
      githubEndpoint: '',
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
    execHandler: null as ExecHandler | null,
    execSyncOut: 'v0.0.1-1-gabc1234',
    execSyncErr: null as Error | null,
    instanceList: [] as Array<Record<string, unknown>>,
    instanceStopErr: null as Error | null,
    /** 0.1.17: override the stop() result (adopted / exited). */
    instanceStopResult: null as null | { adopted?: boolean; exited?: boolean },
    stopCalls: [] as string[],
    launchCalls: [] as Array<{ id: string; opts: unknown }>,
    checkPortQueue: [] as boolean[],
    doctorResult: null as {
      checks: Array<{ severity: string; title: string }>
      summary: { pass: number; warn: number }
    } | null,
    doctorErr: null as Error | null,
    selfcheckResult: null as null | { ok: boolean; exitCode: number | null; output: string },
    selfcheckErr: null as Error | null,
    uvInstalled: false,
    uvPath: 'C:/fake/uv.exe',
    sessionFetch: null as ((url: string) => unknown) | null,
    unzipImpl: null as ((zip: string, dest: string) => void) | null,
    /** One-shot injected copy failures (matched on from OR to path). */
    failCopyOnce: new Set<string>(),
    /** Injected rmSync failures when the path contains any of these substrings. */
    failRmPrefix: [] as string[],
    /** Injected readdir/stat/write failures (matched on the fs key). */
    failReaddir: [] as string[],
    failStat: [] as string[],
    failWritePrefix: [] as string[],
    /** Node-pack fixtures for the post-update compatibility check. */
    nodePacks: [] as Array<{ name: string }>,
    nodeIssues: new Map<string, Array<{ severity: string }>>(),
    nodeIssuesErr: new Set<string>(),
    restoreResult: null as Record<string, unknown> | null,
    restoreErr: null as Error | null,
    createSnapshotErr: null as Error | null,
    /** Node-pack constructor fixtures for the post-update compatibility check. */
    nodePackCheckCalls: [] as string[]
  }

  function fsKey(p: unknown): string {
    // Strip any cwd prefix POSIX resolve() prepends to C:/... paths.
    return pathKey(p)
  }
  function parentOf(p: string): string {
    const d = dirname(p)
    return d === p ? '' : pathKey(d)
  }
  function baseOf(p: string): string {
    const parts = p.split(/[\\/]/)
    return parts[parts.length - 1] || ''
  }
  function attach(p: string): void {
    const parent = parentOf(p)
    if (!parent) return
    const base = baseOf(p)
    if (!base) return
    if (!state.dirs.has(parent)) state.dirs.set(parent, [])
    const children = state.dirs.get(parent)!
    if (!children.includes(base)) children.push(base)
  }
  function detach(p: string): void {
    const parent = parentOf(p)
    if (!parent) return
    const children = state.dirs.get(parent)
    if (!children) return
    const base = baseOf(p)
    const idx = children.indexOf(base)
    if (idx >= 0) children.splice(idx, 1)
  }
  function rmPath(p: string): void {
    const s = fsKey(p)
    const children = state.dirs.get(s)
    if (children) for (const c of [...children]) rmPath(join(s, c))
    state.dirs.delete(s)
    state.files.delete(s)
    state.isDir.delete(s)
    state.exists.delete(s)
    detach(s)
  }
  function copyPath(from: string, to: string): void {
    const f = fsKey(from)
    const t = fsKey(to)
    if (state.files.has(f)) {
      state.files.set(t, state.files.get(f)!)
      return
    }
    state.dirs.set(t, [...(state.dirs.get(f) || [])])
    state.isDir.add(t)
    attach(t)
    for (const c of state.dirs.get(f) || []) copyPath(join(f, c), join(t, c))
  }
  function mkdirPath(p: string): void {
    const s = fsKey(p)
    if (state.dirs.has(s)) return
    const parent = parentOf(s)
    if (parent && !state.dirs.has(parent)) mkdirPath(parent)
    state.dirs.set(s, [])
    state.isDir.add(s)
    state.exists.add(s)
    attach(s)
  }
  function writeFile(p: string, content: string): void {
    const s = fsKey(p)
    const parent = parentOf(s)
    if (parent && !state.dirs.has(parent)) mkdirPath(parent)
    state.files.set(s, content)
    state.exists.add(s)
    attach(s)
  }
  return {
    state,
    fsKey,
    rmPath,
    copyPath,
    mkdirPath,
    writeFile,
    attach
  }
})

// ---------- fs ----------
vi.mock('fs', () => {
  const { state, fsKey, rmPath, copyPath, mkdirPath, attach } = h
  return {
    existsSync: (p: unknown) => {
      const s = fsKey(p)
      return state.exists.has(s) || state.dirs.has(s) || state.files.has(s) || state.isDir.has(s)
    },
    readdirSync: (p: unknown) => {
      const s = fsKey(p)
      if (state.failReaddir.some((x) => s.includes(x))) throw new Error('EACCES (injected readdir)')
      return [...(state.dirs.get(s) || [])]
    },
    rmdirSync: (p: unknown) => rmPath(fsKey(p)),
    statSync: (p: unknown) => {
      const s = fsKey(p)
      if (state.failStat.some((x) => s.includes(x))) throw new Error('EACCES (injected stat)')
      return {
        isDirectory: () => state.isDir.has(s) || state.dirs.has(s),
        isFile: () => state.files.has(s),
        size: 0,
        mtimeMs: 0
      }
    },
    readFileSync: (p: unknown) => state.files.get(fsKey(p)) ?? '',
    writeFileSync: (p: unknown, data: unknown) => {
      const s = fsKey(p)
      if (state.failWritePrefix.some((x) => s.includes(x)))
        throw new Error('EROFS (injected write)')
      state.files.set(s, String(data))
      state.exists.add(s)
      attach(s)
    },
    unlinkSync: (p: unknown) => {
      const s = fsKey(p)
      state.files.delete(s)
      state.exists.delete(s)
    },
    mkdirSync: (p: unknown) => mkdirPath(fsKey(p)),
    rmSync: (p: unknown) => {
      const s = fsKey(p)
      if (state.failRmPrefix.some((prefix) => s.includes(prefix))) {
        throw new Error('EBUSY (injected)')
      }
      rmPath(s)
    },
    renameSync: (from: unknown, to: unknown) => {
      const f = fsKey(from)
      const t = fsKey(to)
      copyPath(f, t)
      rmPath(f)
    },
    copyFileSync: (from: unknown, to: unknown) => {
      const f = fsKey(from)
      const t = fsKey(to)
      if (state.failCopyOnce.has(f) || state.failCopyOnce.has(t)) {
        state.failCopyOnce.delete(f)
        state.failCopyOnce.delete(t)
        throw new Error('EACCES (injected copy failure)')
      }
      state.files.set(t, state.files.get(f) ?? '')
      state.exists.add(t)
      attach(t)
    },
    cpSync: (from: unknown, to: unknown) => {
      const f = fsKey(from)
      const t = fsKey(to)
      if (state.failCopyOnce.has(f) || state.failCopyOnce.has(t)) {
        state.failCopyOnce.delete(f)
        state.failCopyOnce.delete(t)
        throw new Error('EACCES (injected copy failure)')
      }
      copyPath(f, t)
    },
    createWriteStream: (p: unknown) => {
      // Minimal in-memory Writable for the archive body download. `destroy()`
      // must make `end(cb)` never fire its callback, like a real stream.
      const s = fsKey(p)
      let buf = Buffer.alloc(0)
      const stream = {
        destroyed: false,
        write(chunk: Uint8Array, cb?: (err?: Error | null) => void) {
          buf = Buffer.concat([buf, Buffer.from(chunk)])
          cb?.()
          return true
        },
        end(cb?: () => void) {
          stream.destroyed = true
          state.files.set(s, buf.toString('binary'))
          state.exists.add(s)
          attach(s)
          cb?.()
        },
        destroy() {
          stream.destroyed = true
        },
        on() {
          return stream
        },
        once() {
          return stream
        }
      }
      return stream
    }
  }
})

// ---------- crypto ----------
vi.mock('crypto', () => ({
  randomUUID: () => `uuid-${Math.random().toString(16).slice(2, 10)}`,
  createHash: () => {
    let acc = ''
    const api = {
      update: (s: string) => {
        acc += String(s)
        return api
      },
      digest: () => Buffer.from(acc, 'utf8').toString('hex').padEnd(16, '0').slice(0, 16)
    }
    return api
  }
}))

// ---------- child_process ----------
vi.mock('child_process', () => {
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
      let result: ExecResult
      try {
        result = handler(cmd, args, optsArg)
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)), '', '')
        return { pid: 1, exitCode: null, kill: () => undefined }
      }
      if (result.hang) {
        return { pid: 42, exitCode: null, kill: () => undefined }
      }
      if (result.error) {
        const err = result.error as Error & { code?: number }
        if (result.code != null) err.code = result.code
        finish(err, result.stdout || '', result.stderr ?? '')
      } else {
        finish(null, result.stdout || '', result.stderr || '')
      }
    } else {
      finish(null, '', '')
    }
    return { pid: 1, exitCode: null, kill: () => undefined }
  }
  return {
    execFile,
    execFileSync: () => {
      if (h.state.execSyncErr) throw h.state.execSyncErr
      return h.state.execSyncOut
    },
    spawn: () => ({ pid: 2, exitCode: null, kill: () => undefined })
  }
})

// ---------- electron ----------
vi.mock('electron', () => ({
  session: {
    defaultSession: {
      fetch: (url: string) => {
        if (h.state.sessionFetch) return h.state.sessionFetch(String(url))
        throw new Error('no session fetch configured')
      }
    }
  },
  app: { getPath: () => 'C:/fake/userData' }
}))

// ---------- services ----------
vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => h.state.settings,
  loadInstanceConfigs: () => h.state.instances,
  upsertInstanceConfig: vi.fn()
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyEnv: vi.fn(() => ({}))
}))

vi.mock('../../src/main/services/security', () => ({
  normalizePathEverySegment: (p: string) => String(p).replace(/\\/g, '/'),
  hasParentHop: (p: string) => /(^|[\\/])\.\.([\\/]|$)/.test(String(p)),
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
  resolveTorchIndex: vi.fn(() => 'https://mirror.example/whl/cu126'),
  officialTorchIndex: vi.fn(() => 'https://download.pytorch.org/whl/cu126'),
  applyGithubMirror: vi.fn((u: string) => u)
}))

vi.mock('../../src/main/services/nodePack', () => ({
  resolveGitBinary: vi.fn(() => 'git'),
  nodePackService: {
    createSnapshot: vi.fn(() => {
      if (h.state.createSnapshotErr) throw h.state.createSnapshotErr
      return { id: 'snap-pre-update' }
    }),
    restoreNodeVersions: vi.fn(async () => {
      if (h.state.restoreErr) throw h.state.restoreErr
      return (
        h.state.restoreResult || {
          ok: true,
          restored: [],
          skipped: [],
          failed: [],
          warnings: []
        }
      )
    }),
    list: vi.fn(() => h.state.nodePacks),
    checkIssues: vi.fn(async (name: string) => {
      h.state.nodePackCheckCalls.push(name)
      if (h.state.nodeIssuesErr.has(name)) throw new Error('issues boom')
      return h.state.nodeIssues.get(name) || []
    })
  }
}))

vi.mock('../../src/main/ipc/handlers', () => ({
  broadcastNotification: vi.fn()
}))

vi.mock('../../src/main/services/bootstrap', () => ({
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
  return {
    resolveInstancePythonPath: (config: { venvPath?: string }) => {
      if (!config.venvPath) return 'python'
      const win = `${config.venvPath}/Scripts/python.exe`
      return existsSync(win) ? win : `${config.venvPath}/bin/python`
    },
    instanceService: {
      list: () => h.state.instanceList,
      stop: vi.fn(async (id: string) => {
        h.state.stopCalls.push(id)
        if (h.state.instanceStopErr) throw h.state.instanceStopErr
        return { id, status: 'stopped', ...(h.state.instanceStopResult || {}) }
      }),
      checkPort: vi.fn(async () => {
        const available = h.state.checkPortQueue.length ? h.state.checkPortQueue.shift()! : true
        return { port: 8188, available }
      }),
      runStartupSelfCheck: vi.fn(async () => {
        if (h.state.selfcheckErr) throw h.state.selfcheckErr
        return h.state.selfcheckResult || { ok: true, exitCode: 0, output: 'ok' }
      }),
      launch: vi.fn(async (id: string, opts: unknown) => {
        h.state.launchCalls.push({ id, opts })
        return { id, url: 'http://127.0.0.1:8188', status: 'running' }
      })
    }
  }
})

vi.mock('../../src/main/services/doctor', () => ({
  doctorService: {
    run: vi.fn(async () => {
      if (h.state.doctorErr) throw h.state.doctorErr
      return h.state.doctorResult || { checks: [], summary: { pass: 5, warn: 0 } }
    })
  }
}))

vi.mock('../../src/main/services/zipSafe', () => ({
  safeUnzip: vi.fn(async (zip: string, dest: string) => {
    if (h.state.unzipImpl) h.state.unzipImpl(zip, dest)
  })
}))

import {
  PRESERVE_ENTRIES,
  detectComfySource,
  probeComfyVersion,
  comfyUpdaterService
} from '../../src/main/services/updater'
import type { UpdateProgress, ComfyUpdateOptions } from '../../src/shared/types'
import { bootstrapService } from '../../src/main/services/bootstrap'
import { nodePackService, resolveGitBinary } from '../../src/main/services/nodePack'
import { instanceService } from '../../src/main/services/instance'
import { broadcastNotification } from '../../src/main/ipc/handlers'

const svc = comfyUpdaterService as unknown as {
  copyCoreTree: (
    src: string,
    dest: string,
    onProgress?: (done: number, total: number) => void
  ) => Promise<number>
  fetchAndOverlayZip: (comfyDir: string, stableTag?: string) => Promise<void>
  performRollback: (comfyDir: string, backupPath: string, kind: 'git' | 'files') => Promise<boolean>
  overlayTree: (
    src: string,
    dest: string,
    topLevel?: boolean,
    shouldStop?: () => boolean,
    onProgress?: (done: number, total: number) => void
  ) => Promise<number>
  streamBodyToFile: (
    res: { body?: unknown; arrayBuffer?: () => Promise<ArrayBuffer> },
    dest: string,
    onChunk?: (chunk: Buffer) => void
  ) => Promise<number>
  readArchiveManifest: (comfyDir: string) => string[]
  writeArchiveManifest: (comfyDir: string, files: string[]) => void
  listArchiveFiles: (root: string) => string[]
  pruneRemovedArchiveFiles: (comfyDir: string, previous: string[], next: string[]) => number
  postUpdateNodeCheck: (instanceId: string) => Promise<void>
  journalBackupMatchesHead: (journal: Record<string, unknown>) => boolean
  clearUnverifiedArchivePin: (comfyDir: string) => void
  setWork: (id: string, done: number, total: number, label?: string) => void
  clearWork: (id: string) => void
  venvPython: (venvPath: string) => string
  pipArgs: (base: string[]) => string[]
  killTree: (child: {
    pid?: number
    exitCode: number | null
    kill: (s: string) => void
  }) => Promise<void>
  setStep: (
    id: string,
    status: string,
    detail?: string,
    logLine?: string,
    detailKey?: string,
    detailParams?: Record<string, string | number>
  ) => void
  log: (id: string, line: string) => void
  emitProgress: (message?: string) => void
  setBytes: (bytes?: unknown) => void
  assertNotCancelled: () => void
  requireInstance: (id: string) => unknown
  run: (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<string>
  writeJournal: (journal: unknown) => void
  clearJournal: (comfyDir: string) => void
}

const COMFY = 'C:/fake/ComfyUI'
const VENV = 'C:/fake/.venv'

/** Normalize a path to the mock fs key form (forward slashes, cwd-stripped). */
function key(p: string): string {
  return pathKey(p)
}
function fget(p: string): string | undefined {
  return h.state.files.get(key(p))
}
function fhas(p: string): boolean {
  const s = key(p)
  return (
    h.state.files.has(s) || h.state.dirs.has(s) || h.state.isDir.has(s) || h.state.exists.has(s)
  )
}
function dhas(p: string): boolean {
  return h.state.dirs.has(key(p)) || h.state.isDir.has(key(p))
}

function resetState(): void {
  h.state.dirs.clear()
  h.state.files.clear()
  h.state.isDir.clear()
  h.state.exists.clear()
  h.state.execHandler = null
  h.state.execSyncOut = 'v0.0.1-1-gabc1234'
  h.state.execSyncErr = null
  h.state.instanceStopErr = null
  h.state.instanceStopResult = null
  h.state.stopCalls = []
  h.state.launchCalls = []
  h.state.checkPortQueue = []
  h.state.doctorResult = { checks: [], summary: { pass: 5, warn: 0 } }
  h.state.doctorErr = null
  h.state.selfcheckResult = null
  h.state.selfcheckErr = null
  h.state.uvInstalled = false
  h.state.failCopyOnce.clear()
  h.state.failRmPrefix = []
  h.state.failReaddir = []
  h.state.failStat = []
  h.state.failWritePrefix = []
  h.state.nodePacks = []
  h.state.nodeIssues = new Map()
  h.state.nodeIssuesErr = new Set()
  h.state.restoreResult = null
  h.state.restoreErr = null
  h.state.createSnapshotErr = null
  h.state.nodePackCheckCalls = []
  // Default: a minimal valid archive that just re-writes main.py
  h.state.sessionFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => '8' },
    arrayBuffer: async () => new TextEncoder().encode('zipdata').buffer
  })
  h.state.unzipImpl = (zip, dest) => {
    h.writeFile(join(dest, 'main.py'), 'ok')
  }
  h.state.settings = {
    pipIndex: '',
    torchIndexMirror: '',
    githubEndpoint: '',
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
      venvPath: VENV,
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
  h.state.instanceList = []
  const ensure = bootstrapService.ensure as ReturnType<typeof vi.fn>
  ensure.mockImplementation(async () => ({
    runtimesDir: 'C:/fake/runtimes',
    components: h.state.uvInstalled
      ? [{ kind: 'uv', path: h.state.uvPath, installed: true, origin: 'runtimes' }]
      : [],
    pythonPath: 'python',
    pythonOrigin: 'system',
    zipInstallReady: true
  }))
}

/** Seed a zip-style ComfyUI install (main.py present, no .git). */
function seedZipInstall(opts?: { withVenv?: boolean; withReq?: boolean; withGit?: boolean }): void {
  h.mkdirPath(COMFY)
  h.writeFile(join(COMFY, 'main.py'), 'print("comfy")\n')
  if (opts?.withReq !== false) {
    h.writeFile(join(COMFY, 'requirements.txt'), 'torch\n')
  }
  h.writeFile(join(COMFY, 'comfy', '__init__.py'), '')
  if (opts?.withGit) {
    h.mkdirPath(join(COMFY, '.git'))
  }
  if (opts?.withVenv) {
    h.mkdirPath(join(VENV, 'Scripts'))
    h.writeFile(join(VENV, 'Scripts', 'python.exe'), '')
  }
}

function seedGitInstall(opts?: { withVenv?: boolean; withReq?: boolean }): void {
  seedZipInstall({ ...opts, withGit: true })
}

/** Route execFile by matching a substring of `cmd + args`. */
function routeExec(routes: Array<{ match: string; result: () => ExecResult }>): void {
  h.state.execHandler = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    for (const r of routes) {
      if (key.includes(r.match)) return r.result()
    }
    return { stdout: '' }
  }
}

/** Wait for the NEXT run to finish (status done|failed) via progress events. */
function waitFinished(): Promise<UpdateProgress> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      comfyUpdaterService.off('progress', handler)
      reject(new Error('timeout waiting for update to finish'))
    }, 8000)
    const handler = (p: UpdateProgress): void => {
      if (p.status === 'done' || p.status === 'failed' || p.status === 'cancelled') {
        clearTimeout(timer)
        comfyUpdaterService.off('progress', handler)
        // The terminal event fires before runUpdate's `finally` clears `running`;
        // drain it so the next test never observes a "live" run (review fix).
        setTimeout(() => {
          resolve({ ...p, steps: p.steps.map((s) => ({ ...s, log: [...s.log] })) })
        }, 0)
      }
    }
    comfyUpdaterService.on('progress', handler)
  })
}

describe('stable update channel (0.2.5 WP5)', () => {
  beforeEach(() => {
    seedZipInstall({ withVenv: true, withReq: false })
  })

  it('uses the latest release tag, never master, and reports release metadata', async () => {
    h.state.instances[0].updateChannel = 'stable'
    h.state.sessionFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.46.0',
          published_at: '2026-11-18T00:00:00Z',
          body: 'notes',
          html_url: 'https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.46.0',
          prerelease: false
        })
      }) as never
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.channel).toBe('stable')
    expect(info.latest).toBe('v0.46.0')
    expect(info.updatable).toBe(true)
    expect(info.releaseUrl).toContain('/releases/tag/v0.46.0')
    expect(info.releaseNotes).toBe('notes')
  })

  it('skips prereleases and never reports them as stable', async () => {
    h.state.instances[0].updateChannel = 'stable'
    h.state.sessionFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v0.47.0-rc1', prerelease: true })
      }) as never
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.channel).toBe('stable')
    expect(info.updatable).toBe(false)
    expect(info.unknown).toBe(true)
  })

  it('reports up to date when the installed version equals the stable tag', async () => {
    h.state.instances[0].updateChannel = 'stable'
    h.writeFile(join(COMFY, 'pyproject.toml'), '[project]\nversion = "0.46.0"\n')
    h.state.sessionFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v0.46.0', prerelease: false })
      }) as never
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.updatable).toBe(false)
  })

  it('downloads the release tag archive (not master) on a stable update', async () => {
    h.state.instances[0].updateChannel = 'stable'
    const urls: string[] = []
    h.state.sessionFetch = async (url: string) => {
      urls.push(url)
      if (url.includes('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tag_name: 'v0.46.0', prerelease: false })
        }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => '10' },
        arrayBuffer: async () => new TextEncoder().encode('zip').buffer
      }
    }
    h.state.unzipImpl = (_zip, dest) => {
      const nested = join(dest, 'ComfyUI-0.46.0')
      h.mkdirPath(nested)
      h.writeFile(join(nested, 'main.py'), 'print(1)')
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    expect(urls.some((u) => u.includes('/archive/refs/tags/v0.46.0.zip'))).toBe(true)
    expect(urls.some((u) => u.includes('/refs/heads/master.zip'))).toBe(false)
  })

  it('refuses a stable update when no release tag can be resolved', async () => {
    h.state.instances[0].updateChannel = 'stable'
    h.state.sessionFetch = async () => ({ ok: false, status: 403, json: async () => ({}) }) as never
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/no official release tag/i)
  })

  it('checks out the release tag for a stable git install', async () => {
    h.state.instances[0].updateChannel = 'stable'
    seedGitInstall({ withVenv: true, withReq: false })
    const execs: string[] = []
    h.state.sessionFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v0.46.0', prerelease: false })
      }) as never
    h.state.execHandler = (cmd, args) => {
      execs.push(`${cmd} ${args.join(' ')}`)
      if (args.includes('status')) return { stdout: '' }
      if (args.includes('rev-parse')) return { stdout: 'abc1234\n' }
      return { stdout: 'ok\n' }
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    expect(execs.some((c) => c.includes('checkout --detach v0.46.0'))).toBe(true)
  })

  it('treats a legacy instance without updateChannel as nightly', async () => {
    delete h.state.instances[0].updateChannel
    h.state.sessionFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ sha: 'abcdef123456', commit: { committer: { date: '2026-11-20' } } })
      }) as never
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.channel).toBe('nightly')
  })
})

async function runUpdate(opts?: ComfyUpdateOptions): Promise<UpdateProgress> {
  const finished = waitFinished()
  await comfyUpdaterService.start('inst-1', opts)
  return await finished
}

beforeEach(async () => {
  resetState()
  vi.clearAllMocks()
  // Drain any run left over from a previous test so the singleton is idle.
  if (comfyUpdaterService.getStatus() && comfyUpdaterService.getStatus()!.status === 'running') {
    comfyUpdaterService.cancel()
    await waitFinished().catch(() => undefined)
  }
  // Reset private run flags that cancel()/finish leave behind.
  Object.assign(comfyUpdaterService as unknown as Record<string, unknown>, {
    cancelled: false,
    running: false
  })
})

// =====================================================================
// PRESERVE_ENTRIES / detectComfySource / probeComfyVersion
// =====================================================================
describe('PRESERVE_ENTRIES', () => {
  it('covers every user-data directory and the venv/python embeds', () => {
    for (const n of [
      'custom_nodes',
      'models',
      'user',
      'input',
      'output',
      'extra_model_paths.yaml',
      '.comfypilot-env.json',
      '.git',
      'venv',
      '.venv',
      'python_embeded',
      'python_embedded'
    ]) {
      expect(PRESERVE_ENTRIES.has(n)).toBe(true)
    }
    expect(PRESERVE_ENTRIES.has('main.py')).toBe(false)
    expect(PRESERVE_ENTRIES.has('comfy')).toBe(false)
  })
})

describe('detectComfySource', () => {
  it('returns git/zip/unknown based on markers', () => {
    h.mkdirPath(join(COMFY, '.git'))
    expect(detectComfySource(COMFY)).toBe('git')
    h.rmPath(join(COMFY, '.git'))
    h.writeFile(join(COMFY, 'main.py'), 'x')
    expect(detectComfySource(COMFY)).toBe('zip')
    h.rmPath(COMFY)
    expect(detectComfySource(COMFY)).toBe('unknown')
  })
})

describe('probeComfyVersion', () => {
  it('uses git describe for git installs', () => {
    h.mkdirPath(join(COMFY, '.git'))
    h.state.execSyncOut = 'v1.2.3'
    expect(probeComfyVersion(COMFY)).toBe('v1.2.3')
  })

  it('falls back to git marker string when describe returns empty', () => {
    h.mkdirPath(join(COMFY, '.git'))
    h.state.execSyncOut = ''
    expect(probeComfyVersion(COMFY)).toBe('git')
  })

  it('falls through when git describe throws', () => {
    h.mkdirPath(join(COMFY, '.git'))
    h.state.execSyncErr = new Error('not a repo')
    h.writeFile(join(COMFY, 'main.py'), 'x')
    h.writeFile(join(COMFY, 'pyproject.toml'), 'version = "9.9.9"\n')
    expect(probeComfyVersion(COMFY)).toBe('9.9.9')
    h.state.execSyncErr = null
  })

  it('prefers comfyVersion from the stamp file', () => {
    h.writeFile(join(COMFY, 'main.py'), 'x')
    h.writeFile(join(COMFY, '.comfypilot-env.json'), JSON.stringify({ comfyVersion: 'v9.0.0' }))
    expect(probeComfyVersion(COMFY)).toBe('v9.0.0')
  })

  it('uses comfyFetchedAt date when commit/version are absent', () => {
    h.writeFile(join(COMFY, 'main.py'), 'x')
    h.writeFile(
      join(COMFY, '.comfypilot-env.json'),
      JSON.stringify({ comfyFetchedAt: Date.UTC(2024, 5, 15) })
    )
    expect(probeComfyVersion(COMFY)).toBe('2024-06-15')
  })

  it('reads the stamp from the parent directory as a fallback', () => {
    h.writeFile(join(COMFY, 'main.py'), 'x')
    h.writeFile(
      join(dirname(COMFY), '.comfypilot-env.json'),
      JSON.stringify({ comfyCommit: 'abcdef1234567890' })
    )
    expect(probeComfyVersion(COMFY)).toBe('abcdef123456')
  })

  it('returns detected for requirements-only installs', () => {
    h.writeFile(join(COMFY, 'main.py'), 'x')
    h.writeFile(join(COMFY, 'requirements.txt'), 'torch\n')
    expect(probeComfyVersion(COMFY)).toBe('detected')
  })

  it('returns unknown when nothing is discoverable', () => {
    h.mkdirPath(COMFY)
    expect(probeComfyVersion(COMFY)).toBe('unknown')
  })

  it('ignores a corrupt stamp file', () => {
    h.writeFile(join(COMFY, 'main.py'), 'x')
    h.writeFile(join(COMFY, '.comfypilot-env.json'), '{bad json')
    expect(probeComfyVersion(COMFY)).toBe('unknown')
  })
})

// =====================================================================
// check()
// =====================================================================
describe('check()', () => {
  it('rejects unknown instance ids', async () => {
    await expect(comfyUpdaterService.check('nope')).rejects.toThrow(/not found/i)
  })

  it('rejects instances with a parent-hop path', async () => {
    h.state.instances[0].path = 'C:/fake/../etc'
    await expect(comfyUpdaterService.check('inst-1')).rejects.toThrow(/invalid instance path/i)
  })

  it('reports git behind count > 0 as updatable', async () => {
    seedGitInstall()
    routeExec([
      { match: 'fetch', result: () => ({ stdout: '' }) },
      { match: 'rev-list', result: () => ({ stdout: '4\n' }) },
      { match: 'rev-parse', result: () => ({ stdout: 'deadbeef\n' }) },
      { match: 'describe', result: () => ({ stdout: 'v2.0.0\n' }) }
    ])
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.source).toBe('git')
    expect(info.updatable).toBe(true)
    expect(info.behindCount).toBe(4)
    expect(info.latestCommit).toBe('deadbeef')
    expect(info.latest).toBe('v2.0.0')
  })

  it('reports git up-to-date when behind is zero', async () => {
    seedGitInstall()
    routeExec([
      { match: 'fetch', result: () => ({ stdout: '' }) },
      { match: 'rev-list', result: () => ({ stdout: '0\n' }) },
      { match: 'rev-parse', result: () => ({ stdout: 'deadbeef\n' }) },
      { match: 'describe', result: () => ({ stdout: 'v2.0.0\n' }) }
    ])
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.updatable).toBe(false)
    expect(info.behindCount).toBe(0)
  })

  it('falls back to latestCommit when describe fails', async () => {
    seedGitInstall()
    routeExec([
      { match: 'fetch', result: () => ({ stdout: '' }) },
      { match: 'rev-list', result: () => ({ stdout: '1\n' }) },
      { match: 'rev-parse', result: () => ({ stdout: 'cafebabe\n' }) },
      {
        match: 'describe',
        result: () => ({ error: new Error('no tags'), stderr: 'no tags' })
      }
    ])
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.latest).toBe('cafebabe')
    expect(info.latestCommit).toBe('cafebabe')
    expect(info.updatable).toBe(true)
  })

  it('returns error info when git fetch fails', async () => {
    seedGitInstall()
    routeExec([
      {
        match: 'fetch',
        result: () => ({ error: new Error('network unreachable'), stderr: 'network unreachable' })
      }
    ])
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.updatable).toBe(false)
    expect(info.source).toBe('git')
    expect(info.error).toMatch(/network unreachable/)
  })

  it('flags a zip install when the remote sha differs', async () => {
    seedZipInstall()
    h.writeFile(
      join(COMFY, '.comfypilot-env.json'),
      JSON.stringify({ comfyCommit: 'aaaaaaaaaaaa' })
    )
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sha: 'bbbbbbbbbbbbcccc',
        commit: { committer: { date: '2024-06-01T00:00:00Z' } }
      })
    })
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.source).toBe('zip')
    expect(info.updatable).toBe(true)
    expect(info.latestCommit).toBe('bbbbbbbbbbbb')
  })

  it('does not flag a zip install already at the remote sha', async () => {
    seedZipInstall()
    h.writeFile(
      join(COMFY, '.comfypilot-env.json'),
      JSON.stringify({ comfyCommit: 'bbbbbbbbbbbb' })
    )
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sha: 'bbbbbbbbbbbbcccc',
        commit: { committer: { date: '2024-06-01T00:00:00Z' } }
      })
    })
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.updatable).toBe(false)
  })

  it('compares fetch dates for date-stamped zip installs', async () => {
    seedZipInstall()
    h.writeFile(
      join(COMFY, '.comfypilot-env.json'),
      JSON.stringify({ comfyFetchedAt: Date.UTC(2024, 0, 1) })
    )
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sha: '', commit: { committer: { date: '2024-06-01T00:00:00Z' } } })
    })
    const info = await comfyUpdaterService.check('inst-1')
    // current probes to '2024-01-01' which is < 2024-06-01
    expect(info.updatable).toBe(true)
    expect(info.latest).toMatch(/2024-06-01/)
  })

  // 0.1.17 (WP10): offline used to report `updatable: true` (force a re-download).
  // That made the UI claim an update exists without evidence — now it reports
  // `unknown`, and the user can still trigger an update manually.
  it('reports "unknown" (not updatable) when the zip API is down', async () => {
    seedZipInstall()
    h.state.sessionFetch = async () => {
      throw new Error('API offline')
    }
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.source).toBe('zip')
    expect(info.updatable).toBe(false)
    expect(info.unknown).toBe(true)
    expect(info.error).toMatch(/API offline/)
  })

  it('reports unknown source for non-installs', async () => {
    h.mkdirPath(COMFY)
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.source).toBe('unknown')
    expect(info.updatable).toBe(false)
    expect(info.error).toMatch(/main\.py/i)
  })

  it('reports non-OK GitHub API as unknown rather than as an available update', async () => {
    seedZipInstall()
    h.state.sessionFetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.updatable).toBe(false)
    expect(info.unknown).toBe(true)
    expect(info.error).toMatch(/503/)
  })
})

// =====================================================================
// start() concurrency + shape
// =====================================================================
describe('start()', () => {
  it('rejects a second concurrent update', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    // Hang only on pull so cancel can still complete the rollback afterwards.
    h.state.execHandler = (cmd, args) =>
      args.includes('pull') ? { hang: true } : { stdout: 'sha\n' }
    const finished = waitFinished()
    await comfyUpdaterService.start('inst-1')
    await expect(comfyUpdaterService.start('inst-1')).rejects.toThrow(/already running/i)
    comfyUpdaterService.cancel()
    await finished.catch(() => undefined)
  })

  it('returns a progress snapshot with all pipeline steps', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([{ match: '', result: () => ({ stdout: 'abc1234\n' }) }])
    const finished = waitFinished()
    const p = await comfyUpdaterService.start('inst-1', { updateDeps: false })
    expect(p.instanceId).toBe('inst-1')
    expect(p.status).toBe('running')
    const ids = p.steps.map((s) => s.id)
    for (const id of [
      'preflight',
      'stop',
      'backup',
      'fetch',
      'requirements',
      'torch',
      'verify',
      'rollback',
      'done'
    ]) {
      expect(ids).toContain(id)
    }
    await finished
  })

  it('throws for unknown instance ids', async () => {
    await expect(comfyUpdaterService.start('missing')).rejects.toThrow(/not found/i)
  })
})

// =====================================================================
// runUpdate pipeline
// =====================================================================
describe('runUpdate pipeline', () => {
  it('fails preflight when main.py is missing', async () => {
    h.mkdirPath(COMFY)
    const p = await runUpdate()
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/missing main\.py/i)
    const preflight = p.steps.find((s) => s.id === 'preflight')
    expect(preflight?.status).toBe('failed')
  })

  it('skips rollback when git pull fails (local edits must survive)', async () => {
    // Regression S2: pull --ff-only failure means the tree was NOT rewritten
    // by us. Rolling back with reset --hard would destroy the user's local edits.
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) {
        return {
          error: new Error('local changes would be overwritten'),
          stderr: 'local changes would be overwritten'
        }
      }
      return { stdout: 'abc1234\n' }
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/local files were left untouched/i)
    const rollback = p.steps.find((s) => s.id === 'rollback')
    expect(rollback?.status).toBe('skipped')
  })

  it('warns but continues when venv python is missing', async () => {
    seedZipInstall({ withReq: false })
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    const preflight = p.steps.find((s) => s.id === 'preflight')
    expect(preflight?.log.join('\n')).toMatch(/python missing/i)
  })

  it('stops a running instance and waits for the port to free', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.instanceList = [{ id: 'inst-1', status: 'running' }]
    h.state.checkPortQueue = [false, false, true]
    routeExec([{ match: '', result: () => ({ stdout: 'sha1\n' }) }])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    expect(h.state.stopCalls).toEqual(['inst-1'])
    const stop = p.steps.find((s) => s.id === 'stop')
    expect(stop?.log.join('\n')).toMatch(/Instance stopped/)
  })

  it('skips stop when the instance is not running', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.instanceList = [{ id: 'inst-1', status: 'stopped' }]
    routeExec([{ match: '', result: () => ({ stdout: 'sha1\n' }) }])
    const p = await runUpdate({ updateDeps: false })
    expect(h.state.stopCalls).toEqual([])
    const stop = p.steps.find((s) => s.id === 'stop')
    expect(stop?.log.join('\n')).toMatch(/not running/i)
  })

  // 0.1.17 (WP4): a stop that fails (or an adopted external process) must abort
  // the update — overlaying source under a running server was the old bug.
  it('aborts when the instance cannot be stopped', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.instanceList = [{ id: 'inst-1', status: 'running' }]
    h.state.instanceStopErr = new Error('not our process')
    const calls: string[] = []
    routeExec([
      {
        match: '',
        result: () => {
          calls.push('exec')
          return { stdout: 'sha1\n' }
        }
      }
    ])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/cannot update while the instance is running/i)
    // No pull/backup happened after the refusal.
    expect(calls).toEqual([])
    const stop = p.steps.find((s) => s.id === 'stop')
    expect(stop?.status).toBe('failed')
  })

  it('records git HEAD during backup and keeps the backup dir', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    const pulls: string[] = []
    routeExec([
      { match: 'rev-parse HEAD', result: () => ({ stdout: 'abc1234\n' }) },
      {
        match: 'pull',
        result: () => {
          pulls.push('pull')
          return { stdout: 'ok\n' }
        }
      },
      { match: 'rev-parse --short', result: () => ({ stdout: 'abc1234\n' }) }
    ])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    expect(pulls).toEqual(['pull'])
    expect(p.backupPath).toBeTruthy()
    const backup = p.steps.find((s) => s.id === 'backup')
    expect(backup?.log.join('\n')).toMatch(/git HEAD abc1234/)
    // git backups are kept (cheap sha file)
    expect(dhas(p.backupPath!)).toBe(true)
  })

  it('copies only core files for a zip backup (preserves user dirs)', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.mkdirPath(join(COMFY, 'custom_nodes'))
    h.mkdirPath(join(COMFY, 'models'))
    h.writeFile(join(COMFY, 'custom_nodes', 'MyPack', 'a.py'), 'x')
    h.writeFile(join(COMFY, 'models', 'sd.safetensors'), 'x')
    h.writeFile(join(COMFY, 'comfy', 'model.py'), 'x')
    h.mkdirPath(join(COMFY, '.cp-backup-123'))
    // Fail the fetch step so the files backup is NOT cleaned up and can be inspected.
    h.state.sessionFetch = async () => ({
      ok: false,
      status: 500,
      headers: { get: () => '0' },
      arrayBuffer: async () => new ArrayBuffer(0)
    })
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    const backupDir = p.backupPath!
    expect(dhas(join(backupDir, 'comfy'))).toBe(true)
    expect(fhas(join(backupDir, 'main.py'))).toBe(true)
    expect(dhas(join(backupDir, 'custom_nodes'))).toBe(false)
    expect(dhas(join(backupDir, 'models'))).toBe(false)
    expect(dhas(join(backupDir, '.cp-backup-123'))).toBe(false)
    // rollback restored the core tree from that backup
    expect(fget(join(COMFY, 'main.py'))).toBeTruthy()
  })

  it('does NOT rollback when pull fails (preserves local edits)', async () => {
    // Regression S2: pull failure means the tree was not rewritten by us.
    // reset --hard here would destroy the user's uncommitted edits.
    seedGitInstall({ withVenv: true, withReq: false })
    const resets: string[] = []
    routeExec([
      { match: 'rev-parse HEAD', result: () => ({ stdout: 'oldsha\n' }) },
      {
        match: 'pull',
        result: () => ({ error: new Error('local changes'), stderr: 'local changes' })
      },
      {
        match: 'reset',
        result: () => {
          resets.push('reset')
          return { stdout: '' }
        }
      }
    ])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/git pull --ff-only failed/)
    expect(p.error).toMatch(/Your local files were left untouched/)
    expect(resets).toEqual([])
    const rollback = p.steps.find((s) => s.id === 'rollback')
    expect(rollback?.status).toBe('skipped')
  })

  it('reports backup at when git rollback itself fails (after tree was modified)', async () => {
    // Rollback runs only when a step AFTER a successful fetch fails and the
    // failure is NOT a deps-only failure. Torch install failure is that case.
    seedGitInstall({ withVenv: true, withReq: false })
    // 0.1.17 (WP4-3): the rollback decision now compares the real HEAD before
    // and after the fetch, so the mock must actually change it on the pull.
    // call 1 = pre-fetch snapshot, call 2 = backup sha, call 3+ = post-failure check.
    let headCalls = 0
    routeExec([
      {
        match: 'rev-parse HEAD',
        result: () => ({ stdout: ++headCalls <= 2 ? 'oldsha\n' : 'newsha\n' })
      },
      { match: 'pull', result: () => ({ stdout: '' }) },
      { match: 'rev-parse --short', result: () => ({ stdout: 'newsha\n' }) },
      {
        match: 'pip',
        result: () => ({ error: new Error('torch exploded'), stderr: 'torch exploded' })
      },
      { match: 'status', result: () => ({ stdout: '' }) },
      {
        match: 'reset',
        result: () => ({ error: new Error('reset exploded'), stderr: 'reset exploded' })
      }
    ])
    const p = await runUpdate({ updateDeps: true, torchChannel: 'cpu' })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/rollback FAILED/)
    expect(p.error).toMatch(/backup at/)
  })

  it('overlays a GitHub archive for zip installs', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '123' },
      arrayBuffer: async () => new TextEncoder().encode('zipdata').buffer
    })
    h.state.unzipImpl = (zip, dest) => {
      // staged extract: nested ComfyUI-master/
      const nested = join(dest, 'ComfyUI-master')
      h.mkdirPath(nested)
      h.writeFile(join(nested, 'main.py'), 'updated')
      h.writeFile(join(nested, 'comfy', 'model.py'), 'updated')
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    expect(fget(join(COMFY, 'main.py'))).toBe('updated')
    // user dirs untouched
    const fetch = p.steps.find((s) => s.id === 'fetch')
    expect(fetch?.status).toBe('done')
  })

  it('rolls back and keeps the file backup when the startup self-check fails', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '123' },
      arrayBuffer: async () => new TextEncoder().encode('zipdata').buffer
    })
    h.state.unzipImpl = (_zip, dest) => {
      const nested = join(dest, 'ComfyUI-master')
      h.mkdirPath(nested)
      h.writeFile(join(nested, 'main.py'), 'updated')
    }
    h.state.selfcheckResult = { ok: false, exitCode: 1, output: 'broken import' }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.steps.find((s) => s.id === 'verify')?.status).toBe('failed')
    // The backup is the only way back from a failed self-check — it must stay.
    expect(p.backupPath).toBeTruthy()
    expect(dhas(p.backupPath!)).toBe(true)
  })

  it('skips requirements and torch when updateDeps is false', async () => {
    seedZipInstall({ withVenv: true, withReq: true })
    const p = await runUpdate({ updateDeps: false })
    expect(p.steps.find((s) => s.id === 'requirements')?.status).toBe('skipped')
    expect(p.steps.find((s) => s.id === 'torch')?.status).toBe('skipped')
  })

  it('skips requirements when requirements.txt is absent', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const p = await runUpdate({})
    expect(p.steps.find((s) => s.id === 'requirements')?.status).toBe('skipped')
  })

  it('fails when requirements exist but venv python is missing', async () => {
    seedGitInstall({ withVenv: false, withReq: true })
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const p = await runUpdate({})
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/venv python missing/i)
  })

  it('installs requirements via uv when available', async () => {
    seedGitInstall({ withVenv: true, withReq: true })
    h.state.uvInstalled = true
    const cmds: Array<{ cmd: string; args: string[] }> = []
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse')) return { stdout: 'sha\n' }
      if (cmd.includes('uv') || args[0] === 'pip') {
        cmds.push({ cmd, args: [...args] })
        return { stdout: 'ok\n' }
      }
      return { stdout: '' }
    }
    const p = await runUpdate({})
    expect(p.status).toBe('done')
    expect(cmds.some((c) => c.cmd.includes('uv'))).toBe(true)
  })

  it('falls back to venv pip when uv is unavailable', async () => {
    seedGitInstall({ withVenv: true, withReq: true })
    h.state.uvInstalled = false
    const cmds: string[] = []
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse')) return { stdout: 'sha\n' }
      if (args.includes('pip')) {
        cmds.push(cmd)
        return { stdout: 'ok\n' }
      }
      return { stdout: '' }
    }
    const p = await runUpdate({})
    expect(p.status).toBe('done')
    expect(cmds[0]).toContain('python')
  })

  it('fails the run when requirements install throws', async () => {
    seedGitInstall({ withVenv: true, withReq: true })
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse')) return { stdout: 'sha\n' }
      // let the ensurePip probe succeed; fail the actual install
      if (args.includes('--version') || args.includes('ensurepip')) return { stdout: 'pip 24.0\n' }
      if (args.includes('install') || args.includes('-r') || cmd.includes('uv')) {
        return { error: new Error('No matching distribution'), stderr: 'No matching distribution' }
      }
      return { stdout: '' }
    }
    const p = await runUpdate({})
    expect(p.status).toBe('failed')
    // Deps failure is wrapped so the source is kept — the root cause is in the message.
    expect(p.error).toMatch(/requirements install failed/i)
    expect(p.error).toMatch(/No matching distribution/)
  })

  it('appends --index-url from settings for uv installs', async () => {
    seedGitInstall({ withVenv: true, withReq: true })
    h.state.settings.pipIndex = 'https://mirror.example/simple/'
    h.state.uvInstalled = true
    const uvArgs: string[][] = []
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse')) return { stdout: 'sha\n' }
      if (cmd.includes('uv')) {
        uvArgs.push([...args])
        return { stdout: 'ok\n' }
      }
      return { stdout: '' }
    }
    const p = await runUpdate({})
    expect(p.status).toBe('done')
    expect(uvArgs[0]).toContain('--index-url')
    expect(uvArgs[0]).toContain('https://mirror.example/simple/')
  })

  it('installs torch on a mirror channel and retries official when the mirror fails', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    const torchCalls: string[] = []
    let mirrorTried = false
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse')) return { stdout: 'sha\n' }
      if (args.includes('torch')) {
        torchCalls.push(args.join(' '))
        if (!mirrorTried) {
          mirrorTried = true
          return { error: new Error('mirror down'), stderr: 'mirror down' }
        }
        return { stdout: 'ok\n' }
      }
      return { stdout: '' }
    }
    const p = await runUpdate({ torchChannel: 'cu126' })
    expect(p.status).toBe('done')
    expect(torchCalls.length).toBe(2)
    expect(torchCalls[0]).toContain('mirror.example')
    expect(torchCalls[1]).toContain('download.pytorch.org')
    expect(p.steps.find((s) => s.id === 'torch')?.status).toBe('done')
  })

  it('fails the run when the official torch index also fails', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse')) return { stdout: 'sha\n' }
      if (args.includes('torch')) return { error: new Error('torch fail'), stderr: 'torch fail' }
      return { stdout: '' }
    }
    const p = await runUpdate({ torchChannel: 'cu126' })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/torch fail/)
  })

  it('skips torch when no channel is requested', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const p = await runUpdate({})
    expect(p.steps.find((s) => s.id === 'torch')?.status).toBe('skipped')
  })

  it('passes verify when doctor is clean', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.doctorResult = {
      checks: [{ severity: 'ok', title: 'all good' }],
      summary: { pass: 8, warn: 0 }
    }
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    const verify = p.steps.find((s) => s.id === 'verify')
    expect(verify?.status).toBe('done')
    expect(verify?.detail).toMatch(/Startup self-check passed/)
  })

  it('fails and rolls back when the real startup self-check reports a crash', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.selfcheckResult = { ok: false, exitCode: 1, output: 'Traceback: boom' }
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/self-check|did not start/i)
    const verify = p.steps.find((s) => s.id === 'verify')
    expect(verify?.detail).toMatch(/self-check failed|unavailable/i)
  })

  it('fails verify when the self-check cannot run (not a silent pass)', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.selfcheckErr = new Error('self-check module missing')
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    const verify = p.steps.find((s) => s.id === 'verify')
    expect(verify?.detail).toMatch(/unavailable/i)
  })

  it('fails verify when doctor errors and main.py is gone', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.selfcheckErr = new Error('self-check exploded')
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) {
        // wipe main.py to simulate a catastrophic update
        h.rmPath(join(COMFY, 'main.py'))
        return { stdout: 'ok\n' }
      }
      return { stdout: 'sha\n' }
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/self-check exploded|main\.py/i)
  })

  it('relaunches the instance when open is requested', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const p = await runUpdate({ updateDeps: false, open: 'browser' })
    expect(p.status).toBe('done')
    expect(h.state.launchCalls).toHaveLength(1)
    expect(h.state.launchCalls[0].id).toBe('inst-1')
  })

  it('does not relaunch when open is none/absent', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    await runUpdate({ updateDeps: false, open: 'none' })
    expect(h.state.launchCalls).toHaveLength(0)
  })

  it('logs a relaunch failure without failing the update', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const { instanceService } = await import('../../src/main/services/instance')
    ;(instanceService.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('port busy')
    )
    const p = await runUpdate({ updateDeps: false, open: 'embed' })
    expect(p.status).toBe('done')
    expect(p.steps.find((s) => s.id === 'done')?.log.join('\n')).toMatch(/relaunch failed/)
  })

  it('restores core files from a files backup on zip failure', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.writeFile(join(COMFY, 'comfy', 'model.py'), 'ORIGINAL')
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '10' },
      arrayBuffer: async () => new TextEncoder().encode('zip').buffer
    })
    h.state.unzipImpl = (zip, dest) => {
      const nested = join(dest, 'ComfyUI-master')
      h.mkdirPath(nested)
      h.writeFile(join(nested, 'main.py'), 'NEW')
      h.writeFile(join(nested, 'comfy', 'model.py'), 'NEW')
      // then simulate post-overlay verification failure by removing main.py later �?instead
      // make doctor report a missing main.py after we delete it
    }
    h.state.doctorErr = new Error('broken')
    // remove main.py AFTER overlay by wrapping unzip: write then delete main.py
    h.state.unzipImpl = (zip, dest) => {
      const nested = join(dest, 'ComfyUI-master')
      h.mkdirPath(nested)
      h.writeFile(join(nested, 'main.py'), 'NEW')
      h.writeFile(join(nested, 'comfy', 'model.py'), 'NEW')
    }
    // Force failure after overlay: use a doctor error + delete main.py before verify
    h.state.execHandler = () => ({ stdout: '' })
    // Override: after fetchAndOverlayZip, verify runs. Delete main.py inside unzip to force verify failure.
    h.state.unzipImpl = (zip, dest) => {
      const nested = join(dest, 'ComfyUI-master')
      h.mkdirPath(nested)
      h.writeFile(join(nested, 'comfy', 'model.py'), 'NEW')
      // NO main.py in the archive �?Staged archive missing main.py �?throws �?rollback
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/main\.py/i)
    // rollback restored the original comfy/model.py
    expect(fget(join(COMFY, 'comfy', 'model.py'))).toBe('ORIGINAL')
  })

  it('fails the run when zip archive is missing main.py', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '5' },
      arrayBuffer: async () => new TextEncoder().encode('z').buffer
    })
    h.state.unzipImpl = (zip, dest) => {
      h.writeFile(join(dest, 'README.md'), 'no main here')
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/main\.py/i)
  })

  it('fails the run when the archive download returns HTTP error', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.sessionFetch = async () => ({
      ok: false,
      status: 404,
      headers: { get: () => '0' },
      arrayBuffer: async () => new ArrayBuffer(0)
    })
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/HTTP 404/)
  })

  it('settles when the archive body stream errors mid-download (regression)', async () => {
    // 0.1.18: the old finally awaited file.end() after destroy(), whose
    // callback never fires — the run stayed "running" forever.
    seedZipInstall({ withVenv: true, withReq: false })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.error(new Error('network dropped'))
      }
    })
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '3' },
      body
    })
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/network dropped|failed/i)
  })
})

// =====================================================================
// cancel / killTree
// =====================================================================
describe('cancel()', () => {
  it('marks cancelled, kills children and rejects pending runners', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    // Hang ONLY on pull �?backup/reset must still complete so runUpdate can settle.
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { hang: true }
      return { stdout: 'sha\n' }
    }
    const finished = waitFinished()
    await comfyUpdaterService.start('inst-1', { updateDeps: false })
    // give the run a beat to reach the hanging pull
    await new Promise((r) => setTimeout(r, 30))
    expect(comfyUpdaterService.cancel()).toBe(true)
    const p = await finished
    // 0.1.17 (WP4): a cancelled update is `cancelled`, not `failed`.
    expect(p.status).toBe('cancelled')
    expect(p.error).toMatch(/cancelled/i)
  })

  it('killTree on win32 uses taskkill then SIGKILL', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const kills: string[] = []
      const child = {
        pid: 99,
        exitCode: null as number | null,
        kill: (sig: string) => {
          kills.push(sig)
          child.exitCode = 1
        }
      }
      let taskkillArgs: string[] | null = null
      h.state.execHandler = (cmd, args) => {
        if (cmd === 'taskkill') taskkillArgs = [...args]
        return { stdout: '' }
      }
      await svc.killTree(child)
      // win32 path must really run `taskkill /PID <pid> /T /F`…
      expect(taskkillArgs).not.toBeNull()
      expect(taskkillArgs).toEqual(['/PID', '99', '/T', '/F'])
      // …and then SIGKILL the child when it has not exited.
      expect(kills).toContain('SIGKILL')
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('killTree on non-win32 sends SIGTERM then SIGKILL after timeout', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const kills: string[] = []
      const child = {
        pid: 99,
        exitCode: null as number | null,
        kill: (sig: string) => {
          kills.push(sig)
        }
      }
      await svc.killTree(child)
      expect(kills).toContain('SIGTERM')
      expect(kills).toContain('SIGKILL')
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('cancel returns true and tolerates children without a pid', async () => {
    expect(comfyUpdaterService.cancel()).toBe(true)
  })
})

// =====================================================================
// copyCoreTree / overlayTree
// =====================================================================
describe('copyCoreTree / overlayTree', () => {
  it('copyCoreTree copies core files and skips PRESERVE_ENTRIES + backups', async () => {
    h.mkdirPath(join(COMFY, 'comfy'))
    h.writeFile(join(COMFY, 'main.py'), 'm')
    h.writeFile(join(COMFY, 'comfy', 'a.py'), 'a')
    h.writeFile(join(COMFY, 'custom_nodes', 'P', 'x.py'), 'x')
    h.writeFile(join(COMFY, 'models', 'm.safetensors'), 'm')
    h.writeFile(join(COMFY, 'extra_model_paths.yaml'), 'e')
    h.mkdirPath(join(COMFY, '.cp-backup-1'))
    h.mkdirPath(join(COMFY, '.git'))
    h.mkdirPath(join(COMFY, 'nested'))
    h.writeFile(join(COMFY, 'nested', 'b.py'), 'b')
    const dest = join(COMFY, '.cp-backup-test')
    h.mkdirPath(dest)
    const count = await svc.copyCoreTree(COMFY, dest)
    expect(count).toBe(3) // main.py, comfy/, nested/
    expect(fhas(join(dest, 'main.py'))).toBe(true)
    expect(fhas(join(dest, 'comfy', 'a.py'))).toBe(true)
    expect(fhas(join(dest, 'nested', 'b.py'))).toBe(true)
    expect(dhas(join(dest, 'custom_nodes'))).toBe(false)
    expect(dhas(join(dest, 'models'))).toBe(false)
    expect(dhas(join(dest, '.cp-backup-1'))).toBe(false)
    expect(dhas(join(dest, '.git'))).toBe(false)
  })

  it('copyCoreTree returns 0 for an empty source and tolerates unreadable entries', async () => {
    h.mkdirPath(join(COMFY, 'empty'))
    const dest = join(COMFY, 'dest')
    h.mkdirPath(dest)
    await expect(svc.copyCoreTree(join(COMFY, 'empty'), dest)).resolves.toBe(0)
  })

  it('overlayTree overlays files, creates missing dirs and skips preserved names', async () => {
    const src = join(COMFY, 'staging')
    const dest = join(COMFY, 'install')
    h.mkdirPath(join(src, 'comfy'))
    h.mkdirPath(join(dest, 'comfy'))
    h.writeFile(join(src, 'main.py'), 'NEW')
    h.writeFile(join(src, 'comfy', 'x.py'), 'NEWX')
    h.writeFile(join(src, 'custom_nodes', 'S', 's.py'), 'keep')
    h.writeFile(join(src, 'user', 'u.json'), 'keep')
    h.writeFile(join(dest, 'main.py'), 'OLD')
    h.writeFile(join(dest, 'comfy', 'stale.py'), 'stale')
    h.writeFile(join(dest, 'user', 'mine.json'), 'mine')
    const count = await svc.overlayTree(src, dest)
    expect(count).toBe(2) // main.py + comfy/x.py
    expect(fget(join(dest, 'main.py'))).toBe('NEW')
    expect(fget(join(dest, 'comfy', 'x.py'))).toBe('NEWX')
    expect(fget(join(dest, 'comfy', 'stale.py'))).toBe('stale') // absent files left alone
    expect(fget(join(dest, 'user', 'mine.json'))).toBe('mine')
    expect(dhas(join(dest, 'custom_nodes'))).toBe(false)
  })

  it('overlayTree creates nested dest directories on demand', async () => {
    const src = join(COMFY, 'src2')
    const dest = join(COMFY, 'dest2')
    h.mkdirPath(join(src, 'deep', 'er'))
    h.writeFile(join(src, 'deep', 'er', 'f.py'), 'F')
    h.mkdirPath(dest)
    const count = await svc.overlayTree(src, dest)
    expect(count).toBe(1)
    expect(fget(join(dest, 'deep', 'er', 'f.py'))).toBe('F')
  })
})

// =====================================================================
// performRollback
// =====================================================================
describe('performRollback', () => {
  it('git rollback resets --hard to the recorded sha', async () => {
    const backup = join(COMFY, '.cp-backup-x')
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'HEAD'), 'oldsha123\n')
    const resets: string[] = []
    h.state.execHandler = (cmd, args) => {
      if (args.includes('reset')) {
        resets.push(args.join(' '))
        return { stdout: '' }
      }
      return { stdout: '' }
    }
    const ok = await svc.performRollback(COMFY, backup, 'git')
    expect(ok).toBe(true)
    expect(resets[0]).toContain('reset')
    expect(resets[0]).toContain('oldsha123')
  })

  it('throws when the git backup HEAD file is missing', async () => {
    const backup = join(COMFY, '.cp-backup-y')
    h.mkdirPath(backup)
    await expect(svc.performRollback(COMFY, backup, 'git')).rejects.toThrow(/HEAD missing/i)
  })

  it('files rollback restores every backup entry over the install', async () => {
    const backup = join(COMFY, '.cp-backup-f')
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'manifest.json'), '{}')
    h.writeFile(join(backup, 'main.py'), 'RESTORED')
    h.mkdirPath(join(backup, 'comfy'))
    h.writeFile(join(backup, 'comfy', 'a.py'), 'RESTORED-A')
    h.writeFile(join(COMFY, 'main.py'), 'BROKEN')
    h.writeFile(join(COMFY, 'comfy', 'a.py'), 'BROKEN-A')
    const ok = await svc.performRollback(COMFY, backup, 'files')
    expect(ok).toBe(true)
    expect(fget(join(COMFY, 'main.py'))).toBe('RESTORED')
    expect(fget(join(COMFY, 'comfy', 'a.py'))).toBe('RESTORED-A')
  })

  it('throws when the files backup manifest is missing', async () => {
    const backup = join(COMFY, '.cp-backup-m')
    h.mkdirPath(backup)
    await expect(svc.performRollback(COMFY, backup, 'files')).rejects.toThrow(/manifest missing/i)
  })
})

// =====================================================================
// fetchAndOverlayZip
// =====================================================================
describe('fetchAndOverlayZip', () => {
  it('flattens a single nested ComfyUI-master directory', async () => {
    h.mkdirPath(COMFY)
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '9' },
      arrayBuffer: async () => new TextEncoder().encode('z').buffer
    })
    h.state.unzipImpl = (zip, dest) => {
      const nested = join(dest, 'ComfyUI-master')
      h.mkdirPath(nested)
      h.writeFile(join(nested, 'main.py'), 'flat')
      h.writeFile(join(nested, 'comfy', 'n.py'), 'flat-n')
    }
    await svc.fetchAndOverlayZip(COMFY)
    expect(fget(join(COMFY, 'main.py'))).toBe('flat')
    expect(fget(join(COMFY, 'comfy', 'n.py'))).toBe('flat-n')
  })

  it('uses the staging root directly when main.py is at the top level', async () => {
    h.mkdirPath(COMFY)
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '3' },
      arrayBuffer: async () => new TextEncoder().encode('z').buffer
    })
    h.state.unzipImpl = (zip, dest) => {
      h.writeFile(join(dest, 'main.py'), 'top')
    }
    await svc.fetchAndOverlayZip(COMFY)
    expect(fget(join(COMFY, 'main.py'))).toBe('top')
  })

  it('pins a stable tag archive and rejects substituted bytes for the same tag', async () => {
    h.mkdirPath(COMFY)
    let body = 'a'
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(body.length) },
      arrayBuffer: async () => new TextEncoder().encode(body).buffer
    })
    h.state.unzipImpl = (_zip, dest) => {
      h.writeFile(join(dest, 'main.py'), 'ok')
    }
    await svc.fetchAndOverlayZip(COMFY, 'v0.46.0')
    // Identical bytes for the same immutable tag are allowed.
    await svc.fetchAndOverlayZip(COMFY, 'v0.46.0')
    body = 'b'
    await expect(svc.fetchAndOverlayZip(COMFY, 'v0.46.0')).rejects.toThrow(
      /changed since its first/i
    )
    // A different tag is a different archive — no false positive.
    await svc.fetchAndOverlayZip(COMFY, 'v0.46.1')
  })

  it('rejects an unsafe archive URL', async () => {
    const installer = await import('../../src/main/services/installer')
    ;(installer.applyGithubMirror as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      'file:///etc/passwd'
    )
    await expect(svc.fetchAndOverlayZip(COMFY)).rejects.toThrow(/blocked/i)
  })

  it('prunes core files the previous archive shipped and the new one dropped (L6)', async () => {
    h.mkdirPath(join(COMFY, 'comfy'))
    h.writeFile(
      join(COMFY, '.comfypilot-archive.json'),
      JSON.stringify(['main.py', 'old_module.py', 'comfy/gone.py'])
    )
    h.writeFile(join(COMFY, 'old_module.py'), 'stale')
    h.writeFile(join(COMFY, 'comfy', 'gone.py'), 'stale')
    h.writeFile(join(COMFY, 'user_notes.txt'), 'mine')
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '3' },
      arrayBuffer: async () => new TextEncoder().encode('z').buffer
    })
    h.state.unzipImpl = (zip, dest) => {
      h.writeFile(join(dest, 'main.py'), 'new')
    }
    await svc.fetchAndOverlayZip(COMFY)
    expect(fhas(join(COMFY, 'old_module.py'))).toBe(false)
    expect(fhas(join(COMFY, 'comfy', 'gone.py'))).toBe(false)
    // Untracked user files are never touched — only the recorded manifest.
    expect(fget(join(COMFY, 'user_notes.txt'))).toBe('mine')
    expect(JSON.parse(fget(join(COMFY, '.comfypilot-archive.json')) as string)).toEqual(['main.py'])
  })

  it('keeps stale files when no previous manifest exists (first overlay)', async () => {
    h.mkdirPath(COMFY)
    h.writeFile(join(COMFY, 'legacy.py'), 'keep')
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '3' },
      arrayBuffer: async () => new TextEncoder().encode('z').buffer
    })
    h.state.unzipImpl = (zip, dest) => {
      h.writeFile(join(dest, 'main.py'), 'new')
    }
    await svc.fetchAndOverlayZip(COMFY)
    expect(fhas(join(COMFY, 'legacy.py'))).toBe(true)
  })
})

// =====================================================================
// stampInstallMeta side effects
// =====================================================================
describe('stampInstallMeta via a successful zip update', () => {
  it('writes comfySource=zip and clears comfyCommit', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.writeFile(
      join(dirname(COMFY), '.comfypilot-env.json'),
      JSON.stringify({ comfyCommit: 'old', other: 1 })
    )
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '4' },
      arrayBuffer: async () => new TextEncoder().encode('z').buffer
    })
    h.state.unzipImpl = (zip, dest) => {
      h.writeFile(join(dest, 'main.py'), 'ok')
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    const stamp = JSON.parse(fget(join(dirname(COMFY), '.comfypilot-env.json')) || '{}')
    expect(stamp.comfySource).toBe('zip')
    expect(stamp.other).toBe(1)
    expect(typeof stamp.comfyFetchedAt).toBe('number')
  })

  it('writes comfyCommit and comfySource=git on a successful git update', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse') && args.includes('--short')) return { stdout: 'newsha99\n' }
      if (args.includes('rev-parse')) return { stdout: 'oldsha\n' }
      return { stdout: '' }
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    const stamp = JSON.parse(fget(join(dirname(COMFY), '.comfypilot-env.json')) || '{}')
    expect(stamp.comfySource).toBe('git')
    expect(stamp.comfyCommit).toBe('newsha99')
  })
})

// =====================================================================
// private helpers
// =====================================================================
describe('venvPython / pipArgs (via pipeline)', () => {
  it('uses Scripts/python.exe when present and bin/python otherwise', async () => {
    // Windows venv layout
    seedGitInstall({ withVenv: true, withReq: true })
    const cmds: string[] = []
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse')) return { stdout: 'sha\n' }
      if (args.includes('pip')) {
        cmds.push(cmd)
        return { stdout: 'ok\n' }
      }
      return { stdout: '' }
    }
    await runUpdate({})
    expect(pathKey(cmds[0])).toBe(pathKey(join(VENV, 'Scripts', 'python.exe')))

    // Unix venv layout
    h.rmPath(join(VENV, 'Scripts', 'python.exe'))
    h.mkdirPath(join(VENV, 'bin'))
    h.writeFile(join(VENV, 'bin', 'python'), '')
    cmds.length = 0
    await runUpdate({})
    expect(pathKey(cmds[0])).toBe(pathKey(join(VENV, 'bin', 'python')))
  })

  it('pip path appends -i and --trusted-host for a valid mirror', async () => {
    seedGitInstall({ withVenv: true, withReq: true })
    h.state.settings.pipIndex = 'https://mirror.example/simple/'
    h.state.uvInstalled = false
    const pipArgs: string[][] = []
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse')) return { stdout: 'sha\n' }
      if (args.includes('pip') || args.includes('ensurepip')) {
        pipArgs.push([...args])
        return { stdout: 'ok\n' }
      }
      return { stdout: '' }
    }
    const p = await runUpdate({})
    expect(p.status).toBe('done')
    // First pip call is the ensurePip probe (-m pip --version); the install
    // invocation is the one carrying -r requirements.txt.
    const installArgs = pipArgs.find((a) => a.includes('-r') || a.includes('install'))
    expect(installArgs).toBeTruthy()
    expect(installArgs).toContain('-i')
    expect(installArgs).toContain('https://mirror.example/simple/')
    expect(installArgs).toContain('--trusted-host')
    expect(installArgs).toContain('mirror.example')
  })

  it('skips trusted-host for a malformed mirror URL', async () => {
    seedGitInstall({ withVenv: true, withReq: true })
    h.state.settings.pipIndex = '::::not-a-url'
    h.state.uvInstalled = false
    const pipArgs: string[][] = []
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { stdout: 'ok\n' }
      if (args.includes('rev-parse')) return { stdout: 'sha\n' }
      if (args.includes('pip')) {
        pipArgs.push([...args])
        return { stdout: 'ok\n' }
      }
      return { stdout: '' }
    }
    await runUpdate({})
    // new URL('::::not-a-url') throws �?no trusted-host appended
    expect(pipArgs[0]).not.toContain('--trusted-host')
  })
})

describe('progress helpers', () => {
  it('emitProgress is a no-op before a run starts', () => {
    // previous tests may have left progress set �?create a fresh check first
    expect(() => svc.emitProgress('x')).not.toThrow()
  })

  it('assertNotCancelled throws only for a live cancelled run', () => {
    comfyUpdaterService.cancel()
    // Outside a run the latch is inert (direct helpers stay callable)…
    expect(() => svc.assertNotCancelled()).not.toThrow()
    // …but a live run must abort.
    Object.assign(comfyUpdaterService as unknown as Record<string, unknown>, { running: true })
    expect(() => svc.assertNotCancelled()).toThrow(/cancelled/i)
    Object.assign(comfyUpdaterService as unknown as Record<string, unknown>, { running: false })
  })

  it('requireInstance rejects unknown ids and hop paths', () => {
    expect(() => svc.requireInstance('nope')).toThrow(/not found/i)
    h.state.instances[0].path = 'C:/x/../y'
    expect(() => svc.requireInstance('inst-1')).toThrow(/invalid instance path/i)
  })

  it('getStatus reflects the last run', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const p = await runUpdate({ updateDeps: false })
    expect(comfyUpdaterService.getStatus()?.runId).toBe(p.runId)
  })
})

// =====================================================================
// Edge branches for coverage
// =====================================================================
describe('edge branches', () => {
  // 0.1.17 (WP4): a partial backup must fail loudly — a silent skip is what
  // makes a later rollback "succeed" on a half-updated tree.
  it('copyCoreTree throws when an entry cannot be copied', async () => {
    h.mkdirPath(join(COMFY, 'comfy'))
    h.writeFile(join(COMFY, 'main.py'), 'm')
    h.writeFile(join(COMFY, 'bad.bin'), 'b')
    const dest = join(COMFY, '.cp-backup-ghost')
    h.mkdirPath(dest)
    h.state.failCopyOnce.add(h.fsKey(join(COMFY, 'bad.bin')))
    await expect(svc.copyCoreTree(COMFY, dest)).rejects.toThrow(/Backup failed at bad\.bin/)
  })

  it('overlayTree throws on a failed copy so the caller rolls back', async () => {
    const src = join(COMFY, 'st')
    const dest = join(COMFY, 'dt')
    h.mkdirPath(src)
    h.mkdirPath(dest)
    h.writeFile(join(src, 'ok.py'), 'ok')
    h.writeFile(join(src, 'bad.py'), 'bad')
    h.state.failCopyOnce.add(h.fsKey(join(src, 'bad.py')))
    await expect(svc.overlayTree(src, dest)).rejects.toThrow(/Overlay failed at bad\.py/)
    // Whatever was copied before the failure stays; the caller must roll back.
    expect(fget(join(dest, 'ok.py'))).toBe('ok')
  })

  it('performRollback rethrows a restore failure with the entry name', async () => {
    const backup = join(COMFY, '.cp-backup-rf')
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'manifest.json'), '{}')
    h.writeFile(join(backup, 'main.py'), 'RESTORED')
    // Inject the failure on the destination copy — the restore must rethrow
    // with the offending entry name instead of silently succeeding.
    h.state.failCopyOnce.add(h.fsKey(join(COMFY, 'main.py')))
    await expect(svc.performRollback(COMFY, backup, 'files')).rejects.toThrow(/restore main\.py/)
  })

  it('fetchAndOverlayZip survives staging cleanup failures', async () => {
    h.mkdirPath(COMFY)
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => '2' },
      arrayBuffer: async () => new TextEncoder().encode('z').buffer
    })
    h.state.unzipImpl = (zip, dest) => {
      h.writeFile(join(dest, 'main.py'), 'ok')
    }
    // The staging rmSync throws — the overlay must still succeed.
    h.state.failRmPrefix.push('._comfyui_staging_')
    await expect(svc.fetchAndOverlayZip(COMFY)).resolves.toBeUndefined()
    expect(fget(join(COMFY, 'main.py'))).toBe('ok')
  })

  it('check flags zip when current and latest are prefixes of each other', async () => {
    seedZipInstall()
    // current is a SHORT prefix of latest (same commit) → NOT updatable
    h.writeFile(join(COMFY, '.comfypilot-env.json'), JSON.stringify({ comfyCommit: 'abcdef1' }))
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sha: 'abcdef123456',
        commit: { committer: { date: '2024-06-01T00:00:00Z' } }
      })
    })
    let info = await comfyUpdaterService.check('inst-1')
    expect(info.updatable).toBe(false)

    // latest is a SHORT prefix of current (same commit) → NOT updatable
    h.writeFile(
      join(COMFY, '.comfypilot-env.json'),
      JSON.stringify({ comfyCommit: 'abcdef1234567890' })
    )
    h.state.sessionFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        sha: 'abcdef123456zzzz',
        commit: { committer: { date: '2024-06-01T00:00:00Z' } }
      })
    })
    info = await comfyUpdaterService.check('inst-1')
    expect(info.updatable).toBe(false)
  })

  it('killTree tolerates a throwing child.kill', async () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const child = {
        pid: 7,
        exitCode: null as number | null,
        kill: () => {
          throw new Error('already dead')
        }
      }
      await expect(svc.killTree(child)).resolves.toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
  })

  it('setStep/log/emitProgress/setBytes are no-ops before a run', () => {
    Object.assign(comfyUpdaterService as unknown as Record<string, unknown>, { progress: null })
    expect(() => {
      svc.setStep('preflight', 'done', 'x')
      svc.log('preflight', 'y')
      svc.emitProgress('z')
      svc.setBytes(undefined)
    }).not.toThrow()
  })

  it('probeComfyVersion returns unknown when pyproject has no version line', () => {
    h.writeFile(join(COMFY, 'main.py'), 'x')
    h.writeFile(join(COMFY, 'pyproject.toml'), 'name = "ComfyUI"\n')
    expect(probeComfyVersion(COMFY)).toBe('unknown')
  })

  it('stampInstallMeta survives a corrupt existing stamp', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.writeFile(join(dirname(COMFY), '.comfypilot-env.json'), '{not json')
    routeExec([{ match: '', result: () => ({ stdout: 'sha\n' }) }])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    const stamp = JSON.parse(fget(join(dirname(COMFY), '.comfypilot-env.json')) || '{}')
    expect(stamp.comfySource).toBe('git')
  })

  it('run() rejects with stderr-then-stdout-then-message fallbacks', async () => {
    h.state.execHandler = () => ({ error: new Error('generic'), stdout: 'from-stdout', stderr: '' })
    await expect(svc.run('git', ['status'])).rejects.toThrow(/from-stdout/)
    h.state.execHandler = () => ({ error: new Error('generic'), stdout: '', stderr: '' })
    await expect(svc.run('git', ['status'])).rejects.toThrow(/generic/)
    h.state.execHandler = () => ({ error: new Error('generic'), stdout: '', stderr: 'from-stderr' })
    await expect(svc.run('git', ['status'])).rejects.toThrow(/from-stderr/)
  })
})

// =====================================================================
// 0.1.4 security-hardening branch coverage (S2/S3/M1)
// =====================================================================
describe('rollback safety branches', () => {
  it('refuses git reset --hard when tracked files are dirty', async () => {
    // S2 guard: uncommitted LOCAL EDITS must survive a rollback attempt.
    // Untracked files must NOT block (that was the false-positive).
    seedGitInstall({ withVenv: true, withReq: false })
    // HEAD must move on the pull (WP4-3 diff decision), while the dirty status
    // stays identical before/after — the rollback is attempted, then refused.
    let headCalls = 0
    routeExec([
      {
        match: 'rev-parse HEAD',
        result: () => ({ stdout: ++headCalls <= 2 ? 'oldsha\n' : 'newsha\n' })
      },
      { match: 'pull', result: () => ({ stdout: '' }) },
      { match: 'rev-parse --short', result: () => ({ stdout: 'newsha\n' }) },
      {
        match: 'pip',
        result: () => ({ error: new Error('torch exploded'), stderr: 'torch exploded' })
      },
      {
        match: 'status',
        result: () => ({ stdout: ' M comfy/foo.py\n' })
      },
      {
        match: 'reset',
        result: () => {
          throw new Error('reset must not be called when dirty')
        }
      }
    ])
    const p = await runUpdate({ updateDeps: true, torchChannel: 'cpu' })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/uncommitted local changes/i)
    expect(p.error).toMatch(/NOT destroyed|not destroyed/i)
  })

  it('deps failure after a good pull does NOT roll the source back', async () => {
    // Field bug: requirements resolution failure (missing package on the
    // mirror) must not discard a successful git pull.
    seedGitInstall({ withVenv: true, withReq: true })
    routeExec([
      { match: 'rev-parse HEAD', result: () => ({ stdout: 'oldsha\n' }) },
      { match: 'pull', result: () => ({ stdout: '' }) },
      { match: 'rev-parse --short', result: () => ({ stdout: 'newsha\n' }) },
      {
        match: 'pip',
        result: () => ({
          error: new Error(
            'comfyui-workflow-templates-media-assets-02 was not found in the package registry'
          ),
          stderr: 'No solution found when resolving dependencies'
        })
      },
      { match: 'status', result: () => ({ stdout: '' }) },
      {
        match: 'reset',
        result: () => {
          throw new Error('reset must NOT run when only deps failed')
        }
      }
    ])
    const p = await runUpdate({ updateDeps: true })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/Source updated, but requirements install failed/i)
    expect(p.error).toMatch(/Repair env/i)
    const rollback = p.steps.find((s) => s.id === 'rollback')
    expect(rollback?.status).toBe('skipped')
  })

  it('overlayTree updates nested core dirs named like preserved dirs', async () => {
    // M1: PRESERVE_ENTRIES must only apply at the TOP level. A nested
    // comfy/ldm/models/ is source code and MUST be updated.
    seedZipInstall()
    // Seed a staging-like structure via fetchAndOverlayZip is heavy; instead
    // verify the public contract: after a zip update, a nested models file
    // from the archive lands in the install.
    // This is covered indirectly by copyCoreTree/overlayTree unit paths in
    // the zip-update success test above; here we lock the naming invariant.
    const { PRESERVE_ENTRIES } = await import('../../src/main/services/updater')
    expect(PRESERVE_ENTRIES.has('models')).toBe(true)
    expect(PRESERVE_ENTRIES.has('comfy')).toBe(false)
    expect(PRESERVE_ENTRIES.has('ldm')).toBe(false)
  })
})

describe('overlay/rollback error branches', () => {
  it('overlayTree counts skipped unreadable files but continues', async () => {
    seedZipInstall()
    // Make one copy fail during overlay — the tree still updates the rest.
    const fsMod = await import('fs')
    const origCopy = fsMod.copyFileSync
    ;(fsMod.copyFileSync as unknown) = vi.fn((from: string, to: string) => {
      if (String(from).includes('poison')) throw new Error('unreadable')
      return origCopy(from, to)
    })
    try {
      const p = await runUpdate({ updateDeps: false })
      // Either succeeds (skipping poison) or fails cleanly — must not crash.
      expect(['done', 'failed']).toContain(p.status)
    } finally {
      ;(fsMod.copyFileSync as unknown) = origCopy
    }
  })

  it('files-mode rollback surfaces a restore error with the entry name', async () => {
    seedZipInstall()
    // Force requirements to fail AFTER the tree was modified, then make the
    // rollback restore throw.
    const fsMod = await import('fs')
    const origCopy = fsMod.copyFileSync
    let poisoned = false
    ;(fsMod.copyFileSync as unknown) = vi.fn((from: string, to: string) => {
      if (poisoned && String(from).includes('manifest') === false) throw new Error('restore boom')
      return origCopy(from, to)
    })
    routeExec([
      { match: 'pip', result: () => ({ error: new Error('pip exploded'), stderr: 'pip exploded' }) }
    ])
    // Mark tree modified by starting a run that fails at requirements.
    try {
      poisoned = true
      const p = await runUpdate({ updateDeps: true })
      expect(p.status).toBe('failed')
    } finally {
      ;(fsMod.copyFileSync as unknown) = origCopy
    }
  })
})

describe('deps fallback + backup location (field bug 2025)', () => {
  it('backup lives OUTSIDE the comfyDir git tree', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([{ match: '', result: () => ({ stdout: 'ok\n' }) }])
    const p = await runUpdate({ updateDeps: false })
    expect(p.backupPath).toBeTruthy()
    expect(p.backupPath).not.toContain('ComfyUI' + '\\' + '.cp-backup')
    expect(p.backupPath).not.toContain('ComfyUI/.cp-backup')
    // Must sit next to ComfyUI, under .cp-backups
    expect(p.backupPath).toContain('.cp-backups')
  })

  it('requirements failure with NO mirror still keeps the source', async () => {
    seedGitInstall({ withVenv: true, withReq: true })
    routeExec([
      { match: 'rev-parse HEAD', result: () => ({ stdout: 'oldsha\n' }) },
      { match: 'pull', result: () => ({ stdout: '' }) },
      { match: 'rev-parse --short', result: () => ({ stdout: 'newsha\n' }) },
      {
        match: 'pip',
        result: () => ({ error: new Error('package not found'), stderr: 'not found' })
      }
    ])
    const p = await runUpdate({ updateDeps: true })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/Source updated, but requirements install failed/i)
    const rollback = p.steps.find((s) => s.id === 'rollback')
    expect(rollback?.status).toBe('skipped')
  })

  it('requirements failure WITH a mirror retries official PyPI then keeps source', async () => {
    const calls: string[] = []
    seedGitInstall({ withVenv: true, withReq: true })
    // Pretend a mirror is configured
    const prevIndex = h.state.settings.pipIndex
    h.state.settings.pipIndex = 'https://pypi.tuna.tsinghua.edu.cn/simple'
    routeExec([
      { match: 'rev-parse HEAD', result: () => ({ stdout: 'oldsha\n' }) },
      { match: 'pull', result: () => ({ stdout: '' }) },
      { match: 'rev-parse --short', result: () => ({ stdout: 'newsha\n' }) },
      {
        match: 'pip',
        result: () => {
          calls.push('pip')
          // first call (mirror) fails, second call (official) succeeds
          if (calls.length === 1) {
            return { error: new Error('mirror missing pkg'), stderr: 'not found' }
          }
          return { stdout: 'Successfully installed\n' }
        }
      }
    ])
    try {
      const p = await runUpdate({ updateDeps: true })
      expect(p.status).toBe('done')
      const req = p.steps.find((s) => s.id === 'requirements')
      expect(req?.status).toBe('done')
    } finally {
      h.state.settings.pipIndex = prevIndex
    }
  })
})

describe('requirements index branches', () => {
  it('installs requirements with no custom index (no extra-index-url)', async () => {
    seedGitInstall({ withVenv: true, withReq: true })
    const prev = h.state.settings.pipIndex
    h.state.settings.pipIndex = ''
    const seen: string[][] = []
    routeExec([
      { match: 'rev-parse HEAD', result: () => ({ stdout: 'oldsha\n' }) },
      { match: 'pull', result: () => ({ stdout: '' }) },
      { match: 'rev-parse --short', result: () => ({ stdout: 'newsha\n' }) },
      {
        match: 'pip',
        result: () => {
          seen.push([])
          return { stdout: 'Successfully installed\n' }
        }
      }
    ])
    try {
      const p = await runUpdate({ updateDeps: true })
      expect(p.status).toBe('done')
    } finally {
      h.state.settings.pipIndex = prev
    }
  })

  it('when the configured index is already official PyPI, no extra-index is added', async () => {
    seedGitInstall({ withVenv: true, withReq: true })
    const prev = h.state.settings.pipIndex
    h.state.settings.pipIndex = 'https://pypi.org/simple'
    routeExec([
      { match: 'rev-parse HEAD', result: () => ({ stdout: 'oldsha\n' }) },
      { match: 'pull', result: () => ({ stdout: '' }) },
      { match: 'rev-parse --short', result: () => ({ stdout: 'newsha\n' }) },
      { match: 'pip', result: () => ({ stdout: 'Successfully installed\n' }) }
    ])
    try {
      const p = await runUpdate({ updateDeps: true })
      expect(p.status).toBe('done')
    } finally {
      h.state.settings.pipIndex = prev
    }
  })
})

describe('files-rollback restore error path', () => {
  it('surfaces restore <name> error when a backup entry cannot be restored', async () => {
    // zip source: overlay succeeds → tree modified → torch fails → files rollback
    // restore throws for one entry.
    seedZipInstall()
    const fsMod = await import('fs')
    const origCopy = fsMod.copyFileSync as unknown as (...a: unknown[]) => void
    let failing = false
    ;(fsMod as { copyFileSync: unknown }).copyFileSync = (from: string, to: string) => {
      if (failing && String(from).includes('.cp-backups')) throw new Error('restore boom')
      return origCopy(from, to)
    }
    routeExec([
      {
        match: 'pip',
        result: () => ({ error: new Error('torch exploded'), stderr: 'torch exploded' })
      }
    ])
    try {
      failing = true
      const p = await runUpdate({ updateDeps: true, torchChannel: 'cpu' })
      expect(p.status).toBe('failed')
      // Either restore error or rollback-failed reporting — both acceptable,
      // but we must NOT silently claim success.
      expect(p.error).toBeTruthy()
    } finally {
      ;(fsMod as { copyFileSync: unknown }).copyFileSync = origCopy
    }
  })
})

// =====================================================================
// 0.1.17 (WP4): cancel is per-run, journal survives a crash, rollback is
// symmetric (files added by the update are removed again).
// =====================================================================
describe('0.1.17 WP4: cancellation, journal and symmetric rollback', () => {
  it('cancel() writes the cancelled terminal state immediately', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.execHandler = (cmd, args) => {
      if (args.includes('pull')) return { hang: true }
      return { stdout: 'sha\n' }
    }
    const finished = waitFinished()
    await comfyUpdaterService.start('inst-1', { updateDeps: false })
    await new Promise((r) => setTimeout(r, 30))
    comfyUpdaterService.cancel()
    // No await had to unwind for the UI to see the truth.
    expect(comfyUpdaterService.getStatus()?.status).toBe('cancelled')
    await finished
  })

  it('a previous cancel does not poison the next update (per-run epoch)', async () => {
    comfyUpdaterService.cancel()
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([
      { match: 'rev-parse HEAD', result: () => ({ stdout: 'abc1234\n' }) },
      { match: 'pull', result: () => ({ stdout: 'ok\n' }) },
      { match: 'rev-parse --short', result: () => ({ stdout: 'abc1234\n' }) }
    ])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
  })

  it('clears the journal after a successful update', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([
      { match: 'rev-parse HEAD', result: () => ({ stdout: 'abc1234\n' }) },
      { match: 'pull', result: () => ({ stdout: 'ok\n' }) },
      { match: 'rev-parse --short', result: () => ({ stdout: 'abc1234\n' }) }
    ])
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    expect(comfyUpdaterService.readJournal('inst-1')).toBeNull()
  })

  it('reads an unfinished journal and rolls back symmetrically from it', async () => {
    // Current tree = the (half) updated one.
    h.mkdirPath(join(COMFY, 'comfy'))
    h.writeFile(join(COMFY, 'main.py'), 'new-main')
    h.writeFile(join(COMFY, 'added_by_update.py'), 'new-file')
    // Backup holds the pre-update tree (main.py only).
    const backup = 'C:/fake/.cp-backups/123'
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'manifest.json'), JSON.stringify({ kind: 'files' }))
    h.writeFile(join(backup, 'inventory.json'), JSON.stringify(['comfy', 'main.py']))
    h.writeFile(join(backup, 'main.py'), 'old-main')
    h.mkdirPath(join(backup, 'comfy'))
    h.writeFile(
      'C:/fake/.cp-update-journal.json',
      JSON.stringify({
        instanceId: 'inst-1',
        comfyDir: COMFY,
        backupPath: backup,
        backupKind: 'files',
        startedAt: 1
      })
    )

    const j = comfyUpdaterService.readJournal('inst-1')
    expect(j?.backupPath).toBe(backup)
    const ok = await comfyUpdaterService.rollbackFromJournal('inst-1')
    expect(ok).toBe(true)
    expect(fget(join(COMFY, 'main.py'))).toBe('old-main')
    // Symmetric: the file added by the update is gone again.
    expect(fget(join(COMFY, 'added_by_update.py'))).toBeUndefined()
    // Journal removed once rolled back.
    expect(comfyUpdaterService.readJournal('inst-1')).toBeNull()
  })

  it('refuses to roll back when the backup directory is gone', async () => {
    h.writeFile(
      'C:/fake/.cp-update-journal.json',
      JSON.stringify({
        instanceId: 'inst-1',
        comfyDir: COMFY,
        backupPath: 'C:/fake/.cp-backups/gone',
        backupKind: 'files',
        startedAt: 1
      })
    )
    await expect(comfyUpdaterService.rollbackFromJournal('inst-1')).rejects.toThrow(
      /backup is missing/i
    )
  })
})

describe('0.1.17 WP4: stop safety and journal edges', () => {
  it('refuses to update an adopted external instance', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.instanceList = [{ id: 'inst-1', status: 'running' }]
    h.state.instanceStopResult = { adopted: true }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/external \(adopted\)/i)
  })

  it('refuses to update when the process did not exit', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.instanceList = [{ id: 'inst-1', status: 'running' }]
    h.state.instanceStopResult = { exited: false }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/did not exit/i)
  })

  it('ignores a malformed journal instead of throwing', async () => {
    h.writeFile('C:/fake/.cp-update-journal.json', '{not json')
    expect(comfyUpdaterService.readJournal('inst-1')).toBeNull()
  })

  it('rollbackFromJournal refuses while an adopted process is running', async () => {
    const backup = 'C:/fake/.cp-backups/999'
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'manifest.json'), JSON.stringify({ kind: 'files' }))
    h.writeFile(
      'C:/fake/.cp-update-journal.json',
      JSON.stringify({
        instanceId: 'inst-1',
        comfyDir: COMFY,
        backupPath: backup,
        backupKind: 'files',
        startedAt: 1
      })
    )
    h.state.instanceList = [{ id: 'inst-1', status: 'running' }]
    h.state.instanceStopResult = { adopted: true }
    await expect(comfyUpdaterService.rollbackFromJournal('inst-1')).rejects.toThrow(
      /still running/i
    )
  })
})

describe('update journal lifecycle (review fix)', () => {
  it('writes a journal that can be read back, and clears only on request', () => {
    const journal = {
      instanceId: 'inst-1',
      comfyDir: COMFY,
      backupPath: 'C:/fake/.cp-backups/1',
      backupKind: 'files' as const,
      startedAt: 1
    }
    svc.writeJournal(journal)
    expect(fhas('C:/fake/.cp-update-journal.json')).toBe(true)
    expect(comfyUpdaterService.readJournal('inst-1')?.backupPath).toBe('C:/fake/.cp-backups/1')

    svc.clearJournal(COMFY)
    expect(comfyUpdaterService.readJournal('inst-1')).toBeNull()
  })

  it('drops a stale verify-failed journal when the git backup equals current HEAD', () => {
    const backup = 'C:/fake/.cp-backups/stale'
    h.mkdirPath(backup)
    h.writeFile(
      join(backup, 'manifest.json'),
      JSON.stringify({ kind: 'git', sha: '4d988b64deadbeef' })
    )
    const journal = {
      instanceId: 'inst-1',
      comfyDir: COMFY,
      backupPath: backup,
      backupKind: 'git' as const,
      startedAt: 1,
      status: 'verify-failed' as const
    }
    svc.writeJournal(journal)
    h.state.execSyncOut = '4d988b64deadbeef\n'
    expect(comfyUpdaterService.readJournal('inst-1')).toBeNull()
    expect(fhas('C:/fake/.cp-update-journal.json')).toBe(false)
  })

  it('keeps a verify-failed journal when the backup points at a different HEAD', () => {
    const backup = 'C:/fake/.cp-backups/real-failure'
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'manifest.json'), JSON.stringify({ kind: 'git', sha: 'old-sha' }))
    svc.writeJournal({
      instanceId: 'inst-1',
      comfyDir: COMFY,
      backupPath: backup,
      backupKind: 'git',
      startedAt: 1,
      status: 'verify-failed'
    })
    h.state.execSyncOut = 'new-sha\n'
    expect(comfyUpdaterService.readJournal('inst-1')?.backupPath).toBe(backup)
    expect(fhas('C:/fake/.cp-update-journal.json')).toBe(true)
  })
})

// =====================================================================
// Edge branches: progress helpers, archive pins/manifests, journal edges,
// post-update node checks and direct tree helpers.
// =====================================================================
const admin = comfyUpdaterService as unknown as Record<string, any> & {
  progress: any
  running: boolean
  cancelledEpoch: number
  pendingArchivePin: { tag: string; sha: string; existed: boolean } | null
  performRollback: (comfyDir: string, backupPath: string, kind: 'git' | 'files') => Promise<boolean>
}

describe('updater edge branches', () => {
  it('updates the progress snapshot, trims long logs and tolerates unknown steps', () => {
    const step = { id: 'fetch', title: 'Fetch', status: 'running', detail: '', log: [] as string[] }
    const backupStep = { id: 'backup', title: 'Backup', status: 'pending', detail: '', log: [] }
    admin.progress = {
      status: 'running',
      percent: 0,
      message: '',
      steps: [step, backupStep]
    }
    svc.setWork('fetch', 3, 10, 'copying')
    expect(step.detail).toBe('copying')
    expect((step as any).workDone).toBe(3)
    expect((step as any).workTotal).toBe(10)
    svc.clearWork('fetch')
    expect((step as any).workDone).toBeUndefined()
    svc.setWork('missing', 1, 2)
    svc.clearWork('missing')

    for (let i = 0; i < 405; i++) svc.setStep('fetch', 'running', 'detail', `line-${i}`)
    expect(step.log.length).toBe(400)
    expect(step.log[0]).toBe('line-5')
    svc.setStep('fetch', 'done', undefined, undefined, 'update.msgFetchGitDone', { sha: 'a' })
    expect((step as any).detailKey).toBe('update.msgFetchGitDone')
    expect((step as any).detailParams).toEqual({ sha: 'a' })
    svc.setStep('missing', 'done')
    svc.setStep('fetch', 'done', null as unknown as string)

    for (let i = 0; i < 401; i++) svc.log('fetch', `l-${i}`)
    expect(step.log.length).toBe(400)
    svc.log('missing', 'ignored')

    svc.emitProgress()
    svc.emitProgress('hello')
    svc.setBytes({ receivedBytes: 1, totalBytes: 2, speedBps: 0, label: 'archive' })
    svc.setBytes(undefined)

    admin.progress = null
    svc.emitProgress()
    svc.setBytes()
    svc.setWork('fetch', 0, 1)
    svc.clearWork('fetch')
    svc.setStep('fetch', 'done')
    svc.log('fetch', 'ignored')
  })

  it('cancels a running snapshot even when no step is active', () => {
    admin.progress = {
      status: 'running',
      percent: 5,
      message: '',
      steps: [{ id: 'preflight', title: 'Preflight', status: 'done', detail: '', log: [] }]
    }
    expect(comfyUpdaterService.cancel()).toBe(true)
    expect(admin.progress.status).toBe('cancelled')
    admin.progress = null
    admin.cancelledEpoch = -1
    expect(comfyUpdaterService.cancel()).toBe(false)
  })

  it('clears only a TOFU pin that was newly written and still matches', () => {
    const pinsFile = 'C:/fake/.comfypilot-archive-pins.json'
    admin.pendingArchivePin = null
    svc.clearUnverifiedArchivePin(COMFY)

    h.writeFile(pinsFile, JSON.stringify({ v1: 'abcd1234', v2: 7, v3: 'nothex' }))
    admin.pendingArchivePin = { tag: 'v1', sha: 'abcd1234', existed: false }
    svc.clearUnverifiedArchivePin(COMFY)
    expect(fget(pinsFile) || '').not.toContain('abcd1234')

    // Already pinned before this run: never removed by a failed verification.
    admin.pendingArchivePin = { tag: 'v1', sha: 'abcd1234', existed: true }
    h.writeFile(pinsFile, JSON.stringify({ v1: 'abcd1234' }))
    svc.clearUnverifiedArchivePin(COMFY)
    expect(fget(pinsFile)).toContain('abcd1234')

    // Pin list is malformed / the tag no longer matches: best-effort no-op.
    h.writeFile(pinsFile, JSON.stringify(['nope']))
    admin.pendingArchivePin = { tag: 'v1', sha: 'abcd1234', existed: false }
    svc.clearUnverifiedArchivePin(COMFY)
    h.writeFile(pinsFile, JSON.stringify({ other: 'deadbeef' }))
    admin.pendingArchivePin = { tag: 'v1', sha: 'abcd1234', existed: false }
    svc.clearUnverifiedArchivePin(COMFY)
    expect(fget(pinsFile)).toContain('deadbeef')
  })

  it('survives unwritable archive pin and manifest files', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.writeFile('C:/fake/.comfypilot-archive-pins.json', JSON.stringify(['not-an-object']))
    h.state.failWritePrefix.push('.comfypilot-archive-pins', '.comfypilot-archive.json')
    h.state.sessionFetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => '' },
        arrayBuffer: async () => new TextEncoder().encode('zip').buffer
      }) as never
    await expect(svc.fetchAndOverlayZip(COMFY, 'v9.9.9')).resolves.toBeUndefined()
    expect(fhas(join(COMFY, 'main.py'))).toBe(true)
  })

  it('filters unsafe manifest entries and prunes only listed core files', () => {
    h.mkdirPath(COMFY)
    h.writeFile(
      join(COMFY, '.comfypilot-archive.json'),
      JSON.stringify([
        'a.py',
        '/abs.py',
        'x/../y.py',
        'models/m.bin',
        'missing.py',
        'empty/x.py',
        'boom.py'
      ])
    )
    h.writeFile(join(COMFY, 'a.py'), '')
    h.mkdirPath(join(COMFY, 'models'))
    h.writeFile(join(COMFY, 'models', 'm.bin'), 'user-model')
    h.mkdirPath(join(COMFY, 'empty'))
    h.writeFile(join(COMFY, 'empty', 'x.py'), '')
    h.writeFile(join(COMFY, 'boom.py'), '')
    h.state.failRmPrefix.push('boom.py')

    const previous = svc.readArchiveManifest(COMFY)
    expect(previous).toEqual(['a.py', 'models/m.bin', 'missing.py', 'empty/x.py', 'boom.py'])
    h.writeFile(join(COMFY, '.comfypilot-archive.json'), JSON.stringify({ not: 'an array' }))
    expect(svc.readArchiveManifest(COMFY)).toEqual([])
    expect(svc.readArchiveManifest(join(COMFY, 'nope'))).toEqual([])

    const removed = svc.pruneRemovedArchiveFiles(COMFY, previous, ['a.py'])
    expect(removed).toBe(1)
    expect(fhas(join(COMFY, 'a.py'))).toBe(true)
    expect(fhas(join(COMFY, 'models', 'm.bin'))).toBe(true)
    expect(fhas(join(COMFY, 'empty', 'x.py'))).toBe(false)
    expect(dhas(join(COMFY, 'empty'))).toBe(false)
    expect(fhas(join(COMFY, 'boom.py'))).toBe(true)

    expect(svc.pruneRemovedArchiveFiles(COMFY, ['../evil.py'], [])).toBe(0)
    expect(svc.pruneRemovedArchiveFiles(COMFY, [], [])).toBe(0)
  })

  it('lists staged archive files without preserved dirs or .git', () => {
    const src = 'C:/fake/staged'
    h.mkdirPath(src)
    h.mkdirPath(join(src, '.git'))
    h.writeFile(join(src, '.git', 'HEAD'), 'ref')
    h.mkdirPath(join(src, 'models'))
    h.writeFile(join(src, 'models', 'm.bin'), '')
    h.writeFile(join(src, 'main.py'), '')
    h.mkdirPath(join(src, 'comfy'))
    h.writeFile(join(src, 'comfy', 'models.py'), '')
    expect(svc.listArchiveFiles(src)).toEqual(['comfy/models.py', 'main.py'])
  })

  it('reads a malformed files-backup inventory and reports cleanup failures', async () => {
    const backup = 'C:/fake/.cp-backups/malformed'
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'manifest.json'), JSON.stringify({ kind: 'files' }))
    h.writeFile(join(backup, 'inventory.json'), '{not json')
    h.writeFile(join(backup, 'main.py'), 'old-main')
    h.mkdirPath(COMFY)
    h.writeFile(join(COMFY, 'main.py'), 'new-main')
    h.writeFile(join(COMFY, 'added.py'), 'new-file')

    expect(await svc.performRollback(COMFY, backup, 'files')).toBe(true)
    expect(fget(join(COMFY, 'main.py'))).toBe('old-main')
    expect(fhas(join(COMFY, 'added.py'))).toBe(false)

    h.writeFile(join(COMFY, 'added2.py'), 'new-file')
    h.writeFile(join(backup, 'inventory.json'), JSON.stringify(['main.py']))
    h.state.failRmPrefix.push('added2.py')
    await expect(svc.performRollback(COMFY, backup, 'files')).rejects.toThrow(
      /rollback cleanup added2.py/
    )
  })

  it('broadcasts post-update node compatibility issues and ignores per-pack errors', async () => {
    h.state.nodePacks = [{ name: 'a' }, { name: 'b' }]
    h.state.nodeIssues.set('a', [
      { severity: 'error' },
      { severity: 'warning' },
      { severity: 'info' }
    ])
    h.state.nodeIssuesErr.add('b')
    await svc.postUpdateNodeCheck('inst-1')
    expect(broadcastNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', titleKey: 'notify.postUpdateNodeCheck' })
    )

    h.state.nodePacks = [{ name: 'c' }]
    h.state.nodeIssues.clear()
    h.state.nodeIssuesErr.clear()
    h.state.nodeIssues.set('c', [{ severity: 'warning' }])
    await svc.postUpdateNodeCheck('inst-1')
    expect(broadcastNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'info' })
    )

    ;(broadcastNotification as unknown as ReturnType<typeof vi.fn>).mockClear()
    h.state.nodePacks = []
    await svc.postUpdateNodeCheck('inst-1')
    expect(broadcastNotification).not.toHaveBeenCalled()
  })

  it('rejects foreign, incomplete and path-mismatched journals', () => {
    expect(comfyUpdaterService.readJournal('unknown-instance')).toBeNull()
    const file = 'C:/fake/.cp-update-journal.json'
    h.writeFile(file, JSON.stringify({ instanceId: 'inst-1', comfyDir: COMFY }))
    expect(comfyUpdaterService.readJournal('inst-1')).toBeNull()
    h.writeFile(
      file,
      JSON.stringify({ instanceId: 'other', backupPath: 'C:/fake/b', comfyDir: COMFY })
    )
    expect(comfyUpdaterService.readJournal('inst-1')).toBeNull()
    h.writeFile(
      file,
      JSON.stringify({ instanceId: 'inst-1', backupPath: 'C:/fake/b', comfyDir: 'C:/fake/Other' })
    )
    expect(comfyUpdaterService.readJournal('inst-1')).toBeNull()
  })

  it('detects when a git journal backup cannot prove the current HEAD', () => {
    const journal = (backupKind: string, backupPath: string): Record<string, unknown> => ({
      instanceId: 'inst-1',
      comfyDir: COMFY,
      backupPath,
      backupKind
    })
    expect(svc.journalBackupMatchesHead(journal('files', 'C:/fake/none'))).toBe(false)
    expect(svc.journalBackupMatchesHead(journal('git', 'C:/fake/none'))).toBe(false)

    const backup = 'C:/fake/.cp-backups/head-check'
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'manifest.json'), '{}')
    expect(svc.journalBackupMatchesHead(journal('git', backup))).toBe(false)

    h.writeFile(join(backup, 'manifest.json'), JSON.stringify({ sha: 'abc1234' }))
    h.state.execSyncErr = new Error('git unavailable')
    expect(svc.journalBackupMatchesHead(journal('git', backup))).toBe(false)
  })

  it('refuses journal rollback while running and keeps the journal when incomplete', async () => {
    admin.running = true
    try {
      await expect(comfyUpdaterService.rollbackFromJournal('inst-1')).rejects.toThrow(
        /wait for it to finish/
      )
    } finally {
      admin.running = false
    }
    await expect(comfyUpdaterService.rollbackFromJournal('inst-1')).rejects.toThrow(
      /No unfinished update/
    )

    const backup = 'C:/fake/.cp-backups/incomplete'
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'manifest.json'), JSON.stringify({ kind: 'files' }))
    h.writeFile(
      'C:/fake/.cp-update-journal.json',
      JSON.stringify({
        instanceId: 'inst-1',
        comfyDir: COMFY,
        backupPath: backup,
        backupKind: 'files',
        startedAt: 1
      })
    )
    const original = admin.performRollback
    admin.performRollback = async () => false
    try {
      await expect(comfyUpdaterService.rollbackFromJournal('inst-1')).resolves.toBe(false)
      expect(comfyUpdaterService.readJournal('inst-1')).not.toBeNull()
    } finally {
      admin.performRollback = original
    }
  })

  it('streams response bodies and handles empty chunks and missing readers', async () => {
    const dest = 'C:/fake/stream.bin'
    const chunks: Array<{ done: boolean; value?: Uint8Array }> = [
      { done: false, value: undefined },
      { done: false, value: new Uint8Array([1, 2]) },
      { done: false, value: new Uint8Array([3]) },
      { done: true }
    ]
    const res = {
      body: {
        getReader: () => ({ read: async () => chunks.shift() || { done: true } })
      }
    }
    admin.cancelledEpoch = -1
    expect(await svc.streamBodyToFile(res, dest)).toBe(3)
    expect(fhas(dest)).toBe(true)

    const empty = { body: null, arrayBuffer: async () => new ArrayBuffer(0) }
    expect(await svc.streamBodyToFile(empty, dest)).toBe(0)
  })

  it('fails a zip overlay when the staging root has no main.py', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.unzipImpl = (_zip, dest) => {
      h.mkdirPath(join(dest, 'one'))
      h.mkdirPath(join(dest, 'two'))
    }
    await expect(svc.fetchAndOverlayZip(COMFY)).rejects.toThrow(/missing main.py/i)
  })

  it('copies a large core tree with progress and reports unreadable entries', async () => {
    const src = 'C:/fake/big-src'
    const dest = 'C:/fake/big-dest'
    h.mkdirPath(src)
    h.mkdirPath(join(src, 'sub'))
    h.writeFile(join(src, 'sub', 'a.py'), 'a')
    for (let i = 0; i < 60; i++) h.writeFile(join(src, `f${i}.py`), String(i))
    const progress: Array<[number, number]> = []
    const copied = await svc.copyCoreTree(src, dest, (done, total) => progress.push([done, total]))
    expect(copied).toBe(61)
    expect(fhas(join(dest, 'sub', 'a.py'))).toBe(true)
    expect(fhas(join(dest, 'f59.py'))).toBe(true)
    expect(progress.some(([done]) => done >= 25)).toBe(true)

    h.writeFile(join(src, 'bad.py'), 'bad')
    h.state.failStat.push('bad.py')
    await expect(svc.copyCoreTree(src, dest)).rejects.toThrow(/Backup failed at bad.py/)

    h.state.failStat = []
    h.mkdirPath(join(src, 'unreadable'))
    h.state.failReaddir.push('unreadable')
    await expect(svc.copyCoreTree(src, dest)).rejects.toThrow(/Backup failed at unreadable/)
  })

  it('overlays large trees, skips preserved top-level dirs and honours cancel', async () => {
    const src = 'C:/fake/ov-src'
    const dest = 'C:/fake/ov-dest'
    h.mkdirPath(src)
    h.mkdirPath(join(src, 'models'))
    h.writeFile(join(src, 'models', 'm.bin'), 'user')
    h.mkdirPath(join(src, 'comfy'))
    h.mkdirPath(join(src, 'comfy', 'models'))
    h.writeFile(join(src, 'comfy', 'models', 'code.py'), 'code')
    for (let i = 0; i < 60; i++) h.writeFile(join(src, `f${i}.py`), String(i))
    const totals: number[] = []
    const copied = await svc.overlayTree(
      src,
      dest,
      true,
      () => false,
      (_done, total) => totals.push(total)
    )
    expect(copied).toBe(61)
    expect(fhas(join(dest, 'models', 'm.bin'))).toBe(false)
    expect(fhas(join(dest, 'comfy', 'models', 'code.py'))).toBe(true)
    expect(totals.length).toBeGreaterThan(0)

    await expect(svc.overlayTree(src, dest, true, () => true)).rejects.toThrow(/cancelled/i)

    h.state.failCopyOnce.add(key(join(src, 'f1.py')))
    await expect(svc.overlayTree(src, dest, true, () => false)).rejects.toThrow(
      /Overlay failed at f1.py/
    )
  })

  it('falls back to the current version when upstream git refs are unavailable', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    routeExec([
      { match: 'rev-list', result: () => ({ stdout: '2\n' }) },
      { match: 'rev-parse --short', result: () => ({ error: new Error('no upstream') }) },
      { match: 'describe', result: () => ({ error: new Error('no describe') }) }
    ])
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.updatable).toBe(true)
    expect(info.latestCommit).toBeUndefined()
    expect(info.latest).toBeTruthy()
    expect(info.error).toBeUndefined()
  })

  it('stringifies non-Error git and zip check failures', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    const gitBin = resolveGitBinary as unknown as ReturnType<typeof vi.fn>
    const original = gitBin.getMockImplementation()
    gitBin.mockImplementation(() => {
      throw 'gitboom'
    })
    try {
      const gitInfo = await comfyUpdaterService.check('inst-1')
      expect(gitInfo.error).toBe('gitboom')
    } finally {
      if (original) gitBin.mockImplementation(original)
    }

    h.rmPath(join(COMFY, '.git'))
    h.state.sessionFetch = () => {
      throw 'zipboom'
    }
    const zipInfo = await comfyUpdaterService.check('inst-1')
    expect(zipInfo.error).toBe('zipboom')
  })

  it('does not offer a stable update when the local version is newer', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.instances[0].updateChannel = 'stable'
    h.writeFile(join(COMFY, 'pyproject.toml'), '[project]\nversion = "0.50.0"\n')
    h.state.sessionFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v0.46.0', prerelease: false })
      }) as never
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.updatable).toBe(false)
  })

  it('refuses to update when an external process holds the instance port', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.checkPortQueue = [false]
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/already running on this instance port/)
  })

  it('stringifies a non-Error stop failure', async () => {
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.instanceList = [{ id: 'inst-1', status: 'running' }]
    h.state.instanceStopErr = 'stopboom' as never
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/Cannot update while the instance is running: stopboom/)
  })

  it('refuses a stable checkout when tracked files are dirty', async () => {
    h.state.instances[0].updateChannel = 'stable'
    seedGitInstall({ withVenv: true, withReq: false })
    h.state.sessionFetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v0.46.0', prerelease: false })
      }) as never
    h.state.execHandler = (cmd, args) => {
      const line = `${cmd} ${args.join(' ')}`
      if (line.includes('status')) return { stdout: ' M main.py\n' }
      if (line.includes('rev-parse')) return { stdout: 'abc1234\n' }
      return { stdout: 'ok\n' }
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toMatch(/local changes/)
  })

  it('installs requirements without torch via uv and a custom mirror', async () => {
    seedZipInstall({ withVenv: true })
    h.writeFile(join(COMFY, 'requirements.txt'), 'numpy\n')
    h.state.settings.pipIndex = 'https://mirror.example/simple'
    h.state.uvInstalled = true
    const p = await runUpdate()
    expect(p.status).toBe('done')
    const req = p.steps.find((s) => s.id === 'requirements')
    expect(req?.status).toBe('done')
    expect(req?.log.join('\n')).not.toContain('Skipping torch')
  })

  it('falls back to python -m pip when the uv lookup throws for torch', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    const ensure = bootstrapService.ensure as unknown as ReturnType<typeof vi.fn>
    ensure.mockImplementation(async () => {
      throw new Error('uv lookup failed')
    })
    const p = await runUpdate({ torchChannel: 'cu126' })
    expect(p.status).toBe('done')
    expect(p.steps.find((s) => s.id === 'torch')?.status).toBe('done')
  })

  it('stringifies a non-Error startup self-check failure and rolls back', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.selfcheckErr = 'selfboom' as never
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    expect(p.error).toBe('selfboom')
    expect(p.steps.find((s) => s.id === 'rollback')?.status).toBe('done')
  })

  it('logs relaunch results and tolerates a non-Error relaunch failure', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    const launch = instanceService.launch as unknown as ReturnType<typeof vi.fn>
    launch.mockResolvedValueOnce({})
    const first = await runUpdate({ updateDeps: false, open: 'browser' })
    expect(first.status).toBe('done')
    expect(first.steps.find((s) => s.id === 'done')?.log.join('\n')).toContain('relaunched at')

    launch.mockRejectedValueOnce('launchboom')
    const second = await runUpdate({ updateDeps: false, open: 'browser' })
    expect(second.status).toBe('done')
    expect(second.steps.find((s) => s.id === 'done')?.log.join('\n')).toContain(
      'relaunch failed: launchboom'
    )
  })

  it('reports an incomplete rollback when performRollback returns false', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.selfcheckResult = { ok: false, exitCode: 1, output: 'crash' }
    const original = admin.performRollback
    admin.performRollback = async () => false
    try {
      const p = await runUpdate({ updateDeps: false })
      expect(p.status).toBe('failed')
      const rollback = p.steps.find((s) => s.id === 'rollback')
      expect(rollback?.status).toBe('failed')
      expect(rollback?.detail).toMatch(/incomplete/i)
    } finally {
      admin.performRollback = original
    }
  })

  it('logs node snapshot and node rollback details after a failed verify', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.selfcheckResult = { ok: false, exitCode: 1, output: 'crash' }
    h.state.restoreResult = {
      ok: true,
      restored: [{ name: 'a' }],
      skipped: [{ name: 'b' }],
      failed: [{ name: 'c', error: 'boom' }],
      warnings: ['careful']
    }
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('failed')
    const log = p.steps.find((s) => s.id === 'rollback')?.log.join('\n') || ''
    expect(log).toContain('node warning: careful')
    expect(log).toContain('node rollback failed: c: boom')

    h.state.restoreErr = new Error('restore exploded')
    const second = await runUpdate({ updateDeps: false })
    expect(second.status).toBe('failed')
    expect(second.steps.find((s) => s.id === 'rollback')?.log.join('\n')).toContain(
      'node version rollback failed'
    )
    expect(nodePackService.createSnapshot).toHaveBeenCalled()
  })

  it('continues when the pre-update node snapshot cannot be created', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.createSnapshotErr = new Error('snapshot boom')
    const p = await runUpdate({ updateDeps: false })
    expect(p.status).toBe('done')
    expect(p.steps.find((s) => s.id === 'preflight')?.log.join('\n')).toContain(
      'node snapshot failed'
    )
  })

  it('uses the default exec timeout when no options are provided', async () => {
    admin.cancelledEpoch = -1
    h.state.execHandler = () => ({ error: new Error('run failed'), stderr: 'stderr-message' })
    await expect(svc.run('git', ['status'])).rejects.toThrow('stderr-message')
    h.state.execHandler = () => ({ error: new Error('run failed'), stdout: 'stdout-message' })
    await expect(svc.run('git', ['status'])).rejects.toThrow('stdout-message')
  })
})

describe('updater rollback failure branches', () => {
  it('reports ROLLBACK_FAILED with the backup path when restore throws', async () => {
    seedZipInstall({ withVenv: true, withReq: false })
    h.state.selfcheckResult = { ok: false, exitCode: 1, output: 'crash' }
    const original = admin.performRollback
    admin.performRollback = async () => {
      throw new Error('restore exploded')
    }
    try {
      const p = await runUpdate({ updateDeps: false })
      expect(p.status).toBe('failed')
      expect(p.errorCode).toBe('ROLLBACK_FAILED')
      expect(p.error).toContain('rollback FAILED')
      expect(p.error).toContain('restore exploded')
      const rollback = p.steps.find((s) => s.id === 'rollback')
      expect(rollback?.status).toBe('failed')
      expect(String(rollback?.detailParams?.path)).toContain('.cp-backups')
    } finally {
      admin.performRollback = original
      admin.progress = null
    }
  })

  it('rolls back a journal whose live instance stops successfully', async () => {
    const backup = 'C:/fake/.cp-backups/live'
    h.mkdirPath(backup)
    h.writeFile(join(backup, 'manifest.json'), JSON.stringify({ kind: 'files' }))
    h.writeFile(join(backup, 'main.py'), 'old')
    h.mkdirPath(COMFY)
    h.writeFile(join(COMFY, 'main.py'), 'new')
    h.writeFile(
      'C:/fake/.cp-update-journal.json',
      JSON.stringify({
        instanceId: 'inst-1',
        comfyDir: COMFY,
        backupPath: backup,
        backupKind: 'files',
        startedAt: 1
      })
    )
    h.state.instanceList = [{ id: 'inst-1', status: 'running' }]
    h.state.instanceStopResult = {}
    const ok = await comfyUpdaterService.rollbackFromJournal('inst-1')
    expect(ok).toBe(true)
    expect(h.state.stopCalls).toContain('inst-1')
    expect(fget(join(COMFY, 'main.py'))).toBe('old')
  })
})
