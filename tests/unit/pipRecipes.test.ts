/** Curated fix recipes (0.1.12) — data integrity + matching rules. */
import { describe, it, expect } from 'vitest'
import {
  PIP_RECIPES,
  recipeForModule,
  recipeById,
  recipeSupportsPlatform,
  currentPlatform
} from '../../src/shared/pipRecipes'

describe('pip recipes', () => {
  it('every recipe is verifiable: https URLs, pinned hashes+size for wheels', () => {
    for (const r of PIP_RECIPES) {
      expect(r.id).toBeTruthy()
      expect(r.titleKey).toMatch(/^deps\.recipe\./)
      expect(r.descKey).toMatch(/^deps\.recipe\./)
      expect(r.matchModules.length).toBeGreaterThan(0)
      expect(r.sourceUrl).toMatch(/^https:\/\//)
      expect(r.steps.length).toBeGreaterThan(0)
      for (const s of r.steps) {
        if (s.kind === 'pip') expect(s.spec).toBeTruthy()
        if (s.kind === 'wheel') {
          expect(s.url).toMatch(/^https:\/\//)
          expect(s.sha256).toMatch(/^[0-9a-f]{64}$/)
          expect(s.sizeBytes).toBeGreaterThan(0)
        }
      }
    }
  })

  it('matches modules to recipes (sageattention incl. aliases)', () => {
    expect(recipeForModule('sageattention')?.id).toBe('sageattention')
    expect(recipeForModule('triton')?.id).toBe('triton')
    expect(recipeForModule('onnx')?.id).toBe('onnx')
    expect(recipeForModule(' SAGEATTENTION ')?.id).toBe('sageattention')
    expect(recipeForModule('nonexistent')).toBeUndefined()
  })

  it('sageattention is Windows-verified and ordered triton-first', () => {
    const r = recipeById('sageattention')!
    expect(recipeSupportsPlatform(r, 'win32')).toBe(true)
    expect(recipeSupportsPlatform(r, 'linux')).toBe(false)
    expect(r.steps[0].kind).toBe('pip')
    expect(r.steps[0].spec).toBe('triton-windows')
    expect(r.steps[1].kind).toBe('wheel')
  })

  it('platform-free recipes apply everywhere', () => {
    expect(recipeSupportsPlatform(recipeById('triton')!, 'linux')).toBe(true)
    expect(recipeSupportsPlatform(recipeById('onnx')!, 'darwin')).toBe(true)
  })

  it('currentPlatform works without a Node process global (renderer-safe)', () => {
    // In this (Node) environment it reports the real platform…
    expect(currentPlatform()).toBe(process.platform)
    // …and with `process` undefined it falls back to the user agent instead of
    // throwing (isolated renderers have no process global). Both globals may be
    // accessor properties on modern Node — swap via descriptors, not plain assignment.
    const procDesc = Object.getOwnPropertyDescriptor(globalThis, 'process')
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const setGlobal = (key: 'process' | 'navigator', value: unknown): void => {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    }
    try {
      setGlobal('process', undefined)
      setGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120'
      })
      expect(currentPlatform()).toBe('win32')
      setGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
      expect(currentPlatform()).toBe('linux')
      setGlobal('navigator', undefined)
      expect(currentPlatform()).toBe('unknown')
    } finally {
      if (procDesc) Object.defineProperty(globalThis, 'process', procDesc)
      if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  })
})
