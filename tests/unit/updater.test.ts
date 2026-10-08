/**
 * Unit tests for the ComfyUI in-place updater (0.1.4).
 * Focus: source detection, version probing, preserve-list correctness,
 * step machine shape, and rollback bookkeeping — the pure/testable core.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      fetch: vi.fn()
    }
  },
  app: { getPath: vi.fn(() => 'C:/fake/userData') }
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: vi.fn(() => ({
    pipIndex: '',
    torchIndexMirror: '',
    githubEndpoint: '',
    proxy: { enabled: false, protocol: 'http', host: '', port: 7890, bypass: '', username: '', password: '' }
  })),
  loadInstanceConfigs: vi.fn(() => [
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
  ]),
  upsertInstanceConfig: vi.fn()
}))

vi.mock('../../src/main/services/proxy', () => ({
  proxyEnv: vi.fn(() => ({}))
}))

vi.mock('../../src/main/services/security', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/services/security')>(
    '../../src/main/services/security'
  )
  return actual
})

vi.mock('../../src/main/services/installer', () => ({
  resolveTorchIndex: vi.fn(() => 'https://download.pytorch.org/whl/cpu/'),
  officialTorchIndex: vi.fn(() => 'https://download.pytorch.org/whl/cpu/'),
  applyGithubMirror: vi.fn((u: string) => u)
}))

vi.mock('../../src/main/services/nodePack', () => ({
  resolveGitBinary: vi.fn(() => 'git')
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

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => 'v0.0.1-1-gabc1234'),
  promisify: (fn: unknown) => fn
}))

import {
  detectComfySource,
  probeComfyVersion,
  PRESERVE_ENTRIES,
  comfyUpdaterService
} from '../../src/main/services/updater'
import { existsSync, readFileSync } from 'fs'

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    cpSync: vi.fn()
  }
})

describe('PRESERVE_ENTRIES', () => {
  it('keeps every user-data directory the update must never touch', () => {
    for (const name of ['custom_nodes', 'models', 'user', 'input', 'output']) {
      expect(PRESERVE_ENTRIES.has(name)).toBe(true)
    }
    expect(PRESERVE_ENTRIES.has('extra_model_paths.yaml')).toBe(true)
    expect(PRESERVE_ENTRIES.has('.comfypilot-env.json')).toBe(true)
    expect(PRESERVE_ENTRIES.has('main.py')).toBe(false)
    expect(PRESERVE_ENTRIES.has('comfy')).toBe(false)
    expect(PRESERVE_ENTRIES.has('requirements.txt')).toBe(false)
  })
})

describe('detectComfySource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detects git when .git exists', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => String(p).endsWith('.git'))
    expect(detectComfySource('C:/fake/ComfyUI')).toBe('git')
  })

  it('detects zip when main.py exists but no .git', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => String(p).endsWith('main.py'))
    expect(detectComfySource('C:/fake/ComfyUI')).toBe('zip')
  })

  it('returns unknown when neither is present', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect(detectComfySource('C:/fake/ComfyUI')).toBe('unknown')
  })
})

describe('probeComfyVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns git describe output for git installs', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => String(p).endsWith('.git'))
    expect(probeComfyVersion('C:/fake/ComfyUI')).toBe('v0.0.1-1-gabc1234')
  })

  it('reads comfyCommit from the install stamp for zip installs', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const s = String(p)
      return s.endsWith('.comfypilot-env.json') || s.endsWith('main.py')
    })
    vi.mocked(readFileSync).mockImplementation(((p: unknown) => {
      const s = String(p)
      if (s.endsWith('.comfypilot-env.json')) {
        return JSON.stringify({ comfyCommit: 'deadbeefcafebabe', comfyFetchedAt: 1700000000000 })
      }
      return ''
    }) as unknown as typeof readFileSync)
    // .git check comes first — force it false so we hit the stamp path
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.endsWith('.git')) return false
      return s.endsWith('.comfypilot-env.json') || s.endsWith('main.py')
    })
    expect(probeComfyVersion('C:/fake/ComfyUI')).toBe('deadbeefcafe')
  })

  it('falls back to pyproject version when no stamp', () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.endsWith('.git')) return false
      return s.endsWith('pyproject.toml') || s.endsWith('main.py')
    })
    vi.mocked(readFileSync).mockImplementation(((p: unknown) => {
      const s = String(p)
      if (s.endsWith('pyproject.toml')) return 'name = "ComfyUI"\nversion = "0.3.0"\n'
      return ''
    }) as unknown as typeof readFileSync)
    expect(probeComfyVersion('C:/fake/ComfyUI')).toBe('0.3.0')
  })

  it('returns unknown for a non-install', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(readFileSync).mockReturnValue('')
    expect(probeComfyVersion('C:/empty')).toBe('unknown')
  })
})

describe('ComfyUpdaterService shape', () => {
  it('exposes check/start/cancel/getStatus', () => {
    expect(typeof comfyUpdaterService.check).toBe('function')
    expect(typeof comfyUpdaterService.start).toBe('function')
    expect(typeof comfyUpdaterService.cancel).toBe('function')
    expect(typeof comfyUpdaterService.getStatus).toBe('function')
  })

  it('getStatus is null before any run', () => {
    expect(comfyUpdaterService.getStatus()).toBeNull()
  })

  it('check rejects unknown instance ids', async () => {
    await expect(comfyUpdaterService.check('does-not-exist')).rejects.toThrow(/not found/i)
  })

  it('check reports unknown source for a non-install path', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const info = await comfyUpdaterService.check('inst-1')
    expect(info.source).toBe('unknown')
    expect(info.updatable).toBe(false)
    expect(info.error).toMatch(/main\.py/i)
  })
})
