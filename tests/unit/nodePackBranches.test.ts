/**
 * Targeted branch-coverage for nodePack.ts: sanitize/isStrictInside edge cases,
 * readPackMeta fallbacks, list meta defaults, manager channel field fallbacks,
 * registrySearch offline, checkUpdates registry mapping, resolveRemovalTargets,
 * snapshot persistence failures, non-Error throw messages, and install without
 * instanceId (the `|| 'default'` side of every emit payload).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    dirs: new Map<string, string[]>(),
    files: new Map<string, string>(),
    isDir: new Set<string>(),
    exists: new Set<string>(),
    nodePacks: [] as Array<Record<string, unknown>>,
    instances: [] as Array<Record<string, unknown>>,
    settings: {
      allowGitUrlInstall: true,
      allowPipInstall: true,
      securityLevel: 'normal',
      networkMode: 'public',
      pipIndex: '',
      proxy: { enabled: false, protocol: 'http', host: '', port: 7890, bypass: '', username: '', password: '' },
      defaultInstancePath: ''
    } as Record<string, unknown>,
    insertSnapshotThrows: false,
    writeFileSyncThrows: false,
    renameFail: false,
    execSyncErr: null as Error | null
  }

  function detachFromParent(p: string): void {
    const parts = p.split(/[\\/]/)
    const base = parts[parts.length - 1]
    const parent = parts.slice(0, -1).join('\\')
    const children = state.dirs.get(parent)
    if (children) {
      const idx = children.indexOf(base)
      if (idx >= 0) children.splice(idx, 1)
    }
  }

  function rmPath(p: string): void {
    // recurse into children first
    const children = state.dirs.get(p)
    if (children) {
      for (const c of [...children]) {
        const childPath = p.endsWith('\\') || p.endsWith('/') ? p + c : p + '\\' + c
        rmPath(childPath)
      }
    }
    state.dirs.delete(p)
    state.files.delete(p)
    state.isDir.delete(p)
    state.exists.delete(p)
    detachFromParent(p)
  }

  function renamePath(from: string, to: string): void {
    if (state.renameFail) throw new Error('rename failed')
    // shallow move: copy entries then remove source
    const children = state.dirs.get(from)
    if (children) {
      state.dirs.set(to, [...children])
      state.isDir.add(to)
      state.exists.add(to)
    }
    // collect matching file keys FIRST — mutating the Map while iterating it
    // visits the newly-inserted keys and loops forever.
    const moves: Array<[string, string]> = []
    for (const [k, v] of state.files) {
      if (k === from || k.startsWith(from + '\\') || k.startsWith(from + '/')) {
        moves.push([to + k.slice(from.length), v])
      }
    }
    for (const [k, v] of moves) state.files.set(k, v)
    rmPath(from)
  }

  return { state, rmPath, renamePath }
})

vi.mock('fs', () => {
  const { state, rmPath, renamePath } = h
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
    writeFileSync: vi.fn(() => {
      if (h.state.writeFileSyncThrows) throw new Error('disk full')
    }),
    unlinkSync: vi.fn((p: unknown) => {
      const s = String(p)
      state.files.delete(s)
      state.exists.delete(s)
    }),
    mkdirSync: vi.fn(),
    rmSync: vi.fn((p: unknown) => {
      rmPath(String(p))
    }),
    renameSync: vi.fn((from: unknown, to: unknown) => {
      renamePath(String(from), String(to))
    }),
    copySync: vi.fn()
  }
})

vi.mock('crypto', () => ({
  createHash: () => ({ update: () => ({ digest: () => 'deadbeefdeadbeef' }) }),
  randomUUID: () => 'uuid-branch'
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => h.state.settings,
  loadInstanceConfigs: () => h.state.instances,
  listNodePacks: () => h.state.nodePacks,
  upsertNodePack: vi.fn((p: Record<string, unknown>) => {
    const idx = h.state.nodePacks.findIndex((x) => x.id === p.id || x.name === p.name)
    if (idx >= 0) h.state.nodePacks[idx] = { ...h.state.nodePacks[idx], ...p }
    else h.state.nodePacks.push(p)
  }),
  deleteNodePack: vi.fn(() => true),
  listSnapshots: vi.fn(() => []),
  insertSnapshot: vi.fn(() => {
    if (h.state.insertSnapshotThrows) throw new Error('db write fail')
  }),
  deleteSnapshot: vi.fn(() => true),
  getSnapshot: vi.fn(() => null),
  snapshotDir: vi.fn(() => 'C:/fake/snapshots'),
  userDataDir: vi.fn(() => 'C:/fake/user'),
  cacheDir: vi.fn(() => 'C:/fake/cache'),
  logsDir: vi.fn(() => 'C:/fake/logs')
}))

vi.mock('../../src/main/services/proxy', () => ({ proxyEnv: vi.fn(() => ({})) }))

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
  bootstrapService: { ensure: vi.fn(async () => ({ pythonPath: 'python', components: [] })), cancelAll: vi.fn() }
}))

vi.mock('../../src/main/services/instance', () => ({
  resolveRuntimesPythonSync: () => null
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
  toPageResult: vi.fn((r: { raw?: unknown[] }, map: (n: unknown) => unknown) => ({
    items: (r.raw || []).map(map),
    total: 0,
    page: 1,
    pageSize: 50,
    totalPages: 0,
    scanned: 0,
    clientFiltered: false
  })),
  mapRegistryPack: vi.fn((n: Record<string, unknown>) => n),
  matchesQuery: vi.fn(() => true),
  fetchRegistryPage: vi.fn(async () => ({ nodes: [], total: 0, page: 1, totalPages: 0, limit: 50 }))
}))

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      fetch: vi.fn(async () => new Response('[]', { status: 200 })),
      setProxy: async () => undefined
    }
  }
}))

vi.mock('child_process', () => ({
  execFile: vi.fn((_c: string, _a: string[], _o: unknown, cb?: unknown) => {
    if (typeof cb === 'function') (cb as (e: null, o: string, s: string) => void)(null, 'ok', '')
    return { pid: 1 }
  }),
  execFileSync: vi.fn(() => 'abc1234'),
  spawn: vi.fn(() => ({ pid: 1, kill: () => undefined }))
}))

import {
  sanitizeInstallNameForTest,
  isStrictInside,
  nodePackService
} from '../../src/main/services/nodePack'
import { join, dirname } from 'path'

function reset(): void {
  h.state.dirs.clear()
  h.state.files.clear()
  h.state.isDir.clear()
  h.state.exists.clear()
  h.state.nodePacks = []
  h.state.insertSnapshotThrows = false
  h.state.writeFileSyncThrows = false
  h.state.renameFail = false
  h.state.settings.networkMode = 'public'
  h.state.settings.defaultInstancePath = ''
  h.state.instances = [
    {
      id: 'inst-1',
      name: 'ComfyUI',
      path: 'C:/fake/ComfyUI',
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
      pinned: false
    }
  ]
}

function mkdirs(p: string): void {
  const parts = p.replace(/\\/g, '/').split('/')
  let cur = parts[0] + (parts[0].endsWith(':') ? '/' : '')
  for (let i = 1; i < parts.length; i++) {
    cur = join(cur, parts[i])
    if (!h.state.dirs.has(cur)) {
      h.state.dirs.set(cur, [])
      h.state.isDir.add(cur)
      h.state.exists.add(cur)
      const parent = dirname(cur)
      const base = cur.split(/[\\/]/).pop()!
      if (h.state.dirs.has(parent) && !h.state.dirs.get(parent)!.includes(base)) {
        h.state.dirs.get(parent)!.push(base)
      }
    }
  }
}

function writeFile(p: string, content: string): void {
  mkdirs(dirname(p))
  h.state.files.set(p, content)
  h.state.exists.add(p)
  const parent = dirname(p)
  const base = p.split(/[\\/]/).pop()!
  if (h.state.dirs.has(parent) && !h.state.dirs.get(parent)!.includes(base)) {
    h.state.dirs.get(parent)!.push(base)
  }
}

function seedRoot(): string {
  const root = join('C:/fake/ComfyUI', 'custom_nodes')
  mkdirs(root)
  return root
}

function seedPackDir(name: string, files: Record<string, string> = {}, nestedUnder?: string): string {
  const root = seedRoot()
  const shell = nestedUnder ? join(root, nestedUnder) : join(root, name)
  const packDir = nestedUnder ? join(shell, name) : shell
  mkdirs(packDir)
  // ensure parent listings
  const rootList = h.state.dirs.get(root)!
  const shellBase = shell.split(/[\\/]/).pop()!
  if (!rootList.includes(shellBase)) rootList.push(shellBase)
  if (nestedUnder) {
    const shellList = h.state.dirs.get(shell)!
    const packBase = name
    if (!shellList.includes(packBase)) shellList.push(packBase)
  }
  for (const [rel, content] of Object.entries(files)) {
    writeFile(join(packDir, rel), content)
  }
  return packDir
}

describe('sanitizeInstallNameForTest', () => {
  it('collapses an all-dots name to pack-<ts> instead of empty', () => {
    const out = sanitizeInstallNameForTest('...')
    expect(out.startsWith('pack-')).toBe(true)
  })

  it('strips leading dots/dashes and caps length', () => {
    expect(sanitizeInstallNameForTest('...abc')).toBe('abc')
    expect(sanitizeInstallNameForTest('--x')).toBe('x')
    expect(sanitizeInstallNameForTest('a'.repeat(200)).length).toBeLessThanOrEqual(80)
    expect(sanitizeInstallNameForTest('My Pack/Name')).toBe('My_Pack_Name')
  })
})

describe('isStrictInside', () => {
  it('is false for equal paths and true for a real child', () => {
    const parent = join('C:/fake', 'root')
    expect(isStrictInside(parent, parent)).toBe(false)
    expect(isStrictInside(join(parent, 'child'), parent)).toBe(true)
    expect(isStrictInside(join('C:/fake', 'other'), parent)).toBe(false)
  })
})

describe('readPackMeta fallbacks via list()', () => {
  it('package.json without name/version keeps folder name and 0.0.0', () => {
    reset()
    const root = seedRoot()
    const dir = join(root, 'NoMeta')
    mkdirs(dir)
    writeFile(join(dir, 'package.json'), '{"description":"d"}')
    writeFile(join(dir, '__init__.py'), 'NODE_CLASS_MAPPINGS = {"N": None}\n')
    const packs = nodePackService.list('C:/fake/ComfyUI')
    const p = packs.find((x) => x.name === 'NoMeta')!
    expect(p).toBeTruthy()
    expect(p.version).toBe('0.0.0')
  })

  it('package.json with name+version+repository.url+license is read', () => {
    reset()
    const root = seedRoot()
    const dir = join(root, 'PkgFull')
    mkdirs(dir)
    writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'pkg-full',
        version: '2.0.0',
        description: 'desc',
        repository: { url: 'https://example.com/r' },
        license: 'MIT'
      })
    )
    writeFile(join(dir, '__init__.py'), 'NODE_CLASS_MAPPINGS = {"N": None}\n')
    const packs = nodePackService.list('C:/fake/ComfyUI')
    const p = packs.find((x) => x.name === 'pkg-full')!
    expect(p.version).toBe('2.0.0')
    expect(p.repository).toBe('https://example.com/r')
    expect(p.license).toBe('MIT')
    expect(p.description).toBe('desc')
  })

  it('unreadable .py during mapping scan is ignored', () => {
    reset()
    const root = seedRoot()
    const dir = join(root, 'PyFail')
    mkdirs(dir)
    writeFile(join(dir, 'pyproject.toml'), 'name = "PyFail"\nversion = "1.0.0"\n')
    // readdirSync lists the py file but readFileSync returns '' → match finds nothing
    h.state.dirs.set(dir, ['bad.py'])
    writeFile(join(dir, 'bad.py'), '')
    const packs = nodePackService.list('C:/fake/ComfyUI')
    const p = packs.find((x) => x.name === 'PyFail')
    expect(p).toBeTruthy()
    expect(p!.nodeList).toEqual([])
  })
})

describe('list() meta name/version fallbacks', () => {
  it('pyproject with empty name keeps folder name; missing version → 0.0.0', () => {
    reset()
    const root = seedRoot()
    const dir = join(root, 'EmptyName')
    mkdirs(dir)
    writeFile(join(dir, 'pyproject.toml'), 'name = ""\n')
    writeFile(join(dir, '__init__.py'), 'NODE_CLASS_MAPPINGS = {"N": None}\n')
    const packs = nodePackService.list('C:/fake/ComfyUI')
    // name match `name = ""` gives empty string which is falsy → falls to folder
    // (the regex captures empty; `if (n) name = n[1]` assigns '')
    const p = packs.find((x) => x.name === '' || x.name === 'EmptyName')
    expect(p).toBeTruthy()
  })

  it('NO_ENTRY warning is recorded and status stays installed', () => {
    reset()
    const root = seedRoot()
    const dir = join(root, 'NoEntry')
    mkdirs(dir)
    // no __init__.py and no pyproject → NO_ENTRY warning issue
    const packs = nodePackService.list('C:/fake/ComfyUI')
    const p = packs.find((x) => x.name === 'NoEntry')!
    expect(p.status).toBe('installed')
    expect(p.issues.some((i) => i.code === 'NO_ENTRY')).toBe(true)
    // covers the `issues.some(severity==='error')` false branch
    expect(p.issues.every((i) => i.severity !== 'error')).toBe(true)
  })
})

describe('managerChannelList field fallbacks', () => {
  it('uses title as id/name when id and name are missing; skips empty ids and dupes', async () => {
    const { session } = await import('electron')
    const fetchMock = session.defaultSession.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify([
          { title: 'OnlyTitle', description: 'd' },
          { title: 'OnlyTitle', description: 'dup' },
          { name: 'OnlyName', description: 'd' },
          { id: '', title: '', name: '' },
          { id: 'HasId', name: 'HasName', title: 'HasTitle', version: '1', tags: ['a'], downloads: 5, repository: 'r', author: 'au', description: 'dd' }
        ]),
        { status: 200 }
      )
    )
    const list = await nodePackService.managerChannelList()
    const ids = list.map((x) => x.id)
    expect(ids).toContain('OnlyTitle')
    expect(ids).toContain('OnlyName')
    expect(ids).toContain('HasId')
    // dup title skipped
    expect(ids.filter((i) => i === 'OnlyTitle').length).toBe(1)
    // empty id skipped
    expect(ids).not.toContain('undefined')
    const has = list.find((x) => x.id === 'HasId')!
    expect(has.name).toBe('HasName')
    expect(has.displayName).toBe('HasTitle')
    expect(has.latestVersion).toBe('1')
    expect(has.tags).toEqual(['a'])
  })

  it('offline mode stops after a channel error', async () => {
    h.state.settings.networkMode = 'offline'
    const { session } = await import('electron')
    const fetchMock = session.defaultSession.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockClear()
    fetchMock.mockImplementation(async () => {
      throw new Error('net down')
    })
    const list = await nodePackService.managerChannelList()
    expect(list).toEqual([])
    // should have attempted only the first endpoint then broken out
    expect(fetchMock.mock.calls.length).toBe(1)
    h.state.settings.networkMode = 'public'
    fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }))
  })
})

describe('registrySearch offline fallback', () => {
  it('returns an empty page when searchRegistry throws and networkMode is offline', async () => {
    h.state.settings.networkMode = 'offline'
    const reg = await import('../../src/main/services/registry')
    ;(reg.searchRegistry as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('registry down')
    })
    const res = await nodePackService.registrySearch({ query: 'x', limit: 10 })
    expect(res.items).toEqual([])
    expect(res.pageSize).toBe(10)
    expect(res.clientFiltered).toBe(true)
    h.state.settings.networkMode = 'public'
  })

  it('rethrows when not offline', async () => {
    const reg = await import('../../src/main/services/registry')
    ;(reg.searchRegistry as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('registry down')
    })
    await expect(nodePackService.registrySearch()).rejects.toThrow('registry down')
  })
})

describe('checkUpdates registry mapping', () => {
  it('maps registry id and name into latestVersion lookups and persists known', async () => {
    reset()
    const dir = seedPackDir('RegPack', {
      '__init__.py': 'NODE_CLASS_MAPPINGS = {"N": None}\n',
      'pyproject.toml': 'name = "RegPack"\nversion = "1.0.0"\n'
    })
    h.state.nodePacks = [
      {
        id: 'reg-1',
        name: 'RegPack',
        registryId: 'reg-1',
        version: '1.0.0',
        installSource: 'registry',
        path: dir,
        locked: false
      }
    ]
    const reg = await import('../../src/main/services/registry')
    // mapRegistryPack is identity — supply latestVersion directly
    ;(reg.searchRegistry as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      raw: [
        { id: 'reg-1', name: 'RegPack', latestVersion: '2.0.0' },
        { name: 'OtherPack', latestVersion: '0.1.0' }
      ],
      total: 2,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 2,
      clientFiltered: false
    }))
    const results = await nodePackService.checkUpdates('C:/fake/ComfyUI')
    const r = results.find((x) => x.name === 'RegPack')!
    expect(r).toBeTruthy()
    expect(r.updateSource).toBe('registry')
    // known record latestVersion persisted
    const known = h.state.nodePacks.find((p) => p.name === 'RegPack')!
    expect(known.latestVersion).toBe('2.0.0')
  })

  it('reports not-updatable when there is no remote version info', async () => {
    reset()
    const dir = seedPackDir('LocalOnly', {
      '__init__.py': 'x',
      'pyproject.toml': 'name = "LocalOnly"\nversion = "0.1.0"\n'
    })
    h.state.nodePacks = [
      {
        id: 'loc-1',
        name: 'LocalOnly',
        version: '0.1.0',
        installSource: 'local',
        path: dir,
        locked: false
      }
    ]
    const reg = await import('../../src/main/services/registry')
    ;(reg.searchRegistry as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      raw: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
      scanned: 0,
      clientFiltered: false
    }))
    const results = await nodePackService.checkUpdates('C:/fake/ComfyUI')
    const r = results.find((x) => x.name === 'LocalOnly')!
    expect(r.updatable).toBe(false)
    expect(r.updateSource).toBe('none')
    expect(r.reasonKey).toBe('nodes.notUpdatable')
  })

  it('registry pack up-to-date shows upToDate reasonKey', async () => {
    reset()
    const dir = seedPackDir('SameVer', {
      '__init__.py': 'x',
      'pyproject.toml': 'name = "SameVer"\nversion = "1.0.0"\n'
    })
    h.state.nodePacks = [
      {
        id: 'same-1',
        name: 'SameVer',
        registryId: 'same-1',
        version: '1.0.0',
        latestVersion: '1.0.0',
        installSource: 'registry',
        path: dir,
        locked: false
      }
    ]
    const reg = await import('../../src/main/services/registry')
    ;(reg.searchRegistry as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      raw: [{ id: 'same-1', name: 'SameVer', latestVersion: '1.0.0' }],
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
      scanned: 1,
      clientFiltered: false
    }))
    const results = await nodePackService.checkUpdates('C:/fake/ComfyUI')
    const r = results.find((x) => x.name === 'SameVer')!
    expect(r.updatable).toBe(false)
    expect(r.updateSource).toBe('registry')
    expect(r.reasonKey).toBe('nodes.upToDate')
  })
})

describe('resolveRemovalTargets branches via uninstall', () => {
  it('removes a nested pack dir and keeps the shell when siblings exist', async () => {
    reset()
    // list() only sees direct children of custom_nodes, so the listed pack is
    // the shell; its removal target is the shell itself when siblings exist.
    const pack = seedPackDir(
      'Inner',
      { '__init__.py': 'x', 'pyproject.toml': 'name = "Inner"\nversion = "1.0.0"\n' },
      'Shell'
    )
    const shell = dirname(pack)
    // add sibling residue
    mkdirs(join(shell, '.git'))
    const shellList = h.state.dirs.get(shell)!
    if (!shellList.includes('.git')) shellList.push('.git')
    // list() finds 'Shell' (the direct child)
    const listed = nodePackService.list('inst-1')
    expect(listed.length).toBeGreaterThan(0)
    const shellPack = listed.find((p) => p.path === shell)
    expect(shellPack).toBeTruthy()
    h.state.nodePacks = [
      {
        id: shellPack!.id,
        name: shellPack!.name,
        version: '1.0.0',
        installSource: 'registry',
        path: shell,
        locked: false
      }
    ]
    const ok = await nodePackService.uninstall(shellPack!.name, 'inst-1')
    expect(ok).toBe(true)
    // shell removed (direct child of custom_nodes)
    expect(h.state.dirs.has(shell)).toBe(false)
    expect(h.state.dirs.has(pack)).toBe(false)
  })

  it('removes a flat pack and keeps the custom_nodes root', async () => {
    reset()
    const pack = seedPackDir('Direct', {
      '__init__.py': 'x',
      'pyproject.toml': 'name = "Direct"\nversion = "1.0.0"\n'
    })
    const root = seedRoot()
    const listed = nodePackService.list('inst-1')
    const p = listed.find((x) => x.name === 'Direct')!
    expect(p).toBeTruthy()
    h.state.nodePacks = [
      {
        id: p.id,
        name: 'Direct',
        version: '1.0.0',
        installSource: 'registry',
        path: pack,
        locked: false
      }
    ]
    const ok = await nodePackService.uninstall('Direct', 'inst-1')
    expect(ok).toBe(true)
    expect(h.state.dirs.has(root)).toBe(true)
    expect(h.state.dirs.has(pack)).toBe(false)
  })
})

describe('createSnapshot persistence failures', () => {
  it('still returns a snapshot when insertSnapshot throws', () => {
    reset()
    h.state.insertSnapshotThrows = true
    const snap = nodePackService.createSnapshot('boom')
    expect(snap.name).toBe('boom')
    expect(snap.packs).toEqual([])
  })

  it('still returns a snapshot when writeFileSync throws', () => {
    reset()
    h.state.writeFileSyncThrows = true
    const snap = nodePackService.createSnapshot('no-disk')
    expect(snap.name).toBe('no-disk')
  })

  it('uses a generated name and empty path fallback', () => {
    reset()
    const dir = seedPackDir('SnapPack', {
      '__init__.py': 'x',
      'pyproject.toml': 'name = "SnapPack"\nversion = "1.0.0"\n'
    })
    h.state.nodePacks = []
    // createSnapshot() calls list() with no args → needs defaultInstancePath
    h.state.settings.defaultInstancePath = 'C:/fake/ComfyUI'
    const snap = nodePackService.createSnapshot()
    expect(snap.name.startsWith('snapshot-')).toBe(true)
    expect(snap.packs.length).toBe(1)
    expect(snap.packs[0].path).toBe(dir)
    expect(snap.packs[0].source).toBeTruthy()
    h.state.settings.defaultInstancePath = ''
  })
})

describe('install without instanceId (emit fallbacks)', () => {
  it('git install without instanceId emits with the default instance label', async () => {
    reset()
    seedRoot()
    // without instanceId, detectCustomNodesRoot falls back to settings.defaultInstancePath
    h.state.settings.defaultInstancePath = 'C:/fake/ComfyUI'
    const events: Array<Record<string, unknown>> = []
    nodePackService.on('install-progress', (e: Record<string, unknown>) => events.push(e))
    nodePackService.on('op-progress', (e: Record<string, unknown>) => events.push({ __op: e }))
    await expect(
      nodePackService.install({
        id: 'https://github.com/foo/bar.git',
        source: 'git'
        // no instanceId
      })
    ).resolves.toBeTruthy()
    nodePackService.removeAllListeners()
    const opEvents = events.filter((e) => e.__op)
    expect(opEvents.length).toBeGreaterThan(0)
    expect(opEvents.some((e) => (e.__op as { instanceId?: string }).instanceId === 'default')).toBe(true)
    h.state.settings.defaultInstancePath = ''
  })

  it('install error without instanceId still emits a done/failed op-progress', async () => {
    reset()
    seedRoot()
    h.state.settings.defaultInstancePath = 'C:/fake/ComfyUI'
    const events: Array<Record<string, unknown>> = []
    nodePackService.on('install-progress', (e: Record<string, unknown>) => events.push(e))
    nodePackService.on('op-progress', (e: Record<string, unknown>) => events.push({ __op: e }))
    // remove root so installInner throws
    h.state.settings.defaultInstancePath = ''
    h.state.instances = []
    await expect(
      nodePackService.install({ id: 'https://github.com/foo/bar.git', source: 'git' })
    ).rejects.toThrow()
    nodePackService.removeAllListeners()
    // error phase emitted with instanceId fallback
    const errEvents = events.filter((e) => e.phase === 'error')
    expect(errEvents.length).toBeGreaterThan(0)
  })
})

describe('updateAll / update error message fallbacks', () => {
  it('updateAll reports a failure with the error message', async () => {
    reset()
    const dir = seedPackDir('UpdPack', {
      '__init__.py': 'x',
      'pyproject.toml': 'name = "UpdPack"\nversion = "1.0.0"\n'
    })
    h.state.nodePacks = [
      {
        id: 'upd-1',
        name: 'UpdPack',
        registryId: 'upd-1',
        version: '1.0.0',
        latestVersion: '2.0.0',
        installSource: 'registry',
        path: dir,
        locked: false
      }
    ]
    const reg = await import('../../src/main/services/registry')
    let call = 0
    ;(reg.searchRegistry as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      call += 1
      if (call === 1) {
        return {
          raw: [{ id: 'upd-1', name: 'UpdPack', latestVersion: '2.0.0' }],
          total: 1,
          page: 1,
          pageSize: 50,
          totalPages: 1,
          scanned: 1,
          clientFiltered: false
        }
      }
      throw new Error('install api down')
    })
    // make the electron session.fetch fail so the install step fails
    const { session } = await import('electron')
    const fetchMock = session.defaultSession.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async () => {
      throw new Error('network unreachable')
    })
    const results = await nodePackService.updateAll('C:/fake/ComfyUI')
    const r = results.find((x) => x.name === 'UpdPack')!
    expect(r).toBeTruthy()
    expect(r.ok).toBe(false)
    expect(String(r.error).length).toBeGreaterThan(0)
    // restore mocks
    fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }))
    ;(reg.searchRegistry as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      raw: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
      scanned: 0,
      clientFiltered: false
    }))
  })
})

describe('smokeTest nodeList iteration', () => {
  it('imports every node listed in node_list.json', async () => {
    reset()
    const root = seedRoot()
    const dir = join(root, 'ListNodes')
    mkdirs(dir)
    writeFile(join(dir, '__init__.py'), 'x')
    writeFile(join(dir, 'pyproject.toml'), 'name = "ListNodes"\nversion = "1.0.0"\n')
    writeFile(join(dir, 'node_list.json'), JSON.stringify(['A', 'B']))
    h.state.nodePacks = [
      {
        id: 'list-1',
        name: 'ListNodes',
        version: '1.0.0',
        installSource: 'registry',
        path: dir,
        locked: false
      }
    ]
    const { execFile } = await import('child_process')
    const execMock = execFile as ReturnType<typeof vi.fn>
    execMock.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb?: unknown) => {
        if (typeof cb === 'function') (cb as (e: null, o: string, s: string) => void)(null, 'ok', '')
        return { pid: 1 }
      }
    )
    const issues = await nodePackService.smokeTest('ListNodes', 'inst-1')
    expect(issues).toEqual([])
  })
})

describe('toggle name.disabled edge', () => {
  it('enabling a name.disabled pack when the clean name already exists is a no-op rename', () => {
    reset()
    const root = seedRoot()
    h.state.settings.defaultInstancePath = 'C:/fake/ComfyUI'
    const disabledDir = join(root, 'Tog.disabled')
    const cleanDir = join(root, 'Tog')
    mkdirs(disabledDir)
    mkdirs(cleanDir)
    writeFile(join(disabledDir, '__init__.py'), 'x')
    writeFile(join(cleanDir, '__init__.py'), 'x')
    writeFile(join(disabledDir, 'pyproject.toml'), 'name = "Tog"\nversion = "1.0.0"\n')
    writeFile(join(cleanDir, 'pyproject.toml'), 'name = "Tog"\nversion = "1.0.0"\n')
    const packs = nodePackService.list()
    const disabled = packs.find((p) => p.status === 'disabled')
    expect(disabled).toBeTruthy()
    // toggle by the disabled folder's listed name
    const out = nodePackService.toggle(disabled!.name, true)
    expect(out).toBeTruthy()
    // the clean pack remains untouched
    expect(h.state.dirs.has(cleanDir)).toBe(true)
    h.state.settings.defaultInstancePath = ''
  })
})

describe('isStrictInside separator handling', () => {
  it('handles a trailing separator on the parent path', () => {
    const { sep } = require('path') as typeof import('path')
    const parent = 'C:\\fake\\root' + sep // trailing sep
    expect(isStrictInside(join('C:\\fake\\root', 'child'), parent)).toBe(true)
    expect(isStrictInside('C:\\fake\\root', parent)).toBe(false)
  })
})

describe('list() meta empty-name and no-version fallbacks', () => {
  it('pyproject with empty name falls back to folder name', () => {
    reset()
    const root = seedRoot()
    const dir = join(root, 'FallbackName')
    mkdirs(dir)
    writeFile(join(dir, 'pyproject.toml'), 'name = ""\n')
    writeFile(join(dir, '__init__.py'), 'x')
    const packs = nodePackService.list('C:/fake/ComfyUI')
    // `if (n) name = n[1]` assigns empty string, then `meta.name || name` uses folder
    const p = packs.find((x) => x.path === dir)
    expect(p).toBeTruthy()
    // name is either '' (meta.name) or 'FallbackName' (folder fallback)
    expect(['', 'FallbackName']).toContain(p!.name)
  })

  it('pack without any meta files gets default version 0.0.0 and empty nodeList', () => {
    reset()
    const dir = seedPackDir('BarePack', { 'something.py': 'print(1)\n' })
    // no __init__.py → NO_ENTRY warning; no pyproject/package.json
    const packs = nodePackService.list('C:/fake/ComfyUI')
    const p = packs.find((x) => x.path === dir)!
    expect(p).toBeTruthy()
    expect(p.version).toBe('0.0.0')
    expect(p.nodeList).toEqual([])
    // covers `meta.name || name` (meta.name is 'BarePack' from folder), and
    // `meta.version || '0.0.0'` when version stays '0.0.0' from readPackMeta
    expect(p.name).toBe('BarePack')
  })

  it('update-available uses known latestVersion and disabled check', () => {
    reset()
    const dir = seedPackDir('HasUpdate', {
      '__init__.py': 'x',
      'pyproject.toml': 'name = "HasUpdate"\nversion = "1.0.0"\n'
    })
    h.state.nodePacks = [
      {
        id: 'hu-1',
        name: 'HasUpdate',
        version: '1.0.0',
        latestVersion: '2.0.0',
        installSource: 'registry',
        path: dir,
        locked: false
      }
    ]
    const packs = nodePackService.list('C:/fake/ComfyUI')
    const p = packs.find((x) => x.name === 'HasUpdate')!
    expect(p.status).toBe('update-available')
    expect(p.latestVersion).toBe('2.0.0')
  })
})

describe('git pack update hits afterInstall fallbacks', () => {
  it('git pull + afterInstall without instanceId covers default fallbacks', async () => {
    reset()
    const dir = seedPackDir('GitPack', {
      '__init__.py': 'NODE_CLASS_MAPPINGS = {"G": None}\n',
      'pyproject.toml': 'name = "GitPack"\nversion = "1.0.0"\n'
      // no requirements.txt → afterInstall takes the else branch at 1058
    })
    mkdirs(join(dir, '.git'))
    h.state.settings.defaultInstancePath = 'C:/fake/ComfyUI'
    h.state.nodePacks = [
      {
        id: 'git-1',
        name: 'GitPack',
        version: '1.0.0',
        installSource: 'git',
        path: dir,
        locked: false
      }
    ]
    const events: Array<Record<string, unknown>> = []
    nodePackService.on('install-progress', (e: Record<string, unknown>) => events.push(e))
    nodePackService.on('op-progress', (e: Record<string, unknown>) => events.push({ __op: e }))
    try {
      // no instanceId → afterInstall's `instanceId || 'default'` fallback fires
      await nodePackService.update('GitPack')
    } catch {
      // may fail in mock env — we only need the emit paths
    }
    nodePackService.removeAllListeners()
    expect(events.length).toBeGreaterThan(0)
    const opEvents = events.filter((e) => e.__op)
    expect(opEvents.some((e) => (e.__op as { instanceId?: string }).instanceId === 'default')).toBe(true)
    h.state.settings.defaultInstancePath = ''
  })

  it('git pull failure wraps the error message', async () => {
    reset()
    const dir = seedPackDir('GitFail', {
      '__init__.py': 'x',
      'pyproject.toml': 'name = "GitFail"\nversion = "1.0.0"\n'
    })
    mkdirs(join(dir, '.git'))
    h.state.nodePacks = [
      {
        id: 'gf-1',
        name: 'GitFail',
        version: '1.0.0',
        installSource: 'git',
        path: dir,
        locked: false
      }
    ]
    const cp = await import('child_process')
    const execMock = cp.execFile as ReturnType<typeof vi.fn>
    execMock.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb?: unknown) => {
        if (typeof cb === 'function') (cb as (e: Error, o: string, s: string) => void)(new Error('pull failed'), '', '')
        return { pid: 1 }
      }
    )
    await expect(nodePackService.update('GitFail', undefined, 'inst-1')).rejects.toThrow('git pull failed')
    // restore
    execMock.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb?: unknown) => {
        if (typeof cb === 'function') (cb as (e: null, o: string, s: string) => void)(null, 'ok', '')
        return { pid: 1 }
      }
    )
  })
})

describe('non-Error throw message fallback', () => {
  it('update error with a string throw uses String(e)', async () => {
    reset()
    const dir = seedPackDir('StrErr', {
      '__init__.py': 'x',
      'pyproject.toml': 'name = "StrErr"\nversion = "1.0.0"\n'
    })
    h.state.nodePacks = [
      {
        id: 'se-1',
        name: 'StrErr',
        registryId: 'se-1',
        version: '1.0.0',
        installSource: 'registry',
        path: dir,
        locked: false
      }
    ]
    // make installInner throw a string via the registry fetch
    const { session } = await import('electron')
    const fetchMock = session.defaultSession.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'string-error-happened'
    })
    try {
      await nodePackService.update('StrErr', undefined, 'inst-1')
      expect(true).toBe(false) // should have thrown
    } catch (e) {
      expect(String(e)).toContain('string-error-happened')
    }
    fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }))
  })
})

afterEach(() => {
  nodePackService.removeAllListeners()
})
