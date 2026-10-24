import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

const readSrc = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8')

// ============ Security comprehensive tests ============
describe('security: URL safety exhaustive', () => {
  it('blocks dangerous schemes', async () => {
    const { isSafeExternalUrl } = await import('@main/services/security')
    const bad = [
      'file:///etc/passwd',
      'ftp://x',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'vbscript:msgbox',
      'chrome://settings',
      'res://x',
      'blob:x',
      'ws://x',
      'wss://x',
      'jar:',
      'view-source:'
    ]
    for (const u of bad) {
      expect(isSafeExternalUrl(u), u).toBe(false)
    }
  })

  it('allows http and https', async () => {
    const { isSafeExternalUrl } = await import('@main/services/security')
    const good = [
      'https://example.com',
      'http://example.com',
      'https://a.b.c.d/path?query=1#frag',
      'https://127.0.0.1:8188',
      'http://localhost:3000'
    ]
    for (const u of good) {
      expect(isSafeExternalUrl(u), u).toBe(true)
    }
  })
})

describe('security: open path safety', () => {
  it('blocks dangerous extensions', async () => {
    const { isSafeOpenPath } = await import('@main/services/security')
    const bad = ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.jar', '.msi', '.scr', '.com', '.pif']
    for (const ext of bad) {
      expect(isSafeOpenPath(`C:/file${ext}`), ext).toBe(false)
    }
  })

  it('allows safe extensions', async () => {
    const { isSafeOpenPath } = await import('@main/services/security')
    const good = ['.txt', '.json', '.png', '.jpg', '.md', '.yaml', '.log', '.csv']
    for (const ext of good) {
      expect(isSafeOpenPath(`C:/file${ext}`), ext).toBe(true)
    }
  })
})

describe('security: sanitizeId', () => {
  it('produces safe ids from various inputs', async () => {
    const { sanitizeId } = await import('@main/services/security')
    const inputs = ['abc', '../..', 'a/b/c', 'a\\b', 'a\0b', '  spaces  ', '', '!@#$%', 'a.b.c']
    for (const input of inputs) {
      const result = sanitizeId(input)
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
      expect(result).not.toContain('..')
      expect(result).not.toContain('/')
      expect(result).not.toContain('\\')
      expect(result).not.toContain('\0')
    }
  })
})

describe('security: path segment normalization', () => {
  it('normalizePathSegment strips trailing dots/spaces', async () => {
    const { normalizePathSegment } = await import('@main/services/security')
    expect(normalizePathSegment('file.txt.')).toBe('file.txt')
    expect(normalizePathSegment('file.txt ')).toBe('file.txt')
    expect(normalizePathSegment('file.txt')).toBe('file.txt')
  })

  it('normalizePathSegment strips control chars', async () => {
    const { normalizePathSegment } = await import('@main/services/security')
    expect(normalizePathSegment('file\x00.txt')).toBe('file.txt')
    expect(normalizePathSegment('file\x1f.txt')).toBe('file.txt')
  })
})

// ============ Installer URL validation exhaustive ============
describe('installer: assertSafeGitUrl exhaustive', () => {
  it('allows valid git URLs', async () => {
    const { assertSafeGitUrl } = await import('@main/services/installer')
    const good = [
      'https://github.com/user/repo.git',
      'https://github.com/user/repo',
      'http://github.com/user/repo.git',
      'git@github.com:user/repo.git',
      'ssh://git@github.com/user/repo.git',
      'ssh://git@bitbucket.org/user/repo.git',
      'https://gitlab.com/group/project.git'
    ]
    for (const u of good) {
      expect(assertSafeGitUrl(u), u).toBeTruthy()
    }
  })

  it('blocks injection attempts', async () => {
    const { assertSafeGitUrl } = await import('@main/services/installer')
    const bad = [
      'ext::sh -c "evil"',
      'ext::bash -c "rm -rf"',
      '-upload-pack=evil',
      'https://-evil.com/x',
      'git@-evil.com:user/repo',
      'file:///etc/passwd',
      'ftp://example.com/repo',
      'javascript:alert(1)',
      '',
      '  ',
      'not-a-url'
    ]
    for (const u of bad) {
      expect(() => assertSafeGitUrl(u), u).toThrow()
    }
  })
})

