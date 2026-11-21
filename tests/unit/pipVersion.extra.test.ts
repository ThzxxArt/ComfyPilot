import { describe, expect, it } from 'vitest'
import {
  comparePipVersions,
  evaluateMarker,
  isValidPipSpec,
  normalizePipName,
  parsePipRequirement,
  versionSatisfies
} from '../../src/shared/pipVersion'

describe('pipVersion extra branches', () => {
  it('normalises names and validates specs', () => {
    expect(normalizePipName('')).toBe('')
    expect(normalizePipName(' A__b..C ')).toBe('a-b-c')
    expect(isValidPipSpec('')).toBe(false)
    expect(isValidPipSpec('a'.repeat(201))).toBe(false)
    expect(isValidPipSpec('pkg')).toBe(true)
    expect(isValidPipSpec('pkg[extra1,extra2]>=1.0,<2')).toBe(true)
    expect(isValidPipSpec('pkg @ https://x')).toBe(false)
    expect(isValidPipSpec('pkg; python_version<"3.12"')).toBe(false)
  })

  it('parses every requirement form and rejects the rest', () => {
    expect(parsePipRequirement('')).toBeNull()
    expect(parsePipRequirement('# comment')).toBeNull()
    expect(parsePipRequirement('-r other.txt')).toBeNull()
    expect(parsePipRequirement('pkg # inline')).toMatchObject({ name: 'pkg' })
    expect(parsePipRequirement('pkg ;')).toMatchObject({ name: 'pkg' })
    expect(parsePipRequirement(' ; python_version < "3.12"')).toBeNull()
    expect(parsePipRequirement('pkg[extra] @ https://x/y.whl')).toMatchObject({
      name: 'pkg',
      extras: ['extra'],
      directUrl: 'https://x/y.whl'
    })
    expect(parsePipRequirement('pkg @ https://x/y.whl ; python_version > "3.10"')).toMatchObject({
      marker: 'python_version > "3.10"'
    })
    expect(parsePipRequirement('git+https://github.com/a/b.git@main')).toMatchObject({
      name: 'b'
    })
    expect(parsePipRequirement('git+https://github.com/a/b.git@main#egg=Named')).toMatchObject({
      name: 'named'
    })
    expect(parsePipRequirement('git+https://github.com/a/%2E')).toBeNull()
    expect(parsePipRequirement('git+https://github.com/a/.whl')).toBeNull()
    expect(parsePipRequirement('https://x/y.whl')).toMatchObject({ name: 'y' })
    expect(parsePipRequirement('https://x/not-a-wheel.tar.gz')).toBeNull()
    expect(parsePipRequirement('https://x/..whl#sha256=1')).toBeTruthy()
    expect(parsePipRequirement('C:/path/pkg')).toMatchObject({ name: 'c' })
    expect(parsePipRequirement('pkg@1.0')).toMatchObject({ name: 'pkg' })
    expect(parsePipRequirement('pkg[extra1, extra2] (>=1.0)')).toMatchObject({
      name: 'pkg',
      extras: ['extra1', 'extra2']
    })
    expect(parsePipRequirement('pkg~=1.4.2,!=1.4.5')).toMatchObject({
      specifier: '~=1.4.2,!=1.4.5'
    })
  })

  it('compares dev/pre/post/epoch/local versions', () => {
    const cases: Array<[string, string, number]> = [
      ['1.0.dev1', '1.0a1', -1],
      ['1.0a1', '1.0b1', -1],
      ['1.0b1', '1.0rc1', -1],
      ['1.0rc1', '1.0', -1],
      ['1.0', '1.0.post1', -1],
      ['1.0.0', '1.0', 0],
      ['2!1.0', '1.0', 1],
      ['bad!1.0', '1.0', -1],
      ['1.0+abc', '1.0', 1],
      ['1.0+abc', '1.0+abd', -1],
      ['1.0+2', '1.0+1', 1],
      ['1.0+abc', '1.0+1', -1],
      ['1.0+1', '1.0+abc', 1],
      ['1.0alpha2', '1.0a10', -1],
      ['1.0beta', '1.0b1', -1],
      ['1.0preview1', '1.0rc1', -1],
      ['1.0rev2', '1.0', 1],
      ['1.0dev', '1.0dev1', -1],
      ['1.0.1', '1.0.2', -1],
      ['1.0.10', '1.0.9', 1]
    ]
    for (const [a, b, want] of cases) {
      expect(Math.sign(comparePipVersions(a, b)), `${a} vs ${b}`).toBe(want)
    }
  })

  it('evaluates markers and platform comparisons', () => {
    expect(evaluateMarker('')).toBe(true)
    expect(evaluateMarker('unknown_marker == "x"')).toBeNull()
    expect(evaluateMarker('extra == "cuda"')).toBeNull()
    expect(evaluateMarker('python_version >= "3.12" and python_version < "4"')).toBe(true)
    expect(evaluateMarker('python_version < "3" or python_version >= "3"')).toBe(true)
    expect(evaluateMarker('python_version < "3" and extra == "cuda"')).toBe(false)
    expect(evaluateMarker('python_version >= "3" or extra == "cuda"')).toBe(true)
    expect(evaluateMarker('python_version < "3" or extra == "cuda"')).toBeNull()
    expect(evaluateMarker('python_version >= "3" and extra == "cuda"')).toBeNull()
    expect(evaluateMarker('sys_platform == "linux"')).toBe(
      process.platform === 'linux' ? true : false
    )
    expect(evaluateMarker('sys_platform != "win32"')).toBe(process.platform !== 'win32')
    expect(evaluateMarker('sys_platform <= "zzz"')).toBe(true)
    expect(evaluateMarker('sys_platform >= "aaa"')).toBe(true)
    expect(evaluateMarker('sys_platform < "zzz"')).toBe(true)
    expect(evaluateMarker('sys_platform > "aaa"')).toBe(true)
    expect(evaluateMarker('sys_platform === "linux"')).toBe(process.platform === 'linux')
    expect(evaluateMarker('sys_platform in "lin"')).toBe(process.platform === 'linux')
    expect(evaluateMarker('sys_platform not in "win"')).toBe(process.platform !== 'win32')
    expect(evaluateMarker('python_version', { pythonVersion: '3.13.1' })).toBeNull()
    expect(evaluateMarker('python_version == "3.13"', { pythonVersion: '3.13.1' })).toBe(false)
    expect(evaluateMarker('python_version === "3.13.1"', { pythonVersion: '3.13.1' })).toBe(true)
    expect(evaluateMarker('python_version != "3.12"', { pythonVersion: '3.13.1' })).toBe(true)
    expect(evaluateMarker('python_version > "3.10"', { pythonVersion: '3.13.1' })).toBe(true)
    expect(evaluateMarker('python_version >= "3.13.1"', { pythonVersion: '3.13.1' })).toBe(true)
    expect(evaluateMarker('python_version <= "3.13"', { pythonVersion: '3.13.1' })).toBe(false)
    expect(evaluateMarker('python_version < "3.13"', { pythonVersion: '3.13.1' })).toBe(false)
    expect(evaluateMarker('python_version ~= "3.13.0"', { pythonVersion: '3.13.1' })).toBe(true)
    expect(evaluateMarker('python_version ~= "3.13.0"', { pythonVersion: '3.14.0' })).toBe(false)
    expect(evaluateMarker('os_name == "nt"', { osName: 'nt' })).toBe(true)
    expect(evaluateMarker('platform_system == "Linux"', { platformSystem: 'Linux' })).toBe(true)
    expect(evaluateMarker('python_version == "3.13"', { pythonVersion: '' })).toBe(false)
  })

  it('satisfies every clause shape', () => {
    expect(versionSatisfies('1.2.3', '')).toBe(true)
    expect(versionSatisfies('', '>=1')).toBe(false)
    expect(versionSatisfies('1.2.3+cu130', '==1.2.3')).toBe(true)
    expect(versionSatisfies('1.2.3+cu130', '==1.2.3+cu130')).toBe(true)
    expect(versionSatisfies('1.2.3', '==1.2.*')).toBe(true)
    expect(versionSatisfies('1.3.0', '==1.2.*')).toBe(false)
    expect(versionSatisfies('1.3.0', '!=1.2.*')).toBe(true)
    expect(versionSatisfies('1.2.5', '!=1.2.*')).toBe(false)
    expect(versionSatisfies('1.2.3', '===1.2.3')).toBe(true)
    expect(versionSatisfies('1.2.3', '===1.2.4')).toBe(false)
    expect(versionSatisfies('1.2.3', '~=1.2.0')).toBe(true)
    expect(versionSatisfies('2.0.0', '~=1.2.0')).toBe(false)
    expect(versionSatisfies('1.2.3', '>=1,<=2,>1,<2,!=1.2.2')).toBe(true)
    expect(versionSatisfies('1.2.3', 'garbage')).toBe(true)
    expect(versionSatisfies('1.2.3', '>=1,garbage')).toBe(true)
    expect(versionSatisfies('2.0', '~=2.0')).toBe(true)
    expect(versionSatisfies('2.1', '~=2.0')).toBe(true)
  })
})
