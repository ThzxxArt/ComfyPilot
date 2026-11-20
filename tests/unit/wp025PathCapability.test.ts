import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  roots: [] as string[],
  userData: ''
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: class {},
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  clipboard: { writeText: vi.fn() }
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => ({ modelScanRoots: h.roots, proxy: {} }),
  loadInstanceConfigs: () => [],
  userDataDir: () => h.userData,
  workflowLibraryDir: () => join(h.userData, 'workflows'),
  listRemotes: () => []
}))

vi.mock('../../src/main/services/p1p2', () => ({
  remoteService: { list: () => [] }
}))

import {
  approveReadPath,
  assertApprovedExecutable,
  assertApprovedInstallRoot,
  assertModelScanRootsPatch
} from '../../src/main/ipc/context'
import { PathCapabilityStore, pathCapabilities } from '../../src/main/services/pathCapability'
import { isOwnRendererUrl } from '../../src/main/services/rendererEntry'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cp-caps-'))
  h.userData = join(root, 'userData')
  h.roots = []
  mkdirSync(h.userData, { recursive: true })
  pathCapabilities.revokeAll()
})

afterEach(() => {
  pathCapabilities.revokeAll()
  delete process.env.ELECTRON_RENDERER_URL
  rmSync(root, { recursive: true, force: true })
})

describe('PathCapability (0.2.5 WP10)', () => {
  it('issues read/write/exec scopes and expires them', async () => {
    const dir = join(root, 'picked')
    mkdirSync(dir)
    const cap = pathCapabilities.issue(dir, 'read', 'picker', { ttlMs: 15 })
    expect(pathCapabilities.covers(join(dir, 'a.txt'), 'read')).toBe(true)
    expect(pathCapabilities.covers(join(dir, 'a.txt'), 'write')).toBe(false)
    expect(cap.source).toBe('picker')
    await new Promise((r) => setTimeout(r, 40))
    expect(pathCapabilities.covers(join(dir, 'a.txt'), 'read')).toBe(false)
  })

  it('covers new write targets through their real parent', () => {
    const dir = join(root, 'writable')
    mkdirSync(dir)
    pathCapabilities.issue(dir, 'write', 'picker')
    expect(pathCapabilities.covers(join(dir, 'new-file.bin'), 'write')).toBe(true)
    expect(pathCapabilities.covers(join(root, 'elsewhere.bin'), 'write')).toBe(false)
  })

  it('refuses a symlinked root for output/export operations', () => {
    const real = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(real)
    symlinkSync(real, link)
    expect(() => PathCapabilityStore.assertNotSymlinkRoot(link)).toThrow(/symlink/i)
    expect(() => PathCapabilityStore.assertNotSymlinkRoot(real)).not.toThrow()
  })

  it('rejects modelScanRoots ["/"] and arbitrary home paths', () => {
    expect(() => assertModelScanRootsPatch(['/'])).toThrow(/filesystem root/i)
    const homeLike = join(root, 'home')
    mkdirSync(homeLike)
    expect(() => assertModelScanRootsPatch([homeLike])).toThrow(/directory picker/i)

    // A picker grant is the only way to add a new root.
    approveReadPath(homeLike)
    expect(() => assertModelScanRootsPatch([homeLike])).not.toThrow()
  })

  it('accepts an existing root without a new capability (0.2.4 compatibility)', () => {
    const existing = join(root, 'existing-models')
    mkdirSync(existing)
    h.roots = [existing]
    expect(() => assertModelScanRootsPatch([existing])).not.toThrow()
  })

  it('rejects arbitrary executables inside an instance, accepts venv/embedded python', () => {
    const instance = join(root, 'ComfyUI')
    mkdirSync(join(instance, 'python_embeded'), { recursive: true })
    writeFileSync(join(instance, 'python_embeded', 'python.exe'), 'MZ')
    writeFileSync(join(instance, 'python.exe'), 'MZ')
    expect(() =>
      assertApprovedExecutable(join(instance, 'python_embeded', 'python.exe'), 'pythonPath', instance)
    ).not.toThrow()
    expect(() =>
      assertApprovedExecutable(join(instance, 'python.exe'), 'pythonPath', instance)
    ).toThrow(/picker/i)

    const venv = join(root, '.venv')
    mkdirSync(join(venv, 'bin'), { recursive: true })
    writeFileSync(join(venv, 'bin', 'python'), 'elf')
    expect(() => assertApprovedExecutable(join(venv, 'bin', 'python'), 'pythonPath')).not.toThrow()
  })

  it('rejects install roots under home unless picked', () => {
    const homeInstall = join(root, 'home', 'ComfyUI')
    mkdirSync(homeInstall, { recursive: true })
    expect(() => assertApprovedInstallRoot(homeInstall)).toThrow(/picker/i)
    approveReadPath(homeInstall)
    expect(() => assertApprovedInstallRoot(homeInstall)).not.toThrow()
  })
})

describe('renderer origin trust (0.2.5 WP10 / S5)', () => {
  it('accepts only the exact dev origin and path', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    expect(isOwnRendererUrl('http://localhost:5173/')).toBe(true)
    expect(isOwnRendererUrl('http://localhost:5173/index.html')).toBe(true)
    expect(isOwnRendererUrl('http://localhost:5173.evil/')).toBe(false)
    expect(isOwnRendererUrl('http://localhost:5173@evil/')).toBe(false)
    expect(isOwnRendererUrl('http://localhost:51730/')).toBe(false)
    expect(isOwnRendererUrl('http://evil.localhost:5173/')).toBe(false)
  })

  it('compares a dev subpath exactly, not as a string prefix', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/app/'
    expect(isOwnRendererUrl('http://localhost:5173/app/index.html')).toBe(true)
    expect(isOwnRendererUrl('http://localhost:5173/app.evil/index.html')).toBe(false)
    expect(isOwnRendererUrl('http://localhost:5173/other')).toBe(false)
  })
})
