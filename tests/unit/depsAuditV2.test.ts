import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  auditPackRequirements,
  parsePipListJson,
  readPyprojectDependencies,
  readRequirementLines,
  requirementsForPack
} from '../../src/main/services/depsAudit'
import type { NodePackRecord } from '@shared/types'

const roots: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-deps-audit-'))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

function pack(path: string): NodePackRecord {
  return {
    id: 'p1',
    name: 'Pack',
    displayName: 'Pack',
    description: '',
    author: '',
    version: '1.0.0',
    status: 'installed',
    path,
    repository: '',
    nodeCount: 0,
    tags: [],
    installSource: 'local',
    lastCheckedAt: 0,
    issues: [],
    locked: false,
    nodeList: [],
    trainedWords: []
  } as unknown as NodePackRecord
}

describe('depsAudit collectors (0.2.0)', () => {
  it('extracts pip list JSON even with stderr noise', () => {
    const parsed = parsePipListJson(
      'WARNING: deprecation\n[{"name":"Pillow","version":"10.0.0"},{"name":"OpenCV_Python","version":"4.9"}]'
    )
    expect(parsed?.get('pillow')).toBe('10.0.0')
    expect(parsed?.get('opencv-python')).toBe('4.9')
  })

  it('reads -r/-c includes, continuations and pyproject dependencies', () => {
    const dir = temp()
    writeFileSync(join(dir, 'base.txt'), 'requests>=2\n')
    writeFileSync(join(dir, 'constraints.txt'), 'urllib3<3\n')
    writeFileSync(
      join(dir, 'requirements.txt'),
      '# comment\n-r base.txt\n-c constraints.txt\nnumpy \\\n  >=1.26\nhttps://example.com/a.whl\n'
    )
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[project]\ndependencies = [\n  "safetensors>=0.4",\n  "torch; python_version >= \\"3.13\\""\n]\n'
    )
    expect(readRequirementLines(join(dir, 'requirements.txt'))).toEqual([
      'requests>=2',
      'numpy    >=1.26',
      'https://example.com/a.whl'
    ])
    expect(readPyprojectDependencies(join(dir, 'pyproject.toml'))).toEqual([
      'safetensors>=0.4',
      'torch; python_version >= "3.13"'
    ])
    const parsed = requirementsForPack(pack(dir))
    expect(parsed.reqs.map((r) => r.name)).toContain('requests')
    expect(parsed.reqs.map((r) => r.name)).toContain('safetensors')
    expect(parsed.reqs.map((r) => r.name)).toContain('torch')
    expect(parsed.unsupported).toEqual(['https://example.com/a.whl'])
  })

  it('evaluates markers, aliases and PEP 440 versions without false missing', () => {
    const dir = temp()
    writeFileSync(
      join(dir, 'requirements.txt'),
      [
        'Pillow>=10',
        'opencv-python>=4.8',
        'torch; python_version < "3.12"',
        'numpy>=1.26',
        'mystery; extra == "cuda"'
      ].join('\n')
    )
    const parsed = requirementsForPack(pack(dir))
    const installed = new Map<string, string>([
      ['pillow', '10.0.0'],
      ['opencv-python', '4.9.0'],
      ['numpy', '1.26.0']
    ])
    const rows = auditPackRequirements([{ pack: pack(dir), reqs: parsed.reqs }], installed)
    // Nothing is missing/mismatched; marker-skipped lines alone do not create
    // a false problem row.
    expect(rows).toEqual([])

    // With one genuinely missing package, the skipped markers are still
    // recorded on the row for the UI ("platform/marker not applicable").
    const withMissing = auditPackRequirements(
      [
        {
          pack: pack(dir),
          reqs: [
            ...parsed.reqs,
            { name: 'definitely-missing', extras: [], specifier: '', raw: 'definitely-missing' }
          ]
        }
      ],
      installed
    )
    expect(withMissing[0].missing).toEqual(['definitely-missing'])
    expect(withMissing[0].skipped?.length).toBe(2)
  })

  it('reports a real mismatch and a missing distribution', () => {
    const dir = temp()
    writeFileSync(join(dir, 'requirements.txt'), 'Pillow>=11\nmissing-pkg\n')
    const parsed = requirementsForPack(pack(dir))
    const rows = auditPackRequirements(
      [{ pack: pack(dir), reqs: parsed.reqs }],
      new Map([['pillow', '10.0.0']])
    )
    expect(rows[0].missing).toEqual(['missing-pkg'])
    expect(rows[0].mismatched).toEqual([{ name: 'pillow', required: '>=11', installed: '10.0.0' }])
  })
})
