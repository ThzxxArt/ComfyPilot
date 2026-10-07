import { describe, it, expect, vi, afterEach } from 'vitest'
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
  assertSafeRelativeFilename,
  safeJoinFile,
  isAbsoluteOrRelativePath,
  isWinReservedName
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
    expect(() => assertSafeRelativeFilename('   ')).toThrow()
    expect(() => assertSafeRelativeFilename('.')).toThrow()
    expect(() => assertSafeRelativeFilename('...')).toThrow()
    expect(() => assertSafeRelativeFilename('///')).toThrow()
    expect(() => assertSafeRelativeFilename('___')).toThrow()
  })

  it('throws on reserved device names', () => {
    expect(() => assertSafeRelativeFilename('con.txt')).toThrow(/Reserved/)
    expect(() => assertSafeRelativeFilename('NUL')).toThrow(/Reserved/)
    expect(() => assertSafeRelativeFilename('COM1.dat')).toThrow(/Reserved/)
    expect(assertSafeRelativeFilename('normal.txt')).toBe('normal.txt')
    expect(isWinReservedName('lpt3')).toBe(true)
    expect(isWinReservedName('console')).toBe(false)
  })
})

describe('safeJoin / normalizePathEverySegment roots', () => {
  it('joins safe relative parts under root', () => {
    const target = safeJoin(root, 'assets', 'logo.png')
    expect(target.startsWith(root)).toBe(true)
    expect(safeJoin(root, '')).toBe(root.replace(/[/\\]+$/, '') || root)
    expect(safeJoin(root, '.')).toBeTruthy()
  })

  it('rejects absolute paths that leave the root', () => {
    if (process.platform === 'win32') {
      expect(() => safeJoin(root, 'C:\\Windows\\win.ini')).toThrow()
    } else {
      expect(() => safeJoin(root, '/etc/passwd')).toThrow()
    }
  })

  it('keeps a root separator after the drive prefix', () => {
    const n = normalizePathEverySegment('C:/foo/bar')
    expect(n.toLowerCase().startsWith('c:')).toBe(true)
    expect(n.includes('foo')).toBe(true)
  })

  it('keeps a leading separator for unix-style absolute paths', () => {
    const n = normalizePathEverySegment('/foo/bar')
    expect(n.startsWith('/')).toBe(true)
    expect(n).toContain('foo')
    const win = normalizePathEverySegment('\\foo\\bar')
    expect(win.startsWith('\\')).toBe(true)
  })
})

describe('safeResolveUnder decode and empty edges', () => {
  it('rejects malformed percent-encoding and empty targets', () => {
    expect(safeResolveUnder(root, '%')).toBeNull()
    expect(safeResolveUnder(root, '%25252525')).toBeNull()
    expect(safeResolveUnder(root, '///')).toBeNull()
    expect(safeResolveUnder(root, '   ')).toBeNull()
    expect(safeResolveUnder(root, '')).toBeNull()
    expect(safeResolveUnder(root, 'a%00b')).toBeNull()
  })

  it('allows plain nested paths without decoding', () => {
    expect(safeResolveUnder(root, 'a/b.png')).toBeTruthy()
    expect(safeResolveUnder(root, './a/b.png')).toBeTruthy()
  })
})

describe('resolveInsideAnyRoot matching', () => {
  const allow = process.platform === 'win32' ? 'D:\\Downloads' : '/home/user/Downloads'

  it('accepts the root itself and skips empty root entries', () => {
    expect(resolveInsideAnyRoot(allow, ['', allow])).toBe(allow)
    expect(resolveInsideAnyRoot(allow, [])).toBeNull()
  })

  it('rejects candidates outside every root', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'
    expect(resolveInsideAnyRoot(outside, [allow])).toBeNull()
    expect(resolveInsideAnyRoot('', [allow])).toBeNull()
  })

  it('returns null when roots cannot be iterated', () => {
    expect(resolveInsideAnyRoot('a/b', null as never)).toBeNull()
    expect(resolveInsideAnyRoot('a/b', undefined as never)).toBeNull()
  })
})

