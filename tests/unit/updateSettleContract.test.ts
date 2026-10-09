/**
 * Regression locks for the 0.1.4 update IPC contract.
 *
 * `await ipc('instance.updateComfy')` must resolve only when the run SETTLES,
 * not when it is merely kicked off. The renderer's `updating` flag and loading
 * states hang off that await — fire-and-forget would clear them while the
 * update is still running.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pathKey } from '../helpers/pathKey'

const h = vi.hoisted(() => ({
  instance: {
    id: 'inst-1',
    name: 'ComfyUI',
    path: 'C:/fake/ComfyUI',
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
  },
  execResults: [] as Array<{ stdout?: string; stderr?: string; code?: number }>,
  fetchOk: true
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:/fake/userData') },
  session: {
    defaultSession: {
      fetch: vi.fn(async () => ({
        ok: h.fetchOk,
        status: h.fetchOk ? 200 : 503,
        headers: { get: () => '10' },
        json: async () => ({ sha: 'deadbeefcafe', commit: { committer: { date: '2025-01-01T00:00:00Z' } } }),
        arrayBuffer: async () => new ArrayBuffer(8)
      }))
    }
  }
}))

vi.mock('fs', () => {
  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const norm = (p: unknown): string => pathKey(p)
  const mk = (p: string): void => {
    dirs.add(norm(p))
  }
  // seed a git install with venv (forward-slash keys; lookups normalize)
  mk('C:/fake/ComfyUI')
  mk('C:/fake/ComfyUI/.git')
  mk('C:/fake/.venv')
  mk('C:/fake/.venv/Scripts')
  files.set('C:/fake/ComfyUI/main.py', 'print(1)')
  files.set('C:/fake/ComfyUI/requirements.txt', 'torch\n')
  files.set('C:/fake/.venv/Scripts/python.exe', 'bin')
  return {
    existsSync: (p: unknown) => {
      const s = norm(p)
      return dirs.has(s) || files.has(s)
    },
    readdirSync: (p: unknown) => {
      const s = norm(p)
      if (s === 'C:/fake/ComfyUI') return ['main.py', 'requirements.txt', '.git', 'comfy', 'custom_nodes']
      return []
    },
    statSync: (p: unknown) => {
      const s = norm(p)
      return {
        isDirectory: () => dirs.has(s),
        isFile: () => files.has(s),
        size: 0,
        mtimeMs: 0
      }
    },
    readFileSync: (p: unknown) => files.get(norm(p)) || '',
    writeFileSync: (p: unknown, data: unknown) => {
      files.set(norm(p), String(data))
    },
    mkdirSync: (p: unknown) => {
      dirs.add(norm(p))
    },
    rmSync: (p: unknown) => {
      dirs.delete(norm(p))
      files.delete(norm(p))
    },
    copyFileSync: vi.fn(),
    cpSync: vi.fn()
  }
})

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      const result = h.execResults.shift() || { stdout: 'ok\n', stderr: '' }
      const err = result.code ? new Error(result.stderr || 'fail') : null
      if (typeof cb === 'function') {
        setTimeout(() => cb(err, result.stdout || '', result.stderr || ''), 0)
      }
      return { pid: 1, kill: vi.fn() }
    }
  ),
  execFileSync: vi.fn(() => 'v1.0.0'),
  promisify: (fn: unknown) => fn
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: vi.fn(() => ({
    pipIndex: '',
    torchIndexMirror: '',
    githubEndpoint: '',
    proxy: { enabled: false, protocol: 'http', host: '', port: 7890, bypass: '', username: '', password: '' }
  })),
  loadInstanceConfigs: vi.fn(() => [h.instance]),
  upsertInstanceConfig: vi.fn()
}))

vi.mock('../../src/main/services/proxy', () => ({ proxyEnv: vi.fn(() => ({})) }))

vi.mock('../../src/main/services/security', () => ({
  normalizePathEverySegment: (p: string) => String(p).replace(/\\/g, '/'),
  hasParentHop: () => false,
  isSafeExternalUrl: () => true
}))

vi.mock('../../src/main/services/installer', () => ({
  resolveTorchIndex: vi.fn(() => 'https://download.pytorch.org/whl/cpu/'),
  officialTorchIndex: vi.fn(() => 'https://download.pytorch.org/whl/cpu/'),
  applyGithubMirror: vi.fn((u: string) => u)
}))

vi.mock('../../src/main/services/nodePack', () => ({ resolveGitBinary: vi.fn(() => 'git') }))

vi.mock('../../src/main/services/bootstrap', () => ({
  bootstrapService: {
    ensure: vi.fn(async () => ({
      runtimesDir: 'r',
      components: [],
      pythonPath: 'python',
      pythonOrigin: 'system',
      zipInstallReady: true
    })),
    cancelAll: vi.fn()
  }
}))

vi.mock('../../src/main/services/doctor', () => ({
  doctorService: {
    run: vi.fn(async () => ({
      id: 'd',
      instanceId: 'inst-1',
      createdAt: 0,
      durationMs: 1,
      checks: [],
      summary: { pass: 1, warn: 0, fail: 0, info: 0 }
    })),
    fix: vi.fn()
  }
}))

vi.mock('../../src/main/services/instance', () => ({
  instanceService: {
    list: vi.fn(() => [{ ...h.instance, status: 'stopped' }]),
    stop: vi.fn(async () => ({})),
    checkPort: vi.fn(async () => ({ port: 8188, available: true })),
    launch: vi.fn(async () => ({ url: 'http://127.0.0.1:8188' })),
    invalidateVersionCache: vi.fn()
  },
  resolveRuntimesPythonSync: vi.fn(() => null)
}))

import { comfyUpdaterService } from '../../src/main/services/updater'

describe('update IPC settle contract', () => {
  beforeEach(async () => {
    // The service is a module singleton — let any prior run settle first.
    await comfyUpdaterService.waitUntilSettled().catch(() => undefined)
    h.execResults = [
      { stdout: 'abc1234\n' }, // rev-parse / describe
      { stdout: '' }, // pull
      { stdout: 'abc1234\n' } // rev-parse short
    ]
    h.fetchOk = true
  })

  it('start() returns a running snapshot immediately', async () => {
    const p = await comfyUpdaterService.start('inst-1', { updateDeps: false })
    expect(p.status).toBe('running')
    expect(p.instanceId).toBe('inst-1')
    expect(p.steps.length).toBeGreaterThan(0)
  })

  it('waitUntilSettled() resolves only after the run finishes', async () => {
    const initial = await comfyUpdaterService.start('inst-1', { updateDeps: false })
    expect(initial.status).toBe('running')
    const final = await comfyUpdaterService.waitUntilSettled()
    expect(final).not.toBeNull()
    expect(final!.runId).toBe(initial.runId)
    expect(final!.status).not.toBe('running')
    expect(['done', 'failed']).toContain(final!.status)
  })

  it('waitUntilSettled is a no-op when nothing is running', async () => {
    const p = await comfyUpdaterService.waitUntilSettled()
    if (p) expect(p.status).not.toBe('running')
  })
})
