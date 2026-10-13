/**
 * EnvService behaviour (0.1.10): venv creation guards, torch install result
 * parsing and interpreter listing. Real tmpdir fs; exec/electron mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => {
  const state = {
    root: '',
    calls: [] as Array<{ cmd: string; args: string[] }>,
    handler: null as ((cmd: string, args: string[]) => { stdout: string } | Error) | null,
    portablePython: null as string | null
  }
  return { state }
})

vi.mock('electron', () => ({
  app: { getPath: () => h.state.root, name: 't', isPackaged: false }
}))

vi.mock('../../src/main/services/instance', () => ({
  resolveRuntimesPythonSync: () => h.state.portablePython,
  resolveInstancePythonPath: () => 'python'
}))

vi.mock('child_process', () => {
  const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')
  const runHandler = (cmd: string, args: string[]): { stdout: string } | Error => {
    h.state.calls.push({ cmd, args })
    try {
      return h.state.handler ? h.state.handler(cmd, args) : { stdout: '' }
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }
  const execFile: any = (cmd: string, args: string[], _o?: unknown, cb?: unknown) => {
    const result = runHandler(cmd, args)
    const done = typeof cb === 'function' ? (cb as (...a: unknown[]) => void) : null
    queueMicrotask(() => {
      if (!done) return
      if (result instanceof Error) done(result, '', '')
      else done(null, result.stdout, '')
    })
    return { pid: 1 }
  }
  execFile[PROMISIFY_CUSTOM] = (cmd: string, args: string[]) =>
    new Promise((resolve, reject) => {
      const result = runHandler(cmd, args)
      queueMicrotask(() => {
        if (result instanceof Error) reject(result)
        else resolve({ stdout: result.stdout, stderr: '' })
      })
    })
  return { execFile, execFileSync: () => '', spawn: () => ({ pid: 1, kill: () => undefined }) }
})

describe('EnvService (0.1.10 behaviour)', () => {
  beforeEach(() => {
    h.state.root = mkdtempSync(join(tmpdir(), 'cp-env-'))
    h.state.calls = []
    h.state.handler = null
    h.state.portablePython = null
    vi.resetModules()
  })

  it('createVenv rejects unsafe names and builds a python venv', async () => {
    const { envService } = await import('../../src/main/services/env')
    await expect(
      envService.createVenv({
        basePath: h.state.root,
        name: '../evil',
        pythonPath: 'python',
        useUv: false
      })
    ).rejects.toThrow()

    // Simulate the venv layout the command would create.
    h.state.handler = (cmd, args) => {
      if (args.includes('venv')) {
        mkdirSync(join(args[args.indexOf('venv') + 1], 'bin'), { recursive: true })
        writeFileSync(join(args[args.indexOf('venv') + 1], 'bin', 'python'), 'x')
      }
      if (args[0] === '--version') return { stdout: 'Python 3.13.0' }
      if (args[0] === '-c') return { stdout: '{"torch":"2.9.0"}' }
      if (args.includes('list')) return { stdout: '[]' }
      return { stdout: '' }
    }
    const probe = await envService.createVenv({
      basePath: h.state.root,
      name: 'venv-ok',
      pythonPath: 'python',
      useUv: false
    })
    expect(probe.pythonVersion).toContain('Python')
    expect(h.state.calls.some((c) => c.args.includes('venv'))).toBe(true)
  })

  it('installTorch reports success and failure truthfully', async () => {
    const { envService } = await import('../../src/main/services/env')
    h.state.handler = () => ({ stdout: 'Successfully installed torch-2.9.0' })
    await expect(
      envService.installTorch({ pythonPath: 'python', index: 'https://x/cpu/' })
    ).resolves.toBe(true)

    h.state.handler = () => ({ stdout: 'ERROR: no matching distribution' })
    await expect(
      envService.installTorch({ pythonPath: 'python', index: 'https://x/cpu/' })
    ).rejects.toThrow(/pip install torch failed/)
  })

  it('listPythons aggregates found interpreters incl. the managed runtime', async () => {
    const { envService } = await import('../../src/main/services/env')
    h.state.handler = (cmd) => {
      if (cmd === 'python') return { stdout: 'Python 3.13.0' }
      if (cmd === 'python3') return new Error('not found')
      if (cmd === 'py') return new Error('not found')
      if (cmd === 'portable-py') return { stdout: 'Python 3.12.11' }
      return new Error('not found')
    }
    h.state.portablePython = 'portable-py'
    const list = await envService.listPythons()
    expect(list.map((p) => p.path)).toContain('python')
    expect(list.map((p) => p.path)).toContain('portable-py')
    expect(list.every((p) => p.version.includes('Python'))).toBe(true)
  })
})
