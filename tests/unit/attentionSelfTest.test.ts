import { describe, expect, it } from 'vitest'
import {
  ATTENTION_SELF_TEST_SCRIPT,
  emptyAttentionSelfTest,
  parseAttentionSelfTest
} from '../../src/shared/attentionSelfTest'

const SAMPLE = {
  ok: true,
  pythonVersion: '3.13.18',
  torchVersion: '2.14.1+cu130',
  cudaVersion: '13.0',
  gpuName: 'NVIDIA GeForce RTX 4070 Ti SUPER',
  computeCapability: '8.9',
  cudaAvailable: true,
  sageattention: { installed: true, version: '2.2.0', ok: true, error: '' },
  xformers: { installed: false, version: '', ok: false, error: 'ModuleNotFoundError: x' }
}

describe('attention self-test parser (0.2.6)', () => {
  it('parses the last JSON line and keeps per-package failures', () => {
    const out = parseAttentionSelfTest(`warning before\n${JSON.stringify(SAMPLE)}\n`, 1234)
    expect(out.testedAt).toBe(1234)
    expect(out.ok).toBe(true)
    expect(out.cudaAvailable).toBe(true)
    expect(out.computeCapability).toBe('8.9')
    expect(out.sageattention).toMatchObject({ installed: true, ok: true, version: '2.2.0' })
    expect(out.xformers).toMatchObject({ installed: false, ok: false })
    expect(out.xformers.error).toContain('ModuleNotFoundError')
  })

  it('returns an honest failed result for invalid or empty output', () => {
    const invalid = parseAttentionSelfTest('not json', 100, 'spawn failed')
    expect(invalid.ok).toBe(false)
    expect(invalid.error).toBe('spawn failed')
    expect(invalid.sageattention.ok).toBe(false)

    const missing = parseAttentionSelfTest('', 200)
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('Empty self-test output')

    const noFallback = parseAttentionSelfTest('not json', 250)
    expect(noFallback.error).toContain('Invalid self-test JSON')
  })

  it('normalizes a JSON object with no package records', () => {
    const out = parseAttentionSelfTest(JSON.stringify({ ok: true, cudaAvailable: false }), 260)
    expect(out.ok).toBe(true)
    expect(out.sageattention).toEqual({
      installed: false,
      version: undefined,
      ok: false,
      error: undefined
    })
    expect(out.xformers.installed).toBe(false)
  })

  it('carries the fallback error when the script exits non-zero', () => {
    const out = parseAttentionSelfTest('', 300, 'exit 1')
    expect(out.error).toBe('exit 1')
    expect(out.testedAt).toBe(300)
  })

  it('emptyAttentionSelfTest marks both optional packages failed', () => {
    const out = emptyAttentionSelfTest('no venv', 400)
    expect(out.ok).toBe(false)
    expect(out.error).toBe('no venv')
    expect(out.sageattention).toMatchObject({ installed: false, ok: false })
    expect(out.xformers).toMatchObject({ installed: false, ok: false })
  })

  it('script exercises imports and both CUDA kernels', () => {
    expect(ATTENTION_SELF_TEST_SCRIPT).toContain('from sageattention import sageattn')
    expect(ATTENTION_SELF_TEST_SCRIPT).toContain(
      'from xformers.ops import memory_efficient_attention'
    )
    expect(ATTENTION_SELF_TEST_SCRIPT).toContain('torch.isfinite')
  })
})
