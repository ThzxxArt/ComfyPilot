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

  it('probe() runs a syntactically valid multi-line torch script (0.1.12 fix)', async () => {
    const { envService } = await import('../../src/main/services/env')
    h.state.handler = (_cmd, args) => {
      if (args[0] === '--version') return { stdout: 'Python 3.12.1' }
      if (args[0] === '-c' && String(args[1]).includes('json.dumps')) {
        return {
          stdout: JSON.stringify({
            torch: '2.9.0+cu130',
            cuda: '13.0',
            rocm: null,
            mps: false,
            npu: false
          })
        }
      }
      if (args[0] === '-m' && args[1] === 'pip' && args[2] === '--version') {
        return { stdout: 'pip 24.0 from x (python 3.12)' }
      }
      if (args[0] === '-m') return { stdout: '[]' }
      return { stdout: '' }
    }
    const probe = await envService.probe({ pythonPath: 'python' })
    const torchCall = h.state.calls.find(
      (c) => c.args[0] === '-c' && String(c.args[1]).includes('json.dumps')
    )
    expect(torchCall).toBeTruthy()
    const script = String(torchCall!.args[1])
    // Regression (0.1.12): join(';') produced `{;"torch"` → Python SyntaxError
    // forever (silently reported as 'torch probe failed'). The script must be
    // newline-joined and free of semicolon artifacts.
    expect(script).not.toMatch(/\{;|,;|;;|;\}/)
    expect(script.split('\n').length).toBeGreaterThan(5)
    expect(script).toContain('import json, torch')
    expect(probe.torchVersion).toBe('2.9.0+cu130')
    expect(probe.cudaVersion).toBe('13.0')
    expect(probe.pip).toEqual({ present: true, version: '24.0' })
  })
})

describe('outputIndicatesFailure (0.1.13)', () => {
  it('classifies uv/pip output without false alarms', async () => {
    const { outputIndicatesFailure } = await import('../../src/main/services/env')
    // uv success shapes — the old check rejected these as failures.
    expect(
      outputIndicatesFailure('Resolved 3 packages in 12ms\nInstalled 3 packages in 34ms')
    ).toBe(false)
    expect(outputIndicatesFailure('Audited 14 packages in 8ms')).toBe(false)
    // pip success shapes.
    expect(outputIndicatesFailure('Successfully installed foo-1.0')).toBe(false)
    expect(outputIndicatesFailure('Requirement already satisfied: onnx in ...')).toBe(false)
    // Real failures (line-anchored).
    expect(
      outputIndicatesFailure('ERROR: Could not find a version that satisfies the requirement foo')
    ).toBe(true)
    expect(outputIndicatesFailure('  error: subprocess-exited-with-error')).toBe(true)
    // "error" mentioned mid-line is NOT a failure marker.
    expect(outputIndicatesFailure('collected some notes about an error: nothing fatal')).toBe(false)
    expect(outputIndicatesFailure('')).toBe(false)
  })

  it('classifies REAL machine output samples (captured 2026-10-15, Windows venv)', async () => {
    const { outputIndicatesFailure } = await import('../../src/main/services/env')
    // `python -m pip install onnx` on an already-satisfied venv:
    //   Requirement already satisfied: onnx in d:\...\.venv\lib\site-packages (1.23.2)
    expect(
      outputIndicatesFailure(
        'Requirement already satisfied: onnx in d:\\comfypilotruntimes\\comfy-main\\.venv\\lib\\site-packages (1.23.2)\n' +
          '[notice] A new release of pip is available: 25.2 -> 26.2.1'
      )
    ).toBe(false)
    // `uv pip install --python <venv> onnx` on the same venv (uv writes to stderr):
    //   Using Python 3.13.7 environment at: D:\ComfyPilotRuntimes\comfy-main\.venv
    //   Audited 1 package in 55ms
    expect(
      outputIndicatesFailure(
        'Using Python 3.13.7 environment at: D:\\ComfyPilotRuntimes\\comfy-main\\.venv\n' +
          'Audited 1 package in 55ms'
      )
    ).toBe(false)
    // `python -m pip install <nonexistent>` — the real failure shape:
    //   ERROR: No matching distribution found for comfypilot-definitely-missing-pkg-xyz
    expect(
      outputIndicatesFailure(
        'ERROR: Could not find a version that satisfies the requirement comfypilot-definitely-missing-pkg-xyz\n' +
          'ERROR: No matching distribution found for comfypilot-definitely-missing-pkg-xyz'
      )
    ).toBe(true)
  })
})
