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
