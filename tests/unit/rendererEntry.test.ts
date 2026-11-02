import { describe, expect, it, afterEach } from 'vitest'
import { isOwnRendererUrl } from '../../src/main/services/rendererEntry'

const original = process.env.ELECTRON_RENDERER_URL
afterEach(() => {
  if (original === undefined) delete process.env.ELECTRON_RENDERER_URL
  else process.env.ELECTRON_RENDERER_URL = original
})

describe('rendererEntry (0.2.0 single definition)', () => {
  it('accepts the configured dev renderer URL', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    expect(isOwnRendererUrl('http://localhost:5173/index.html')).toBe(true)
    expect(isOwnRendererUrl('http://evil.example/index.html')).toBe(false)
  })

  it('rejects non-file production URLs', () => {
    delete process.env.ELECTRON_RENDERER_URL
    expect(isOwnRendererUrl('https://evil.example/index.html')).toBe(false)
    expect(isOwnRendererUrl('data:text/html,hi')).toBe(false)
  })
})
