/**
 * Integration: installer security gates without running real git/pip.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return { app: { getPath: () => path.join(os.tmpdir(), 'cp-int') } }
})

// Avoid pulling systeminformation GPU probes in unit env
vi.mock('systeminformation', () => ({
  default: { graphics: async () => ({ controllers: [] }) }
}))

describe('installer service gates (integration)', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('start rejects invalid installRoot and bad git URLs (git mode)', async () => {
    const os = await import('os')
    const path = await import('path')
    const { installerService } = await import('../../src/main/services/installer')
    await expect(
      installerService.start({
        installRoot: '',
        instanceName: 'x',
        useUv: false,
        pythonPath: 'python',
        torchChannel: 'cpu',
        comfyRepo: 'https://github.com/a/b.git',
        comfyBranch: '',
        createDesktopShortcut: false,
        autoStart: false,
        comfySource: 'git'
      })
    ).rejects.toThrow(/install root/i)

    await expect(
      installerService.start({
        installRoot: path.join(os.tmpdir(), 'cp-int', 'ok'),
        instanceName: 'x',
        useUv: false,
        pythonPath: 'python',
        torchChannel: 'cpu',
        comfyRepo: 'ext::sh -c evil',
        comfyBranch: '',
        createDesktopShortcut: false,
        autoStart: false,
        comfySource: 'git'
      })
    ).rejects.toThrow()
  })

  it('zip mode does not require git URL validation (zero-prereq path)', async () => {
    const os = await import('os')
    const path = await import('path')
    const { installerService } = await import('../../src/main/services/installer')
    // Bad git URL is irrelevant in zip mode — start returns a runId (async plan).
    const res = await installerService.start({
      installRoot: path.join(os.tmpdir(), 'cp-int', 'zip-mode'),
      instanceName: 'x',
      useUv: false,
      pythonPath: 'python',
      torchChannel: 'cpu',
      comfyRepo: 'ext::sh -c evil',
      comfyBranch: '',
      createDesktopShortcut: false,
      autoStart: false,
      comfySource: 'zip',
      skipStarter: true
    })
    expect(res.runId).toBeTruthy()
    installerService.cancel()
  })

  it('preflight reports checks array', async () => {
    const os = await import('os')
    const path = await import('path')
    const { installerService } = await import('../../src/main/services/installer')
    const res = await installerService.preflight({
      installRoot: path.join(os.tmpdir(), 'cp-int', 'ok'),
      useUv: false,
      pythonPath: 'definitely-not-a-python-binary-xyz'
    })
    expect(Array.isArray(res.checks)).toBe(true)
    expect(res.checks.find((c) => c.id === 'python')?.ok).toBe(false)
  })
})
