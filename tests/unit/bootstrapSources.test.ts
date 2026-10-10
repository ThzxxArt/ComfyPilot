/**
 * Zero-prereq bootstrap: runtime source table + torch index resolution.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: { getPath: () => path.join(os.tmpdir(), 'cp-boot-test') },
    session: { defaultSession: { fetch: globalThis.fetch, setProxy: async () => undefined } }
  }
})
vi.mock('systeminformation', () => ({
  default: { graphics: async () => ({ controllers: [] }) }
}))

import { RUNTIME_SOURCES, TORCH_DISK_GB, STARTER_MODELS, COMFY_ZIP_URL } from '../../src/shared/constants'

describe('runtime sources table', () => {
  it('covers win/linux/darwin uv and portable python', () => {
    expect(RUNTIME_SOURCES['uv-win-x64']).toBeTruthy()
    expect(RUNTIME_SOURCES['uv-linux-x64']).toBeTruthy()
    expect(RUNTIME_SOURCES['uv-darwin-arm64']).toBeTruthy()
    expect(RUNTIME_SOURCES['python-win-x64']).toBeTruthy()
    expect(RUNTIME_SOURCES['mingit-win-x64']).toBeTruthy()
  })

  it('all sources are https with size hints', () => {
    for (const s of Object.values(RUNTIME_SOURCES)) {
      expect(s.url.startsWith('https://')).toBe(true)
      expect(s.sizeHint).toBeGreaterThan(0)
    }
  })
})

describe('torch disk estimates', () => {
  it('cu130 needs more disk than cpu', () => {
    expect(TORCH_DISK_GB.cu130).toBeGreaterThan(TORCH_DISK_GB.cpu)
    expect(TORCH_DISK_GB.cpu).toBeGreaterThan(0)
  })
})

describe('starter models', () => {
  it('offers at least one recommended pack', () => {
    expect(STARTER_MODELS.length).toBeGreaterThanOrEqual(1)
    expect(STARTER_MODELS.some((m) => m.recommended)).toBe(true)
    for (const m of STARTER_MODELS) {
      expect(m.url.startsWith('https://')).toBe(true)
      expect(m.approxBytes).toBeGreaterThan(0)
    }
  })
})

describe('comfy zip url', () => {
  it('is a GitHub archive URL (no .git)', () => {
    expect(COMFY_ZIP_URL).toContain('/archive/')
    expect(COMFY_ZIP_URL.endsWith('.zip')).toBe(true)
  })
})

describe('findInRuntimes nested install_only layout', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('finds python under runtimes/python/python/python.exe and mingit cmd/git.exe', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const { app } = await import('electron')
    const { findInRuntimes } = await import('../../src/main/services/bootstrap')
    const root = path.join(app.getPath('userData'), 'runtimes')
    // python-build-standalone install_only extracts a top-level python/ dir
    const pyDir = path.join(root, 'python', 'python')
    fs.mkdirSync(pyDir, { recursive: true })
    const pyExe = path.join(pyDir, process.platform === 'win32' ? 'python.exe' : 'python3')
    fs.writeFileSync(pyExe, '')
    // MinGit extracts cmd/git.exe (sometimes under mingit64/)
    const gitDir = path.join(root, 'mingit', 'mingit64', 'cmd')
    fs.mkdirSync(gitDir, { recursive: true })
    fs.writeFileSync(path.join(gitDir, process.platform === 'win32' ? 'git.exe' : 'git'), '')

    const foundPy = findInRuntimes('python')
    expect(foundPy).toBeTruthy()
    expect(foundPy!.replace(/\\/g, '/')).toContain('python/python/')
    const foundGit = findInRuntimes('git')
    expect(foundGit).toBeTruthy()
    expect(foundGit!.replace(/\\/g, '/')).toContain('mingit64/cmd/')
    // uv direct layout
    fs.mkdirSync(path.join(root, 'uv'), { recursive: true })
    fs.writeFileSync(path.join(root, 'uv', process.platform === 'win32' ? 'uv.exe' : 'uv'), '')
    expect(findInRuntimes('uv')).toBeTruthy()
    expect(findInRuntimes('definitely-missing-binary-xyz')).toBeNull()
  })
})

describe('resolveTorchIndex', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('uses official index and channel suffix', async () => {
    const { resolveTorchIndex } = await import('../../src/main/services/installer')
    expect(resolveTorchIndex('cpu')).toContain('download.pytorch.org')
    expect(resolveTorchIndex('cu126')).toContain('cu126')
    expect(resolveTorchIndex('cu130')).toContain('cu130')
  })
})

describe('APP_VERSION injection branches', () => {
  it('uses the build-injected __APP_VERSION__ when present', async () => {
    vi.resetModules()
    ;(globalThis as Record<string, unknown>)['__APP_VERSION__'] = '9.9.9'
    const mod = await import('../../src/shared/constants')
    expect(mod.APP_VERSION).toBe('9.9.9')
    delete (globalThis as Record<string, unknown>)['__APP_VERSION__']
  })

  it('falls back to the literal when __APP_VERSION__ is absent or empty', async () => {
    vi.resetModules()
    delete (globalThis as Record<string, unknown>)['__APP_VERSION__']
    const mod = await import('../../src/shared/constants')
    expect(mod.APP_VERSION).toBe('0.1.5')

    vi.resetModules()
    ;(globalThis as Record<string, unknown>)['__APP_VERSION__'] = ''
    const mod2 = await import('../../src/shared/constants')
    expect(mod2.APP_VERSION).toBe('0.1.5')
    delete (globalThis as Record<string, unknown>)['__APP_VERSION__']
  })
})
