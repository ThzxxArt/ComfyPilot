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
  })

  it('flags NUL bytes', () => {
    expect(findZipSlipEntry(['a\u0000b'])).toBeTruthy()
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
