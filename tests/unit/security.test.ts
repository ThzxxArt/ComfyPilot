import { describe, it, expect } from 'vitest'
import {
  sanitizeId,
  normalizePathSegment,
  normalizePathEverySegment,
  hasParentHop,
  isPathInside,
  safeJoin,
  safeResolveUnder,
  resolveInsideAnyRoot,
  isSafeExternalUrl,
  isSafeEmbedUrl,
  isLocalhostUrl,
  isSafeOpenPath,
  assertSafeRelativeFilename
} from '../../src/main/services/security'

const root = process.platform === 'win32' ? 'C:\\app\\root' : '/app/root'

describe('sanitizeId', () => {
  it('strips path separators and dots-dot sequences', () => {
    expect(sanitizeId('../../evil')).not.toContain('..')
    expect(sanitizeId('../../evil')).not.toContain('/')
    expect(sanitizeId('a/b\\c')).not.toContain('/')
    expect(sanitizeId('a/b\\c')).not.toContain('\\')
  })

  it('keeps safe id chars', () => {
    expect(sanitizeId('abc-123_x.y')).toBe('abc-123_x.y')
  })

  it('falls back for empty / pure dots', () => {
    expect(sanitizeId('')).toBeTruthy()
    expect(sanitizeId('...')).toBeTruthy()
  })
})

describe('normalizePathEverySegment / hasParentHop', () => {
  it('strips Win32 trailing spaces per segment so `.. ` becomes a hop', () => {
    // post-decode paths
    expect(hasParentHop('foo/.. /evil')).toBe(true)
    expect(hasParentHop('foo\\.. \\evil')).toBe(true)
    // raw percent-encoding is decoded in safeResolveUnder, not here
    expect(safeResolveUnder(root, 'foo/..%20/..%20/x')).toBeNull()
  })

  it('detects classic .. hops', () => {
    expect(hasParentHop('../etc/passwd')).toBe(true)
    expect(hasParentHop('foo/../../etc')).toBe(true)
    expect(hasParentHop('foo/./bar')).toBe(false)
    expect(hasParentHop('foo/bar')).toBe(false)
  })

  it('normalizePathSegment strips trailing dots/spaces and controls', () => {
    expect(normalizePathSegment('evil.exe ')).toBe('evil.exe')
    expect(normalizePathSegment('evil.exe...')).toBe('evil.exe')
    expect(normalizePathSegment('a\x00b')).toBe('ab')
  })
})

describe('isPathInside / safeJoin / safeResolveUnder', () => {
  it('isPathInside blocks sibling prefix escape', () => {
    const sibling = process.platform === 'win32' ? 'C:\\app\\root-evil\\x' : '/app/root-evil/x'
    expect(isPathInside(sibling, root)).toBe(false)
    expect(isPathInside(root + (process.platform === 'win32' ? '\\a' : '/a'), root)).toBe(true)
  })

  it('safeJoin rejects parent hops', () => {
    expect(() => safeJoin(root, '..', 'evil')).toThrow()
    expect(() => safeJoin(root, 'foo/.. /evil')).toThrow()
  })

  it('safeResolveUnder blocks encoded parent hops and absolute drives', () => {
    expect(safeResolveUnder(root, '..%2f..%2fetc%2fpasswd')).toBeNull()
    expect(safeResolveUnder(root, 'foo/..%20/..%20/x')).toBeNull()
    expect(safeResolveUnder(root, 'C:/Windows/win.ini')).toBeNull()
    expect(safeResolveUnder(root, 'a%00b')).toBeNull()
  })

  it('safeResolveUnder allows nested relative file', () => {
    const p = safeResolveUnder(root, 'assets/logo.png')
    expect(p).toBeTruthy()
  })
})

describe('resolveInsideAnyRoot', () => {
  const allow = process.platform === 'win32' ? 'D:\\Downloads' : '/home/user/Downloads'

  it('rejects parent hop out of allowlist', () => {
    expect(resolveInsideAnyRoot(allow + (process.platform === 'win32' ? '\\.. \\evil' : '/../evil'), [allow])).toBeNull()
    expect(resolveInsideAnyRoot(allow + '/../x', [allow])).toBeNull()
  })

  it('accepts path under root', () => {
    const ok = resolveInsideAnyRoot(allow + (process.platform === 'win32' ? '\\sub' : '/sub'), [allow])
    expect(ok).toBeTruthy()
  })
})

describe('URL safety', () => {
  it('external allowlist', () => {
    expect(isSafeExternalUrl('https://github.com/x')).toBe(true)
    expect(isSafeExternalUrl('http://127.0.0.1:8188')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('ms-msdt:/id x')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
  })

  it('localhost exact host match', () => {
    expect(isLocalhostUrl('http://localhost:8188')).toBe(true)
    expect(isLocalhostUrl('http://127.0.0.1:8188')).toBe(true)
    expect(isLocalhostUrl('http://localhost.evil.com')).toBe(false)
    expect(isLocalhostUrl('https://evil.com/http://localhost')).toBe(false)
  })

  it('embed requires http(s)', () => {
    expect(isSafeEmbedUrl('http://127.0.0.1:8188')).toBe(true)
    expect(isSafeEmbedUrl('file:///x')).toBe(false)
  })
})

describe('isSafeOpenPath', () => {
  it('blocks executables including trailing-space variants', () => {
    expect(isSafeOpenPath('C:\\x\\a.exe')).toBe(false)
    expect(isSafeOpenPath('C:\\x\\a.exe ')).toBe(false)
    expect(isSafeOpenPath('C:\\x\\a.BAT')).toBe(false)
    expect(isSafeOpenPath('C:\\x\\a.ps1')).toBe(false)
    expect(isSafeOpenPath('C:\\x\\a.lnk')).toBe(false)
  })

  it('allows media/json', () => {
    expect(isSafeOpenPath('C:\\x\\w.json')).toBe(true)
    expect(isSafeOpenPath('C:\\x\\a.png')).toBe(true)
    expect(isSafeOpenPath('/home/u/w.png')).toBe(true)
  })
})

describe('assertSafeRelativeFilename', () => {
  it('strips separators and parent refs', () => {
    expect(assertSafeRelativeFilename('../../a.bin')).not.toContain('..')
    expect(assertSafeRelativeFilename('a/b.bin')).not.toContain('/')
  })

  it('throws on empty', () => {
    expect(() => assertSafeRelativeFilename('')).toThrow()
    expect(() => assertSafeRelativeFilename('..')).toThrow()
  })
})
