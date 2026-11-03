/** PEP 440-lite helpers (0.1.12) — requirement parsing, version rules, spec validation. */
import { describe, it, expect } from 'vitest'
import {
  normalizePipName,
  parsePipRequirement,
  comparePipVersions,
  versionSatisfies,
  isValidPipSpec
} from '../../src/shared/pipVersion'

describe('normalizePipName', () => {
  it('applies PEP 503 normalization', () => {
    expect(normalizePipName('OpenCV_Python')).toBe('opencv-python')
    expect(normalizePipName('flash..attn')).toBe('flash-attn')
  })
})

describe('parsePipRequirement', () => {
  it('parses names, extras and specifiers', () => {
    const r = parsePipRequirement('Flash_Attn[cuda]>=2.6.0,<3 ; python_version >= "3.10"')
    expect(r?.name).toBe('flash-attn')
    expect(r?.extras).toEqual(['cuda'])
    expect(r?.specifier).toBe('>=2.6.0,<3')
  })

  it('parses named, VCS and wheel direct references by inferred name', () => {
    const named = parsePipRequirement('sam2 @ git+https://github.com/facebookresearch/sam2')
    expect(named?.name).toBe('sam2')
    expect(named?.directUrl).toContain('facebookresearch/sam2')
    expect(parsePipRequirement('git+https://github.com/a/b.git')?.name).toBe('b')
    expect(parsePipRequirement('https://example.com/pkg-1.0-py3-none-any.whl')?.name).toBe('pkg')
  })

  it('rejects comments, options, paths, unnameable URLs and editable installs', () => {
    expect(parsePipRequirement('# comment')).toBeNull()
    expect(parsePipRequirement('-r other.txt')).toBeNull()
    expect(parsePipRequirement('./local-pkg')).toBeNull()
    expect(parsePipRequirement('https://example.com/a.zip')).toBeNull()
    expect(parsePipRequirement('-e ./local-pkg')).toBeNull()
    expect(parsePipRequirement('')).toBeNull()
  })

  it('keeps bare names and single pins', () => {
    expect(parsePipRequirement('sageattention')?.specifier).toBe('')
    expect(parsePipRequirement('onnx==1.17.0')?.specifier).toBe('==1.17.0')
    expect(parsePipRequirement('matplotlib # inline comment')?.name).toBe('matplotlib')
  })
})

describe('comparePipVersions', () => {
  it('orders numeric segments numerically (not lexically)', () => {
    expect(comparePipVersions('1.10', '1.9')).toBe(1)
    expect(comparePipVersions('2.2.0', '2.2.0')).toBe(0)
    expect(comparePipVersions('1.0', '2.0')).toBe(-1)
  })

  it('treats pre-release suffixes below the bare release (PEP 440)', () => {
    expect(comparePipVersions('1.0rc1', '1.0')).toBe(-1)
    expect(comparePipVersions('1.0b2', '1.0b10')).toBe(-1)
  })

  it('handles epoch and local versions', () => {
    expect(comparePipVersions('1!1.0', '2.0')).toBe(1)
    expect(comparePipVersions('2.2.0+cu130', '2.2.0')).toBe(1)
    expect(comparePipVersions('2.2.0', '2.2.0+cu130')).toBe(-1)
  })

  it('orders multi-segment releases correctly', () => {
    expect(comparePipVersions('2.9.0', '2.10.0')).toBe(-1)
    // 0.2.0: trailing zero segments are insignificant (PEP 440).
    expect(comparePipVersions('0.39.0', '0.39')).toBe(0)
    expect(comparePipVersions('1.0', '1.0.0')).toBe(0)
    expect(comparePipVersions('1.0rc1', '1.0')).toBe(-1)
    expect(comparePipVersions('1.0', '1.0.post1')).toBe(-1)
    expect(comparePipVersions('1.0.dev1', '1.0a1')).toBe(-1)
    expect(comparePipVersions('1.0.post1', '1.0')).toBe(1)
    expect(comparePipVersions('1.0', '1.0.post1')).toBe(-1)
  })

  it('keeps environment markers and evaluates the common ones (0.2.0)', async () => {
    const { parsePipRequirement, evaluateMarker } = await import('@shared/pipVersion')
    const req = parsePipRequirement('torch ; python_version < "3.12"')
    expect(req?.marker).toContain('python_version')
    expect(evaluateMarker('python_version < "3.12"', { pythonVersion: '3.13.18' })).toBe(false)
    expect(evaluateMarker('python_version >= "3.12"', { pythonVersion: '3.13.18' })).toBe(true)
    expect(evaluateMarker('sys_platform == "win32"', { sysPlatform: 'linux' })).toBe(false)
    expect(evaluateMarker('sys_platform == "win32"', { sysPlatform: 'win32' })).toBe(true)
    expect(evaluateMarker('extra == "cuda"')).toBeNull()
    expect(
      evaluateMarker('python_version < "3.12" or sys_platform == "linux"', {
        pythonVersion: '3.13'
      })
    ).toBe(true)
    expect(evaluateMarker('sys_platform != "win32"', { sysPlatform: 'linux' })).toBe(true)
    expect(evaluateMarker('sys_platform > "a"', { sysPlatform: 'b' })).toBe(true)
    expect(evaluateMarker('sys_platform in "linux"', { sysPlatform: 'linux' })).toBe(true)
    expect(evaluateMarker('sys_platform not in "win32"', { sysPlatform: 'linux' })).toBe(true)
    expect(evaluateMarker('os_name == "posix"', { osName: 'posix' })).toBe(true)
    expect(evaluateMarker('platform_system == "Linux"', { platformSystem: 'Linux' })).toBe(true)
    expect(evaluateMarker('python_full_version ~= "3.13.0"', { pythonVersion: '3.13.2' })).toBe(
      true
    )
    expect(evaluateMarker('python_version ~= "3.12"', { pythonVersion: '3.13.2' })).toBe(true)
    expect(evaluateMarker('unknown_marker == "x"')).toBeNull()
    expect(
      evaluateMarker('python_version < "3" and sys_platform == "linux"', { pythonVersion: '3.13' })
    ).toBe(false)
    expect(
      evaluateMarker('python_version > "3" and sys_platform == "linux"', {
        pythonVersion: '3.13',
        sysPlatform: 'win32'
      })
    ).toBe(false)
  })

  it('parses extras and URL/VCS lines honestly', async () => {
    const { parsePipRequirement } = await import('@shared/pipVersion')
    const req = parsePipRequirement('flash-attn[cuda]>=2.0,<3')
    expect(req?.name).toBe('flash-attn')
    expect(req?.extras).toEqual(['cuda'])
    expect(req?.specifier).toBe('>=2.0,<3')
    expect(parsePipRequirement('-r other.txt')).toBeNull()
    expect(parsePipRequirement('https://example.com/a.whl')?.directUrl).toBe(
      'https://example.com/a.whl'
    )
    expect(parsePipRequirement('https://example.com/a.zip')).toBeNull()
  })

  it('handles token-count mismatch, alpha-vs-numeric and local ordering', () => {
    expect(comparePipVersions('1.0.0', '1.0.0.1')).toBe(-1)
    expect(comparePipVersions('1.0.0.1', '1.0.0')).toBe(1)
    expect(comparePipVersions('1.0a1', '1.0.1')).toBe(-1)
    expect(comparePipVersions('2.2.0+cu130abc', '2.2.0+cu130xyz')).toBe(-1)
    expect(comparePipVersions('2.2.0+cu130', '2.2.0+cu130')).toBe(0)
  })
})

