import { describe, it, expect } from 'vitest'
import { join } from 'path'

const readSrc = (rel: string): string => {
  const { readFileSync } = require('fs')
  return readFileSync(join(__dirname, '..', '..', rel), 'utf-8')
}

// ============ Security module ============
describe('security: path safety', () => {
  it('isPathInside handles basic containment', async () => {
    const { isPathInside } = await import('@main/services/security')
    expect(isPathInside(join('/a', 'b', 'c'), join('/a', 'b'))).toBe(true)
    // prefix but not inside
    expect(isPathInside(join('/a', 'bc'), join('/a', 'b'))).toBe(false)
    // parent is not inside child
    expect(isPathInside(join('/a', 'b'), join('/a', 'b', 'c'))).toBe(false)
  })

  it('isSafeExternalUrl allows http/https only', async () => {
    const { isSafeExternalUrl } = await import('@main/services/security')
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('ftp://example.com')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
  })

  it('isSafeOpenPath blocks executables', async () => {
    const { isSafeOpenPath } = await import('@main/services/security')
    expect(isSafeOpenPath('C:/file.txt')).toBe(true)
    expect(isSafeOpenPath('C:/file.png')).toBe(true)
    // These are typically blocked
    expect(isSafeOpenPath('C:/file.exe')).toBe(false)
    expect(isSafeOpenPath('C:/file.bat')).toBe(false)
    expect(isSafeOpenPath('C:/file.cmd')).toBe(false)
    expect(isSafeOpenPath('C:/file.ps1')).toBe(false)
  })

  it('sanitizeId strips dangerous chars', async () => {
    const { sanitizeId } = await import('@main/services/security')
    expect(sanitizeId('abc-123')).toBeTruthy()
    expect(sanitizeId('')).toBeTruthy() // returns something safe
    const safe = sanitizeId('../../etc/passwd')
    expect(safe).not.toContain('..')
    expect(safe).not.toContain('/')
  })

  it('isLocalhostUrl detects localhost variants', async () => {
    const { isLocalhostUrl } = await import('@main/services/security')
    expect(isLocalhostUrl('http://127.0.0.1:8188')).toBe(true)
    expect(isLocalhostUrl('http://localhost:8188')).toBe(true)
    expect(isLocalhostUrl('http://[::1]:8188')).toBe(true)
    expect(isLocalhostUrl('http://example.com')).toBe(false)
  })

  it('assertSafeRelativeFilename rejects or sanitizes traversal', async () => {
    const { assertSafeRelativeFilename } = await import('@main/services/security')
    expect(() => assertSafeRelativeFilename('good-name.json')).not.toThrow()
    // '..' is either sanitized to a safe name or throws
    try {
      const r = assertSafeRelativeFilename('..')
      expect(r).not.toContain('..')
    } catch (err) {
      // throws for empty after sanitization — must be a real Error.
      expect(err).toBeInstanceOf(Error)
    }
  })

  it('safeResolveUnder returns path or null', async () => {
    const { safeResolveUnder } = await import('@main/services/security')
    // Should reject escaping
    const escape = safeResolveUnder('/a/b', '../../etc/passwd')
    expect(escape === null || escape === false).toBe(true)
    // Absolute input is NOT honored as a system path: per the comfy-pilot:// protocol
    // contract, leading separators are stripped and the result must stay under the root.
    const abs = safeResolveUnder('/a/b', '/etc/passwd')
    expect(abs === null || abs.startsWith('/a/b')).toBe(true)
    expect(abs).not.toBe('/etc/passwd')
  })
})

// ============ ZipSafe module ============
describe('zipSafe: zip-slip protection', () => {
  it('module loads and exports safeUnzip', async () => {
    const mod = await import('@main/services/zipSafe')
    expect(mod).toBeDefined()
    expect(
      typeof mod.safeUnzip === 'function' ||
        typeof (mod as Record<string, unknown>).default === 'function'
    ).toBe(true)
  })

  it('source contains path safety checks (contract)', () => {
    const src = readSrc('src/main/services/zipSafe.ts')
    // The module must have path validation
    expect(src).toContain('isPathInside')
    expect(src).toContain('resolve')
    // Must handle path traversal
    expect(src).toContain('..')
  })
})

