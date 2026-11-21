/**
 * Env streaming/requirements edge branches: spawn fallbacks, abort/timeout,
 * uv vs pip installs, mirror retries and torch requirement filtering.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({
  root: '',
  execHandler: null as null | ((cmd: string, args: string[]) => { stdout?: string } | Error),
  onSpawn: null as null | ((child: any) => void),
  lastChild: null as any,
  killTree: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.root, name: 't', isPackaged: false }
}))

vi.mock('../../src/main/services/db', () => ({
  loadSettings: () => ({ proxy: {}, pipIndex: '' }),
  uvPythonInstallDir: () => join(h.root, 'uv-python')
}))

vi.mock('../../src/main/services/processTree', () => ({
  killProcessTree: h.killTree
}))

vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const run = (cmd: string, args: string[]): { stdout?: string } | Error =>
    h.execHandler ? h.execHandler(cmd, args) : { stdout: '' }
  const execFile: any = (cmd: string, args: string[], _o: unknown, cb?: unknown) => {
    const r = run(cmd, args)
    queueMicrotask(() => {
      if (typeof cb !== 'function') return
      if (r instanceof Error) (cb as any)(r, '', '')
      else (cb as any)(null, r.stdout || '', '')
    })
    return { pid: 1 }
  }
  execFile[promisify.custom] = (cmd: string, args: string[]) =>
    new Promise((resolve, reject) => {
      const r = run(cmd, args)
      queueMicrotask(() => {
        if (r instanceof Error) reject(r)
        else resolve({ stdout: r.stdout || '', stderr: '' })
      })
    })
  const spawn = (): any => {
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.exitCode = null
    child.kill = vi.fn()
    h.lastChild = child
    queueMicrotask(() => h.onSpawn?.(child))
    return child
  }
  return { execFile, execFileSync: () => '', spawn }
})

import {
  installRequirements,
  outputIndicatesFailure,
  runStreaming,
  torchChannelFromProbe,
  filterTorchRequirements
} from '../../src/main/services/env'

let calls: string[][] = []
const exec = async (cmd: string, args: string[]): Promise<string> => {
  calls.push([cmd, ...args])
  const r = h.execHandler?.(cmd, args)
  if (r instanceof Error) throw r
  return r?.stdout || ''
}

describe('env streaming and requirements edges', () => {
  beforeEach(() => {
    calls = []
    h.root = mkdtempSync(join(tmpdir(), 'cp-env-stream-'))
    h.execHandler = null
    h.onSpawn = null
    h.lastChild = null
    h.killTree.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(h.root, { recursive: true, force: true })
  })

  it('falls back to a buffered exec without an onLine sink', async () => {
    const fallback = vi.fn(async () => 'buffered')
    await expect(runStreaming('cmd', ['a'], { cwd: '/x', timeout: 5 }, fallback)).resolves.toBe(
      'buffered'
    )
    expect(fallback).toHaveBeenCalledWith('cmd', ['a'], { cwd: '/x', timeout: 5 })
  })

  it('streams whole lines across chunks and folds stderr into success output', async () => {
    const lines: string[] = []
    h.onSpawn = (child) => {
      child.stdout.emit('data', Buffer.from('one\ntw'))
      child.stdout.emit('data', Buffer.from('o\rprogress 1%\r\n'))
      child.stderr.emit('data', Buffer.from('warn\n'))
      child.emit('close', 0)
    }
    const out = await runStreaming('cmd', [], { onLine: (l) => lines.push(l) }, async () => {
      throw new Error('fallback should not run')
    })
    expect(lines).toEqual(['one', 'two', 'progress 1%', 'warn'])
    expect(out).toContain('one')
    expect(out).toContain('warn')
  })

  it('rejects on non-zero exit, child errors and missing output', async () => {
    h.onSpawn = (child) => {
      child.stderr.emit('data', Buffer.from('boom\n'))
      child.emit('close', 2)
    }
    await expect(
      runStreaming('cmd', [], { onLine: () => undefined }, async () => '')
    ).rejects.toThrow(/boom/)

    h.onSpawn = (child) => {
      child.emit('close', 3)
    }
    await expect(
      runStreaming('cmd', [], { onLine: () => undefined }, async () => '')
    ).rejects.toThrow(/exit 3/)

    h.onSpawn = (child) => {
      child.emit('error', new Error('spawn exploded'))
    }
    await expect(
      runStreaming('cmd', [], { onLine: () => undefined }, async () => '')
    ).rejects.toThrow(/spawn exploded/)
  })

  it('aborts by killing the process tree before rejecting', async () => {
    const ac = new AbortController()
    h.onSpawn = () => {
      ac.abort()
    }
    await expect(
      runStreaming('cmd', [], { onLine: () => undefined, signal: ac.signal }, async () => '')
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.killTree).toHaveBeenCalled()

    const already = new AbortController()
    already.abort()
    await expect(
      runStreaming('cmd', [], { onLine: () => undefined, signal: already.signal }, async () => '')
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('times out and kills the process tree', async () => {
    vi.useFakeTimers()
    const promise = runStreaming(
      'cmd',
      [],
      { onLine: () => undefined, timeout: 50 },
      async () => ''
    )
    const assertion = expect(promise).rejects.toThrow(/timeout after 50ms/)
    await vi.advanceTimersByTimeAsync(60)
    await assertion
    expect(h.killTree).toHaveBeenCalled()
  })

  it('detects failure markers without rejecting success text', () => {
    expect(outputIndicatesFailure('ERROR: No matching distribution')).toBe(true)
    expect(outputIndicatesFailure('error: bad wheel')).toBe(true)
    expect(outputIndicatesFailure('error:lowercase')).toBe(true)
    expect(outputIndicatesFailure('Successfully installed x\nERROR: y')).toBe(true)
    expect(outputIndicatesFailure('Installed 10 packages')).toBe(false)
    expect(outputIndicatesFailure('')).toBe(false)
  })

  it('installs via uv with official and custom indexes', async () => {
    h.execHandler = () => ({ stdout: 'ok' })
    const req = join(h.root, 'requirements.txt')
    writeFileSync(req, 'numpy\n')
    await installRequirements('python', req, exec, { uvPath: 'uv' })
    expect(calls[0]).not.toContain('--index-url')

    calls.length = 0
    await installRequirements('python', req, exec, {
      uvPath: 'uv',
      pipIndex: 'https://pypi.org/simple'
    })
    expect(calls[0]).toContain('--index-url')
    expect(calls[0]).not.toContain('--extra-index-url')

    calls.length = 0
    await installRequirements('python', req, exec, {
      uvPath: 'uv',
      pipIndex: 'https://mirror.example/simple'
    })
    expect(calls[0]).toContain('--extra-index-url')
  })

  it('falls back to pip, retries official PyPI and reports both failures', async () => {
    const req = join(h.root, 'requirements.txt')
    writeFileSync(req, 'numpy\n')
    h.execHandler = (_cmd, args) => {
      if (args.includes('--version')) return { stdout: 'pip 25.0' }
      return { stdout: 'ok' }
    }
    await installRequirements('python', req, exec, {
      pipIndex: 'https://mirror.example/simple'
    })
    expect(calls.some((c) => c.join(' ').includes('--trusted-host mirror.example'))).toBe(true)

    let attempts = 0
    h.execHandler = (cmd, args) => {
      if (args.includes('--version')) return { stdout: 'pip 25.0' }
      attempts += 1
      if (attempts === 1) return new Error('mirror down')
      return { stdout: 'ok' }
    }
    await expect(
      installRequirements('python', req, exec, {
        pipIndex: 'https://mirror.example/simple'
      })
    ).resolves.toBeUndefined()
    expect(attempts).toBeGreaterThan(1)

    h.execHandler = (cmd, args) => {
      if (args.includes('--version')) return { stdout: 'pip 25.0' }
      return new Error('still down')
    }
    await expect(
      installRequirements('python', req, exec, {
        pipIndex: 'https://mirror.example/simple'
      })
    ).rejects.toThrow(/mirror and official/)

    h.execHandler = () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      return e
    }
    await expect(installRequirements('python', req, exec, { uvPath: 'uv' })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('skips and cleans torch requirements, including missing/commented files', async () => {
    const missing = filterTorchRequirements(join(h.root, 'missing.txt'))
    expect(missing.removed).toEqual([])
    missing.cleanup()

    const comments = join(h.root, 'comments.txt')
    writeFileSync(comments, '# torch\n\nnumpy\n')
    const kept = filterTorchRequirements(comments)
    expect(kept.removed).toEqual([])
    expect(kept.file).toBe(comments)

    const req = join(h.root, 'torch.txt')
    writeFileSync(req, 'torch==2.9.0\ntorchvision\ntorchaudio\nnumpy\n')
    const filtered = filterTorchRequirements(req)
    expect(filtered.removed).toHaveLength(3)
    expect(filtered.file).not.toBe(req)
    expect(readFileSync(filtered.file, 'utf-8')).toContain('numpy')
    filtered.cleanup()
    expect(existsSync(filtered.file)).toBe(false)

    const out: string[] = []
    h.onSpawn = (child) => child.emit('close', 0)
    await expect(
      installRequirements('python', req, exec, { onLine: (l) => out.push(l) })
    ).resolves.toBeUndefined()
    expect(out.join('\n')).toContain('Skipping torch packages')
  })

  it('maps torch probes to channels across platforms', () => {
    expect(torchChannelFromProbe(null)).toBe('')
    expect(torchChannelFromProbe({ cudaVersion: '13.0' } as never)).toBe('cu130')
    expect(torchChannelFromProbe({ cudaVersion: '12.6' } as never)).toBe('cu126')
    expect(torchChannelFromProbe({ cudaVersion: '11.8' } as never)).toBe('cpu')
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(torchChannelFromProbe({ rocmVersion: '6.2' } as never)).toBe('rocm10.0')
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true })
    }
    expect(torchChannelFromProbe({ rocmVersion: '6.2' } as never)).toBe('rocm7.2')
    expect(torchChannelFromProbe({ npuAvailable: true } as never)).toBe('xpu')
    expect(torchChannelFromProbe({ mpsAvailable: true } as never)).toBe('mps')
    expect(torchChannelFromProbe({ torchVersion: '2.9.0' } as never)).toBe('cpu')
    expect(torchChannelFromProbe({} as never)).toBe('')
  })
})
