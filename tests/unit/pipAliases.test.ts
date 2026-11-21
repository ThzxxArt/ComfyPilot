import { describe, it, expect } from 'vitest'
import { pipAliasCandidates, resolvePipAlias } from '../../src/shared/pipAliases'

describe('pip import aliases', () => {
  it('normalises separators/case and resolves known aliases', () => {
    expect(resolvePipAlias(' PIL ')).toBe('pillow')
    expect(resolvePipAlias('OpenGL_accelerate')).toBe('pyopengl-accelerate')
    expect(resolvePipAlias('sam2')).toBe('sam-2')
    expect(resolvePipAlias('unknown_pkg')).toBe('unknown-pkg')
    expect(resolvePipAlias('')).toBe('')
  })

  it('builds candidate sets including reverse aliases', () => {
    expect(pipAliasCandidates('opencv')).toContain('opencv-python')
    expect(pipAliasCandidates('pillow')).toContain('pillow')
    expect(pipAliasCandidates('torch-npu')).toContain('torch-npu')
    const empty = pipAliasCandidates('')
    expect(empty).toEqual([''])
    expect(empty).not.toContain('opencv-python')
  })
})
