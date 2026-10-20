/**
 * 0.1.17 (WP8) security boundaries:
 *  - launcher/bundle extensions are refused by `isSafeOpenPath`
 *  - settings endpoints only accept http(s)
 *  - renderer data reads are contained by real path resolution (not prefixes)
 *  - extracted trees are walked for symlinks / escapes
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  isSafeOpenPath,
  assertSafeEndpointSetting,
  isSafeDataReadPath
} from '@main/services/security'
import { assertExtractedInside } from '@main/services/zipSafe'

const root = mkdtempSync(join(tmpdir(), 'cp-wp8-'))

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('isSafeOpenPath (0.1.17 additions)', () => {
  it.each(['desktop', 'command', 'app', 'appimage', 'exe', 'bat', 'ps1'])(
    'refuses .%s launchers',
    (ext) => {
      expect(isSafeOpenPath(`/tmp/evil.${ext}`)).toBe(false)
      expect(isSafeOpenPath(`/tmp/EVIL.${ext.toUpperCase()}`)).toBe(false)
    }
  )

  it('still allows ordinary data files', () => {
    expect(isSafeOpenPath('/tmp/workflow.json')).toBe(true)
    expect(isSafeOpenPath('/tmp/render.png')).toBe(true)
  })
})

describe('settings endpoint gate', () => {
  it('accepts http(s) and empty values', () => {
    expect(() => assertSafeEndpointSetting('hfEndpoint', undefined)).not.toThrow()
    expect(() => assertSafeEndpointSetting('hfEndpoint', '')).not.toThrow()
    expect(() => assertSafeEndpointSetting('hfEndpoint', 'https://hf-mirror.com')).not.toThrow()
    expect(() =>
      assertSafeEndpointSetting('pipIndex', 'http://127.0.0.1:8080/simple')
    ).not.toThrow()
  })

  it('rejects non-http schemes and malformed values', () => {
    expect(() => assertSafeEndpointSetting('hfEndpoint', 'file:///etc/passwd')).toThrow(/http/)
    expect(() => assertSafeEndpointSetting('hfEndpoint', 'javascript:alert(1)')).toThrow()
    expect(() => assertSafeEndpointSetting('hfEndpoint', 'not a url')).toThrow(/valid URL/)
    expect(() => assertSafeEndpointSetting('hfEndpoint', 42)).toThrow(/must be a URL/)
  })

  it('rejects URLs that embed credentials (review fix)', () => {
    expect(() =>
      assertSafeEndpointSetting('pipIndex', 'https://user:token@example.com/simple')
    ).toThrow(/credentials/)
    expect(() => assertSafeEndpointSetting('hfEndpoint', 'https://token@mirror.local')).toThrow(
      /credentials/
    )
  })
})

describe('isSafeDataReadPath containment', () => {
  const picked = join(root, 'picked')
  const outside = join(root, 'outside')

  it('trusts files under a picked root', () => {
    expect(
      isSafeDataReadPath(join(picked, 'workflow.json'), {
        approvedRoots: [picked],
        allowedRoots: []
      })
    ).toBe(true)
  })

  it('rejects a traversal that escapes the picked root', () => {
    const escape = join(picked, '..', 'evil.json')
    expect(isSafeDataReadPath(escape, { approvedRoots: [picked], allowedRoots: [] })).toBe(false)
    // Win32 strips trailing spaces, so `.. ` is still a parent hop.
    expect(
      isSafeDataReadPath(`${picked}${'.. '}/evil.json`, {
        approvedRoots: [picked],
        allowedRoots: []
      })
    ).toBe(false)
  })

  it('requires existence under app-owned roots', () => {
    mkdirSync(outside, { recursive: true })
    const real = join(outside, 'wf.json')
    writeFileSync(real, '{}')
    expect(isSafeDataReadPath(real, { approvedRoots: [], allowedRoots: [outside] })).toBe(true)
    expect(
      isSafeDataReadPath(join(outside, 'missing.json'), { approvedRoots: [], allowedRoots: [] })
    ).toBe(false)
  })

  it('refuses a symlink inside an approved folder that points outside (review fix)', () => {
    const insideDir = join(root, 'sym-inside')
    const secretDir = join(root, 'sym-secret')
    mkdirSync(insideDir, { recursive: true })
    mkdirSync(secretDir, { recursive: true })
    writeFileSync(join(secretDir, 'token.json'), '{"secret":true}')
    const link = join(insideDir, 'leak.json')
    try {
      symlinkSync(join(secretDir, 'token.json'), link)
    } catch {
      return // platform without symlink permission (Windows without developer mode)
    }
    // Lexically inside the approved root, but the real file is outside it.
    expect(isSafeDataReadPath(link, { approvedRoots: [insideDir], allowedRoots: [] })).toBe(false)
  })

  it('refuses non-data and executable extensions before touching the disk', () => {
    expect(
      isSafeDataReadPath(join(picked, 'run.exe'), { approvedRoots: [picked], allowedRoots: [] })
    ).toBe(false)
    expect(
      isSafeDataReadPath(join(picked, 'notes.md'), { approvedRoots: [picked], allowedRoots: [] })
    ).toBe(false)
  })
})

describe('assertExtractedInside', () => {
  it('passes a clean tree', () => {
    const dest = join(root, 'clean')
    mkdirSync(join(dest, 'sub'), { recursive: true })
    writeFileSync(join(dest, 'sub', 'a.txt'), 'ok')
    expect(() => assertExtractedInside(dest)).not.toThrow()
    expect(existsSync(dest)).toBe(true)
  })

  it('rejects and removes a tree containing a symlink escape', () => {
    const dest = join(root, 'linky')
    mkdirSync(dest, { recursive: true })
    const target = join(root, 'outside-secret.txt')
    writeFileSync(target, 'secret')
    try {
      symlinkSync(target, join(dest, 'link'))
    } catch {
      return // no symlink privilege (Windows non-admin) — nothing to assert
    }
    expect(() => assertExtractedInside(dest)).toThrow(/symlink/)
    expect(existsSync(dest)).toBe(false)
  })
})
