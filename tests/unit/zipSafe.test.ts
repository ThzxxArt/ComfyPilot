import { describe, it, expect } from 'vitest'
import { findZipSlipEntry } from '../../src/main/services/zipSafe'

describe('findZipSlipEntry', () => {
  it('flags classic parent traversal', () => {
    expect(findZipSlipEntry(['foo/../../etc/passwd'])).toBeTruthy()
    expect(findZipSlipEntry(['../evil.txt'])).toBeTruthy()
    expect(findZipSlipEntry(['..\\evil.txt'])).toBeTruthy()
  })

  it('flags Win32 trailing-space parent hops', () => {
    expect(findZipSlipEntry(['foo/.. /evil'])).toBeTruthy()
    expect(findZipSlipEntry(['.. /x'])).toBeTruthy()
  })

  it('flags absolute paths and drive letters', () => {
    expect(findZipSlipEntry(['/etc/passwd'])).toBeTruthy()
    expect(findZipSlipEntry(['C:/Windows/win.ini'])).toBeTruthy()
    expect(findZipSlipEntry(['C:\\Windows\\win.ini'])).toBeTruthy()
    // drive-relative (not absolute on win32) still matches the drive-letter guard
    expect(findZipSlipEntry(['C:foo/bar.txt'])).toBeTruthy()
    expect(findZipSlipEntry(['c:evil'])).toBeTruthy()
    expect(findZipSlipEntry(['ok.txt'])).toBeNull()
  })

  it('flags NUL bytes', () => {
    expect(findZipSlipEntry(['a\u0000b'])).toBeTruthy()
  })

  it('flags Win32 reserved device names', () => {
    expect(findZipSlipEntry(['NUL'])).toBeTruthy()
    expect(findZipSlipEntry(['CON.txt'])).toBeTruthy()
    expect(findZipSlipEntry(['foo/CON/bar.txt'])).toBeTruthy()
    expect(findZipSlipEntry(['com1.dat'])).toBeTruthy()
    expect(findZipSlipEntry(['LPT9'])).toBeTruthy()
  })

  it('flags trailing dot/space segments', () => {
    expect(findZipSlipEntry(['foo.'])).toBeTruthy()
    expect(findZipSlipEntry(['foo '])).toBeTruthy()
    expect(findZipSlipEntry(['dir./evil'])).toBeTruthy()
    expect(findZipSlipEntry(['dir /evil'])).toBeTruthy()
  })

  it('flags empty mid-path segments', () => {
    expect(findZipSlipEntry(['foo//bar'])).toBeTruthy()
    expect(findZipSlipEntry(['foo/./bar.txt'])).toBeNull()
  })

  it('allows normal nested entries', () => {
    expect(findZipSlipEntry(['ComfyUI/main.py', 'ComfyUI/nodes/foo.py', '__MACOSX/'])).toBeNull()
    expect(findZipSlipEntry(['foo/bar/baz.txt'])).toBeNull()
    expect(findZipSlipEntry(['./foo/bar.txt'])).toBeNull()
  })

  it('empty list is safe', () => {
    expect(findZipSlipEntry([])).toBeNull()
  })
})
