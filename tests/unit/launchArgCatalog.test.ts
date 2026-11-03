import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ path: '' }))

vi.mock('../../src/main/services/target', () => ({
  resolveReadTarget: () => ({ id: 'i1', path: h.path })
}))

describe('launchArgCatalog (0.2.0)', () => {
  it('falls back to the static ComfyUI flags when cli_args.py is absent', async () => {
    h.path = ''
    const { launchArgCatalog } = await import('../../src/main/services/launchArgCatalog')
    const flags = launchArgCatalog('i1')
    expect(flags).toContain('--listen')
    expect(flags).toContain('--output-directory')
    expect(flags).toContain('--enable-agent')
    expect(flags).toEqual([...flags].sort())
  })

  it('readCliArgsFlags reads only the installed build and tolerates a missing file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cp-launch-flags-'))
    try {
      const { readCliArgsFlags } = await import('../../src/main/services/launchArgCatalog')
      expect(readCliArgsFlags(root)).toEqual([])
      expect(readCliArgsFlags('')).toEqual([])
      mkdirSync(join(root, 'comfy'), { recursive: true })
      writeFileSync(
        join(root, 'comfy', 'cli_args.py'),
        "parser.add_argument('--fast-disk', action='store_true')\n" +
          'parser.add_argument("--enable-assets")\n' +
          "parser.add_argument('--fast-disk')\n"
      )
      expect(readCliArgsFlags(root)).toEqual(['--enable-assets', '--fast-disk'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns an empty list when cli_args.py is unreadable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cp-launch-broken-'))
    try {
      // A directory at the file path makes readFileSync throw after existsSync
      // passed — the catch path must fall back to the static catalogue.
      mkdirSync(join(root, 'comfy', 'cli_args.py'), { recursive: true })
      const { readCliArgsFlags, launchArgCatalog } =
        await import('../../src/main/services/launchArgCatalog')
      expect(readCliArgsFlags(root)).toEqual([])
      h.path = root
      expect(launchArgCatalog('i1')).toContain('--listen')
    } finally {
      h.path = ''
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not invent flags from malformed cli_args.py entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cp-launch-catalog-'))
    try {
      mkdirSync(join(root, 'comfy'), { recursive: true })
      writeFileSync(
        join(root, 'comfy', 'cli_args.py'),
        "parser.add_argument('--good-flag')\nparser.add_argument('not-a-flag')\n"
      )
      h.path = root
      const { launchArgCatalog } = await import('../../src/main/services/launchArgCatalog')
      const flags = launchArgCatalog('i1')
      expect(flags).toContain('--good-flag')
      expect(flags).not.toContain('not-a-flag')
    } finally {
      h.path = ''
      rmSync(root, { recursive: true, force: true })
    }
  })
})
