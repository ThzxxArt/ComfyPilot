/**
 * E2E smoke — loads the built Electron main bundle for real.
 * Requires `npm run build` first.
 * SKIP_E2E=1 skips (CI Linux without xvfb).
 *
 * Run: npm run test:e2e
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const skip = process.env.SKIP_E2E === '1'
const root = process.cwd()
// The packaged app entry is bootstrap.cjs (package.json "main"); it requires
// out/main/index.js. Smoke the REAL entry so bootstrap regressions surface.
const mainJs = join(root, 'out', 'main', 'bootstrap.cjs')
const preloadJs = join(root, 'out', 'preload', 'index.js')
const rendererHtml = join(root, 'out', 'renderer', 'index.html')

function electronBin(): string {
  // Platform-aware: only Windows may use electron.exe. A shared node_modules
  // (e.g. Windows-installed tree opened from WSL) otherwise makes POSIX runs
  // spawn a PE binary directly and die with no output.
  if (process.platform === 'win32') {
    const win = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    if (existsSync(win)) return win
  } else {
    const posix = join(root, 'node_modules', 'electron', 'dist', 'electron')
    if (existsSync(posix)) return posix
  }
  return join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron'
  )
}

describe.skipIf(skip)('electron app smoke (real bundle)', () => {
  let child: ChildProcess | null = null

  beforeAll(() => {
    expect(existsSync(mainJs), 'out/main/bootstrap.cjs missing — run npm run build first').toBe(
      true
    )
    expect(existsSync(preloadJs), 'out/preload/index.js missing').toBe(true)
    expect(existsSync(rendererHtml), 'out/renderer/index.html missing').toBe(true)
  })

  afterAll(() => {
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  })

  it('main bundle starts, mounts the renderer, and exits cleanly on quit', async () => {
    const bin = electronBin()
    expect(existsSync(bin), `electron binary not found at ${bin} — run npm install`).toBe(true)

    const result = await new Promise<{ code: number | null; text: string }>((resolve) => {
      // Real Electron (not ELECTRON_RUN_AS_NODE) loading the packaged entry.
      // Entry as a RELATIVE path: under WSL, Windows Electron (via interop)
      // cannot resolve POSIX absolute paths like /mnt/d/….
      const p = spawn(bin, ['out/main/bootstrap.cjs', '--e2e-smoke'], {
        env: {
          ...process.env,
          ELECTRON_ENABLE_LOGGING: '1',
          COMFYPILOT_E2E: '1',
          // 0.1.17 (review fix): the single-instance lock would make the smoke
          // test exit immediately whenever a dev instance is already running.
          COMFYPILOT_ALLOW_MULTIPLE: '1'
        },
        windowsHide: true
      })
      child = p
      let text = ''
      let settled = false
      let hardKill: ReturnType<typeof setTimeout> | null = null
      const done = (code: number | null): void => {
        if (settled) return
        settled = true
        if (hardKill) clearTimeout(hardKill)
        resolve({ code, text })
      }
      p.stdout?.on('data', (d) => (text += String(d)))
      p.stderr?.on('data', (d) => (text += String(d)))
      p.on('error', (e) => {
        text += `spawn-error:${e.message}`
        done(null)
      })
      // 'close' (not 'exit') — stdio must be fully drained before the text is
      // read. Listening on 'exit' raced the final stdout chunk (Linux/WSL:
      // the renderer-mounted marker was printed yet collected as empty).
      p.on('close', (code) => done(code))
      // Hard stop only if the app fails to quit (graceful --e2e-smoke path)
      hardKill = setTimeout(() => {
        text += 'TIMEOUT_KILLED'
        try {
          p.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        done(-1)
      }, 12000)
    })

    // Must not have failed to spawn
    expect(result.text).not.toContain('spawn-error:')
    // Must not hit the force-kill path — main exits via --e2e-smoke
    expect(result.text).not.toContain('TIMEOUT_KILLED')
    if (/Electron failed to install correctly/i.test(result.text)) {
      throw new Error('Electron runtime missing: ' + result.text.slice(0, 200))
    }
    // 0xC0000135 = STATUS_DLL_NOT_FOUND (missing VC++ redist on the host)
    if (result.code === 3221225781 || result.code === -1073741515) {
      throw new Error(
        'Electron cannot start: missing system DLL (install Microsoft Visual C++ Redistributable)'
      )
    }
    // The renderer must have actually MOUNTED (the main process probes #app
    // after did-finish-load and prints a marker) — a bare exit code only
    // proves "a process ran".
    if (!result.text.includes('[e2e] renderer-mounted')) {
      throw new Error(
        `renderer did not mount — got: ${
          result.text.includes('[e2e] renderer-empty')
            ? '[e2e] renderer-empty'
            : result.text.includes('[e2e] renderer-probe-failed')
              ? '[e2e] renderer-probe-failed'
              : 'no marker'
        }; output tail: ${result.text.slice(-400)}`
      )
    }
    expect(result.code === 0 || result.code === null).toBe(true)
  }, 20000)
})