describe('versionSatisfies', () => {
  it('supports the common specifier set', () => {
    expect(versionSatisfies('2.6.0', '>=2.6.0,<3')).toBe(true)
    expect(versionSatisfies('3.0.0', '>=2.6.0,<3')).toBe(false)
    expect(versionSatisfies('1.17.0', '==1.17.0')).toBe(true)
    expect(versionSatisfies('1.17.1', '==1.17.0')).toBe(false)
    expect(versionSatisfies('1.17.1', '!=1.17.0')).toBe(true)
    expect(versionSatisfies('2.2.0', '~=2.2.0')).toBe(true)
    expect(versionSatisfies('2.3.0', '~=2.2.0')).toBe(false)
    expect(versionSatisfies('2.2.5', '==2.2.*')).toBe(true)
    expect(versionSatisfies('2.3.0', '==2.2.*')).toBe(false)
  })

  it('passes on empty specifier; fails on empty installed', () => {
    expect(versionSatisfies('anything', '')).toBe(true)
    expect(versionSatisfies('', '>=1.0')).toBe(false)
  })

  it('treats unparseable clauses as satisfied (advisory audit)', () => {
    expect(versionSatisfies('1.0.0', 'weird-clause')).toBe(true)
  })

  it('handles the CJK real-world case: 1.0 must NOT satisfy >=1.2', () => {
    expect(versionSatisfies('1.0', '>=1.2')).toBe(false)
  })

  it('applies the PEP 440 local-version rule (installed local ignored)', () => {
    // Real case: torch 2.9.0+cu130 must satisfy a declared `torch==2.9.0`.
    expect(versionSatisfies('2.9.0+cu130', '==2.9.0')).toBe(true)
    expect(versionSatisfies('2.9.0+cu130', '>=2.8')).toBe(true)
    expect(versionSatisfies('2.9.0+cu130', '==2.9.0+cu130')).toBe(true)
    expect(versionSatisfies('2.9.1+cu130', '==2.9.0')).toBe(false)
    expect(versionSatisfies('2.9.0+cu130', '!=2.9.0')).toBe(false)
  })
})

describe('isValidPipSpec', () => {
  it('accepts plain names, extras and pins', () => {
    expect(isValidPipSpec('sageattention')).toBe(true)
    expect(isValidPipSpec('flash-attn[cuda]')).toBe(true)
    expect(isValidPipSpec('onnx==1.17.0')).toBe(true)
    expect(isValidPipSpec('torch>=2.9,<3')).toBe(true)
  })

  it('rejects URLs, paths, whitespace and shell metacharacters', () => {
    expect(isValidPipSpec('https://example.com/a.whl')).toBe(false)
    expect(isValidPipSpec('pkg @ https://x')).toBe(false)
    expect(isValidPipSpec('pkg; rm -rf /')).toBe(false)
    expect(isValidPipSpec('pkg && whoami')).toBe(false)
    expect(isValidPipSpec('pkg name')).toBe(false)
    expect(isValidPipSpec('')).toBe(false)
    expect(isValidPipSpec('a'.repeat(220))).toBe(false)
  })
})
