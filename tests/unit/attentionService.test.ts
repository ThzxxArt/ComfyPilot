import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceServiceContext } from '../../src/main/services/instance/types'

const h = vi.hoisted(() => ({
  stdout: '',
  error: null as (Error & { stdout?: string }) | null,
  calls: [] as Array<{ cmd: string; args: string[] }>
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      h.calls.push({ cmd, args })
      queueMicrotask(() => {
        if (h.error) cb(h.error, h.stdout, '')
        else cb(null, h.stdout, '')
      })
      return { pid: 1 }
    }
  }
})

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => [{ id: 'i1', path: '/tmp/comfy' }]
}))

const ctx = {
  resolvePython: () => 'C:/env/python.exe'
} as unknown as InstanceServiceContext

const SAMPLE = JSON.stringify({
  ok: true,
  pythonVersion: '3.13.18',
  torchVersion: '2.14.1+cu130',
  cudaVersion: '13.0',
  cudaAvailable: true,
  sageattention: { installed: true, version: '2.2.0', ok: true },
  xformers: { installed: false, version: '', ok: false, error: 'missing' }
})

describe('instance attention self-test (0.2.6)', () => {
  beforeEach(() => {
    h.stdout = SAMPLE
    h.error = null
    h.calls = []
  })

  it('runs the fixed script in the instance interpreter and parses the result', async () => {
    const { selfTest } = await import('../../src/main/services/instance/attention')
    const out = await selfTest(ctx, 'i1')
    expect(out.ok).toBe(true)
    expect(out.sageattention).toMatchObject({ installed: true, ok: true, version: '2.2.0' })
    expect(out.xformers).toMatchObject({ installed: false, ok: false })
    expect(h.calls[0].cmd).toBe('C:/env/python.exe')
    expect(h.calls[0].args[0]).toBe('-c')
    expect(h.calls[0].args[1]).toContain('from sageattention import sageattn')
  })

  it('parses partial stdout when the interpreter exits non-zero', async () => {
    const err = Object.assign(new Error('exit 1'), { stdout: SAMPLE })
    h.error = err
    const { selfTest } = await import('../../src/main/services/instance/attention')
    const out = await selfTest(ctx, 'i1')
    expect(out.ok).toBe(true)
    expect(out.error).toBe('exit 1')
  })

  it('returns an honest failure for an unknown instance', async () => {
    const { selfTest } = await import('../../src/main/services/instance/attention')
    const out = await selfTest(ctx, 'missing')
    expect(out.ok).toBe(false)
    expect(out.error).toContain('Instance not found')
    expect(h.calls).toHaveLength(0)
  })
})
