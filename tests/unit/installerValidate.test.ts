import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return { app: { getPath: () => path.join(os.tmpdir(), 'cp-inst-test') } }
})
vi.mock('systeminformation', () => ({
  default: { graphics: async () => ({ controllers: [] }) }
}))

describe('assertSafeGitUrl', () => {
  it('accepts https / ssh / git@ remotes', async () => {
    const { assertSafeGitUrl } = await import('../../src/main/services/installer')
    expect(assertSafeGitUrl('https://github.com/comfyanonymous/ComfyUI.git')).toContain('github.com')
    expect(assertSafeGitUrl('ssh://git@github.com/x/y.git')).toBeTruthy()
    expect(assertSafeGitUrl('git@github.com:x/y.git')).toBeTruthy()
  })

  it('rejects ext:: and option-injection / empty', async () => {
    const { assertSafeGitUrl } = await import('../../src/main/services/installer')
    expect(() => assertSafeGitUrl('ext::sh -c evil')).toThrow()
    expect(() => assertSafeGitUrl('--upload-pack=touch x')).toThrow()
    expect(() => assertSafeGitUrl('')).toThrow()
    expect(() => assertSafeGitUrl('file:///tmp/x')).toThrow()
    expect(() => assertSafeGitUrl('ftp://x/y')).toThrow()
  })
})

describe('assertSafeBranch', () => {
  it('allows normal branch names', async () => {
    const { assertSafeBranch } = await import('../../src/main/services/installer')
    expect(assertSafeBranch('master')).toBe('master')
    expect(assertSafeBranch('feature/foo-bar')).toBe('feature/foo-bar')
    expect(assertSafeBranch('')).toBe('')
    expect(assertSafeBranch(undefined as unknown as string)).toBe('')
  })

  it('rejects dashes, dots-dot, and special chars', async () => {
    const { assertSafeBranch } = await import('../../src/main/services/installer')
    expect(() => assertSafeBranch('-b')).toThrow()
    expect(() => assertSafeBranch('a..b')).toThrow()
    expect(() => assertSafeBranch('a;rm -rf')).toThrow()
    expect(() => assertSafeBranch('a b')).toThrow()
  })
})
