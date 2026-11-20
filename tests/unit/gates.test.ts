import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'

const repo = join(__dirname, '..', '..')
const ratchet = join(repo, 'scripts', 'coverage-ratchet.cjs')
const asar = join(repo, 'scripts', 'check-asar.cjs')
const roots: string[] = []

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-gate-'))
  roots.push(dir)
  mkdirSync(join(dir, 'coverage'), { recursive: true })
  return dir
}

function lcov(
  rootDir: string,
  files: Array<{
    file: string
    lines: number
    hit: number
    branches?: number
    bh?: number
    functions?: number
    fh?: number
  }>
): void {
  const body = files
    .map((f) =>
      [
        `SF:${join(rootDir, f.file)}`,
        `LF:${f.lines}`,
        `LH:${f.hit}`,
        `BRF:${f.branches || 0}`,
        `BRH:${f.bh || 0}`,
        `FNF:${f.functions || 0}`,
        `FNH:${f.fh || 0}`,
        'end_of_record'
      ].join('\n')
    )
    .join('\n')
  writeFileSync(join(rootDir, 'coverage', 'lcov.info'), body)
}

function baseline(rootDir: string, value: unknown): void {
  writeFileSync(join(rootDir, 'coverage-baseline.json'), JSON.stringify(value))
}

function run(
  script: string,
  rootDir: string,
  args: string[] = []
): { status: number; out: string } {
  const r = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, CP_GATE_ROOT: rootDir },
    encoding: 'utf-8'
  })
  return { status: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` }
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('coverage ratchet gate (0.2.5 WP8)', () => {
  it('fails when a baseline file is missing from the report', () => {
    const dir = root()
    lcov(dir, [{ file: 'src/a.ts', lines: 10, hit: 10 }])
    baseline(dir, {
      'src/a.ts': { lines: 100, branches: 100, functions: 100 },
      'src/gone.ts': { lines: 50, branches: 50, functions: 50 }
    })
    const r = run(ratchet, dir)
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/MISSING FROM REPORT/)
  })

  it('fails a new file below 30% lines and a >1pp drop', () => {
    const dir = root()
    lcov(dir, [
      { file: 'src/a.ts', lines: 10, hit: 5 },
      { file: 'src/new.ts', lines: 10, hit: 0 }
    ])
    baseline(dir, { 'src/a.ts': { lines: 90, branches: 90, functions: 90 } })
    const r = run(ratchet, dir)
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/NEW FILE BELOW 30%/)
    expect(r.out).toMatch(/DROP/)
  })

  it('requires --accept for --update and never lowers an existing floor', () => {
    const dir = root()
    lcov(dir, [{ file: 'src/a.ts', lines: 10, hit: 2 }])
    baseline(dir, { 'src/a.ts': { lines: 90, branches: 90, functions: 90 } })
    const noAccept = run(ratchet, dir, ['--update'])
    expect(noAccept.status).not.toBe(0)
    expect(noAccept.out).toMatch(/requires --accept/)
    const accepted = run(ratchet, dir, ['--update', '--accept'])
    expect(accepted.status).toBe(0)
    const written = JSON.parse(
      require('fs').readFileSync(join(dir, 'coverage-baseline.json'), 'utf-8')
    )
    expect(written['src/a.ts'].lines).toBe(90)
  })

  it('passes when every file is at or above its baseline', () => {
    const dir = root()
    lcov(dir, [{ file: 'src/a.ts', lines: 10, hit: 10 }])
    baseline(dir, { 'src/a.ts': { lines: 90, branches: 100, functions: 100 } })
    const r = run(ratchet, dir)
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/OK/)
  })
})

describe('check-asar gate (0.2.5 WP8)', () => {
  const validYml = `files:\n  - out/**\n  - '!out/preload/**'\n  - '!out/renderer/**'\nextraResources:\n  - from: out/preload\n    to: preload\n  - from: out/renderer\n    to: renderer\n`
  it('fails when the packaging config re-includes the duplicate runtime trees', () => {
    const dir = root()
    writeFileSync(join(dir, 'electron-builder.yml'), 'files:\n  - out/**\nextraResources: []\n')
    const r = run(asar, dir)
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/must exclude/)
  })

  it('passes a valid packaging config', () => {
    const dir = root()
    writeFileSync(join(dir, 'electron-builder.yml'), validYml)
    const r = run(asar, dir)
    expect(r.status).toBe(0)
  })
})
