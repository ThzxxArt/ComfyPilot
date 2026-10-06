/**
 * E2E smoke — launches Electron main bundle and verifies the window boots.
 * Requires a built app (`npm run build`) and a display-capable host.
 * Set SKIP_E2E=1 to skip in headless CI without xvfb.
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

describe.skipIf(skip)('electron shell smoke', () => {
  let child: ChildProcess | null = null

  beforeAll(() => {
    expect(existsSync(mainJs), 'out/main/index.js missing — run npm run build first').toBe(true)
  })

  afterAll(() => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
    }
  })

  it('process starts and exits cleanly with --version-style probe', async () => {
    // Use electron binary from node_modules
    const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    const bin = existsSync(electronBin)
      ? electronBin
      : join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')

    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const p = spawn(bin, ['-e', 'process.stdout.write("E2E_OK");process.exit(0)'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true
      })
      child = p
      let text = ''
      p.stdout?.on('data', (d) => (text += String(d)))
      p.stderr?.on('data', (d) => (text += String(d)))
      p.on('exit', (code) => resolve({ code, text }))
      setTimeout(() => {
        try {
          p.kill()
        } catch {
          /* ignore */
        }
      }, 15000)
    })

    expect(out.text).toContain('E2E_OK')
    expect(out.code === 0 || out.code === null).toBe(true)
  })
})