// ============ Format utilities ============
describe('format utilities', () => {
  it('formatBytes handles zero', async () => {
    const { formatBytes } = await import('@/utils/format')
    expect(formatBytes(0)).toBeTruthy()
  })

  it('formatBytes handles KB/MB/GB', async () => {
    const { formatBytes } = await import('@/utils/format')
    expect(formatBytes(1024)).toBeTruthy()
    expect(formatBytes(1024 * 1024)).toBeTruthy()
    expect(formatBytes(1024 * 1024 * 1024)).toBeTruthy()
    expect(formatBytes(1536)).toBeTruthy() // 1.5 KB
  })

  it('clampPercent clamps to 0-100', async () => {
    const { clampPercent } = await import('@/utils/format')
    expect(clampPercent(-10)).toBe(0)
    expect(clampPercent(0)).toBe(0)
    expect(clampPercent(50)).toBe(50)
    expect(clampPercent(100)).toBe(100)
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(NaN)).toBe(0)
    // Infinity may map to 0 or 100 depending on implementation
    const inf = clampPercent(Infinity)
    expect(inf === 0 || inf === 100).toBe(true)
  })
})

// ============ Constants module ============
describe('constants', () => {
  it('APP_NAME is ComfyPilot', async () => {
    const { APP_NAME } = await import('@shared/constants')
    expect(APP_NAME).toBe('ComfyPilot')
  })

  it('DEFAULT_SETTINGS has all required fields', async () => {
    const { DEFAULT_SETTINGS } = await import('@shared/constants')
    expect(DEFAULT_SETTINGS.locale).toBe('zh-CN')
    expect(DEFAULT_SETTINGS.securityLevel).toBe('normal')
    expect(DEFAULT_SETTINGS.allowGitUrlInstall).toBe(false)
    expect(DEFAULT_SETTINGS.allowPipInstall).toBe(true)
    expect(DEFAULT_SETTINGS.networkMode).toBe('public')
    expect(DEFAULT_SETTINGS.proxy).toBeDefined()
    expect(DEFAULT_SETTINGS.proxy.enabled).toBe(false)
    expect(DEFAULT_SETTINGS.proxy.protocol).toBe('http')
    expect(DEFAULT_SETTINGS.proxy.bypass).toContain('localhost')
  })

  it('LAUNCH_TEMPLATES has valid ids', async () => {
    const { LAUNCH_TEMPLATES } = await import('@shared/constants')
    expect(LAUNCH_TEMPLATES.length).toBeGreaterThanOrEqual(7)
    const ids = LAUNCH_TEMPLATES.map((t) => t.id)
    expect(ids).toContain('default')
    expect(ids).toContain('preview-taesd')
    expect(ids).toContain('manager')
    expect(ids).toContain('offline')
    expect(ids).toContain('lan')
    expect(ids).toContain('lowvram')
    expect(ids).toContain('cpu')
  })

  it('MODEL_CATEGORY_LABELS covers all categories', async () => {
    const { MODEL_CATEGORY_LABELS } = await import('@shared/constants')
    const cats = [
      'checkpoints',
      'diffusion_models',
      'loras',
      'vae',
      'clip',
      'controlnet',
      'upscale_models',
      'embeddings',
      'text_encoders',
      'unet',
      'other'
    ]
    for (const c of cats) {
      expect(MODEL_CATEGORY_LABELS[c]).toBeTruthy()
    }
  })

  it('TORCH_DISK_GB has all channels', async () => {
    const { TORCH_DISK_GB } = await import('@shared/constants')
    const channels = ['cu130', 'cu126', 'cu124', 'rocm', 'xpu', 'mps', 'cpu']
    for (const ch of channels) {
      expect(TORCH_DISK_GB[ch as keyof typeof TORCH_DISK_GB]).toBeGreaterThan(0)
    }
  })

  it('STARTER_MODELS have valid URLs and categories', async () => {
    const { STARTER_MODELS } = await import('@shared/constants')
    expect(STARTER_MODELS.length).toBeGreaterThanOrEqual(3)
    for (const m of STARTER_MODELS) {
      expect(m.url).toBeTruthy()
      expect(m.url).toMatch(/^https?:\/\//)
      expect(m.category).toBeTruthy()
      expect(m.approxBytes).toBeGreaterThan(0)
    }
  })

  it('RUNTIME_SOURCES has win/linux/darwin entries', async () => {
    const { RUNTIME_SOURCES } = await import('@shared/constants')
    const keys = Object.keys(RUNTIME_SOURCES)
    expect(keys.some((k) => k.includes('win'))).toBe(true)
    expect(keys.some((k) => k.includes('linux'))).toBe(true)
    expect(keys.some((k) => k.includes('darwin'))).toBe(true)
    expect(keys.some((k) => k.includes('uv'))).toBe(true)
    expect(keys.some((k) => k.includes('mingit'))).toBe(true)
    expect(keys.some((k) => k.includes('python'))).toBe(true)
  })

  it('COMFY_ZIP_URL points to GitHub archive', async () => {
    const { COMFY_ZIP_URL } = await import('@shared/constants')
    expect(COMFY_ZIP_URL).toContain('github.com')
    expect(COMFY_ZIP_URL).toContain('ComfyUI')
  })

  it('REGISTRY_API is set', async () => {
    const { REGISTRY_API } = await import('@shared/constants')
    expect(REGISTRY_API).toContain('comfy.org')
  })
})

// ============ Model helpers ============
describe('model helpers', () => {
  it('readSafetensorsMeta returns null for non-existent file', async () => {
    const { readSafetensorsMeta } = await import('@main/services/model')
    expect(readSafetensorsMeta('/nonexistent/file.safetensors')).toBeNull()
  })

  it('sha256File hashes content', async () => {
    const { sha256File } = await import('@main/services/model')
    const { writeFileSync, rmSync } = require('fs')
    const { tmpdir } = require('os')
    const p = join(tmpdir(), `sha-test-${Date.now()}.bin`)
    writeFileSync(p, 'hello')
    const h = await sha256File(p)
    expect(h).toMatch(/^[a-f0-9]{64}$/)
    rmSync(p, { force: true })
  })

  it('parseExtraModelPaths returns empty for missing file', async () => {
    const { parseExtraModelPaths } = await import('@main/services/model')
    const result = parseExtraModelPaths('/nonexistent/extra_model_paths.yaml')
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })
})

// ============ Workflow convert ============
describe('workflowConvert', () => {
  it('module loads without errors', async () => {
    const mod = await import('@main/services/workflowConvert')
    expect(mod).toBeDefined()
    expect(
      typeof mod.buildIterationPrompt === 'function' ||
        typeof (mod as Record<string, unknown>).default === 'object'
    ).toBe(true)
  })
})

// ============ Media module ============
describe('media module', () => {
  it('thumbnailDisplayUrl handles empty', async () => {
    const { thumbnailDisplayUrl } = await import('@main/services/media')
    expect(thumbnailDisplayUrl('')).toBeFalsy()
    expect(thumbnailDisplayUrl(undefined)).toBeFalsy()
  })

  it('toMediaUrl handles empty', async () => {
    const { toMediaUrl } = await import('@main/services/media')
    expect(toMediaUrl('')).toBeFalsy()
    expect(toMediaUrl(undefined)).toBeFalsy()
  })
})

// ============ Registry search ============
describe('registry search', () => {
  it('module loads', async () => {
    const mod = await import('@main/services/registry')
    expect(mod).toBeDefined()
  })
})

// ============ NetProbe ============
describe('netProbe', () => {
  it('recommendMirrors is exported', async () => {
    const mod = await import('@main/services/netProbe')
    expect(typeof mod.recommendMirrors).toBe('function')
  })
})

// ============ ComfyApi ============
describe('comfyApi', () => {
  it('ComfyApiClient is a class', async () => {
    const { ComfyApiClient } = await import('@main/services/comfyApi')
    expect(typeof ComfyApiClient).toBe('function')
    const client = new ComfyApiClient('http://127.0.0.1:8188')
    expect(client).toBeDefined()
  })
})

// ============ Environment service ============
describe('env service', () => {
  it('module loads', async () => {
    const mod = await import('@main/services/env')
    expect(mod).toBeDefined()
    expect(mod.envService).toBeDefined()
  })
})

// ============ Bootstrap service ============
describe('bootstrap service', () => {
  it('module loads and exposes bootstrapService', async () => {
    const mod = await import('@main/services/bootstrap')
    expect(mod.bootstrapService).toBeDefined()
  })
})

// ============ Desktop service ============
describe('desktop service', () => {
  it('module loads', async () => {
    const mod = await import('@main/services/desktop')
    expect(mod).toBeDefined()
    expect(typeof mod.setLaunchOnBoot).toBe('function')
  })
})

// ============ Tray service ============
describe('tray service', () => {
  it('exports createTray and destroyTray', async () => {
    const mod = await import('@main/services/tray')
    expect(typeof mod.createTray).toBe('function')
    expect(typeof mod.destroyTray).toBe('function')
    expect(typeof mod.refreshTray).toBe('function')
    expect(typeof mod.hasTray).toBe('function')
  })
})

// ============ Proxy module ============
describe('proxy module', () => {
  it('exports proxyEnv and syncProxyFromSettings', async () => {
    const mod = await import('@main/services/proxy')
    expect(typeof mod.proxyEnv).toBe('function')
    expect(typeof mod.syncProxyFromSettings).toBe('function')
    expect(typeof mod.testProxy).toBe('function')
    expect(typeof mod.redactProxyUrl).toBe('function')
  })

  it('proxyEnv builds env vars', async () => {
    const { proxyEnv } = await import('@main/services/proxy')
    const env = proxyEnv({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      username: '',
      password: '',
      bypass: 'localhost'
    })
    expect(env.HTTP_PROXY || env.HTTPS_PROXY).toBeTruthy()
    expect(env.NO_PROXY).toContain('localhost')
  })

  it('proxyEnv returns empty for disabled', async () => {
    const { proxyEnv } = await import('@main/services/proxy')
    const env = proxyEnv({
      enabled: false,
      protocol: 'http',
      host: '',
      port: 0,
      username: '',
      password: '',
      bypass: ''
    })
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
  })

  it('redactProxyUrl hides password', async () => {
    const { redactProxyUrl } = await import('@main/services/proxy')
    const url = redactProxyUrl({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      username: 'user',
      password: 'secret123',
      bypass: ''
    })
    expect(url).not.toContain('secret123')
  })
})

// ============ Installer validation ============
describe('installer git URL validation', () => {
  it('assertSafeGitUrl allows https/ssh/git@', async () => {
    const { assertSafeGitUrl } = await import('@main/services/installer')
    expect(assertSafeGitUrl('https://github.com/user/repo.git')).toBeTruthy()
    expect(assertSafeGitUrl('git@github.com:user/repo.git')).toBeTruthy()
    expect(assertSafeGitUrl('ssh://git@github.com/user/repo.git')).toBeTruthy()
  })

  it('assertSafeGitUrl blocks ext::', async () => {
    const { assertSafeGitUrl } = await import('@main/services/installer')
    expect(() => assertSafeGitUrl('ext::sh -c evil')).toThrow()
  })

  it('assertSafeGitUrl blocks dash injection', async () => {
    const { assertSafeGitUrl } = await import('@main/services/installer')
    expect(() => assertSafeGitUrl('-upload-pack=evil')).toThrow()
    expect(() => assertSafeGitUrl('https://-evil.com/x')).toThrow()
  })

  it('assertSafeGitUrl blocks non-git schemes', async () => {
    const { assertSafeGitUrl } = await import('@main/services/installer')
    expect(() => assertSafeGitUrl('file:///etc/passwd')).toThrow()
    expect(() => assertSafeGitUrl('ftp://example.com')).toThrow()
    expect(() => assertSafeGitUrl('')).toThrow()
  })

  it('assertSafeBranch allows valid branches', async () => {
    const { assertSafeBranch } = await import('@main/services/installer')
    expect(assertSafeBranch('main')).toBe('main')
    expect(assertSafeBranch('feature/foo-bar')).toBe('feature/foo-bar')
    expect(assertSafeBranch('v1.0.0')).toBe('v1.0.0')
    expect(assertSafeBranch('')).toBe('')
  })

  it('assertSafeBranch blocks dangerous branches', async () => {
    const { assertSafeBranch } = await import('@main/services/installer')
    expect(() => assertSafeBranch('--upload-pack')).toThrow()
    expect(() => assertSafeBranch('..')).toThrow()
    expect(() => assertSafeBranch('a; rm -rf /')).toThrow()
    expect(() => assertSafeBranch('a b')).toThrow()
  })
})

// ============ IPC contract ============
describe('IPC channel map consistency', () => {
  it('all IpcChannelMap keys are implemented in handlers', () => {
    const types = readSrc('src/shared/types.ts')
    const handlers = readSrc('src/main/ipc/handlers.ts')
    // Extract channel names from IpcChannelMap
    const mapMatch = types.match(/export type IpcChannelMap = \{([\s\S]*?)\n\}/)
    expect(mapMatch).toBeTruthy()
    const channels = [...mapMatch![1].matchAll(/'([a-zA-Z0-9_.]+)':/g)].map((m) => m[1])
    expect(channels.length).toBeGreaterThan(100)
    for (const ch of channels) {
      expect(handlers).toContain(`'${ch}'`)
    }
  })
})

// ============ IPC events ============
describe('IPC_EVENTS constants', () => {
  it('all events are defined', async () => {
    const { IPC_EVENTS } = await import('@shared/types')
    const expected = [
      'instanceStatus',
      'instanceLog',
      'modelScanProgress',
      'downloadProgress',
      'monitorTick',
      'monitorWs',
      'doctorProgress',
      'batchProgress',
      'nodeInstallProgress',
      'installProgress',
      'registryIndexProgress',
      'notification',
      'runtimeProgress',
      'comfyUpdateProgress',
      'nodeUpdateProgress',
      'repairProgress',
      'nodeOperationProgress'
    ]
    for (const e of expected) {
      expect(IPC_EVENTS[e as keyof typeof IPC_EVENTS]).toBeTruthy()
    }
  })
})
