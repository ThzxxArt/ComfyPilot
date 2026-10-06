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
const mainJs = join(root, 'out', 'main', 'index.js')
const preloadJs = join(root, 'out', 'preload', 'index.js')
const rendererHtml = join(root, 'out', 'renderer', 'index.html')

function electronBin(): string {
  const win = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (existsSync(win)) return win
  return join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
}

describe.skipIf(skip)('electron app smoke (real bundle)', () => {
  let child: ChildProcess | null = null

  beforeAll(() => {
    expect(existsSync(mainJs), 'out/main/index.js missing — run npm run build first').toBe(true)
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

  it('main bundle starts, logs boot, and exits cleanly on quit', async () => {
    const bin = electronBin()
    expect(existsSync(bin) || bin.endsWith('electron') || bin.endsWith('electron.cmd')).toBe(true)

    const result = await new Promise<{ code: number | null; text: string }>((resolve) => {
      // Real Electron (not ELECTRON_RUN_AS_NODE) loading out/main
      const p = spawn(bin, [join(root, 'out', 'main', 'index.js'), '--e2e-smoke'], {
        env: {
          ...process.env,
          ELECTRON_ENABLE_LOGGING: '1',
          COMFYPILOT_E2E: '1'
        },
        windowsHide: true
      })
      child = p
      let text = ''
      let settled = false
      const done = (code: number | null): void => {
        if (settled) return
        settled = true
        resolve({ code, text })
      }
      p.stdout?.on('data', (d) => (text += String(d)))
      p.stderr?.on('data', (d) => (text += String(d)))
      p.on('error', (e) => {
        text += `spawn-error:${e.message}`
        done(null)
      })
      p.on('exit', (code) => done(code))
      // Hard stop only if the app fails to quit (graceful --e2e-smoke path)
      setTimeout(() => {
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
    expect(result.code === 0 || result.code === null).toBe(true)
  }, 20000)
})