describe('installer: assertSafeBranch exhaustive', () => {
  it('allows valid branches', async () => {
    const { assertSafeBranch } = await import('@main/services/installer')
    const good = [
      'main',
      'master',
      'dev',
      'feature/foo',
      'release/1.0',
      'v1.0.0',
      'a.b.c',
      'user-branch',
      ''
    ]
    for (const b of good) {
      expect(assertSafeBranch(b), b).toBe(b)
    }
  })

  it('blocks dangerous branches', async () => {
    const { assertSafeBranch } = await import('@main/services/installer')
    const bad = [
      '--upload-pack',
      '-x',
      '../evil',
      'a b',
      'a;b',
      'a|b',
      'a&b',
      'a`b',
      'a$b',
      '..',
      '...'
    ]
    for (const b of bad) {
      expect(() => assertSafeBranch(b), b).toThrow()
    }
  })
})

// ============ Format utilities exhaustive ============
describe('format: formatBytes', () => {
  it('formats various sizes', async () => {
    const { formatBytes } = await import('@/utils/format')
    const sizes = [
      0,
      1,
      512,
      1023,
      1024,
      1536,
      1024 * 1024,
      1024 * 1024 * 1.5,
      1024 ** 3,
      1024 ** 4
    ]
    for (const s of sizes) {
      const result = formatBytes(s)
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    }
  })
})

describe('format: clampPercent exhaustive', () => {
  it('clamps various values', async () => {
    const { clampPercent } = await import('@/utils/format')
    const cases: Array<[number, number | 'edge']> = [
      [-100, 0],
      [-1, 0],
      [0, 0],
      [1, 1],
      [50, 50],
      [99, 99],
      [100, 100],
      [101, 100],
      [200, 100],
      [1000, 100],
      [NaN, 0]
    ]
    for (const [input, expected] of cases) {
      const result = clampPercent(input)
      if (expected === 'edge') continue
      expect(result, `clampPercent(${input})`).toBe(expected)
    }
  })
})

