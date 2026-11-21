import { describe, expect, it } from 'vitest'
import {
  buildEffectiveArgList,
  firstFlagValue,
  formatHostUrl,
  isAbsolutePathLike,
  isManagerEnabledInArgv,
  isWildcardHost,
  joinPathLike,
  parseListenAddresses,
  probeHostForListen,
  readLastFlagValue,
  resolveEffectiveDirs,
  resolveEffectiveInstance,
  resolveEffectiveListen,
  resolveEffectivePort,
  splitFlagToken
} from '../../src/shared/instanceLayout'

const base: any = {
  id: 'i1',
  name: 'Main',
  path: '/opt/ComfyUI',
  port: 8188,
  listen: '127.0.0.1',
  extraArgs: [],
  argTemplateId: 'default',
  enabled: true
}

describe('instanceLayout extra branches', () => {
  it('parses flags and values', () => {
    expect(splitFlagToken('')).toEqual({ flag: '' })
    expect(splitFlagToken('value')).toEqual({ flag: 'value' })
    expect(splitFlagToken('--a')).toEqual({ flag: '--a' })
    expect(splitFlagToken('--a=')).toEqual({ flag: '--a', value: '' })
    expect(splitFlagToken('--a=b=c')).toEqual({ flag: '--a', value: 'b=c' })
    expect(readLastFlagValue(['--x', '1', '--x=2'], '--x')).toBe('2')
    expect(readLastFlagValue(['--x', '--y'], '--x')).toBeUndefined()
    expect(readLastFlagValue([], '--x')).toBeUndefined()
    expect(firstFlagValue(['--x=1', '--x', '2'], '--x')).toBe('1')
    expect(firstFlagValue(['--x'], '--x')).toBeUndefined()
    expect(firstFlagValue([], '--x')).toBeUndefined()
  })

  it('handles absolute and joined paths', () => {
    for (const p of ['/a', '\\\\srv\\a', '//srv/a', 'C:\\a', 'C:/a', 'C:']) {
      expect(isAbsolutePathLike(p), p).toBe(true)
    }
    for (const p of ['', 'a', 'C', './a']) {
      expect(isAbsolutePathLike(p), p).toBe(false)
    }
    expect(joinPathLike('/root', '')).toBe('/root')
    expect(joinPathLike('/root/', 'a/../b')).toBe('/root/b')
    expect(joinPathLike('C:\\root', '../a')).toBe('C:\\a')
    expect(joinPathLike('', 'a')).toBe('/a')
    expect(joinPathLike('/root', '/abs/./x')).toBe('/abs/x')
  })

  it('parses listen addresses and picks probe hosts', () => {
    expect(parseListenAddresses(undefined)).toEqual([])
    expect(parseListenAddresses('')).toEqual([])
    expect(parseListenAddresses(' 127.0.0.1, , ::1 ')).toEqual(['127.0.0.1', '::1'])
    expect(isWildcardHost('0.0.0.0')).toBe(true)
    expect(isWildcardHost('[::]')).toBe(true)
    expect(isWildcardHost('*')).toBe(true)
    expect(isWildcardHost('127.0.0.1')).toBe(false)
    expect(probeHostForListen(undefined)).toBe('127.0.0.1')
    expect(probeHostForListen('')).toBe('127.0.0.1')
    expect(probeHostForListen('0.0.0.0')).toBe('127.0.0.1')
    expect(probeHostForListen('10.0.0.1,127.0.0.1')).toBe('127.0.0.1')
    expect(probeHostForListen('[::1]')).toBe('::1')
    expect(probeHostForListen('10.0.0.1')).toBe('10.0.0.1')
    expect(formatHostUrl('::1', 8188)).toBe('http://[::1]:8188')
    expect(formatHostUrl('[::1]', 0)).toBe('http://[::1]:8188')
    expect(formatHostUrl('', 9000)).toBe('http://127.0.0.1:9000')
  })

  it('resolves effective args, ports, listen and dirs', () => {
    expect(resolveEffectivePort(base)).toBe(8188)
    expect(resolveEffectivePort(base, ['--port', '9999'])).toBe(9999)
    expect(resolveEffectivePort(base, ['--port', '0'])).toBe(8188)
    expect(resolveEffectivePort(base, ['--port', 'x'])).toBe(8188)
    expect(resolveEffectivePort({ ...base, port: 0 }, [])).toBe(8188)
    expect(resolveEffectiveListen(base)).toBe('127.0.0.1')
    expect(resolveEffectiveListen(base, ['--listen', '10.0.0.1'])).toBe('10.0.0.1')
    expect(resolveEffectiveListen(base, ['--listen', '  '])).toBe('127.0.0.1')
    const dirs = resolveEffectiveDirs(base, [
      '--base-directory',
      'root',
      '--user-directory',
      'u',
      '--models-directory',
      'm',
      '--input-directory',
      'in',
      '--output-directory',
      'out',
      '--temp-directory',
      'tmp',
      '--previews-directory',
      'prev'
    ])
    expect(dirs.base).toContain('root')
    expect(dirs.workflows).toContain('default/workflows')
    expect(dirs.manager).toContain('__manager')
    const fallback = resolveEffectiveDirs({ ...base, path: '' }, [])
    expect(fallback.base).toBeTruthy()
    const effective = resolveEffectiveInstance(base)
    expect(effective.url).toContain('8188')
    expect(effective.probeHost).toBe('127.0.0.1')
  })

  it('builds args and detects manager/string extra args', () => {
    const args = buildEffectiveArgList(base)
    expect(args).toContain('--port')
    expect(args).toContain('--listen')
    const stringArgs = buildEffectiveArgList({
      ...base,
      extraArgs: '--enable-manager "--foo bar"'
    } as any)
    expect(stringArgs).toContain('--enable-manager')
    expect(isManagerEnabledInArgv({ ...base, extraArgs: ['--enable-manager'] })).toBe(true)
    expect(isManagerEnabledInArgv({ ...base, extraArgs: [] })).toBe(false)
    expect(
      isManagerEnabledInArgv({ ...base, argTemplateId: 'manager', extraArgs: [] } as any)
    ).toBeTypeOf('boolean')
    expect(buildEffectiveArgList({ ...base, extraArgs: undefined } as any)).toContain('--port')
  })
})
