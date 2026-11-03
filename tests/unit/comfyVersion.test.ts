import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readComfyVersion } from '../../src/main/services/comfyVersion'

describe('readComfyVersion (0.2.3)', () => {
  it('reads the build-time comfyui_version.py first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-comfy-version-'))
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'comfyui_version.py'), '__version__ = "0.43.0"\n')
      writeFileSync(join(dir, 'pyproject.toml'), 'version = "0.40.0"\n')
      expect(readComfyVersion(dir)).toBe('0.43.0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to pyproject.toml when the build file is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-comfy-version-'))
    try {
      writeFileSync(join(dir, 'pyproject.toml'), '[project]\nversion = "0.39.1"\n')
      expect(readComfyVersion(dir)).toBe('0.39.1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for missing or version-less trees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-comfy-version-'))
    try {
      expect(readComfyVersion(dir)).toBeUndefined()
      writeFileSync(join(dir, 'comfyui_version.py'), '# no version here\n')
      expect(readComfyVersion(dir)).toBeUndefined()
      expect(readComfyVersion('')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores a version-looking string that is not an assignment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-comfy-version-'))
    try {
      writeFileSync(join(dir, 'comfyui_version.py'), 'const text = "version = 1.0.0"\n')
      expect(readComfyVersion(dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