describe('URL parse failures and non-http localhost', () => {
  it('returns false for unparseable URLs', () => {
    expect(isSafeExternalUrl('%%%')).toBe(false)
    expect(isSafeExternalUrl('http://')).toBe(false)
    expect(isSafeEmbedUrl('nope')).toBe(false)
    expect(isSafeEmbedUrl('')).toBe(false)
    expect(isLocalhostUrl('nope')).toBe(false)
    expect(isLocalhostUrl('')).toBe(false)
  })

  it('rejects non-http(s) localhost lookalikes', () => {
    expect(isLocalhostUrl('ftp://localhost')).toBe(false)
    expect(isLocalhostUrl('file://localhost')).toBe(false)
    expect(isLocalhostUrl('http://[::1]:8188')).toBe(true)
    expect(isLocalhostUrl('http://127.0.0.1')).toBe(true)
    expect(isLocalhostUrl('https://localhost')).toBe(true)
    expect(isLocalhostUrl('http://LOCALHOST:8188')).toBe(true)
    expect(isLocalhostUrl('http://127.0.0.2')).toBe(false)
  })

  it('isSafeEmbedUrl allows http(s) only', () => {
    expect(isSafeEmbedUrl('https://example.com')).toBe(true)
    expect(isSafeEmbedUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeEmbedUrl('not-a-url')).toBe(false)
  })
})

describe('isSafeOpenPath / safeJoinFile / isAbsoluteOrRelativePath', () => {
  it('blocks empty and NUL paths', () => {
    expect(isSafeOpenPath('')).toBe(false)
    expect(isSafeOpenPath('a\u0000b.exe')).toBe(false)
    expect(isSafeOpenPath('plain.txt')).toBe(true)
  })

  it('blocks remaining executable extensions', () => {
    for (const ext of ['.msi', '.jar', '.cpl', '.reg', '.url', '.hta', '.vbs', '.wsf']) {
      expect(isSafeOpenPath(`C:\\x\\a${ext}`)).toBe(false)
    }
  })

  it('safeJoinFile builds a contained path', () => {
    const out = safeJoinFile(root, 'report.pdf')
    expect(out).toContain('report.pdf')
    expect(safeJoinFile(root, '../../evil.bin')).toContain('evil')
    expect(() => safeJoinFile(root, 'con')).toThrow()
    expect(() => safeJoinFile(root, '')).toThrow()
  })

  it('isAbsoluteOrRelativePath classifies inputs', () => {
    expect(isAbsoluteOrRelativePath('file.txt')).toBe(false)
    expect(isAbsoluteOrRelativePath('')).toBe(false)
    expect(isAbsoluteOrRelativePath('a/b')).toBe(true)
    expect(isAbsoluteOrRelativePath('a\\b')).toBe(true)
    expect(isAbsoluteOrRelativePath(process.platform === 'win32' ? 'C:\\a' : '/a')).toBe(true)
  })
})

describe('isPathInside platform folding', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('folds case on win32 and is strict off win32', () => {
    const spy = vi.spyOn(process, 'platform', 'get')
    spy.mockReturnValue('win32')
    expect(isPathInside('C:\\App\\Root\\x', 'c:\\app\\root')).toBe(true)

    spy.mockReturnValue('linux')
    expect(isPathInside('/app/root/x', '/app/root')).toBe(true)
    expect(isPathInside('/app/root', '/app/root')).toBe(true)
    expect(isPathInside('/app/root-evil/x', '/app/root')).toBe(false)
  })
})

describe('normalizePathSegment empty input', () => {
  it('handles empty and undefined-like segments', () => {
    expect(normalizePathSegment('')).toBe('')
    expect(normalizePathSegment('...')).toBe('')
    expect(normalizePathSegment('   ')).toBe('')
  })
})
