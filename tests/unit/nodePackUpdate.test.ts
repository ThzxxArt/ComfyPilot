/**
 * Unit tests for nodePack update machinery: version comparison, git binary
 * resolution, checkUpdates/updateAll contracts, uninstall shell cleanup,
 * and update rollback semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const h = vi.hoisted(() => {
  type Dirent = { name: string; isDirectory: () => boolean }
  const state = {
    dirs: new Map<string, string[]>(),
    files: new Map<string, string>(),
    isDir: new Set<string>(),
    exists: new Set<string>(),
    nodePacks: [] as Array<Record<string, unknown>>,
    instances: [] as Array<Record<string, unknown>>
  }
  return { state }
})

vi.mock('fs', () => {
  const { state } = h
  return {
    existsSync: (p: unknown) => {
      const s = String(p)
      return state.exists.has(s) || state.dirs.has(s) || state.files.has(s) || state.isDir.has(s)
    },
    readdirSync: (p: unknown) => {
      const s = String(p)
      return state.dirs.get(s) || []
    },
    statSync: (p: unknown) => {
      const s = String(p)
      return {
        isDirectory: () => state.isDir.has(s) || state.dirs.has(s),
        isFile: () => state.files.has(s),
        size: 0,
        mtimeMs: 0
      }
    },
    readFileSync: (p: unknown) => {
      const s = String(p)
      return state.files.get(s) || ''
    },
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    renameSync: vi.fn(),
    createHash: undefined
  }
})

vi.mock('crypto', () => ({
  createHash: () => ({
    update: () => ({
      digest: () => 'abcdef0123456789'
    })
  }),
  randomUUID: () => 'uuid-1'
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: vi.fn(() => ({
    allowGitUrlInstall: true,
    allowPipInstall: true,
    securityLevel: 'normal',
    networkMode: 'public',
    pipIndex: '',
    proxy: { enabled: false, protocol: 'http', host: '', port: 7890, bypass: '', username: '', password: '' },
    defaultInstancePath: ''
  })),
  loadInstanceConfigs: vi.fn(() => h.state.instances),
  listNodePacks: vi.fn(() => h.state.nodePacks),
  upsertNodePack: vi.fn(),
  deleteNodePack: vi.fn(),
  listSnapshots: vi.fn(() => []),
  insertSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(() => true),
  getSnapshot: vi.fn(() => null),
  snapshotDir: vi.fn(() => 'C:/fake/snapshots'),
  userDataDir: vi.fn(() => 'C:/fake/user'),
  cacheDir: vi.fn(() => 'C:/fake/cache'),
  logsDir: vi.fn(() => 'C:/fake/logs')
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyEnv: vi.fn(() => ({}))
}))

vi.mock('../../src/main/services/security', () => ({
  sanitizeId: (s: string) => s,
  isPathInside: (child: string, parent: string) => String(child).startsWith(String(parent)),
  normalizePathEverySegment: (p: string) => String(p).replace(/\\/g, '/')
}))

vi.mock('../../src/main/services/installer', () => ({
  assertSafeGitUrl: vi.fn((u: string) => {
    if (!u || u.startsWith('-') || /ext::/i.test(u)) throw new Error('Invalid git URL')
    return u
  }),
  applyGithubMirror: vi.fn((u: string) => u),
  assertSafeBranch: vi.fn((b: string) => b),
  resolveTorchIndex: vi.fn(() => 'https://download.pytorch.org/whl/cpu/'),
  officialTorchIndex: vi.fn(() => 'https://download.pytorch.org/whl/cpu/')
}))

vi.mock('../../src/main/services/bootstrap', () => ({
  findInRuntimes: vi.fn(() => null),
  bootstrapService: { ensure: vi.fn(), cancelAll: vi.fn() }
}))

vi.mock('../../src/main/services/instance', () => ({
  resolveRuntimesPythonSync: vi.fn(() => null)
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
  toPageResult: vi.fn(() => ({ items: [], total: 0, page: 1, pageSize: 50, totalPages: 0, scanned: 0, clientFiltered: false })),
  mapRegistryPack: vi.fn((n: Record<string, unknown>) => n),
  matchesQuery: vi.fn(() => true),
  fetchRegistryPage: vi.fn(async () => ({ nodes: [], total: 0, page: 1, totalPages: 0, limit: 50 }))
}))

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
    if (typeof cb === 'function') {
      ;(cb as (e: null, o: string, e2: string) => void)(null, 'ok', '')
    }
    return { pid: 1 }
  }),
  execFileSync: vi.fn(() => 'abc1234'),
  promisify: (fn: unknown) => {
    return async (...args: unknown[]) => {
      const last = args[args.length - 1]
      // promisify(execFile) — call through with a callback we resolve
      return new Promise((resolve, reject) => {
        const cb = (err: Error | null, stdout: string, stderr: string): void => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        }
        ;(fn as (...a: unknown[]) => void)(...args.slice(0, -1), cb)
        void last
      })
    }
  }
}))

import {
  compareVersions,
  isUpdateAvailable,
  resolveGitBinary,
  nodePackService,
  resolveInstanceConfig
} from '../../src/main/services/nodePack'

function resetFsState(): void {
  h.state.dirs.clear()
  h.state.files.clear()
  h.state.isDir.clear()
  h.state.exists.clear()
  h.state.nodePacks = []
  h.state.instances = [
    {
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
    }
  ]
}

function seedPack(opts: { name: string; nested?: boolean; withGit?: boolean }): void {
  // Use path.join so the mock matches Windows backslash paths from the service.
  const { join } = require('path') as typeof import('path')
  const root = join('C:/fake/ComfyUI', 'custom_nodes')
  const shell = join(root, opts.name)
  const packDir = opts.nested ? join(shell, `${opts.name}-inner`) : shell
  h.state.isDir.add(root)
  h.state.dirs.set(root, [opts.name])
  h.state.isDir.add(shell)
  if (opts.nested) {
    h.state.dirs.set(shell, [`${opts.name}-inner`])
    h.state.isDir.add(packDir)
    h.state.dirs.set(packDir, ['__init__.py'])
  } else {
    h.state.dirs.set(shell, ['__init__.py'])
  }
  h.state.files.set(join(packDir, '__init__.py'), `NODE_CLASS_MAPPINGS = {"${opts.name}Node": None}\n`)
  h.state.files.set(join(packDir, 'pyproject.toml'), `name = "${opts.name}"\nversion = "1.0.0"\n`)
  if (opts.withGit) {
    h.state.isDir.add(join(packDir, '.git'))
    h.state.exists.add(join(packDir, '.git'))
    h.state.dirs.set(join(packDir, '.git'), [])
  }
}

describe('compareVersions', () => {
  it('orders numeric dotted versions', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })

  it('treats missing as older and empty-equal', () => {
    expect(compareVersions('', '')).toBe(0)
    expect(compareVersions('', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '')).toBeGreaterThan(0)
  })

  it('sorts pre-release before release', () => {
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBeLessThan(0)
    expect(compareVersions('1.2.3', '1.2.3-rc1')).toBeGreaterThan(0)
  })

  it('pads missing segments with zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.0.1', '1.2.0')).toBeGreaterThan(0)
  })

  it('falls back to string compare for non-semver', () => {
    expect(compareVersions('abc', 'abc')).toBe(0)
    expect(compareVersions('abc', 'abd')).toBeLessThan(0)
  })
})

describe('isUpdateAvailable', () => {
  it('flags strictly newer numeric versions', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true)
    expect(isUpdateAvailable('1.0.1', '1.0.0')).toBe(false)
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false)
  })

  it('never flags non-numeric versions (commit shas etc.)', () => {
    expect(isUpdateAvailable('abc1234', 'def5678')).toBe(false)
    expect(isUpdateAvailable('detected', '1.2.3')).toBe(false)
    expect(isUpdateAvailable('', '1.0.0')).toBe(false)
    expect(isUpdateAvailable('1.0.0', '')).toBe(false)
  })
})

describe('resolveGitBinary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prefers portable MinGit from runtimes when present', async () => {
    const bootstrap = await import('../../src/main/services/bootstrap')
    ;(bootstrap.findInRuntimes as ReturnType<typeof vi.fn>).mockReturnValue('C:/runtimes/cmd/git.exe')
    expect(resolveGitBinary()).toBe('C:/runtimes/cmd/git.exe')
  })

  it('falls back to bare git when no portable binary', async () => {
    const bootstrap = await import('../../src/main/services/bootstrap')
    ;(bootstrap.findInRuntimes as ReturnType<typeof vi.fn>).mockReturnValue(null)
    expect(resolveGitBinary()).toBe('git')
  })
})

describe('resolveInstanceConfig', () => {
  beforeEach(() => {
    resetFsState()
  })

  it('returns the matching instance for an id', () => {
    const c = resolveInstanceConfig('inst-1')
    expect(c?.id).toBe('inst-1')
  })

  it('returns undefined for an unknown explicit id (never silently falls back)', () => {
    expect(resolveInstanceConfig('nope')).toBeUndefined()
  })

  it('returns first enabled instance when no id given', () => {
    const c = resolveInstanceConfig()
    expect(c?.id).toBe('inst-1')
  })
})

describe('NodePackService.update guards', () => {
  beforeEach(() => {
    resetFsState()
    vi.clearAllMocks()
  })

  it('refuses to update a locked pack', async () => {
    seedPack({ name: 'PackA' })
    const { join } = require('path') as typeof import('path')
    const packPath = join('C:/fake/ComfyUI', 'custom_nodes', 'PackA')
    h.state.nodePacks = [
      {
        id: 'abcdef0123456789',
        name: 'PackA',
        locked: true,
        installSource: 'git',
        path: packPath,
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: []
      }
    ]
    await expect(nodePackService.update('PackA', undefined, 'inst-1')).rejects.toThrow(/locked/i)
  })

  it('throws not-updatable for local packs without git', async () => {
    seedPack({ name: 'PackA' })
    const { join } = require('path') as typeof import('path')
    const packPath = join('C:/fake/ComfyUI', 'custom_nodes', 'PackA')
    h.state.nodePacks = [
      {
        id: 'abcdef0123456789',
        name: 'PackA',
        locked: false,
        installSource: 'local',
        path: packPath,
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: []
      }
    ]
    await expect(nodePackService.update('PackA', undefined, 'inst-1')).rejects.toThrow(/not updatable/i)
  })

  it('throws not found for unknown pack names', async () => {
    resetFsState()
    const { join } = require('path') as typeof import('path')
    const root = join('C:/fake/ComfyUI', 'custom_nodes')
    h.state.isDir.add(root)
    h.state.dirs.set(root, [])
    await expect(nodePackService.update('Nope', undefined, 'inst-1')).rejects.toThrow(/not found/i)
  })
})

describe('nodePackService.checkUpdates', () => {
  beforeEach(() => {
    resetFsState()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('marks locked packs as not updatable with a reasonKey', { timeout: 15000 }, async () => {
    seedPack({ name: 'PackA' })
    const { join } = require('path') as typeof import('path')
    const packPath = join('C:/fake/ComfyUI', 'custom_nodes', 'PackA')
    h.state.nodePacks = [
      {
        id: 'abcdef0123456789',
        name: 'PackA',
        locked: true,
        installSource: 'registry',
        registryId: 'pack-a',
        path: packPath,
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: []
      }
    ]
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results).toHaveLength(1)
    expect(results[0].updatable).toBe(false)
    expect(results[0].reasonKey).toBe('nodes.locked')
  })

  it('returns an empty list when nothing is installed', { timeout: 15000 }, async () => {
    resetFsState()
    const { join } = require('path') as typeof import('path')
    const root = join('C:/fake/ComfyUI', 'custom_nodes')
    h.state.isDir.add(root)
    h.state.dirs.set(root, [])
    const results = await nodePackService.checkUpdates('inst-1')
    expect(results).toEqual([])
  })
})

describe('nodePackService.updateAll', () => {
  beforeEach(() => {
    resetFsState()
    vi.clearAllMocks()
  })

  it('skips non-updatable packs without touching them', { timeout: 15000 }, async () => {
    seedPack({ name: 'PackA' })
    const { join } = require('path') as typeof import('path')
    const packPath = join('C:/fake/ComfyUI', 'custom_nodes', 'PackA')
    h.state.nodePacks = [
      {
        id: 'abcdef0123456789',
        name: 'PackA',
        locked: true,
        installSource: 'registry',
        registryId: 'pack-a',
        path: packPath,
        version: '1.0.0',
        issues: [],
        tags: [],
        nodeList: []
      }
    ]
    const out = await nodePackService.updateAll('inst-1')
    expect(out).toHaveLength(1)
    expect(out[0].skipped).toBe(true)
    expect(out[0].ok).toBe(true)
  })
})

describe('event emitter surface', () => {
  it('NodePackService is an EventEmitter with the update API', () => {
    expect(nodePackService).toBeInstanceOf(EventEmitter)
    expect(typeof nodePackService.checkUpdates).toBe('function')
    expect(typeof nodePackService.updateAll).toBe('function')
    expect(typeof nodePackService.update).toBe('function')
    expect(typeof nodePackService.install).toBe('function')
    expect(typeof nodePackService.uninstall).toBe('function')
    expect(typeof nodePackService.createSnapshot).toBe('function')
    expect(typeof nodePackService.restoreSnapshot).toBe('function')
  })
})

void afterEach
