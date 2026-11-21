/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  configs: [] as any[],
  settings: { modelScanRoots: [] as string[] },
  ownRenderer: true,
  view: null as any,
  views: [] as any[],
  windows: [] as any[],
  stats: null as any
}))

vi.mock('electron', () => {
  class WebContentsView {
    webContents: any
    setBounds = vi.fn()
    constructor() {
      this.webContents = {
        on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
          this.webContents[`on:${event}`] = cb
        }),
        once: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
          this.webContents[`once:${event}`] = cb
        }),
        setWindowOpenHandler: vi.fn((cb: any) => {
          this.webContents.windowOpen = cb
        }),
        close: vi.fn(),
        loadURL: vi.fn(async () => undefined)
      }
      h.view = this
      h.views.push(this)
    }
  }
  return {
    WebContentsView,
    BrowserWindow: class {
      static getAllWindows(): any[] {
        return h.windows
      }
    },
    shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() }
  }
})

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => h.configs,
  loadSettings: () => h.settings,
  userDataDir: () => join(h.root, 'userData'),
  workflowLibraryDir: () => join(h.root, 'workflows')
}))

vi.mock('../../src/main/services/secretStorage', () => ({
  secretStorageBackend: () => 'plaintext'
}))

vi.mock('../../src/main/services/p1p2', () => ({
  remoteService: {
    list: () => [{ id: 'r1', baseUrl: 'http://remote:8188' }]
  }
}))

vi.mock('../../src/main/services/rendererEntry', () => ({
  isOwnRendererUrl: () => h.ownRenderer
}))

vi.mock('../../src/main/services/comfyApi', () => ({
  ComfyApiClient: class {
    constructor(public url: string) {}
    async systemStats() {
      return h.stats
    }
  }
}))

import {
  assertApprovedExecutable,
  assertApprovedInstallRoot,
  assertApprovedVenvBase,
  assertApprovedVenvPath,
  assertModelScanRootsPatch,
  assertSafeEndpointSettings,
  assertTrustedIpcSender,
  approveReadPath,
  approvedReadRootsList,
  broadcast,
  broadcastNotification,
  closeEmbed,
  collectRevealRoots,
  createIpcContext,
  fail,
  isPathInsideInstance,
  isSafeReadPath,
  isTrustedComfyUrl,
  ok,
  notifyPipResult,
  openEmbedInternal,
  remoteSummary,
  requireRunningInstance,
  resizeEmbed,
  settingsView,
  toPlainIpcData,
  wrap
} from '../../src/main/ipc/context'
import { pathCapabilities } from '../../src/main/services/pathCapability'
import { DEFAULT_SETTINGS } from '../../src/shared/constants'

beforeAll(() => {
  h.root = mkdtempSync(join(tmpdir(), 'comfypilot-context-'))
  mkdirSync(join(h.root, 'comfy', 'models'), { recursive: true })
  mkdirSync(join(h.root, 'comfy', '.venv', 'bin'), { recursive: true })
  mkdirSync(join(h.root, 'userData'), { recursive: true })
  mkdirSync(join(h.root, 'workflows'), { recursive: true })
  writeFileSync(join(h.root, 'comfy', 'main.py'), 'x')
  writeFileSync(join(h.root, 'comfy', 'x.json'), '{}')
  writeFileSync(join(h.root, 'comfy', '.venv', 'bin', 'python'), 'x')
  h.configs = [
    {
      ...(DEFAULT_SETTINGS as any),
      id: 'i1',
      name: 'Main',
      path: join(h.root, 'comfy'),
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default'
    }
  ]
  h.settings = { ...(DEFAULT_SETTINGS as any), modelScanRoots: [join(h.root, 'comfy', 'models')] }
})

afterAll(() => rmSync(h.root, { recursive: true, force: true }))

beforeEach(() => {
  pathCapabilities.revokeAll()
  h.ownRenderer = true
  h.views.length = 0
  h.view = null
  h.windows.length = 0
  h.stats = { ok: true }
  h.configs = [
    {
      ...(DEFAULT_SETTINGS as any),
      id: 'i1',
      name: 'Main',
      path: join(h.root, 'comfy'),
      port: 8188,
      listen: '127.0.0.1',
      extraArgs: [],
      argTemplateId: 'default'
    }
  ]
  h.settings = { ...(DEFAULT_SETTINGS as any), modelScanRoots: [join(h.root, 'comfy', 'models')] }
})