// ============ Constants exhaustive ============
describe('constants: RUNTIME_SOURCES URLs', () => {
  it('all URLs are valid https GitHub releases', async () => {
    const { RUNTIME_SOURCES } = await import('@shared/constants')
    for (const [key, src] of Object.entries(RUNTIME_SOURCES)) {
      expect(src.url, key).toMatch(/^https:\/\//)
      expect(src.sizeHint, key).toBeGreaterThan(0)
      expect(src.description, key).toBeTruthy()
    }
  })
})

describe('constants: PIP_INDEX_PRESETS', () => {
  it('has official + mirrors', async () => {
    const { PIP_INDEX_PRESETS } = await import('@shared/constants')
    expect(PIP_INDEX_PRESETS.length).toBeGreaterThanOrEqual(4)
    // First is official (empty value)
    expect(PIP_INDEX_PRESETS[0].value).toBe('')
  })
})

describe('constants: TORCH_INDEX_PRESETS', () => {
  it('has official + mirrors', async () => {
    const { TORCH_INDEX_PRESETS } = await import('@shared/constants')
    expect(TORCH_INDEX_PRESETS.length).toBeGreaterThanOrEqual(3)
    expect(TORCH_INDEX_PRESETS[0].value).toBe('')
  })
})

describe('constants: COMFY_DEFAULT_PORTS', () => {
  it('has common ports', async () => {
    const { COMFY_DEFAULT_PORTS } = await import('@shared/constants')
    expect(COMFY_DEFAULT_PORTS).toContain(8188)
    expect(COMFY_DEFAULT_PORTS.length).toBeGreaterThanOrEqual(5)
  })
})

describe('constants: NODE_SNAPSHOT_PREFIX', () => {
  it('is defined', async () => {
    const { NODE_SNAPSHOT_PREFIX } = await import('@shared/constants')
    expect(NODE_SNAPSHOT_PREFIX).toBeTruthy()
    expect(NODE_SNAPSHOT_PREFIX).toBe('cp-snapshot')
  })
})

// ============ Proxy env exhaustive ============
describe('proxy: proxyEnv exhaustive', () => {
  it('sets all proxy vars when enabled with auth', async () => {
    const { proxyEnv } = await import('@main/services/proxy')
    const env = proxyEnv({
      enabled: true,
      protocol: 'socks5',
      host: 'p.example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
      bypass: 'localhost,127.0.0.1'
    })
    expect(env.ALL_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY).toBeTruthy()
    expect(env.NO_PROXY).toContain('localhost')
    expect(env.NO_PROXY).toContain('127.0.0.1')
  })

  it('returns empty proxy vars when disabled', async () => {
    const { proxyEnv } = await import('@main/services/proxy')
    const env = proxyEnv({
      enabled: false,
      protocol: 'http',
      host: 'x',
      port: 1,
      username: 'u',
      password: 'p',
      bypass: ''
    })
    // No HTTP_PROXY/HTTPS_PROXY/ALL_PROXY when disabled (other env vars like
    // NPM_CONFIG_NOPROXY may still be set)
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.ALL_PROXY).toBeUndefined()
  })
})

// ============ ZipWrite module ============
describe('zipWrite', () => {
  it('exports createWorkflowZip', async () => {
    const mod = await import('@main/services/zipWrite')
    expect(
      typeof mod.createWorkflowZip === 'function' ||
        typeof (mod as Record<string, unknown>).default === 'function'
    ).toBe(true)
  })
})

