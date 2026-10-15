/**
 * IPC registration contract (0.1.10): the declared IpcChannelMap and the
 * channels actually registered by registerIpcHandlers must be the SAME SET.
 *
 * Unlike the old "source contains string" contracts, this executes the real
 * registration path under a mocked electron and compares runtime facts —
 * a channel in types.ts without a handler (or a stray handler without a type)
 * fails immediately.
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => {
  const handled = new Map<string, unknown>()
  return { handled }
})

vi.mock('electron', () => {
  const app = {
    getPath: (name: string) => {
      const base = process.env.CP_IPC_TEST_ROOT || tmpdir()
      return join(base, name)
    },
    getAppPath: () => process.env.CP_IPC_TEST_ROOT || tmpdir(),
    isPackaged: false,
    name: 'ComfyPilotTest',
    quit: () => undefined,
    whenReady: async () => undefined,
    on: () => undefined,
    setLoginItemSettings: () => undefined,
    getLoginItemSettings: () => ({ openAtLogin: false })
  }
  class FakeWebContentsView {
    webContents = {
      close: () => undefined,
      loadURL: async () => undefined,
      once: () => undefined,
      setWindowOpenHandler: () => undefined,
      on: () => undefined
    }
    setBounds(): void {
      /* noop */
    }
  }
  return {
    app,
    ipcMain: {
      handle: (channel: string, fn: unknown) => {
        h.handled.set(channel, fn)
      },
      removeHandler: (channel: string) => {
        h.handled.delete(channel)
      },
      on: () => undefined
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
      showErrorBox: () => undefined
    },
    shell: {
      openExternal: async () => undefined,
      openPath: async () => '',
      showItemInFolder: () => undefined
    },
    BrowserWindow: { getAllWindows: () => [] },
    WebContentsView: FakeWebContentsView,
    clipboard: { writeText: () => undefined },
    session: {
      defaultSession: {
        fetch: async () => new Response('{}', { status: 200 }),
        setProxy: async () => undefined
      }
    },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => true,
        resize: () => ({ toPNG: () => Buffer.alloc(0) })
      }),
      createEmpty: () => ({ isEmpty: () => true })
    },
    Tray: class {
      setContextMenu(): void {}
      setToolTip(): void {}
      on(): void {}
      destroy(): void {}
    },
    Menu: { buildFromTemplate: () => ({}) },
    protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined },
    net: { fetch: async () => new Response('') }
  }
})

describe('IPC registration contract (0.1.10)', () => {
  // tmpfs hygiene (0.1.15): the mocked userData root must not outlive the run.
  afterAll(() => {
    const root = process.env.CP_IPC_TEST_ROOT
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  it('registered channels === channels declared in IpcChannelMap, exactly', async () => {
    process.env.CP_IPC_TEST_ROOT = mkdtempSync(join(tmpdir(), 'cp-ipc-'))
    const { registerIpcHandlers } = await import('../../src/main/ipc/handlers')

    // IpcChannelMap is a TYPE (no runtime object) — extract the declared
    // channel literals from the source and compare them against what the real
    // registration path actually registers at runtime.
    const typesSrc = readFileSync(join(__dirname, '../../src/shared/types.ts'), 'utf-8')
    const declared: string[] = []
    for (const m of typesSrc.matchAll(/^\s*'([a-zA-Z][\w-]*\.[\w.-]+)':\s*\{\s*args:/gm)) {
      declared.push(m[1])
    }
    expect(declared.length).toBeGreaterThan(100)

    registerIpcHandlers(() => null)

    const registered = [...h.handled.keys()]
    const missingHandlers = declared.filter((c) => !h.handled.has(c))
    const undeclaredHandlers = registered.filter((c) => !declared.includes(c))

    expect(missingHandlers, `declared but NOT registered: ${missingHandlers.join(', ')}`).toEqual(
      []
    )
    expect(
      undeclaredHandlers,
      `registered but NOT declared in IpcChannelMap: ${undeclaredHandlers.join(', ')}`
    ).toEqual([])
    // Every registered channel must be a callable handler.
    for (const [, fn] of h.handled) expect(typeof fn).toBe('function')
  })
})
