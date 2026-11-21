import { describe, it, expect } from 'vitest'
import { categoryVisual } from '../../src/renderer/src/utils/categoryIcons'

describe('categoryVisual', () => {
  it('returns a stable visual for known categories and a fallback for unknown ones', () => {
    for (const cat of ['checkpoints', 'loras', 'vae', 'controlnet', 'clip', 'unet', 'other']) {
      expect(categoryVisual(cat).icon).toBeTruthy()
      expect(categoryVisual(cat).tone).toMatch(/^#/)
    }
    const fallback = categoryVisual('not-a-category')
    expect(fallback.icon).toBeTruthy()
    expect(fallback.tone).toBe(categoryVisual('other').tone)
    expect(fallback.tone).not.toBe(categoryVisual('checkpoints').tone)
  })
})