// ============ Workflow convert buildIterationPrompt ============
describe('workflowConvert: buildIterationPrompt', () => {
  it('applies increment seeds against the base seed (real call)', async () => {
    const { buildIterationPrompt } = await import('@main/services/workflowConvert')
    const graph = { '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } } }
    const { prompt, seed } = buildIterationPrompt(graph, {
      iteration: 2,
      seedMode: 'increment',
      baseSeed: 1000
    })
    expect(seed).toBe(1002)
    expect((prompt as Record<string, { inputs: Record<string, unknown> }>)['3'].inputs.seed).toBe(
      1002
    )
    // 原对象不得被就地修改
    expect(graph['3'].inputs.seed).toBe(1)
  })
})

// ============ Registry index ============
describe('registryIndex', () => {
  it('exports registryIndex singleton', async () => {
    const mod = await import('@main/services/registryIndex')
    expect(mod.registryIndex).toBeDefined()
    expect(typeof mod.registryIndex.status).toBe('function')
    expect(typeof mod.registryIndex.ensure).toBe('function')
  })
})

// ============ P1P2 service exports ============
describe('p1p2 service exports', () => {
  it('exports batchService, outputService, remoteService, marketService', async () => {
    const mod = await import('@main/services/p1p2')
    expect(mod.batchService).toBeDefined()
    expect(mod.outputService).toBeDefined()
    expect(mod.remoteService).toBeDefined()
    expect(mod.marketService).toBeDefined()
    expect(typeof mod.resolveOutputDir).toBe('function')
  })
})

// ============ Instance service exports ============
describe('instance service', () => {
  it('exports instanceService', async () => {
    const mod = await import('@main/services/instance')
    expect(mod.instanceService).toBeDefined()
  })
})

// ============ NodePack service exports ============
describe('nodePack service', () => {
  it('exports nodePackService', async () => {
    const mod = await import('@main/services/nodePack')
    expect(mod.nodePackService).toBeDefined()
    expect(typeof mod.nodePackService.list).toBe('function')
    expect(typeof mod.nodePackService.install).toBe('function')
    expect(typeof mod.nodePackService.update).toBe('function')
    expect(typeof mod.nodePackService.uninstall).toBe('function')
  })
})

// ============ Model service exports ============
describe('model service', () => {
  it('exports modelService', async () => {
    const mod = await import('@main/services/model')
    expect(mod.modelService).toBeDefined()
    expect(typeof mod.modelService.list).toBe('function')
    expect(typeof mod.modelService.scan).toBe('function')
    expect(typeof mod.modelService.download).toBe('function')
  })
})

// ============ Workflow service exports ============
describe('workflow service', () => {
  it('exports workflowService', async () => {
    const mod = await import('@main/services/workflow')
    expect(mod.workflowService).toBeDefined()
    expect(typeof mod.workflowService.list).toBe('function')
    expect(typeof mod.workflowService.importFile).toBe('function')
  })
})

// ============ Backup service exports ============
describe('backup service', () => {
  it('exports backupService', async () => {
    const mod = await import('@main/services/backup')
    expect(mod.backupService).toBeDefined()
    expect(typeof mod.backupService.create).toBe('function')
    expect(typeof mod.backupService.restore).toBe('function')
    expect(typeof mod.backupService.list).toBe('function')
    expect(typeof mod.backupService.delete).toBe('function')
  })
})

// ============ Doctor service exports ============
describe('doctor service', () => {
  it('exports doctorService', async () => {
    const mod = await import('@main/services/doctor')
    expect(mod.doctorService).toBeDefined()
    expect(typeof mod.doctorService.run).toBe('function')
    expect(typeof mod.doctorService.fix).toBe('function')
  })
})

// ============ Monitor service exports ============
describe('monitor service', () => {
  it('exports monitorService and helpers', async () => {
    const mod = await import('@main/services/monitor')
    expect(mod.monitorService).toBeDefined()
    expect(typeof mod.monitorService.systemSnapshot).toBe('function')
    expect(typeof mod.monitorService.connectWs).toBe('function')
    expect(typeof mod.monitorService.disconnectWs).toBe('function')
    expect(typeof mod.mergeGpuMemory).toBe('function')
    expect(typeof mod.assertMonitorBaseUrl).toBe('function')
  })
})

// ============ Env service exports ============
describe('env service', () => {
  it('exports envService', async () => {
    const mod = await import('@main/services/env')
    expect(mod.envService).toBeDefined()
    expect(typeof mod.envService.probe).toBe('function')
    expect(typeof mod.envService.createVenv).toBe('function')
    expect(typeof mod.envService.installTorch).toBe('function')
    expect(typeof mod.envService.repairEnv).toBe('function')
    expect(typeof mod.envService.listPythons).toBe('function')
  })
})

// ============ Installer service exports ============
describe('installer service', () => {
  it('exports installerService and helpers', async () => {
    const mod = await import('@main/services/installer')
    expect(mod.installerService).toBeDefined()
    expect(typeof mod.installerService.detectGpu).toBe('function')
    expect(typeof mod.installerService.preflight).toBe('function')
    expect(typeof mod.installerService.start).toBe('function')
    expect(typeof mod.listStarterModels).toBe('function')
    expect(typeof mod.assertSafeGitUrl).toBe('function')
    expect(typeof mod.assertSafeBranch).toBe('function')
    expect(typeof mod.applyGithubMirror).toBe('function')
  })
})

// ============ Updater service exports ============
describe('updater service', () => {
  it('exports comfyUpdaterService', async () => {
    const mod = await import('@main/services/updater')
    expect(mod.comfyUpdaterService).toBeDefined()
    expect(typeof mod.comfyUpdaterService.check).toBe('function')
    expect(typeof mod.comfyUpdaterService.start).toBe('function')
  })
})

// ============ Media service exports ============
describe('media service', () => {
  it('exports thumbnailService, renameService, aria2Service', async () => {
    const mod = await import('@main/services/media')
    expect(mod.thumbnailService).toBeDefined()
    expect(mod.renameService).toBeDefined()
    expect(mod.aria2Service).toBeDefined()
    expect(typeof mod.toMediaUrl).toBe('function')
    expect(typeof mod.thumbnailDisplayUrl).toBe('function')
  })
})

// ============ ComfyApi exports ============
describe('comfyApi', () => {
  it('exports COMFY_CLIENT_ID', async () => {
    const mod = await import('@main/services/comfyApi')
    expect(mod.COMFY_CLIENT_ID).toBeTruthy()
    expect(typeof mod.COMFY_CLIENT_ID).toBe('string')
  })
})

// ============ Source code quality checks ============
describe('source quality: no TODO/FIXME in production code', () => {
  const prodFiles = [
    'src/main/services/nodePack.ts',
    'src/main/services/model.ts',
    'src/main/services/workflow.ts',
    'src/main/services/p1p2.ts',
    'src/main/services/db.ts',
    'src/main/services/backup.ts',
    'src/main/services/installer.ts',
    'src/main/services/updater.ts'
  ]
  for (const f of prodFiles) {
    it(`${f} has no TODO/FIXME`, () => {
      const src = readSrc(f)
      expect(src).not.toMatch(/\bTODO\b/)
      expect(src).not.toMatch(/\bFIXME\b/)
    })
  }
})

describe('source quality: i18n key uniqueness', () => {
  it('zh-CN has no duplicate top-level keys', () => {
    const src = readSrc('src/renderer/src/i18n/locales/zh-CN.ts')
    // Extract top-level keys (2-space indent, ending with colon)
    const keys = [...src.matchAll(/^ {2}([a-zA-Z]+):\s*\{/gm)].map((m) => m[1])
    const seen = new Set<string>()
    for (const k of keys) {
      expect(seen.has(k), `duplicate key: ${k}`).toBe(false)
      seen.add(k)
    }
    expect(seen.size).toBeGreaterThan(15)
  })

  it('en-US has no duplicate top-level keys', () => {
    const src = readSrc('src/renderer/src/i18n/locales/en-US.ts')
    const keys = [...src.matchAll(/^ {2}([a-zA-Z]+):\s*\{/gm)].map((m) => m[1])
    const seen = new Set<string>()
    for (const k of keys) {
      expect(seen.has(k), `duplicate key: ${k}`).toBe(false)
      seen.add(k)
    }
    expect(seen.size).toBeGreaterThan(15)
  })
})


// ============ Readme consistency ============
describe('README consistency', () => {
  it('README mentions the current package version', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    const src = readFileSync(join(__dirname, '../../README.md'), 'utf-8')
    expect(src).toContain(pkg.version)
  })

  it('README does not claim 257 tests', () => {
    const src = readSrc('README.md')
    expect(src).not.toContain('257 tests')
    expect(src).not.toContain('257 用例')
  })
})

// ============ Package.json consistency ============
describe('package.json', () => {
  it('has correct metadata', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    expect(pkg.name).toBe('comfy-pilot')
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.license).toBe('MIT')
    expect(pkg.author).toBe('ThzxxArt')
    expect(pkg.main).toBeTruthy()
    expect(pkg.scripts.test).toBeTruthy()
    expect(pkg.scripts.typecheck).toBeTruthy()
    expect(pkg.scripts.build).toBeTruthy()
  })
})

// ============ Electron builder config ============
describe('electron-builder config', () => {
  it('has win/mac/linux targets', () => {
    const src = readSrc('electron-builder.yml')
    expect(src).toContain('nsis')
    expect(src).toContain('dmg')
    expect(src).toContain('AppImage')
    expect(src).toContain('appId')
    expect(src).toContain('productName: ComfyPilot')
  })
})
