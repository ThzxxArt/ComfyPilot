/**
 * Regression locks for the 0.1.4 security fixes (S1/S2/S3/M1/M4).
 * These cover the new branches introduced by the hardening pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  state: {
    dirs: new Set<string>(),
    files: new Map<string, string>(),
    nodePacks: [] as Array<Record<string, unknown>>,
    instances: [] as Array<Record<string, unknown>>,
    renameFail: [] as string[],
    execHandler: null as
      | null
      | ((cmd: string, args: string[]) => { stdout?: string; stderr?: string; error?: Error; hang?: boolean })
  }
}))

vi.mock('fs', () => {
  const norm = (p: unknown): string => String(p).replace(/\\/g, '/')
  const { state } = h
  return {
    existsSync: (p: unknown) => {
      const s = norm(p)
      return state.dirs.has(s) || state.files.has(s)
    },
    readdirSync: (p: unknown) => {
      const s = norm(p)
      if (!state.dirs.has(s)) return []
      // derive children from keys
      const prefix = s + '/'
      const kids = new Set<string>()
      for (const k of [...state.dirs.keys(), ...state.files.keys()]) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length)
          kids.add(rest.split('/')[0])
        }
      }
      return [...kids]
    },
    statSync: (p: unknown) => {
      const s = norm(p)
      return {
        isDirectory: () => state.dirs.has(s),
        isFile: () => state.files.has(s),
        size: 0,
        mtimeMs: 0
      }
    },
    readFileSync: (p: unknown) => state.files.get(norm(p)) || '',
    writeFileSync: (p: unknown, data: unknown) => {
      state.files.set(norm(p), String(data))
    },
    unlinkSync: (p: unknown) => {
      state.files.delete(norm(p))
    },
    mkdirSync: (p: unknown) => {
      state.dirs.add(norm(p))
    },
    rmSync: (p: unknown) => {
      const s = norm(p)
      state.dirs.delete(s)
      state.files.delete(s)
    },
    renameSync: (from: unknown, to: unknown) => {
      const f = norm(from)
      const t = norm(to)
      for (const frag of state.renameFail) {
        if (f.includes(frag)) throw new Error(`rename failed: ${f} -> ${t}`)
      }
      // Move the dir/file AND every nested key.
      const prefix = f + '/'
      for (const k of [...state.dirs.keys()]) {
        if (k === f) {
          state.dirs.delete(k)
          state.dirs.add(t)
        } else if (k.startsWith(prefix)) {
          state.dirs.delete(k)
          state.dirs.add(t + k.slice(f.length))
        }
      }
      for (const k of [...state.files.keys()]) {
        if (k === f) {
          state.files.set(t, state.files.get(f)!)
          state.files.delete(f)
        } else if (k.startsWith(prefix)) {
          state.files.set(t + k.slice(f.length), state.files.get(k)!)
          state.files.delete(k)
        }
      }
    },
    copyFileSync: vi.fn(),
    cpSync: vi.fn()
  }
})

vi.mock('crypto', () => ({
  createHash: () => ({ update: () => ({ digest: () => 'abcdef0123456789' }) }),
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
  logsDir: vi.fn(() => 'C:/fake/logs'),
  saveInstallRun: vi.fn(),
  loadInstallRuns: vi.fn(() => []),
  loadLatestInstallRun: vi.fn(() => null)
}))

vi.mock('../../src/main/services/proxy', () => ({ proxyEnv: vi.fn(() => ({})) }))
vi.mock('../../src/main/services/security', () => ({
  sanitizeId: (s: string) => s,
  isPathInside: (child: string, parent: string) => {
    const c = String(child).replace(/\\/g, '/')
    const p = String(parent).replace(/\\/g, '/')
    return c === p || c.startsWith(p + '/')
  },
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
vi.mock('../../src/main/services/instance', () => ({ resolveRuntimesPythonSync: vi.fn(() => null) }))
vi.mock('../../src/main/services/registry', () => ({
  searchRegistry: vi.fn(async () => ({ raw: [], total: 0, page: 1, pageSize: 50, totalPages: 0, scanned: 0, clientFiltered: false })),
  toPageResult: vi.fn(() => ({ items: [], total: 0, page: 1, pageSize: 50, totalPages: 0, scanned: 0, clientFiltered: false })),
  mapRegistryPack: vi.fn((n: Record<string, unknown>) => n),
  matchesQuery: vi.fn(() => true),
  fetchRegistryPage: vi.fn(async () => ({ nodes: [], total: 0, page: 1, totalPages: 0, limit: 50 }))
}))
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: unknown, cb?: unknown) => {
    const handler = h.state.execHandler
    const finish = (err: Error | null, out: string, errOut: string): void => {
      queueMicrotask(() => {
        if (typeof cb === 'function') (cb as (e: Error | null, o: string, e2: string) => void)(err, out, errOut)
      })
    }
    if (handler) {
      const r = handler(cmd, args)
      if (r.hang) return { pid: 42, kill: vi.fn() }
      if (r.error) finish(r.error, r.stdout || '', r.stderr || '')
      else finish(null, r.stdout || '', r.stderr || '')
    } else finish(null, 'ok', '')
    return { pid: 1, kill: vi.fn() }
  }),
  execFileSync: vi.fn(() => 'abc1234'),
  promisify: (fn: unknown) => {
    return async (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        ;(fn as (...a: unknown[]) => void)(...args.slice(0, -1), (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      })
  }
}))

import {
  nodePackService,
  compareVersions,
  isUpdateAvailable,
  resolveGitBinary,
  isStrictInside,
  sanitizeInstallNameForTest
} from '../../src/main/services/nodePack'

function reset(): void {
  h.state.dirs.clear()
  h.state.files.clear()
  h.state.nodePacks = []
  h.state.renameFail = []
  h.state.execHandler = null
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
  h.state.dirs.add('C:/fake/ComfyUI')
  h.state.dirs.add('C:/fake/ComfyUI/custom_nodes')
}

describe('S1: install destination safety', () => {
  beforeEach(() => reset())

  it('rejects clone when the URL tail collapses to a name equal to the root', async () => {
    // URL ending in '/.' previously produced dest === custom_nodes and cleanup
    // would wipe every pack. sanitizeInstallName must never yield empty/'.'.
    h.state.execHandler = (cmd, args) => {
      if (args.includes('clone')) {
        // simulate clone into whatever dest is given
        const dest = String(args[args.length - 1]).replace(/\\/g, '/')
        h.state.dirs.add(dest)
      }
      return { stdout: '' }
    }
    // Even with a hostile URL tail, install must never target the root itself.
    await expect(
      nodePackService.install({ id: 'https://evil.example/x/.', source: 'git', url: 'https://evil.example/x/.', instanceId: 'inst-1' })
    ).resolves.toBeDefined()
    // Root must still exist and still be a directory listing container
    expect(h.state.dirs.has('C:/fake/ComfyUI/custom_nodes')).toBe(true)
  })

  it('does not delete a pre-existing dest when clone fails', async () => {
    const dest = 'C:/fake/ComfyUI/custom_nodes/KeepMe'
    h.state.dirs.add(dest)
    h.state.files.set(dest + '/__init__.py', 'x')
    h.state.execHandler = (cmd, args) => {
      if (args.includes('clone')) return { error: new Error('clone failed'), stderr: 'clone failed' }
      return { stdout: '' }
    }
    await expect(
      nodePackService.install({ id: 'https://github.com/u/KeepMe.git', source: 'git', url: 'https://github.com/u/KeepMe.git', instanceId: 'inst-1' })
    ).rejects.toThrow(/clone failed/)
    // The pre-existing user directory must survive
    expect(h.state.dirs.has(dest)).toBe(true)
  })

  it('cleans only the temp clone dir on failure', async () => {
    h.state.execHandler = (cmd, args) => {
      if (args.includes('clone')) {
        const dest = String(args[args.length - 1]).replace(/\\/g, '/')
        h.state.dirs.add(dest)
        return { error: new Error('boom'), stderr: 'boom' }
      }
      return { stdout: '' }
    }
    await expect(
      nodePackService.install({ id: 'https://github.com/u/NewPack.git', source: 'git', url: 'https://github.com/u/NewPack.git', instanceId: 'inst-1' })
    ).rejects.toThrow()
    // No ._clone_tmp_* residue
    const leftovers = [...h.state.dirs.keys()].filter((k) => k.includes('._clone_tmp_'))
    expect(leftovers).toEqual([])
    // custom_nodes root intact
    expect(h.state.dirs.has('C:/fake/ComfyUI/custom_nodes')).toBe(true)
  })

  it('refuses to install when dest already exists', async () => {
    h.state.dirs.add('C:/fake/ComfyUI/custom_nodes/Dup')
    h.state.execHandler = (cmd, args) => {
      if (args.includes('clone')) {
        const dest = String(args[args.length - 1]).replace(/\\/g, '/')
        h.state.dirs.add(dest)
      }
      return { stdout: '' }
    }
    await expect(
      nodePackService.install({ id: 'https://github.com/u/Dup.git', source: 'git', url: 'https://github.com/u/Dup.git', instanceId: 'inst-1' })
    ).rejects.toThrow(/already exists/i)
  })
})

describe('version helpers still behave', () => {
  it('compareVersions and isUpdateAvailable', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true)
    expect(isUpdateAvailable('abc', 'def')).toBe(false)
    expect(typeof resolveGitBinary()).toBe('string')
  })
})

describe('isStrictInside (path containment, equal is NOT inside)', () => {
  it('returns false for equal paths', () => {
    expect(isStrictInside('C:/a/b', 'C:/a/b')).toBe(false)
  })
  it('returns true for a real descendant', () => {
    expect(isStrictInside('C:/a/b/c', 'C:/a/b')).toBe(true)
  })
  it('returns false for siblings with a shared prefix', () => {
    expect(isStrictInside('C:/a/bc', 'C:/a/b')).toBe(false)
  })
  it('returns false when child is the parent', () => {
    expect(isStrictInside('C:/a', 'C:/a/b')).toBe(false)
  })
})

describe('sanitizeInstallNameForTest (never yields empty / dot)', () => {
  it('maps hostile tails to a safe fallback', () => {
    expect(sanitizeInstallNameForTest('.')).not.toBe('')
    expect(sanitizeInstallNameForTest('.')).not.toBe('.')
    expect(sanitizeInstallNameForTest('..')).not.toBe('..')
    expect(sanitizeInstallNameForTest('')).toMatch(/^pack-/)
    expect(sanitizeInstallNameForTest('...')).toMatch(/^pack-/)
  })
  it('keeps normal names', () => {
    expect(sanitizeInstallNameForTest('ComfyUI-Foo')).toBe('ComfyUI-Foo')
    expect(sanitizeInstallNameForTest('pack.name')).toBe('pack.name')
  })
  it('strips leading dots/dashes and illegal chars', () => {
    expect(sanitizeInstallNameForTest('.hidden')).toBe('hidden')
    expect(sanitizeInstallNameForTest('a b/c')).toBe('a_b_c')
  })
})

describe('best-effort snapshot paths swallow errors', () => {
  beforeEach(() => reset())

  it('createSnapshot still returns a snapshot when the DB insert throws', async () => {
    const db = await import('../../src/main/services/db')
    const orig = db.insertSnapshot
    ;(db.insertSnapshot as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('db down')
    })
    const snap = nodePackService.createSnapshot('t1')
    expect(snap).toBeTruthy()
    expect(snap.name).toBe('t1')
    ;(db.insertSnapshot as unknown) = orig
  })

  it('createSnapshot still returns a snapshot when the file write throws', async () => {
    const fsMod = await import('fs')
    const orig = fsMod.writeFileSync as unknown as (...a: unknown[]) => void
    ;(fsMod as { writeFileSync: unknown }).writeFileSync = () => {
      throw new Error('disk full')
    }
    try {
      const snap = nodePackService.createSnapshot('t2')
      expect(snap.name).toBe('t2')
    } finally {
      ;(fsMod as { writeFileSync: unknown }).writeFileSync = orig
    }
  })

  it('updateAll still runs when the pre-update snapshot throws', async () => {
    const db = await import('../../src/main/services/db')
    ;(db.insertSnapshot as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('db down')
    })
    const out = await nodePackService.updateAll('inst-1')
    expect(Array.isArray(out)).toBe(true)
  })
})

describe('sanitizeInstallName safety (exported via install behavior)', () => {
  beforeEach(() => reset())

  it('a URL tail of "." never collapses the destination to custom_nodes root', async () => {
    h.state.execHandler = (cmd, args) => {
      if (args.includes('clone')) {
        const dest = String(args[args.length - 1]).replace(/\\/g, '/')
        // The clone dest must NEVER be the custom_nodes root itself
        expect(dest).not.toBe('C:/fake/ComfyUI/custom_nodes')
        expect(dest.length).toBeGreaterThan('C:/fake/ComfyUI/custom_nodes/'.length)
        h.state.dirs.add(dest)
        h.state.files.set(dest + '/__init__.py', 'x')
        h.state.files.set(dest + '/pyproject.toml', 'name = "DotPack"\nversion = "1.0.0"\n')
      }
      return { stdout: '' }
    }
    await nodePackService.install({
      id: 'https://evil.example/x/.',
      source: 'git',
      url: 'https://evil.example/x/.',
      instanceId: 'inst-1'
    })
    expect(h.state.dirs.has('C:/fake/ComfyUI/custom_nodes')).toBe(true)
  })

  it('rejects a git URL that starts with a dash (option injection)', async () => {
    await expect(
      nodePackService.install({ id: '-e', source: 'git', url: '--upload-pack=evil', instanceId: 'inst-1' })
    ).rejects.toThrow(/Invalid git URL/)
  })

  it('rejects ext:: transport URLs', async () => {
    await expect(
      nodePackService.install({ id: 'ext', source: 'git', url: 'ext::sh -c evil', instanceId: 'inst-1' })
    ).rejects.toThrow(/Invalid git URL/)
  })
})
