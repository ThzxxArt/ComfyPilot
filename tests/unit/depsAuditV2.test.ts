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
    // 0.2.2: wheel URLs are parsed into a name-only direct reference instead
    // of being labelled unsupported forever.
    expect(parsed.reqs.find((r) => r.directUrl)?.name).toBe('a')
    expect(parsed.unsupported).toEqual([])
  })

  it('skips pip options but still reports editable installs as unsupported', () => {
    const dir = temp()
    writeFileSync(
      join(dir, 'requirements.txt'),
      [
        '--extra-index-url https://example.com/simple',
        '--trusted-host example.com',
        '--find-links ./wheels',
        'numpy>=1.26',
        '-e ./local-pack'
      ].join('\n')
    )
    const parsed = requirementsForPack(pack(dir))
    expect(parsed.reqs.map((r) => r.name)).toEqual(['numpy'])
    expect(parsed.unsupported).toEqual(['-e ./local-pack'])
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
    const audit = auditPackRequirements([{ pack: pack(dir), reqs: parsed.reqs }], installed)
    // Nothing is missing/mismatched; marker-skipped lines alone do not create
    // a false problem row.
    expect(audit.packs).toEqual([])
    expect(audit.unverifiable).toEqual([])

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
    expect(withMissing.packs[0].missing).toEqual(['definitely-missing'])
    expect(withMissing.packs[0].skipped?.length).toBe(2)
  })

  it('reports a real mismatch and a missing distribution', () => {
    const dir = temp()
    writeFileSync(join(dir, 'requirements.txt'), 'Pillow>=11\nmissing-pkg\n')
    const parsed = requirementsForPack(pack(dir))
    const audit = auditPackRequirements(
      [{ pack: pack(dir), reqs: parsed.reqs }],
      new Map([['pillow', '10.0.0']])
    )
    expect(audit.packs[0].missing).toEqual(['missing-pkg'])
    expect(audit.packs[0].mismatched).toEqual([
      { name: 'pillow', required: '>=11', installed: '10.0.0' }
    ])
  })

  it('verifies a named direct reference when its distribution is installed', () => {
    const dir = temp()
    writeFileSync(
      join(dir, 'requirements.txt'),
      'sam2 @ git+https://github.com/facebookresearch/sam2\n'
    )
    const parsed = requirementsForPack(pack(dir))
    const audit = auditPackRequirements(
      [{ pack: pack(dir), reqs: parsed.reqs }],
      new Map([['sam-2', '1.0']])
    )
    expect(audit.packs).toEqual([])
    expect(audit.unverifiable).toEqual([])
  })

  it('reports an absent direct reference as unverifiable, not missing', () => {
    const dir = temp()
    writeFileSync(
      join(dir, 'requirements.txt'),
      'sam2 @ git+https://github.com/facebookresearch/sam2\n'
    )
    const parsed = requirementsForPack(pack(dir))
    const audit = auditPackRequirements([{ pack: pack(dir), reqs: parsed.reqs }], new Map())
    expect(audit.packs).toEqual([])
    expect(audit.unverifiable).toHaveLength(1)
    expect(audit.unverifiable[0].lines[0]).toContain('facebookresearch/sam2')
  })

  it('does not turn pip index options into permanent unsupported rows', () => {
    const dir = temp()
    writeFileSync(
      join(dir, 'requirements.txt'),
      '--extra-index-url https://example.com/simple\nnumpy>=1.26\n'
    )
    const parsed = requirementsForPack(pack(dir))
    const audit = auditPackRequirements(
      [{ pack: pack(dir), reqs: parsed.reqs, unsupported: parsed.unsupported }],
      new Map([['numpy', '1.26.0']])
    )
    expect(parsed.unsupported).toEqual([])
    expect(audit.packs).toEqual([])
    expect(audit.unverifiable).toEqual([])
  })
})
