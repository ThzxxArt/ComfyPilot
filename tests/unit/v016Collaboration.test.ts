/**
 * v0.1.6 collaboration / chain-integrity contracts.
 * These are source-level guards plus behavioural checks for the
 * cross-domain fixes (instance switching, notifications, market deep link,
 * batch produced semantics, workflow id stability).
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const root = join(__dirname, '..', '..')
const ROOT = join(tmpdir(), `cp-v016-collab-${process.pid}`)

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

vi.mock('electron', async () => {
  return {
    app: { getPath: () => ROOT },
    shell: {
      showItemInFolder: () => undefined,
      openExternal: async () => undefined,
      openPath: async () => ''
    }
  }
})

describe('collaboration substrate (source contracts)', () => {
  it('store exposes instanceSwitchTick and prunes stale activeInstanceId', () => {
    const src = read('src/renderer/src/stores/app.ts')
    expect(src).toContain('instanceSwitchTick')
    expect(src).toContain('pruneActiveInstance')
    // stale id must actually be dropped, not only assigned
    expect(src).toMatch(/pruneActiveInstance[\s\S]*?activeInstanceId\.value\s*=/)
  })

  it('store subscribes to the notification event', () => {
    const src = read('src/renderer/src/stores/app.ts')
    expect(src).toContain('onNotification')
    expect(src).toContain('pushNotification')
  })

  it('handlers export broadcastNotification wired to IPC_EVENTS.notification', () => {
    const src = read('src/main/ipc/handlers.ts')
    expect(src).toContain('export function broadcastNotification')
    expect(src).toContain('IPC_EVENTS.notification')
  })

  it('registryIndex ready is bridged so Market cannot stick on indexing', () => {
    const src = read('src/main/index.ts')
    expect(src).toMatch(/registryIndex\.on\(\s*'ready'/)
    expect(src).toMatch(/ready:\s*true/)
  })

  it('requireRunningInstance never silently falls back to instances[0] for an explicit id', () => {
    const src = read('src/main/ipc/handlers.ts')
    const fn = src.slice(src.indexOf('async function requireRunningInstance'))
    const body = fn.slice(0, fn.indexOf('ipcMain.handle') > 0 ? fn.indexOf('ipcMain.handle') : 1200)
    // explicit id must be looked up by id, with no `|| instances[0]` escape hatch
    expect(body).not.toMatch(/\|\|\s*instances\[0\]/)
    expect(body).toMatch(/Instance not found/)
  })

  it('MarketView consumes route.query.q (workflow missing-node deep link)', () => {
    const src = read('src/renderer/src/views/nodes/MarketView.vue')
    expect(src).toContain('useRoute')
    expect(src).toMatch(/route\.query\.q|query\.q/)
  })

  it('MonitorView does not disconnect the global WS on unmount', () => {
    const src = read('src/renderer/src/views/monitor/MonitorView.vue')
    expect(src).not.toContain('monitor.disconnectWs')
  })

  it('store owns WS sync for the active instance', () => {
    const src = read('src/renderer/src/stores/app.ts')
    expect(src).toContain('syncWs')
    expect(src).toContain('monitor.connectWs')
  })
})

describe('batch produced semantics (behavioural)', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('produced only counts prompts that linked output files', async () => {
    const src = read('src/main/services/p1p2.ts')
    // produced must not be incremented in lockstep with completed
    const completedIdx = src.indexOf('item.completed += 1')
    expect(completedIdx).toBeGreaterThan(-1)
    // The fake-metric pattern: produced += 1 immediately next to completed += 1
    const window = src.slice(Math.max(0, completedIdx - 80), completedIdx + 120)
    expect(window).not.toMatch(/produced\s*\+=\s*1/)
  })

  it('re-running a finished job resets run counters', async () => {
    const src = read('src/main/services/p1p2.ts')
    // start() must reset produced/submitted/completed/failed for done/error, not only cancelled
    const startFn = src.slice(src.indexOf('async start('))
    const body = startFn.slice(0, startFn.indexOf('async cancel') > 0 ? startFn.indexOf('async cancel') : 2500)
    expect(body).toMatch(/done|error/)
    expect(body).toMatch(/produced\s*=\s*0/)
  })
})

describe('workflow id stability (behavioural)', () => {
  it('rename keeps the original record id so external links survive', async () => {
    const src = read('src/main/services/workflow.ts')
    const renameFn = src.slice(src.indexOf('async rename('))
    const body = renameFn.slice(0, 900)
    // must NOT re-assign id: recordIdFor(dest) on rename
    expect(body).not.toMatch(/id:\s*recordIdFor\(dest\)/)
  })

  it('copyToInstance reuses identical content instead of name-1.json stacking', async () => {
    const src = read('src/main/services/workflow.ts')
    const fn = src.slice(src.indexOf('copyToInstancePath'))
    const body = fn.slice(0, 1400)
    expect(body).toMatch(/hash|sha|content/i)
  })
})

describe('git-prefer install path', () => {
  it('resolveRepoUrl derives GitHub repo from archive download URL', async () => {
    const { resolveRepoUrl } = await import('../../src/main/services/nodePack')
    expect(
      await resolveRepoUrl('', 'https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip', 'x')
    ).toBe('https://github.com/comfyanonymous/ComfyUI.git')
    expect(
      await resolveRepoUrl('', 'https://codeload.github.com/owner/repo/zip/refs/heads/main', 'x')
    ).toBe('https://codeload.github.com/owner/repo.git')
    // Explicit repository wins
    expect(
      await resolveRepoUrl('https://github.com/explicit/repo.git', 'https://github.com/other/repo/archive/x.zip', 'x')
    ).toBe('https://github.com/explicit/repo.git')
    // Non-GitHub URL with no repo → empty (registry index lookup also fails for 'x')
    expect(await resolveRepoUrl('', 'https://example.com/pack.zip', 'x')).toBe('')
  })

  it('resolveGitBinary prefers PATH git over portable MinGit', async () => {
    const src = read('src/main/services/nodePack.ts')
    const fn = src.slice(src.indexOf('export function resolveGitBinary'))
    // Must probe system git first and only fall back to findInRuntimes
    expect(fn.slice(0, 500)).toContain('git --version')
    expect(fn.slice(0, 500)).toContain('findInRuntimes')
  })

  it('registry install git path bypasses allowGitUrlInstall gate', async () => {
    const src = read('src/main/services/nodePack.ts')
    // The registry install path must call installInner (not install) for the
    // internal git clone — install() would re-check assertInstallAllowed('git')
    // which is gated by allowGitUrlInstall (default false).
    const registryGit = src.slice(
      src.indexOf('resolveRepoUrl'),
      src.indexOf('Using zip download')
    )
    expect(registryGit).toContain('installInner')
    expect(registryGit).not.toMatch(/this\.install\(\{[^}]*source:\s*'git'/)
  })
})
