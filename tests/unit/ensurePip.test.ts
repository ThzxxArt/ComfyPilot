/**
 * ensurePip / installRequirements — the "No module named pip" field bug.
 * uv-created venvs have no pip; every `python -m pip` path must survive that.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:/fake/userData') },
  session: { defaultSession: { fetch: vi.fn(), setProxy: vi.fn() } }
}))

import { ensurePip, installRequirements } from '../../src/main/services/env'

function makeExec(script: Record<string, Error | string>): (cmd: string, args: string[]) => Promise<string> {
  return async (_cmd: string, args: string[]) => {
    const key = args.join(' ')
    for (const [k, v] of Object.entries(script)) {
      if (key.includes(k)) {
        if (v instanceof Error) throw v
        return v
      }
    }
    return ''
  }
}

describe('ensurePip', () => {
  it('is a no-op when pip already works', async () => {
    const calls: string[] = []
    const exec = async (_c: string, a: string[]): Promise<string> => {
      calls.push(a.join(' '))
      return 'pip 24.0'
    }
    await ensurePip('C:/venv/python.exe', exec)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('--version')
  })

  it('seeds pip via ensurepip when missing', async () => {
    const calls: string[] = []
    let pipWorks = false
    const exec = async (_c: string, a: string[]): Promise<string> => {
      calls.push(a.join(' '))
      if (a.includes('ensurepip')) {
        pipWorks = true
        return ''
      }
      if (a.includes('--version')) {
        if (!pipWorks) throw new Error('No module named pip')
        return 'pip 24.0'
      }
      return ''
    }
    await ensurePip('C:/venv/python.exe', exec)
    expect(calls.some((c) => c.includes('ensurepip'))).toBe(true)
  })

  it('throws a actionable error when ensurepip cannot help', async () => {
    const exec = makeExec({
      '--version': new Error('No module named pip'),
      ensurepip: new Error('ensurepip disabled')
    })
    await expect(ensurePip('C:/venv/python.exe', exec)).rejects.toThrow(/ensurepip|pip is not available/i)
  })
})

describe('installRequirements', () => {
  it('prefers uv and does not need pip in the venv', async () => {
    const calls: string[] = []
    const exec = async (cmd: string, a: string[]): Promise<string> => {
      calls.push(cmd + ' ' + a.join(' '))
      return 'Successfully installed'
    }
    await installRequirements('C:/venv/python.exe', 'C:/req.txt', exec, {
      uvPath: 'C:/uv.exe',
      pipIndex: ''
    })
    expect(calls[0]).toContain('uv')
    expect(calls[0]).toContain('pip install')
  })

  it('streams output lines to onLine', async () => {
    const lines: string[] = []
    // runStreaming falls back to exec when spawn is not used — but with onLine
    // it goes through spawn. In this unit test we exercise the fallback path
    // by passing an exec that resolves and an onLine that gets called from
    // runStreaming's spawn path. To keep the test hermetic we verify the
    // wrapper wires onLine through: simulate via the error-retry message.
    const exec = async (_c: string, a: string[]): Promise<string> => {
      if (a.includes('--version')) return 'pip 24.0'
      throw new Error('mirror missing pkg')
    }
    await installRequirements('C:/venv/python.exe', 'C:/req.txt', exec, {
      pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
      onLine: (l) => lines.push(l)
    }).catch(() => undefined)
    // The mirror-failure notice is pushed to onLine.
    expect(lines.some((l) => l.includes('retrying official'))).toBe(true)
  })

  it('falls back to ensurepip + pip when uv is unavailable', async () => {
    const calls: string[] = []
    let pipWorks = false
    const exec = async (_c: string, a: string[]): Promise<string> => {
      calls.push(a.join(' '))
      if (a.includes('ensurepip')) {
        pipWorks = true
        return ''
      }
      if (a.includes('--version')) {
        if (!pipWorks) throw new Error('No module named pip')
        return 'pip 24.0'
      }
      return 'Successfully installed'
    }
    await installRequirements('C:/venv/python.exe', 'C:/req.txt', exec, {})
    expect(calls.some((c) => c.includes('ensurepip'))).toBe(true)
    expect(calls.some((c) => c.includes('install'))).toBe(true)
  })

  it('adds official PyPI as extra-index when a mirror is configured', async () => {
    const calls: string[] = []
    const exec = async (cmd: string, a: string[]): Promise<string> => {
      calls.push(cmd + '|' + a.join(' '))
      return 'Successfully installed'
    }
    await installRequirements('C:/venv/python.exe', 'C:/req.txt', exec, {
      uvPath: 'C:/uv.exe',
      pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple'
    })
    const uvCall = calls.find((c) => c.includes('uv'))
    expect(uvCall).toContain('--extra-index-url')
    expect(uvCall).toContain('pypi.org/simple')
  })

  it('retries official PyPI when the mirror cannot resolve', async () => {
    const calls: string[] = []
    const exec = async (cmd: string, a: string[]): Promise<string> => {
      calls.push(cmd + '|' + a.join(' '))
      if (calls.length === 1) throw new Error('package not found in registry')
      return 'Successfully installed'
    }
    await installRequirements('C:/venv/python.exe', 'C:/req.txt', exec, {
      uvPath: 'C:/uv.exe',
      pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple'
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('pypi.org/simple')
  })
})