describe('IPC context helpers', () => {
  it('serialises results and failures with every optional error field', () => {
    expect(ok(undefined)).toEqual({ ok: true, data: undefined })
    expect(ok(1)).toEqual({ ok: true, data: 1 })
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } })
    const circular: any = {}
    circular.self = circular
    expect(() => toPlainIpcData(circular)).toThrow(/not serialisable/)
    const err = Object.assign(new Error('boom'), {
      code: 'X',
      suggestedPort: 9,
      messageKey: 'k',
      params: { a: 1 },
      detail: 'd',
      retryable: true
    })
    expect(fail(err)).toMatchObject({ ok: false, error: 'boom', code: 'X', suggestedPort: 9 })
    expect(fail('plain')).toEqual({ ok: false, error: 'plain' })
    expect(fail({})).toMatchObject({ ok: false })
  })

  it('trusts only the app renderer frame, failing closed in production', async () => {
    delete process.env.VITEST
    process.env.NODE_ENV = 'production'
    expect(() => assertTrustedIpcSender(null)).toThrow(/without a sender frame/)
    expect(() => assertTrustedIpcSender({})).toThrow(/without a sender frame/)
    process.env.NODE_ENV = 'test'
    h.ownRenderer = false
    expect(() => assertTrustedIpcSender({ senderFrame: { url: 'x' } })).toThrow(/untrusted/)
    h.ownRenderer = true
    expect(() => assertTrustedIpcSender({ senderFrame: { url: 'app://x' } })).not.toThrow()
    expect(() => assertTrustedIpcSender({ senderFrame: null })).toThrow(/untrusted/)
    process.env.VITEST = '1'
    process.env.NODE_ENV = 'test'
    expect(() => assertTrustedIpcSender(null)).not.toThrow()
    expect(() => assertTrustedIpcSender({})).not.toThrow()
  })

  it('wraps handlers and serialises their result/failure', async () => {
    const good = wrap((a: number, b: number) => a + b)
    expect(await good({}, 1, 2)).toEqual({ ok: true, data: 3 })
    const bad = wrap(() => {
      throw new Error('no')
    })
    expect(await bad({})).toMatchObject({ ok: false, error: 'no' })
  })

  it('validates trusted ComfyUI URLs', () => {
    expect(isTrustedComfyUrl(null)).toBe(false)
    expect(isTrustedComfyUrl('not a url')).toBe(false)
    expect(isTrustedComfyUrl('ftp://localhost')).toBe(false)
    expect(isTrustedComfyUrl('http://localhost:8188')).toBe(true)
    expect(isTrustedComfyUrl('http://127.0.0.1:8188')).toBe(true)
    expect(isTrustedComfyUrl('http://remote:8188')).toBe(true)
    expect(isTrustedComfyUrl(`http://127.0.0.1:${h.configs[0].port}`)).toBe(true)
    h.configs = [{ ...h.configs[0], path: '' }]
    expect(isTrustedComfyUrl('http://127.0.0.1:8188')).toBe(true)
    h.configs = []
    expect(isTrustedComfyUrl('http://example.com:8188')).toBe(false)
  })

  it('approves read paths and validates executables', () => {
    approveReadPath(null)
    approveReadPath(join(h.root, 'userData'))
    expect(approvedReadRootsList().length).toBeGreaterThan(0)
    expect(() => assertApprovedExecutable('', 'pythonPath')).not.toThrow()
    expect(() => assertApprovedExecutable('a\0b', 'pythonPath')).toThrow(/invalid character/)
    expect(() => assertApprovedExecutable('../python', 'pythonPath')).toThrow(/parent/)
    for (const p of [
      'python',
      'python3',
      'python3.13',
      'py.exe',
      'C:/Windows/System32/python.exe',
      'C:/Program Files/Python/python.exe',
      'C:/Program Files (x86)/Python/python.exe',
      '/usr/bin/python3',
      '/usr/local/bin/python',
      '/opt/python/bin/python3',
      'C:/Users/u/AppData/Local/Programs/Python/python.exe',
      '/home/u/miniconda/bin/python',
      '/home/u/anaconda/bin/python',
      '/x/.venv/bin/python',
      '/x/venv-1/scripts/python.exe',
      '/x/venv/bin/python3.11'
    ]) {
      expect(() => assertApprovedExecutable(p, 'pythonPath'), p).not.toThrow()
    }
    expect(() => assertApprovedExecutable('/x/random/python', 'pythonPath')).toThrow(/picker/)
    expect(() =>
      assertApprovedExecutable(
        join(h.root, 'comfy', 'python_embeded', 'python.exe'),
        'p',
        h.configs[0].path
      )
    ).not.toThrow()
    expect(() =>
      assertApprovedExecutable(
        join(h.root, 'comfy', 'python', 'bin', 'python3'),
        'p',
        h.configs[0].path
      )
    ).not.toThrow()
    expect(() =>
      assertApprovedExecutable(join(h.root, 'python', 'python.exe'), 'p', h.configs[0].path)
    ).not.toThrow()
    expect(() =>
      assertApprovedExecutable(join(h.root, 'comfy', 'evil.exe'), 'p', h.configs[0].path)
    ).toThrow(/picker/)
  })

  it('validates venv paths and bases', () => {
    expect(() => assertApprovedVenvPath('', h.configs[0].path)).not.toThrow()
    expect(() => assertApprovedVenvPath('a\0b', h.configs[0].path)).toThrow(/invalid character/)
    expect(() => assertApprovedVenvPath('../venv', h.configs[0].path)).toThrow(/parent/)
    expect(() =>
      assertApprovedVenvPath(join(h.root, 'comfy', '.venv'), h.configs[0].path)
    ).not.toThrow()
    expect(() => assertApprovedVenvPath(join(h.root, 'venv'), h.configs[0].path)).not.toThrow()
    expect(() =>
      assertApprovedVenvPath(join(h.root, '..', 'outside-venv'), h.configs[0].path)
    ).toThrow(/inside/)
    pathCapabilities.issue(join(h.root, 'picked'), 'write', 'picker')
    expect(() => assertApprovedVenvPath(join(h.root, 'picked'), h.configs[0].path)).not.toThrow()

    expect(() => assertApprovedVenvBase('')).toThrow(/Invalid/)
    expect(() => assertApprovedVenvBase('a\0b')).toThrow(/Invalid/)
    expect(() => assertApprovedVenvBase('relative')).toThrow(/absolute/)
    expect(() => assertApprovedVenvBase(`${h.root}/../x`)).toThrow(/parent/)
    expect(() => assertApprovedVenvBase(join(h.root, 'userData', 'venv'))).not.toThrow()
    expect(() => assertApprovedVenvBase(h.root)).not.toThrow()
    expect(() => assertApprovedVenvBase(join(h.root, 'comfy', '.venv'))).not.toThrow()
    expect(() => assertApprovedVenvBase(join(h.root, '..', 'elsewhere'))).toThrow(/inside/)
    pathCapabilities.issue(join(h.root, 'pickedbase'), 'write', 'picker')
    expect(() => assertApprovedVenvBase(join(h.root, 'pickedbase'))).not.toThrow()

    expect(isPathInsideInstance(join(h.root, 'comfy', 'x'))).toBe(true)
    expect(isPathInsideInstance(join(h.root, 'outside'))).toBe(false)
  })

  it('validates install roots, scan roots and endpoint settings', () => {
    expect(() => assertApprovedInstallRoot('')).toThrow(/Invalid/)
    expect(() => assertApprovedInstallRoot('a\0b')).toThrow(/Invalid/)
    expect(() => assertApprovedInstallRoot('relative')).toThrow(/absolute/)
    expect(() => assertApprovedInstallRoot(join(h.root, 'x'))).toThrow(/picker/)
    pathCapabilities.issue(join(h.root, 'install'), 'write', 'picker')
    expect(() => assertApprovedInstallRoot(join(h.root, 'install', 'sub'))).not.toThrow()

    expect(() => assertModelScanRootsPatch(undefined)).not.toThrow()
    expect(() => assertModelScanRootsPatch('x')).toThrow(/array/)
    expect(() => assertModelScanRootsPatch([1])).toThrow(/paths/)
    expect(() => assertModelScanRootsPatch([''])).toThrow(/paths/)
    expect(() => assertModelScanRootsPatch(['a\0b'])).toThrow(/invalid path/)
    expect(() => assertModelScanRootsPatch(['/'])).toThrow(/filesystem root/)
    expect(() => assertModelScanRootsPatch([h.settings.modelScanRoots[0]])).not.toThrow()
    expect(() => assertModelScanRootsPatch([join(h.root, 'new')])).toThrow(/picker/)
    pathCapabilities.issue(join(h.root, 'new'), 'read', 'picker')
    expect(() => assertModelScanRootsPatch([join(h.root, 'new')])).not.toThrow()

    expect(() =>
      assertSafeEndpointSettings({ githubEndpoint: 'https://example.com', hfEndpoint: '' })
    ).not.toThrow()
    expect(() => assertSafeEndpointSettings({ githubEndpoint: 'ftp://evil' })).toThrow()
    expect(() => assertSafeEndpointSettings({ githubEndpoint: 'http://user:pw@evil' })).toThrow()
  })

  it('projects settings and remote summaries without secrets', () => {
    const settings = {
      ...(DEFAULT_SETTINGS as any),
      proxy: { ...(DEFAULT_SETTINGS as any).proxy, password: 'secret' }
    }
    const view = settingsView(settings)
    expect(view.proxy).not.toHaveProperty('password')
    expect(view.proxy.hasPassword).toBe(true)
    expect(view.proxy.backend).toBe('plaintext')
    expect(
      remoteSummary({ id: 'r', name: 'R', baseUrl: 'http://x', label: '', enabled: true })
    ).toMatchObject({
      id: 'r',
      apiKeySet: false
    })
    expect(
      remoteSummary({
        id: 'r',
        name: 'R',
        baseUrl: 'http://x',
        label: '',
        enabled: true,
        apiKey: 'k'
      })
    ).toMatchObject({ apiKeySet: true })
    expect(
      remoteSummary({
        id: 'r',
        name: 'R',
        baseUrl: 'http://x',
        label: '',
        enabled: true,
        apiKey: 'k',
        apiKeyLocked: true
      })
    ).toMatchObject({ apiKeySet: false })

    expect(isSafeReadPath(join(h.root, 'userData', 'x.json'))).toBe(false)
    approveReadPath(join(h.root, 'userData'))
    expect(isSafeReadPath(join(h.root, 'userData', 'x.json'))).toBe(true)
    expect(isSafeReadPath(join(h.root, 'comfy', 'x.json'))).toBe(true)
    expect(isSafeReadPath(join(h.root, 'outside', 'x.json'))).toBe(false)
  })

  it('opens, resizes, reports and closes the embed view', async () => {
    const ctx = createIpcContext(() => null)
    expect(await openEmbedInternal(ctx, 'http://localhost:8188')).toBe(false)
    expect(resizeEmbed({ x: 0, y: 0, width: 1, height: 1 })).toBe(false)

    const win: any = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      getBounds: () => ({ width: 1200, height: 800 })
    }
    const ctx2 = createIpcContext(() => win)
    await expect(openEmbedInternal(ctx2, 'http://evil.example.com')).rejects.toThrow(/unsafe/)
    expect(await openEmbedInternal(ctx2, 'http://localhost:8188', 'title')).toBe(true)
    const first = h.view
    expect(first.setBounds).toHaveBeenCalled()
    first.webContents['once:page-title-updated']({ preventDefault: vi.fn() })
    expect(first.webContents.windowOpen({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(first.webContents.windowOpen({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    const prevent = vi.fn()
    first.webContents['on:will-navigate']({ preventDefault: prevent }, 'http://localhost:8188')
    expect(prevent).not.toHaveBeenCalled()
    first.webContents['on:will-navigate']({ preventDefault: prevent }, 'http://evil')
    expect(prevent).toHaveBeenCalled()
    first.webContents['on:did-finish-load']()
    first.webContents['on:did-fail-load']({}, -1, 'err', 'http://x', true)
    first.webContents['on:did-fail-load']({}, -1, 'err', 'http://x', false)
    expect(await openEmbedInternal(ctx2, 'http://localhost:8188')).toBe(true)
    expect(win.contentView.removeChildView).toHaveBeenCalled()
    expect(resizeEmbed({ x: 1, y: 2, width: 3, height: 4 })).toBe(true)
    h.view.webContents.loadURL.mockRejectedValueOnce(new Error('load failed'))
    await openEmbedInternal(ctx2, 'http://localhost:8188')
    await Promise.resolve()
    expect(closeEmbed(ctx2)).toBe(true)
    expect(closeEmbed(createIpcContext(() => null))).toBe(true)
  })

  it('covers the remaining projection, notification and target branches', async () => {
    expect(() =>
      toPlainIpcData({
        toJSON() {
          throw 'string failure'
        }
      })
    ).toThrow(/string failure/)
    expect(() => assertTrustedIpcSender({ senderFrame: { url: '' } })).not.toThrow()
    h.configs = [{ ...h.configs[0], path: '' }]
    expect(isTrustedComfyUrl('http://example.com:8188')).toBe(false)
    h.configs = [{ ...h.configs[0] }]
    pathCapabilities.issue(join(h.root, 'exe'), 'exec', 'picker')
    expect(() => assertApprovedExecutable(join(h.root, 'exe', 'python'), 'p')).not.toThrow()
    expect(() => assertApprovedVenvBase(join(homedir(), 'venv'))).not.toThrow()
    h.configs = [
      { ...h.configs[0], path: '' },
      { ...h.configs[0], path: join(h.root, 'comfy') }
    ]
    expect(() => assertApprovedVenvBase(join(h.root, '..', 'x2'))).toThrow(/inside/)
    expect(isSafeReadPath(join(h.root, 'comfy', 'x.json'))).toBe(true)
    h.settings = { ...(DEFAULT_SETTINGS as any), modelScanRoots: undefined }
    expect(() => assertModelScanRootsPatch([])).not.toThrow()
    expect(await collectRevealRoots()).toBeTruthy()
    h.settings = { ...(DEFAULT_SETTINGS as any), modelScanRoots: [] }
    h.configs = [{ ...h.configs[0] }]

    const sent: any[] = []
    h.windows = [
      { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: vi.fn() } },
      { isDestroyed: () => false, webContents: { isDestroyed: () => true, send: vi.fn() } },
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (...a: any[]) => {
            sent.push(a)
          }
        }
      },
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: () => {
            throw new Error('dead')
          }
        }
      }
    ]
    broadcast('x', 1)
    expect(sent).toHaveLength(1)
    broadcastNotification({ type: 'info', title: 't', message: 'm' })
    notifyPipResult({ cancelled: true, ok: false, requested: [], installed: [] })
    notifyPipResult({ ok: true, requested: ['a'], installed: [] })
    notifyPipResult({ ok: true, requested: [], installed: ['b'] })
    notifyPipResult({ ok: false, requested: [], installed: [], error: 'e' })
    notifyPipResult({ ok: false, requested: [], installed: [] })

    h.stats = null
    await expect(requireRunningInstance(undefined)).rejects.toMatchObject({
      code: 'TARGET_REQUIRED'
    })
    await expect(requireRunningInstance('missing')).rejects.toThrow(/not found/)
    await expect(requireRunningInstance('i1')).rejects.toThrow(/not running/)
    h.stats = { ok: true }
    expect((await requireRunningInstance('i1')).id).toBe('i1')

    h.view = null
    const ctx = createIpcContext(
      () =>
        ({
          contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
          getBounds: () => ({ width: 100, height: 100 })
        }) as any
    )
    h.view = null
    const original = h.view
    await openEmbedInternal(ctx, 'http://localhost:8188')
    h.view.webContents.loadURL.mockRejectedValueOnce('plain failure')
    await openEmbedInternal(ctx, 'http://localhost:8188')
    await Promise.resolve()
    expect(original).toBeNull()
    closeEmbed(ctx)
  })

  it('collects reveal roots and skips symlinks', async () => {
    const link = join(h.root, 'models-link')
    try {
      symlinkSync(join(h.root, 'comfy'), link)
    } catch {
      /* symlinks may be unavailable */
    }
    h.settings = { ...(DEFAULT_SETTINGS as any), modelScanRoots: [link] }
    const roots = await collectRevealRoots()
    expect(roots).toContain(join(h.root, 'comfy'))
    expect(roots).not.toContain(link)
    h.settings = { ...(DEFAULT_SETTINGS as any), modelScanRoots: [] }
  })
})
