/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertSafeEndpointSetting,
  assertSafeRelativeFilename,
  assertSafeSettingsPatch,
  credentialOriginForUrl,
  hasExecutableMagic,
  hasParentHop,
  isAbsoluteOrRelativePath,
  isAllowedListenHost,
  isAllowedListenList,
  isLocalhostUrl,
  isPathInside,
  isSafeDataReadPath,
  isSafeEmbedUrl,
  isSafeExportSourcePath,
  isSafeExternalUrl,
  isSafeOpenPath,
  isSafeOpenPathUnderRoots,
  isWinReservedName,
  normalizeForCompare,
  normalizePathEverySegment,
  normalizePathSegment,
  proxyCredentialOrigin,
  realpathUnderAnyRoot,
  resolveInsideAnyRoot,
  safeJoin,
  safeJoinFile,
  safeResolveUnder,
  sanitizeId,
  stripImportedSettingsSecrets
} from '../../src/main/services/security'

const root = mkdtempSync(join(tmpdir(), 'cp-security-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('security extra branches', () => {
  it('sanitizes ids and relative filenames', () => {
    expect(sanitizeId('')).toBeTruthy()
    expect(sanitizeId('..')).toBeTruthy()
    expect(sanitizeId('a b/c')).toBe('a_b_c')
    expect(sanitizeId('x'.repeat(200))).toHaveLength(120)
    expect(isWinReservedName('con.txt')).toBe(true)
    expect(isWinReservedName('normal.txt')).toBe(false)
    for (const bad of ['', '.', '..', '___', 'con']) {
      expect(() => assertSafeRelativeFilename(bad), bad).toThrow()
    }
    expect(assertSafeRelativeFilename('  good.safetensors  ')).toBe('good.safetensors')
    expect(assertSafeRelativeFilename('a/b..c.png')).toBe('a_b_c.png')
    expect(assertSafeRelativeFilename('x'.repeat(300))).toHaveLength(180)
  })

  it('normalizes segments and paths', () => {
    expect(normalizePathSegment(' a\u0000b.  ')).toBe('ab')
    expect(normalizePathSegment('...')).toBe('')
    expect(normalizePathEverySegment('C:\\a\\.. \\b')).toBe('C:\\a\\..\\b')
    expect(normalizePathEverySegment('/a/.../b')).toBe('/a/../b')
    expect(normalizePathEverySegment('a/./b')).toBe('a/b')
    expect(normalizePathEverySegment('a\\b')).toBe('a\\b')
    expect(hasParentHop('a/../b')).toBe(true)
    expect(hasParentHop('a..b/c')).toBe(false)
    expect(normalizeForCompare('C:\\\\a\\\\b\\\\')).toBe('C:/a/b')
    expect(normalizeForCompare('/')).toBe('/')
    expect(isPathInside('/a/b', '/a')).toBe(true)
    expect(isPathInside('/a', '/a/b')).toBe(false)
    expect(isPathInside('C:/A/B', 'c:/a')).toBe(process.platform === 'win32')
  })

  it('joins and resolves paths safely', () => {
    expect(safeJoin('/root', 'a', 'b')).toBe(resolve('/root', 'a', 'b'))
    expect(() => safeJoin('/root', '..')).toThrow()
    expect(safeResolveUnder('/root', 'a')).toBe(resolve('/root', 'a'))
    expect(safeResolveUnder('/root', '../a')).toBeNull()
    expect(safeResolveUnder('/root', 1 as never)).toBe(resolve('/root', '1'))
    expect(resolveInsideAnyRoot('/a/b', ['/a'])).toBe(resolve('/a/b'))
    expect(resolveInsideAnyRoot('/b', ['/a'])).toBeNull()
    expect(resolveInsideAnyRoot('/a/../b', ['/b'])).toBeNull()
    expect(safeJoinFile('/root', 'a/b')).toBe(resolve('/root', 'b'))
    expect(() => safeJoinFile('/root', '..')).toThrow()
    expect(isAbsoluteOrRelativePath('/x')).toBe(true)
    expect(isAbsoluteOrRelativePath('x/y')).toBe(true)
    expect(isAbsoluteOrRelativePath('x')).toBe(false)
  })

  it('validates URLs and listen addresses', () => {
    expect(isSafeExternalUrl('https://x')).toBe(true)
    expect(isSafeExternalUrl('file:///x')).toBe(false)
    expect(isSafeExternalUrl('not url')).toBe(false)
    expect(isSafeEmbedUrl('http://x')).toBe(true)
    expect(isSafeEmbedUrl('ftp://x')).toBe(false)
    expect(isSafeEmbedUrl('bad')).toBe(false)
    expect(isLocalhostUrl('http://localhost')).toBe(true)
    expect(isLocalhostUrl('https://127.0.0.1')).toBe(true)
    expect(isLocalhostUrl('http://[::1]')).toBe(true)
    expect(isLocalhostUrl('ftp://localhost')).toBe(false)
    expect(isLocalhostUrl('http://localhost.evil')).toBe(false)
    expect(isLocalhostUrl('bad')).toBe(false)
    for (const host of [
      '0.0.0.0',
      '::',
      '*',
      '::1',
      '127.1.2.3',
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '100.64.0.1',
      'fd00::1',
      'fe80::1'
    ]) {
      expect(isAllowedListenHost(host), host).toBe(true)
    }
    for (const host of [
      '',
      '8.8.8.8',
      '999.1.1.1',
      '11.0.0.1',
      '172.15.0.1',
      '100.63.0.1',
      'abcd',
      'fc'
    ]) {
      expect(isAllowedListenHost(host), host).toBe(false)
    }
    expect(isAllowedListenList('127.0.0.1, 10.0.0.1')).toBe(true)
    expect(isAllowedListenList('')).toBe(false)
    expect(isAllowedListenList('8.8.8.8')).toBe(false)
  })

  it('gates open/read/export paths and executable magic', () => {
    expect(isSafeOpenPath('')).toBe(false)
    expect(isSafeOpenPath('a\0b')).toBe(false)
    expect(isSafeOpenPath('evil.exe ')).toBe(false)
    expect(isSafeOpenPath('ok.png')).toBe(true)
    const exe = join(root, 'evil.png')
    writeFileSync(exe, Buffer.from([0x4d, 0x5a, 0, 0]))
    const txt = join(root, 'ok.txt')
    writeFileSync(txt, 'hello')
    const empty = join(root, 'empty.txt')
    writeFileSync(empty, '')
    const dir = join(root, 'dir')
    writeFileSync(dir, '')
    expect(hasExecutableMagic(exe)).toBe(true)
    expect(hasExecutableMagic(txt)).toBe(false)
    expect(hasExecutableMagic(empty)).toBe(false)
    expect(hasExecutableMagic(join(root, 'missing'))).toBe(false)
    expect(isSafeOpenPathUnderRoots(txt, [root])).toBe(true)
    expect(isSafeOpenPathUnderRoots(exe, [root])).toBe(false)
    expect(isSafeOpenPathUnderRoots(txt, [])).toBe(false)
    expect(isSafeOpenPathUnderRoots('evil.exe', [root])).toBe(false)
    expect(isSafeExportSourcePath(txt, [root])).toBe(true)
    expect(isSafeExportSourcePath(exe, [root])).toBe(false)
    expect(isSafeExportSourcePath('', [root])).toBe(false)
    expect(isSafeExportSourcePath('a\0b', [root])).toBe(false)
    expect(realpathUnderAnyRoot(txt, [root])).toBeTruthy()
    expect(realpathUnderAnyRoot(join(root, 'missing'), [root])).toBeNull()
    expect(realpathUnderAnyRoot('', [root])).toBeNull()
    expect(realpathUnderAnyRoot(txt, ['', '/nope'])).toBeNull()
    expect(isSafeDataReadPath(txt, { approvedRoots: [root], allowedRoots: [] })).toBe(true)
    expect(isSafeDataReadPath(txt, { approvedRoots: [], allowedRoots: [root] })).toBe(true)
    expect(isSafeDataReadPath(exe, { approvedRoots: [], allowedRoots: [root] })).toBe(true)
    expect(isSafeDataReadPath('bad.bin', { approvedRoots: [root], allowedRoots: [] })).toBe(false)
    expect(isSafeDataReadPath('', { approvedRoots: [root], allowedRoots: [] })).toBe(false)
  })

  it('validates endpoint settings and settings patches', () => {
    const txt = join(root, 'aria2.txt')
    writeFileSync(txt, 'x')
    expect(() => assertSafeEndpointSetting('x', undefined)).not.toThrow()
    expect(() => assertSafeEndpointSetting('x', 1)).toThrow()
    expect(() => assertSafeEndpointSetting('x', 'not url')).toThrow()
    expect(() => assertSafeEndpointSetting('x', 'ftp://x')).toThrow()
    expect(() => assertSafeEndpointSetting('x', 'http://u:p@x')).toThrow()
    expect(() => assertSafeEndpointSetting('x', 'https://x')).not.toThrow()

    expect(credentialOriginForUrl('https://Host/prod/')).toBe('https://host/prod')
    expect(credentialOriginForUrl('bad')).toBe('')
    expect(proxyCredentialOrigin({})).toBe('http://:0')
    expect(proxyCredentialOrigin({ protocol: 'HTTPS', host: ' H ', port: 1, username: 'u' })).toBe(
      'https://u@h:1'
    )

    expect(() => assertSafeSettingsPatch({ locale: 'bad' })).toThrow()
    expect(() => assertSafeSettingsPatch({ securityLevel: 'bad' })).toThrow()
    expect(() => assertSafeSettingsPatch({ networkMode: 'bad' })).toThrow()
    expect(() => assertSafeSettingsPatch({ stopMode: 'bad' })).toThrow()
    expect(() => assertSafeSettingsPatch({ embedFrontend: 1 })).toThrow()
    expect(() => assertSafeSettingsPatch({ activeInstance: 'a\nb' })).toThrow()
    expect(() => assertSafeSettingsPatch({ activeInstance: 'a'.repeat(201) })).toThrow()
    expect(() => assertSafeSettingsPatch({ modelScanRoots: 'x' })).toThrow()
    expect(() => assertSafeSettingsPatch({ modelScanRoots: [1] })).toThrow()
    expect(() => assertSafeSettingsPatch({ modelScanRoots: [''] })).toThrow()
    expect(() => assertSafeSettingsPatch({ modelScanRoots: ['a\0b'] })).toThrow()
    expect(() => assertSafeSettingsPatch({ modelScanRoots: [join(root, 'missing')] })).toThrow()
    expect(() => assertSafeSettingsPatch({ modelScanRoots: [txt] })).not.toThrow()
    for (const key of [
      'healthCheckIntervalMs',
      'healthCheckTimeoutMs',
      'healthStaleMs',
      'autoRecoverCooldownMs',
      'autoRecoverMaxAttempts',
      'batchDeadlineMs'
    ]) {
      expect(() => assertSafeSettingsPatch({ [key]: 'x' }), key).toThrow()
      expect(() => assertSafeSettingsPatch({ [key]: -1 }), key).toThrow()
    }
    expect(() => assertSafeSettingsPatch({ outputScanDepth: 1 })).toThrow()
    expect(() => assertSafeSettingsPatch({ outputScanDepth: 2.5 })).toThrow()
    expect(() => assertSafeSettingsPatch({ proxy: 1 })).toThrow()
    expect(() => assertSafeSettingsPatch({ proxy: [] })).toThrow()
    expect(() => assertSafeSettingsPatch({ proxy: { port: 0 } })).toThrow()
    for (const key of ['host', 'username', 'password', 'bypass']) {
      expect(() => assertSafeSettingsPatch({ proxy: { [key]: 1 } })).toThrow()
    }
    expect(() => assertSafeSettingsPatch({ proxy: { enabled: 'yes' } })).toThrow()
    expect(() => assertSafeSettingsPatch({ proxy: { protocol: 'ftp' } })).toThrow()
    expect(() => assertSafeSettingsPatch({ proxy: { enabled: true, host: '' } })).toThrow()
    expect(() => assertSafeSettingsPatch({ proxy: { enabled: true, host: 'a;b' } })).toThrow()
    expect(() => assertSafeSettingsPatch({ proxy: { enabled: true, host: 'a' } })).not.toThrow()
    expect(() => assertSafeSettingsPatch({ aria2Path: 'rel' })).toThrow()
    expect(() => assertSafeSettingsPatch({ aria2Path: 'a\0b' })).toThrow()
    expect(() => assertSafeSettingsPatch({ aria2Path: join(root, 'missing') })).toThrow()
    expect(() => assertSafeSettingsPatch({ aria2Path: txt })).not.toThrow()
  })

  it('strips imported secrets and unsafe runtime flags', () => {
    const out = stripImportedSettingsSecrets({
      locale: 'en-US',
      proxy: { host: 'h', password: 'secret' },
      allowUnverifiedRuntime: true,
      allowGitUrlInstall: true
    })
    expect(out.patch.locale).toBe('en-US')
    expect((out.patch.proxy as any).password).toBeUndefined()
    expect(out.patch.allowUnverifiedRuntime).toBeUndefined()
    expect(out.applied).toContain('locale')
    const arr = stripImportedSettingsSecrets({ proxy: [] })
    expect(arr.patch.proxy).toEqual([])
  })
})
